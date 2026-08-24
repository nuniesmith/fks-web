<script lang="ts">
  /**
   * Rithmic session control — the single-credential handover.
   *
   * Rithmic permits ONE session per credential, so the platform and the
   * operator's R|Trader Pro app cannot both be connected: each revokes the
   * other. Before this existed the two fought, and the connector logged the
   * operator out of their trading phone every few seconds. This hands the
   * session over deliberately instead.
   *
   * ASYMMETRIC BY DESIGN, mirroring the cockpit's kill/rearm split:
   *   RELEASE  is the SAFE direction (gives the session up)  → operator+
   *   RECONNECT is the DANGEROUS one (takes it back, and can revoke the
   *             operator's phone mid-trade)                   → admin-only,
   *             and typed-confirm here so it is never a stray click.
   *
   * "Unreachable" is rendered as its own state, never as "not killed". The
   * operator uses this to free their trading session; an ambiguous answer is
   * the one failure that actually matters.
   */
  import Badge from '$lib/components/ui/Badge.svelte';
  import { api, ApiError } from '$api/client';

  interface RithmicStatus {
    reachable: boolean;
    reason?: string;
    connected?: boolean;
    killed?: boolean;
    subscribed_instruments?: number;
    kill_detail?: string;
  }

  let status = $state<RithmicStatus | null>(null);
  let loading = $state(true);
  let submitting = $state(false);
  let result = $state<{ ok: boolean; text: string } | null>(null);
  let confirmText = $state('');

  const RESUME_CONFIRM = 'RECONNECT';

  /**
   * The same honesty the cockpit applies: a request that fails is
   * "unconfirmed", not "definitely didn't happen" — the sentinel write can land
   * after the client gives up. Always re-read rather than assume.
   */
  const UNVERIFIED = ' — outcome unverified; check the badge above before acting.';

  async function refresh(): Promise<void> {
    try {
      status = await api.get<RithmicStatus>('/api/rithmic/status');
    } catch {
      status = { reachable: false, reason: 'status request failed' };
    } finally {
      loading = false;
    }
  }

  async function act(action: 'kill' | 'resume'): Promise<void> {
    if (submitting) return;
    if (action === 'resume' && confirmText !== RESUME_CONFIRM) return;
    submitting = true;
    result = null;
    try {
      const r = await api.post<{ detail?: string; error?: string }>(`/api/rithmic/${action}`);
      result = { ok: true, text: r.detail ?? 'done' };
      confirmText = '';
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? `${e.status}: ${typeof e.body === 'string' ? e.body : e.statusText}`
          : String(e);
      result = { ok: false, text: `${msg}${UNVERIFIED}` };
    } finally {
      submitting = false;
      // Re-verify on EVERY outcome, not just success — a failed call may still
      // have landed, and the next decision must be made against a fresh read.
      await refresh();
    }
  }

  $effect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  });

  let killed = $derived(status?.killed === true);
  let reachable = $derived(status?.reachable === true);
</script>

<div class="sess">
  <div class="sess-head">
    <span class="sess-title">Session</span>
    {#if loading}
      <Badge variant="default">checking…</Badge>
    {:else if !reachable}
      <Badge variant="amber">unreachable</Badge>
    {:else if killed}
      <Badge variant="amber">released</Badge>
    {:else if status?.connected}
      <Badge variant="green">streaming · {status.subscribed_instruments ?? 0}</Badge>
    {:else}
      <Badge variant="default">idle</Badge>
    {/if}
  </div>

  <p class="sess-why">
    Rithmic allows <strong>one session per credential</strong>. Release it before signing in
    on R|Trader Pro, then reconnect when you're done.
  </p>

  {#if !reachable && !loading}
    <p class="sess-note">{status?.reason ?? 'connector unreachable'}</p>
  {:else if killed}
    <p class="sess-note">
      Released — the credential is free for another login.
      {#if status?.kill_detail}<br /><code>{status.kill_detail}</code>{/if}
    </p>
  {/if}

  <div class="sess-actions">
    {#if killed}
      <label class="sess-confirm">
        <span>Type <code>{RESUME_CONFIRM}</code> to take the session back</span>
        <input
          type="text"
          bind:value={confirmText}
          placeholder={RESUME_CONFIRM}
          disabled={submitting || !reachable}
          spellcheck="false"
          autocomplete="off"
        />
      </label>
      <button
        class="btn-danger"
        disabled={submitting || !reachable || confirmText !== RESUME_CONFIRM}
        onclick={() => act('resume')}
      >
        {submitting ? 'Reconnecting…' : 'Reconnect'}
      </button>
      <span class="sess-hint">Revokes any other Rithmic login, including your phone.</span>
    {:else}
      <button class="btn-warn" disabled={submitting || !reachable} onclick={() => act('kill')}>
        {submitting ? 'Releasing…' : 'Release session'}
      </button>
      <span class="sess-hint">Stops the feed. Candles resume on reconnect.</span>
    {/if}
  </div>

  {#if result}
    <p class="sess-result" class:bad={!result.ok}>{result.text}</p>
  {/if}
</div>

<style>
  .sess {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    padding: 0.75rem;
    border: 1px solid var(--border, #333);
    border-radius: 6px;
    margin-bottom: 0.9rem;
  }
  .sess-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .sess-title {
    font-size: 0.78rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-dim, #999);
  }
  .sess-why,
  .sess-note,
  .sess-hint {
    margin: 0;
    font-size: 0.76rem;
    color: var(--fg-dim, #999);
    line-height: 1.4;
  }
  .sess-note code {
    font-size: 0.7rem;
    white-space: pre-wrap;
  }
  .sess-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .sess-confirm {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.72rem;
    color: var(--fg-dim, #999);
  }
  .sess-confirm input {
    padding: 0.28rem 0.45rem;
    font-family: inherit;
    font-size: 0.78rem;
    background: var(--bg-input, #111);
    color: var(--fg, #ddd);
    border: 1px solid var(--border, #333);
    border-radius: 4px;
  }
  .btn-warn,
  .btn-danger {
    padding: 0.35rem 0.75rem;
    font: inherit;
    font-size: 0.8rem;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn-warn {
    background: var(--amber, #d79921);
    color: #111;
  }
  .btn-danger {
    background: var(--red, #cc241d);
    color: #fff;
  }
  .btn-warn:disabled,
  .btn-danger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .sess-result {
    margin: 0;
    font-size: 0.76rem;
    color: var(--green, #98971a);
  }
  .sess-result.bad {
    color: var(--red, #cc241d);
  }
</style>
