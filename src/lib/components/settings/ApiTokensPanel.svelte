<script lang="ts">
  /*
    API tokens (API v1, EDGE_FACTORY_PLAN §7.2): the signed-in user's own
    personal access tokens, for agents and scripts. A token is shown ONCE, at
    mint; it acts as you at min(your role, its role), and never as an admin.
  */
  import { onMount } from 'svelte';
  import Panel from '$components/ui/Panel.svelte';
  import Badge from '$components/ui/Badge.svelte';
  import Skeleton from '$components/ui/Skeleton.svelte';
  import EmptyState from '$components/ui/EmptyState.svelte';
  import ConfirmButton from '$components/ui/ConfirmButton.svelte';
  import { ApiError } from '$api/client';
  import { tokens as tokensApi } from '$api/tokens';
  import { fmtDateTime, fmtRelative, fmtUntil } from '$lib/utils/format';
  import {
    API_TOKEN_ROLES,
    API_TOKEN_TTL_DAYS,
    type ApiTokenList,
  } from '$lib/types/tokens';

  let list = $state<ApiTokenList | null>(null);
  let loadError = $state<string | null>(null);
  let name = $state('');
  let role = $state<string>('viewer');
  let ttlDays = $state<number>(90);
  let creating = $state(false);
  let revoking = $state<number | null>(null);
  let feedback = $state<{ msg: string; ok: boolean } | null>(null);
  /** The just-minted raw token. Held only in this component, never refetched. */
  let minted = $state<{ name: string; token: string } | null>(null);
  let copied = $state(false);

  function errText(e: unknown): string {
    if (e instanceof ApiError) {
      const b = e.body as { error?: string } | undefined;
      return b?.error ?? `${e.status} ${e.statusText}`;
    }
    return String(e);
  }

  async function load() {
    try {
      list = await tokensApi.list();
      loadError = null;
    } catch (e) {
      loadError = errText(e);
    }
  }

  async function create(e: Event) {
    e.preventDefault();
    if (creating || !name.trim()) return;
    creating = true;
    feedback = null;
    copied = false;
    try {
      const r = await tokensApi.create({ name: name.trim(), role, ttlDays });
      minted = { name: r.apiToken.name, token: r.token };
      name = '';
      await load();
    } catch (e) {
      feedback = { msg: `Create failed: ${errText(e)}`, ok: false };
    } finally {
      creating = false;
    }
  }

  async function revoke(id: number) {
    revoking = id;
    feedback = null;
    try {
      await tokensApi.revoke(id);
      feedback = { msg: 'Token revoked: it stops working now.', ok: true };
      await load();
    } catch (e) {
      feedback = { msg: `Revoke failed: ${errText(e)}`, ok: false };
    } finally {
      revoking = null;
    }
  }

  async function copy() {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.token);
      copied = true;
    } catch {
      copied = false;
    }
  }

  onMount(load);
</script>

