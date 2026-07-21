<!--
  AlertInbox — the alert-ack inbox surface (M3 Phase B). Renders the shared
  `/api/alerts/inbox` payload: firing alerts get an Ack button (+ a one-line
  note on expand); acked incidents collapse into a dimmed, still-visible
  "acked by {user} {ago}" history section (audit, never deleted).

  Degraded states are honest (webui plan 04 Phase B):
    - prom_available:false → error EmptyState (never an empty-green inbox);
    - configured:false     → alerts render READ-ONLY + an amber "ack store
      unavailable" line (an ack-store outage must never hide a live alert).

  Reused on /monitoring (full feed) and /cockpit (filtered to armed alertnames)
  via the optional `filter` predicate.
-->
<script lang="ts">
  import { api, ApiError } from '$api/client';
  import Badge from '$components/ui/Badge.svelte';
  import Skeleton from '$components/ui/Skeleton.svelte';
  import EmptyState from '$components/ui/EmptyState.svelte';
  import type { AlertInbox, InboxAlert } from '$lib/types/alertInbox';

  interface Props {
    inbox: AlertInbox | null;
    loading?: boolean;
    /** Restrict which alerts render (cockpit armed-path panel). */
    filter?: (a: InboxAlert) => boolean;
    /** Called after a successful ack so the parent can refresh the shared poll. */
    onacked?: () => void;
    /** Hide the acked-history section (compact cockpit panel). */
    hideHistory?: boolean;
  }
  let { inbox, loading = false, filter, onacked, hideHistory = false }: Props = $props();

  const shown = $derived((inbox?.alerts ?? []).filter((a) => (filter ? filter(a) : true)));
  const unacked = $derived(shown.filter((a) => !a.acked));
  const acked = $derived(shown.filter((a) => a.acked));

  function severityVariant(sev: string | undefined): 'red' | 'amber' | 'cyan' | 'default' {
    switch ((sev ?? '').toLowerCase()) {
      case 'critical': return 'red';
      case 'warning':  return 'amber';
      case 'info':     return 'cyan';
      default:         return 'default';
    }
  }

  // Per-incident UI state (expanded note editor + in-flight guard + error).
  let expanded = $state<Record<string, boolean>>({});
  let notes = $state<Record<string, string>>({});
  let busy = $state<Record<string, boolean>>({});
  let errors = $state<Record<string, string>>({});

  function toggle(key: string) {
    expanded = { ...expanded, [key]: !expanded[key] };
  }

  async function ack(a: InboxAlert) {
    if (busy[a.key]) return;
    busy = { ...busy, [a.key]: true };
    errors = { ...errors, [a.key]: '' };
    try {
      await api.post('/api/alerts/ack', {
        key: a.key,
        labels: a.labels,
        activeAt: a.activeAt,
        note: notes[a.key]?.trim() || undefined,
      });
      expanded = { ...expanded, [a.key]: false };
      onacked?.(); // refresh the shared poll → the row moves to history
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? `${e.status}: ${typeof e.body === 'string' ? e.body : e.statusText}`
          : String(e);
      errors = { ...errors, [a.key]: `ack failed — ${msg}` };
    } finally {
      busy = { ...busy, [a.key]: false };
    }
  }
</script>

