<script lang="ts">
  /**
   * /users — the admin user-management console (Phase B). Admin-only: the seam
   * (adapter R5) redirects non-admins home before this ever renders, and every
   * /api/users call is admin-gated (R1) + re-checked in usersDispatch.
   *
   * Capabilities: create users (temp password shown ONCE), enable/disable,
   * change role, reset password (temp shown once), revoke sessions. The
   * one-time credential is never retrievable again — the callout says so.
   * Self-row destructive actions (disable/demote) are disabled with a hint;
   * the server guards them regardless (last-admin / self-disable).
   *
   * .page-scroll archetype (document page) — rigid Panels, the page scrolls.
   */
  import { page } from "$app/stores";
  import Panel from "$lib/components/ui/Panel.svelte";
  import Badge from "$lib/components/ui/Badge.svelte";
  import EmptyState from "$lib/components/ui/EmptyState.svelte";
  import Skeleton from "$lib/components/ui/Skeleton.svelte";
  import { usersApi } from "$lib/api/users";
  import { invitesApi } from "$lib/api/invites";
  import { ApiError } from "$lib/api/client";
  import type { AssignableRole, AuditEvent, UserSummary } from "$lib/types/users";
  import type { InviteRole, InviteStatus, InviteSummary } from "$lib/types/invites";

  const ROLES: AssignableRole[] = ["admin", "operator", "viewer"];
  const INVITE_ROLES: InviteRole[] = ["operator", "viewer"];

  let users = $state<UserSummary[] | null>(null);
  let loadError = $state<string | null>(null);

  // Create-user form.
  let newUsername = $state("");
  let newRole = $state<AssignableRole>("operator");
  let createError = $state<string | null>(null);
  let creating = $state(false);

  // One-time credential reveal (create or reset). Never re-fetchable.
  let reveal = $state<{ username: string; password: string; kind: "created" | "reset" } | null>(null);
  let copied = $state(false);

  // Per-row transient UI state.
  let confirming = $state<{ id: number; action: "disable" | "reset" | "revoke" } | null>(null);
  let pendingRole = $state<Record<number, AssignableRole>>({});
  let rowError = $state<Record<number, string>>({});
  let rowBusy = $state<number | null>(null);

  let me = $derived(
    ($page.data.user as { username: string; role: string } | null)?.username ?? "",
  );

  function errText(e: unknown): string {
    if (e instanceof ApiError) {
      // The backend sends { error } / { ok:false, error } JSON as the body text.
      try {
        const b = JSON.parse(String(e.body ?? ""));
        if (b?.error) return String(b.error);
      } catch {
        /* not JSON — fall through */
      }
      return e.message;
    }
    return e instanceof Error ? e.message : String(e);
  }

  async function load() {
    loadError = null;
    try {
      const r = await usersApi.list();
      users = r.users;
      pendingRole = Object.fromEntries(r.users.map((u) => [u.id, u.role as AssignableRole]));
    } catch (e) {
      loadError = errText(e);
      users = [];
    }
  }

  $effect(() => {
    void load();
  });

  async function createUser(ev: SubmitEvent) {
    ev.preventDefault();
    createError = null;
    if (!newUsername.trim()) {
      createError = "Username is required.";
      return;
    }
    creating = true;
    try {
      const r = await usersApi.create(newUsername.trim(), newRole);
      reveal = { username: r.user.username, password: r.tempPassword, kind: "created" };
      copied = false;
      newUsername = "";
      newRole = "operator";
      await load();
    } catch (e) {
      createError = errText(e);
    } finally {
      creating = false;
    }
  }

  function clearRowError(id: number) {
    const { [id]: _drop, ...rest } = rowError;
    rowError = rest;
  }

  async function run(id: number, fn: () => Promise<unknown>) {
    rowBusy = id;
    clearRowError(id);
    confirming = null;
    try {
      await fn();
      await load();
    } catch (e) {
      rowError = { ...rowError, [id]: errText(e) };
    } finally {
      rowBusy = null;
    }
  }

  function toggleDisable(u: UserSummary) {
    if (u.disabled) {
      void run(u.id, () => usersApi.enable(u.id));
    } else {
      // Destructive → inline confirm first.
      confirming = { id: u.id, action: "disable" };
    }
  }

  async function saveRole(u: UserSummary) {
    const role = pendingRole[u.id];
    if (!role || role === u.role) return;
    await run(u.id, () => usersApi.setRole(u.id, role));
  }

  async function resetPassword(u: UserSummary) {
    rowBusy = u.id;
    clearRowError(u.id);
    confirming = null;
    try {
      const r = await usersApi.resetPassword(u.id);
      reveal = { username: u.username, password: r.tempPassword, kind: "reset" };
      copied = false;
      await load();
    } catch (e) {
      rowError = { ...rowError, [u.id]: errText(e) };
    } finally {
      rowBusy = null;
    }
  }

  async function copyPassword() {
    if (!reveal) return;
    try {
      await navigator.clipboard.writeText(reveal.password);
      copied = true;
    } catch {
      copied = false;
    }
  }

  function status(u: UserSummary): { label: string; variant: "green" | "red" | "amber" } {
    if (u.disabled) return { label: "disabled", variant: "red" };
    if (u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now()) {
      return { label: "locked", variant: "amber" };
    }
    return { label: "active", variant: "green" };
  }

  function roleVariant(role: string): "cyan" | "purple" | "default" {
    if (role === "admin") return "purple";
    if (role === "operator") return "cyan";
    return "default";
  }

  function fmtDate(iso: string): string {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t) || t <= 0) return "—";
    return new Date(iso).toLocaleDateString();
  }

  let onlyAdmin = $derived(
    (users ?? []).filter((u) => u.role === "admin" && !u.disabled).length <= 1,
  );

  // ── Invites (Phase C) ──────────────────────────────────────────────────────
  let invites = $state<InviteSummary[] | null>(null);
  let invitesError = $state<string | null>(null);
  let inviteRole = $state<InviteRole>("operator");
  let creatingInvite = $state(false);
  let createInviteError = $state<string | null>(null);
  // One-time invite URL reveal (absolute, built from the relative path + origin).
  let inviteReveal = $state<{ url: string } | null>(null);
  let inviteCopied = $state(false);
  let confirmingRevoke = $state<number | null>(null);
  let inviteRowBusy = $state<number | null>(null);
  let inviteRowError = $state<Record<number, string>>({});

  async function loadInvites() {
    invitesError = null;
    try {
      const r = await invitesApi.list();
      invites = r.invites;
    } catch (e) {
      invitesError = errText(e);
      invites = [];
    }
  }

  $effect(() => {
    void loadInvites();
  });

  async function createInvite(ev: SubmitEvent) {
    ev.preventDefault();
    createInviteError = null;
    creatingInvite = true;
    try {
      const r = await invitesApi.create(inviteRole);
      // Complete the RELATIVE path with THIS admin browser's origin — the server
      // deliberately never guesses its own public host.
      inviteReveal = { url: `${window.location.origin}${r.url}` };
      inviteCopied = false;
      await loadInvites();
    } catch (e) {
      createInviteError = errText(e);
    } finally {
      creatingInvite = false;
    }
  }

  async function copyInviteUrl() {
    if (!inviteReveal) return;
    try {
      await navigator.clipboard.writeText(inviteReveal.url);
      inviteCopied = true;
    } catch {
      inviteCopied = false;
    }
  }

  async function revokeInvite(id: number) {
    inviteRowBusy = id;
    confirmingRevoke = null;
    const { [id]: _drop, ...rest } = inviteRowError;
    inviteRowError = rest;
    try {
      await invitesApi.revoke(id);
      await loadInvites();
    } catch (e) {
      inviteRowError = { ...inviteRowError, [id]: errText(e) };
    } finally {
      inviteRowBusy = null;
    }
  }

  function inviteStatusVariant(s: InviteStatus): "green" | "red" | "amber" | "default" {
    if (s === "active") return "green";
    if (s === "revoked") return "red";
    if (s === "expired") return "amber";
    return "default"; // redeemed
  }

  // ── Recent auth events (Phase D) ────────────────────────────────────────────
  // Read-only view of the existing audit trail — every login/mutation/invite
  // action already writes a row (Phase B/C); this only surfaces them.
  let events = $state<AuditEvent[] | null>(null);
  let eventsError = $state<string | null>(null);

  async function loadAudit() {
    eventsError = null;
    try {
      const r = await usersApi.audit(100);
      events = r.events;
    } catch (e) {
      eventsError = errText(e);
      events = [];
    }
  }

  $effect(() => {
    void loadAudit();
  });

  // Color-code by CLASS: failures (red), auth successes (green), admin
  // mutations (purple), invite events (cyan). Unknown verbs fall back neutral.
  const AUTH_OK = new Set(["login_ok", "logout", "bootstrap", "credential_change"]);
  const AUTH_FAIL = new Set(["login_fail", "lockout"]);
  const ADMIN_MUTATION = new Set([
    "user_created",
    "user_disabled",
    "user_enabled",
    "role_changed",
    "password_reset",
    "sessions_revoked",
  ]);
  const INVITE_EVENT = new Set(["invite_created", "invite_redeemed", "invite_revoked"]);

  function actionVariant(action: string): "green" | "red" | "purple" | "cyan" | "default" {
    if (AUTH_FAIL.has(action)) return "red";
    if (AUTH_OK.has(action)) return "green";
    if (ADMIN_MUTATION.has(action)) return "purple";
    if (INVITE_EVENT.has(action)) return "cyan";
    return "default";
  }

  function relTime(iso: string): string {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "—";
    const diff = Date.now() - t;
    if (diff < 0) return "just now";
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(iso).toLocaleDateString();
  }
