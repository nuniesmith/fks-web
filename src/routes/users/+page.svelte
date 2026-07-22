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
  import { ApiError } from "$lib/api/client";
  import type { AssignableRole, UserSummary } from "$lib/types/users";

  const ROLES: AssignableRole[] = ["admin", "operator", "viewer"];

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
</style>
