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

  P1 — ANNOTATIONS. A Prometheus rule carries the operator's whole recovery
  procedure in its `annotations`: `summary` (what is wrong, in words),
  `description` (the failure shape), `runbook` (the steps). Those used to stop
  at Prometheus. Here `summary` is the row TITLE, the alertname is demoted to a
  correlation id beside it (never dropped — it is what /monitoring, Alertmanager
  and the cockpit filter key off), and description/runbook sit behind a
  per-incident expander. At 3am the row reads "ALL real-money venues stale — bot
  is blind" instead of "BotAllVenuesStale bot_id=… 15m".
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

  // ── Annotations ────────────────────────────────────────────────────────
  // `summary` is promoted to the title; `description` + `runbook` get dedicated
  // slots in the expander. Everything else a rule author writes is rendered
  // generically rather than dropped — the whole point of P1 is that the
  // operator's writing reaches the operator.
  const SLOTTED = new Set(['summary', 'description', 'runbook']);

  function ann(a: InboxAlert): Record<string, string> {
    return a.annotations ?? {};
  }
  /** Row title: the human sentence when the rule wrote one, else the id. */
  function title(a: InboxAlert): string {
    return ann(a).summary || (a.labels.alertname ?? 'alert');
  }
  /** Any annotation beyond `summary` → there is something to expand. */
  function extraAnnotations(a: InboxAlert): [string, string][] {
    return Object.entries(ann(a)).filter(([k]) => !SLOTTED.has(k));
  }
  function hasDetail(a: InboxAlert): boolean {
    const x = ann(a);
    return !!x.description || !!x.runbook || extraAnnotations(a).length > 0;
  }

  // Per-incident UI state (expanded note editor + detail expander + in-flight
  // guard + error). `detail` is independent of `expanded` so opening a runbook
  // never arms the note/ack editor.
  let expanded = $state<Record<string, boolean>>({});
  let detail = $state<Record<string, boolean>>({});
  let notes = $state<Record<string, string>>({});
  let busy = $state<Record<string, boolean>>({});
  let errors = $state<Record<string, string>>({});

  function toggle(key: string) {
    expanded = { ...expanded, [key]: !expanded[key] };
  }

  function toggleDetail(key: string) {
    detail = { ...detail, [key]: !detail[key] };
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
          {@const an = ann(a)}
          <div class="alert-row">
            <div class="alert-head">
              <Badge variant={severityVariant(a.labels.severity)}>
                {a.labels.severity ?? '—'}
              </Badge>
              <span class="alert-title">{title(a)}</span>
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

            <!-- Correlation line: the alertname is the id Prometheus,
                 Alertmanager and the cockpit filter all key off, so it stays
                 visible even when a summary took the title slot. -->
            <div class="alert-meta">
              <span class="alert-name">{a.labels.alertname ?? 'alert'}</span>
              {#if a.labels.symbol}<span class="alert-sym dim">{a.labels.symbol}</span>{/if}
              {#if a.labels.instance}<span class="alert-instance dim">{a.labels.instance}</span>{/if}
              {#if a.labels.bot_id}<span class="alert-bot dim">{a.labels.bot_id}</span>{/if}
              {#if hasDetail(a)}
                <button
                  class="detail-toggle"
                  onclick={() => toggleDetail(a.key)}
                  aria-expanded={detail[a.key] ?? false}
                >{detail[a.key] ? '▾ hide' : an.runbook ? '▸ what to do' : '▸ details'}</button>
              {/if}
            </div>

            {#if detail[a.key]}
              <div class="alert-detail">
                {#if an.description}
                  <p class="detail-desc">{an.description}</p>
                {/if}
                {#if an.runbook}
                  <div class="detail-block">
                    <span class="detail-label">Runbook</span>
                    <p class="detail-runbook">{an.runbook}</p>
                  </div>
                {/if}
                {#each extraAnnotations(a) as [k, v] (k)}
                  <div class="detail-block">
                    <span class="detail-label">{k}</span>
                    <p class="detail-extra">{v}</p>
                  </div>
                {/each}
              </div>
            {/if}

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
            <!-- Same sentence the unacked row showed, so the operator can
                 recognise what they acked without decoding the alertname. -->
            {#if ann(a).summary}<span class="acked-summary dim">{ann(a).summary}</span>{/if}
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
  /* The human sentence from `annotations.summary` — the thing the operator
     actually reads first. Wraps rather than truncates: a half-sentence at 3am
     is worse than two lines. */
  .alert-title {
    font-weight: 600;
    font-size: 12px;
    color: var(--t1);
    line-height: 1.35;
    min-width: 0;
    flex: 1 1 auto;
  }
  .alert-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 3px;
  }
  .alert-name {
    font-size: 10px;
    font-weight: 600;
    color: var(--t3);
    letter-spacing: 0.02em;
  }
  .alert-sym, .alert-instance, .alert-age, .alert-bot { font-size: 10px; }
  .dim { color: var(--t3); }
  .alert-actions { margin-left: auto; display: flex; gap: 6px; }

  /* Description / runbook expander. Deliberately on the META row, left-aligned:
     it must NOT join the right-hand action cluster, because reading a runbook
     is the safe act and Ack is the irreversible one — they should never be
     neighbours a thumb can confuse. */
  .detail-toggle {
    font-family: inherit;
    font-size: 10px;
    padding: 1px 6px;
    background: transparent;
    color: var(--cyan);
    border: 1px solid transparent;
    border-radius: var(--r);
    cursor: pointer;
    line-height: 1.4;
  }
  .detail-toggle:hover { border-color: var(--b1); }

  .alert-detail {
    margin-top: 6px;
    padding: 6px 8px;
    border-left: 2px solid var(--b1);
    background: var(--bg0, var(--bg1));
    border-radius: 0 var(--r) var(--r) 0;
  }
  .detail-desc, .detail-runbook, .detail-extra {
    margin: 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--t2, var(--t1));
    /* Rule authors use both YAML folded (`>`, newlines become spaces) and
       literal (`|`, newlines kept) scalars. `pre-line` honours the breaks that
       survived and collapses the rest — a literal-block runbook keeps its
       steps on their own lines instead of reflowing into one blob. */
    white-space: pre-line;
  }
  .detail-block { margin-top: 6px; }
  .detail-label {
    display: block;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--t3);
    margin-bottom: 2px;
  }

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

  /* ── A-2: coarse-pointer touch targets ────────────────────────────────────
     `.ack-btn` / `.note-toggle` computed to ~20px tall under a thumb — far
     under the 44px floor, on an armed-path page.

     THE FLOOR AND THE GAP SHIP TOGETHER, ALWAYS. `ack()` has no confirm and no
     undo: on success the row leaves the actionable list for the acked history
     and stops counting toward the StatusBar chip. Doubling the button's height
     while leaving it 6px from `+ note` (and 6px from the next incident's Ack)
     would make an accidental silence MORE likely, not less — a bigger target
     that is still crowded is a worse target. So the same block that raises the
     height also triples the intra-cluster gap and doubles the row gap, and
     `.note-toggle` (the harmless one) is the button nearer the page edge.
     If a later change shrinks these gaps, restore them or drop the floor.
     Pinned by tests/e2e/alerts.spec.ts. */
  @media (pointer: coarse) {
    .alert-list { gap: 12px; }
    .alert-actions { gap: 18px; }
    .ack-btn, .note-toggle {
      min-height: 44px;
      min-width: 64px;
      font-size: 12px;
      padding: 0 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    /* The runbook expander gets the same floor. It is the SAFE control, so the
       point of enlarging it is reachability — but MEASURED, it does not "grow
       downward away from Ack" as first assumed: it sits in the meta row
       directly above the action row, and at 44px its bottom edge lands 3px
       from Ack. Ack has no confirm and no undo, so 3px is a mis-tap that
       silences an armed-path alert.
       The floor therefore ships WITH explicit separation below. */
    .detail-toggle { min-height: 44px; padding: 4px 10px; }
    /* The expander renders BELOW the action row (.alert-actions is emitted
       first), so the separation has to go on the toggle itself. Guarded by a
       2D separation spec that measures every sibling in the card rather than a
       named pair, so the next control added here is covered automatically. */
    .detail-toggle { margin-top: 14px; }

  }

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
  .acked-summary { flex: 1 1 200px; min-width: 0; }
  .acked-by { font-size: 10px; }
  .acked-note { font-style: italic; color: var(--t3); }
</style>