{#if loading && !inbox}
  <Skeleton lines={3} height="14px" />
{:else if inbox && !inbox.prom_available}
  <EmptyState
    icon="🛰️"
    variant="error"
    title="Prometheus unreachable"
    hint="The alert feed could not be read — this is an outage, not an all-clear. Alerts cannot be shown or acked until Prometheus responds."
  />
{:else if inbox}
  {#if !inbox.configured}
    <p class="ack-store-warn">
      ⚠ Ack store unavailable — alerts are read-only (they cannot be acknowledged
      until <code>webui_alert_acks</code> is reachable). Live alerts are NOT hidden.
    </p>
  {/if}

  {#if shown.length === 0}
    <span class="ok-msg">✓ No active alerts</span>
  {:else}
    <!-- Unacked (actionable) -->
    {#if unacked.length > 0}
      <div class="alert-list">
        {#each unacked as a (a.key)}
          <div class="alert-row">
            <div class="alert-head">
              <Badge variant={severityVariant(a.labels.severity)}>
                {a.labels.severity ?? '—'}
              </Badge>
              <span class="alert-name">{a.labels.alertname ?? 'alert'}</span>
              {#if a.labels.symbol}<span class="alert-sym dim">{a.labels.symbol}</span>{/if}
              {#if a.labels.instance}<span class="alert-instance dim">{a.labels.instance}</span>{/if}
              <span class="alert-age dim">{a.age_str}</span>
              {#if inbox.configured}
                <div class="alert-actions">
                  <button
                    class="note-toggle"
                    onclick={() => toggle(a.key)}
                    title="Add a note"
                    aria-expanded={expanded[a.key] ?? false}
                  >{expanded[a.key] ? '−' : '+ note'}</button>
                  <button
                    class="ack-btn"
                    onclick={() => ack(a)}
                    disabled={busy[a.key]}
                  >{busy[a.key] ? 'acking…' : 'Ack'}</button>
                </div>
              {/if}
            </div>
            {#if inbox.configured && expanded[a.key]}
              <input
                class="note-input"
                type="text"
                placeholder="optional note (why is this ok?)"
                maxlength="500"
                bind:value={notes[a.key]}
                onkeydown={(e) => { if (e.key === 'Enter') ack(a); }}
              />
            {/if}
            {#if errors[a.key]}
              <p class="ack-error">{errors[a.key]}</p>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <!-- Acked history (dimmed, still visible — audit, not deleted) -->
    {#if !hideHistory && acked.length > 0}
      <div class="acked-section">
        <div class="acked-head">Acknowledged ({acked.length})</div>
        {#each acked as a (a.key)}
          <div class="acked-row">
            <span class="acked-name">{a.labels.alertname ?? 'alert'}</span>
            {#if a.labels.symbol}<span class="dim">{a.labels.symbol}</span>{/if}
            <span class="acked-by dim">acked by {a.acked?.by} · {a.age_str} old</span>
            {#if a.acked?.note}<span class="acked-note">“{a.acked.note}”</span>{/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
{/if}

<style>
  .ok-msg { color: var(--green); font-size: 12px; }
  .ack-store-warn {
    margin: 0 0 8px;
    padding: 6px 8px;
    font-size: 11px;
    color: var(--amber);
    background: var(--amber-dim, rgba(200, 150, 0, 0.08));
    border: 1px solid var(--amber-brd, rgba(200, 150, 0, 0.3));
    border-radius: var(--r);
  }
  .ack-store-warn code { font-size: 10px; }

  .alert-list { display: flex; flex-direction: column; gap: 6px; }
  .alert-row {
    padding: 6px 8px;
    border: 1px solid var(--b1);
    border-radius: var(--r);
    background: var(--bg1);
  }
  .alert-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .alert-name { font-weight: 600; font-size: 12px; color: var(--t1); }
  .alert-sym, .alert-instance, .alert-age { font-size: 10px; }
  .dim { color: var(--t3); }
  .alert-actions { margin-left: auto; display: flex; gap: 6px; }

  .ack-btn, .note-toggle {
    font-family: inherit;
    font-size: 10px;
    padding: 2px 8px;
    border-radius: var(--r);
    cursor: pointer;
    line-height: 1.4;
  }
  .ack-btn {
    background: var(--accent, var(--cyan));
    color: var(--bg0, #000);
    border: 1px solid transparent;
    font-weight: 600;
  }
  .ack-btn:hover:not(:disabled) { filter: brightness(1.1); }
  .ack-btn:disabled { opacity: 0.5; cursor: default; }
  .note-toggle {
    background: transparent;
    color: var(--t3);
    border: 1px solid var(--b1);
  }
  .note-toggle:hover { color: var(--t1); border-color: var(--t3); }

  .note-input {
    margin-top: 6px;
    width: 100%;
    font-family: inherit;
    font-size: 12px;
    padding: 4px 6px;
    background: var(--bg0, var(--bg1));
    border: 1px solid var(--b1);
    border-radius: var(--r);
    color: var(--t1);
  }
  .ack-error { margin: 6px 0 0; font-size: 10px; color: var(--red); }

  .acked-section { margin-top: 12px; border-top: 1px dashed var(--b1); padding-top: 8px; }
  .acked-head {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--t3);
    margin-bottom: 6px;
  }
  .acked-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
    padding: 3px 0;
    font-size: 11px;
    opacity: 0.6;
  }
  .acked-name { font-weight: 600; color: var(--t2, var(--t1)); }
  .acked-by { font-size: 10px; }
  .acked-note { font-style: italic; color: var(--t3); }
</style>