<Panel title="API tokens">
  {#if list === null}
    {#if loadError}
      <div class="status-display key-status">
        <span class="status-dot dot-amber"></span>
        <span class="mono">Tokens unreachable: {loadError}</span>
      </div>
    {:else}
      <div aria-busy="true"><Skeleton lines={2} height="20px" /></div>
    {/if}
  {:else if !list.available}
    <div class="status-display key-status">
      <span class="status-dot dot-amber"></span>
      <span class="mono">API tokens are off on this server: webui_api_tokens is missing (fks 027 not applied)</span>
    </div>
  {:else}
    {#if minted}
      <div class="minted" role="status" data-testid="minted-token">
        <div class="minted-lbl">
          Token "{minted.name}". Copy it now: it is not shown again.
        </div>
        <code class="minted-val">{minted.token}</code>
        <div class="minted-actions">
          <button type="button" class="btn-ghost" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          <button type="button" class="btn-ghost" onclick={() => (minted = null)}>Done</button>
        </div>
      </div>
    {/if}

    <form class="tok-form" onsubmit={create}>
      <label class="tok-field">
        <span class="form-label">Name</span>
        <input class="form-input" type="text" bind:value={name} maxlength="64" placeholder="e.g. muse, claude, phone" />
      </label>
      <label class="tok-field">
        <span class="form-label">Role</span>
        <select class="form-select" bind:value={role}>
          {#each API_TOKEN_ROLES as r (r)}<option value={r}>{r}</option>{/each}
        </select>
      </label>
      <label class="tok-field">
        <span class="form-label">Expires</span>
        <select class="form-select" bind:value={ttlDays}>
          {#each API_TOKEN_TTL_DAYS as d (d)}<option value={d}>{d} days</option>{/each}
        </select>
      </label>
      <button type="submit" class="btn-primary" disabled={creating || !name.trim()}>
        {creating ? 'Creating…' : 'Create token'}
      </button>
    </form>

    {#if feedback}
      <p class="feedback" class:ok={feedback.ok}>{feedback.msg}</p>
    {/if}

    {#if list.tokens.length === 0}
      <EmptyState icon="🔑" title="No API tokens" hint="Create one for an agent or a script." />
    {:else}
      <div class="tok-list">
        {#each list.tokens as t (t.id)}
          <div class="tok-row" class:dead={t.status !== 'active'}>
            <span class="tok-name" title={t.name}>{t.name}</span>
            <Badge variant={t.roleCap === 'operator' ? 'amber' : 'default'}>{t.roleCap}</Badge>
            <span class="tok-meta" title={fmtDateTime(t.expiresAt)}>
              {t.status === 'active'
                ? `expires ${fmtUntil(t.expiresAt)}`
                : t.status}
            </span>
            <span class="tok-meta" title={t.lastUsedAt ? fmtDateTime(t.lastUsedAt) : ''}>
              {t.lastUsedAt ? `used ${fmtRelative(t.lastUsedAt)}` : 'never used'}
            </span>
            {#if t.status === 'active'}
              <ConfirmButton
                label="Revoke"
                confirmLabel={`Revoke "${t.name}"?`}
                ariaLabel={`Revoke token ${t.name}`}
                busy={revoking === t.id}
                disabled={revoking !== null && revoking !== t.id}
                onconfirm={() => revoke(t.id)}
              />
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
  <div class="cred-hint">
    Send as <code>Authorization: Bearer fks_pat_…</code> to this server's <code>/api/…</code> routes, on
    the tailnet. A token acts as you, at the lower of your role and its own; it can't open pages,
    manage users or tokens, or do anything admin-only (keys, webhooks, live money).
  </div>
</Panel>

<style>
  /* Shared with /settings (its styles are page-scoped, so copied here). */
  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
    background: var(--t3);
  }
  .dot-amber { background: var(--amber); box-shadow: 0 0 4px var(--amber); }
  .status-display {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--t1);
  }
  .key-status {
    margin-bottom: 8px;
    font-size: 11px;
  }
  .form-label {
    display: block;
    font-size: 10px;
    color: var(--t2);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .form-input,
  .form-select {
    width: 100%;
    padding: 6px 8px;
    background: var(--bg2);
    border: 1px solid var(--b1);
    border-radius: var(--r);
    color: var(--t1);
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    outline: none;
    box-sizing: border-box;
  }
  .form-input:focus,
  .form-select:focus {
    border-color: var(--accent, var(--cyan));
  }
  .form-input::placeholder {
    color: var(--t3);
  }
  .form-select option {
    background: var(--bg2);
    color: var(--t1);
  }
  .btn-primary {
    all: unset;
    padding: 5px 14px;
    font-size: 11px;
    font-weight: 600;
    color: var(--bg0);
    background: var(--accent, var(--cyan));
    border-radius: var(--r);
    cursor: pointer;
    white-space: nowrap;
  }
  .btn-primary:hover { opacity: 0.85; }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-ghost {
    all: unset;
    padding: 4px 10px;
    font-size: 11px;
    font-weight: 600;
    color: var(--t2);
    border: 1px solid var(--b1);
    border-radius: var(--r);
    cursor: pointer;
    white-space: nowrap;
  }
  .btn-ghost:hover {
    color: var(--t1);
    border-color: var(--t2);
  }
  .cred-hint {
    font-size: 9px;
    color: var(--t3);
    margin-top: 6px;
    line-height: 1.5;
  }
  .tok-form {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: flex-end;
    margin-bottom: 8px;
  }
  .tok-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .tok-field:first-child {
    flex: 1 1 160px;
  }
  .tok-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .tok-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: 11px;
  }
  .tok-row.dead {
    opacity: 0.55;
  }
  .tok-name {
    flex: 1 1 120px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tok-meta {
    color: var(--t3);
  }
  .minted {
    border: 1px solid var(--accent);
    border-radius: var(--r);
    padding: 8px;
    margin-bottom: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .minted-lbl {
    font-size: 11px;
  }
  .minted-val {
    font-size: 11px;
    word-break: break-all;
    user-select: all;
  }
  .minted-actions {
    display: flex;
    gap: 6px;
  }
  .feedback {
    font-size: 10px;
    padding: 5px 8px;
    border-radius: var(--r);
    background: var(--red-dim);
    color: var(--red);
  }
  .feedback.ok {
    background: var(--green-dim);
    color: var(--green);
  }
</style>