</script>

<svelte:head><title>Users — FKS Terminal</title></svelte:head>

<div class="page-scroll users-page">
  <header class="hdr">
    <h1>Users</h1>
    <p class="sub">
      Create and manage the people who can sign in. Roles: <strong>admin</strong>
      (full control), <strong>operator</strong> (operate/trade), <strong>viewer</strong>
      (read-only).
    </p>
  </header>

  {#if reveal}
    <div class="callout" role="alert">
      <div class="callout-head">
        <span class="callout-icon" aria-hidden="true">🔑</span>
        <div>
          <strong>
            {reveal.kind === "created" ? "User created" : "Password reset"} —
            temporary password for <code>{reveal.username}</code>
          </strong>
          <p class="callout-note">
            Shown once — copy it now and hand it over. The user must change it on
            first login. It is never retrievable again.
          </p>
        </div>
      </div>
      <div class="callout-cred">
        <code class="temp-pw">{reveal.password}</code>
        <button type="button" class="btn small" onclick={copyPassword}>
          {copied ? "Copied ✓" : "Copy"}
        </button>
        <button type="button" class="btn small ghost" onclick={() => (reveal = null)}>
          Dismiss
        </button>
      </div>
    </div>
  {/if}

  <Panel title="Create user">
    <form class="create-form" onsubmit={createUser}>
      <label class="fld">
        <span>Username</span>
        <input
          type="text"
          bind:value={newUsername}
          autocomplete="off"
          placeholder="e.g. friend"
          disabled={creating}
        />
      </label>
      <label class="fld">
        <span>Role</span>
        <select bind:value={newRole} disabled={creating}>
          {#each ROLES as r}
            <option value={r}>{r}</option>
          {/each}
        </select>
      </label>
      <button type="submit" class="btn" disabled={creating}>
        {creating ? "Creating…" : "Create user"}
      </button>
      {#if createError}
        <span class="inline-err" role="alert">{createError}</span>
      {/if}
    </form>
  </Panel>

  <Panel title="People" noPad>
    {#if users === null}
      <div class="pad"><Skeleton /></div>
    {:else if loadError}
      <EmptyState icon="⚠️" title="Failed to load users" variant="error" hint={loadError} />
    {:else if users.length === 0}
      <EmptyState icon="👤" title="No users yet" hint="Create one above to get started." />
    {:else if users.length === 1 && onlyAdmin}
      <EmptyState
        icon="👤"
        title="You're the only user"
        hint="Create an operator or viewer above to share the dashboard. Disabling or demoting the last admin is blocked."
      />
    {/if}

    {#if users && users.length > 0 && !loadError}
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Status</th>
              <th>Created</th>
              <th class="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each users as u (u.id)}
              {@const isSelf = u.username === me}
              {@const st = status(u)}
              {@const lastAdmin = u.role === "admin" && !u.disabled && onlyAdmin}
              <tr class:self={isSelf}>
                <td>
                  <span class="uname">{u.username}</span>
                  {#if isSelf}<span class="you">you</span>{/if}
                  {#if u.mustChange}
                    <span class="mc" title="Must change password on next login">must-change</span>
                  {/if}
                </td>
                <td><Badge variant={roleVariant(u.role)}>{u.role}</Badge></td>
                <td><Badge variant={st.variant}>{st.label}</Badge></td>
                <td class="dim">{fmtDate(u.createdAt)}</td>
                <td class="actions">
                  <!-- Role select + Save -->
                  <span class="role-edit">
                    <select
                      bind:value={pendingRole[u.id]}
                      disabled={rowBusy === u.id || (isSelf && lastAdmin)}
                      aria-label="Role for {u.username}"
                    >
                      {#each ROLES as r}
                        <option value={r}>{r}</option>
                      {/each}
                    </select>
                    <button
                      type="button"
                      class="btn small"
                      disabled={rowBusy === u.id || pendingRole[u.id] === u.role}
                      onclick={() => saveRole(u)}
                    >
                      Save
                    </button>
                  </span>

                  {#if confirming?.id === u.id && confirming.action === "disable"}
                    <span class="confirm">
                      Disable {u.username}?
                      <button type="button" class="btn small danger" onclick={() => run(u.id, () => usersApi.disable(u.id))}>Yes</button>
                      <button type="button" class="btn small ghost" onclick={() => (confirming = null)}>No</button>
                    </span>
                  {:else if confirming?.id === u.id && confirming.action === "reset"}
                    <span class="confirm">
                      Reset password?
                      <button type="button" class="btn small danger" onclick={() => resetPassword(u)}>Yes</button>
                      <button type="button" class="btn small ghost" onclick={() => (confirming = null)}>No</button>
                    </span>
                  {:else if confirming?.id === u.id && confirming.action === "revoke"}
                    <span class="confirm">
                      Revoke all sessions?
                      <button type="button" class="btn small danger" onclick={() => run(u.id, () => usersApi.revokeSessions(u.id))}>Yes</button>
                      <button type="button" class="btn small ghost" onclick={() => (confirming = null)}>No</button>
                    </span>
                  {:else}
                    <button
                      type="button"
                      class="btn small"
                      class:danger={!u.disabled}
                      disabled={rowBusy === u.id || (isSelf && !u.disabled)}
                      title={isSelf && !u.disabled ? "You cannot disable your own account" : undefined}
                      onclick={() => toggleDisable(u)}
                    >
                      {u.disabled ? "Enable" : "Disable"}
                    </button>
                    <button
                      type="button"
                      class="btn small"
                      disabled={rowBusy === u.id}
                      onclick={() => (confirming = { id: u.id, action: "reset" })}
                    >
                      Reset password
                    </button>
                    <button
                      type="button"
                      class="btn small ghost"
                      disabled={rowBusy === u.id}
                      onclick={() => (confirming = { id: u.id, action: "revoke" })}
                    >
                      Revoke sessions
                    </button>
                  {/if}
                  {#if rowError[u.id]}
                    <span class="inline-err" role="alert">{rowError[u.id]}</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Panel>

  {#if inviteReveal}
    <div class="callout" role="alert">
      <div class="callout-head">
        <span class="callout-icon" aria-hidden="true">🔗</span>
        <div>
          <strong>Invite link created</strong>
          <p class="callout-note">
            Shown once — copy it now and hand it over (message, not email). The
            person opening it sets their own username and password. Single-use,
            expires in 48 hours. It is never retrievable again.
          </p>
        </div>
      </div>
      <div class="callout-cred">
        <code class="temp-pw invite-url">{inviteReveal.url}</code>
        <button type="button" class="btn small" onclick={copyInviteUrl}>
          {inviteCopied ? "Copied ✓" : "Copy"}
        </button>
        <button type="button" class="btn small ghost" onclick={() => (inviteReveal = null)}>
          Dismiss
        </button>
      </div>
    </div>
  {/if}

  <Panel title="Invite links">
    <form class="create-form" onsubmit={createInvite}>
      <label class="fld">
        <span>Role</span>
        <select bind:value={inviteRole} disabled={creatingInvite}>
          {#each INVITE_ROLES as r}
            <option value={r}>{r}</option>
          {/each}
        </select>
      </label>
      <button type="submit" class="btn" disabled={creatingInvite}>
        {creatingInvite ? "Creating…" : "Create invite link"}
      </button>
      {#if createInviteError}
        <span class="inline-err" role="alert">{createInviteError}</span>
      {/if}
    </form>
    <p class="panel-note">
      Invites grant <strong>operator</strong> or <strong>viewer</strong> only —
      admins are created above. Use an invite for remote family; use "Create user"
      for hand-the-laptop cases.
    </p>
  </Panel>

  <Panel title="Outstanding invites" noPad>
    {#if invites === null}
      <div class="pad"><Skeleton /></div>
    {:else if invitesError}
      <EmptyState icon="⚠️" title="Failed to load invites" variant="error" hint={invitesError} />
    {:else if invites.length === 0}
      <EmptyState icon="🔗" title="No invites yet" hint="Create one above to invite someone." />
    {:else}
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>Role</th>
              <th>Status</th>
              <th>Created by</th>
              <th>Expires</th>
              <th class="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each invites as inv (inv.id)}
              <tr>
                <td><Badge variant={roleVariant(inv.role)}>{inv.role}</Badge></td>
                <td><Badge variant={inviteStatusVariant(inv.status)}>{inv.status}</Badge></td>
                <td class="dim">{inv.createdBy}</td>
                <td class="dim">{fmtDate(inv.expiresAt)}</td>
                <td class="actions">
                  {#if inv.status === "active"}
                    {#if confirmingRevoke === inv.id}
                      <span class="confirm">
                        Revoke this invite?
                        <button type="button" class="btn small danger" disabled={inviteRowBusy === inv.id} onclick={() => revokeInvite(inv.id)}>Yes</button>
                        <button type="button" class="btn small ghost" onclick={() => (confirmingRevoke = null)}>No</button>
                      </span>
                    {:else}
                      <button
                        type="button"
                        class="btn small danger"
                        disabled={inviteRowBusy === inv.id}
                        onclick={() => (confirmingRevoke = inv.id)}
                      >
                        Revoke
                      </button>
                    {/if}
                  {:else}
                    <span class="dim">—</span>
                  {/if}
                  {#if inviteRowError[inv.id]}
                    <span class="inline-err" role="alert">{inviteRowError[inv.id]}</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Panel>

  <Panel title="Recent auth events" noPad>
    {#if events === null}
      <div class="pad"><Skeleton /></div>
    {:else if eventsError}
      <EmptyState icon="⚠️" title="Failed to load audit trail" variant="error" hint={eventsError} />
    {:else if events.length === 0}
      <EmptyState icon="🗒️" title="No events yet" hint="Logins and admin actions will appear here." />
    {:else}
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>User</th>
              <th>IP</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {#each events as ev, i (i)}
              <tr>
                <td class="dim" title={new Date(ev.at).toLocaleString()}>{relTime(ev.at)}</td>
                <td><Badge variant={actionVariant(ev.action)}>{ev.action}</Badge></td>
                <td><span class="uname">{ev.username || "—"}</span></td>
                <td class="dim mono">{ev.ip || "—"}</td>
                <td class="dim detail">{ev.detail || "—"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Panel>
</div>

<style>
  .users-page {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
  }
  .hdr h1 {
    font-size: 18px;
    margin: 0 0 2px;
  }
  .sub {
    font-size: 12px;
    color: var(--t2);
    margin: 0;
    max-width: 70ch;
  }

  /* One-time credential callout */
  .callout {
    border: 1px solid var(--amber-brd, #6b5300);
    background: var(--amber-dim, rgba(224, 160, 0, 0.08));
    border-radius: var(--r-md);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .callout-head {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .callout-icon {
    font-size: 18px;
  }
  .callout-note {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--t2);
  }
  .callout-cred {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .temp-pw {
    font-family: var(--mono, monospace);
    font-size: 14px;
    padding: 6px 10px;
    background: var(--bg0, #000);
    border: 1px solid var(--b2);
    border-radius: var(--r);
    user-select: all;
  }

  .create-form {
    display: flex;
    gap: 12px;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .fld {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    color: var(--t2);
  }
  .fld input,
  .fld select,
  .actions select {
    background: var(--bg0, #0a0a0a);
    border: 1px solid var(--b2);
    border-radius: var(--r);
    color: var(--t1);
    padding: 6px 8px;
    font-size: 12px;
  }

  .tbl-wrap {
    overflow-x: auto;
  }
  .tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .tbl th,
  .tbl td {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid var(--b2);
    vertical-align: top;
  }
  .tbl th {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--t3);
    font-weight: 600;
  }
  tr.self {
    background: var(--bg2, rgba(255, 255, 255, 0.02));
  }
  .uname {
    font-weight: 600;
  }
  .you {
    font-size: 9px;
    text-transform: uppercase;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: var(--r);
    padding: 0 4px;
    margin-left: 6px;
  }
  .mc {
    font-size: 9px;
    color: var(--amber, #e0a000);
    margin-left: 6px;
  }
  .dim {
    color: var(--t3);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .role-edit,
  .confirm {
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
  .confirm {
    font-size: 11px;
    color: var(--amber, #e0a000);
  }

  .btn {
    background: var(--accent);
    color: var(--bg0, #000);
    border: 1px solid var(--accent);
    border-radius: var(--r);
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .btn.small {
    padding: 4px 8px;
    font-size: 11px;
  }
  .btn.ghost {
    background: transparent;
    color: var(--t2);
    border-color: var(--b2);
  }
  .btn.danger {
    background: var(--red, #e5484d);
    border-color: var(--red, #e5484d);
    color: #fff;
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .inline-err {
    color: var(--red, #e5484d);
    font-size: 11px;
  }
  .pad {
    padding: 12px;
  }
  .panel-note {
    margin: 10px 0 0;
    font-size: 11px;
    color: var(--t3);
    max-width: 70ch;
  }
  .invite-url {
    word-break: break-all;
    font-size: 12px;
  }
  .mono {
    font-family: var(--mono, monospace);
    font-size: 11px;
  }
  .detail {
    max-width: 40ch;
    word-break: break-word;
  }
</style>
