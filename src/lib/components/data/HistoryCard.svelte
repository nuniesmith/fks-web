<!--
  One history recorder (a `history.*` template instance): Binance's public
  archive, downloaded into the lake and kept current.

  Live: the recorder's own /status through the spawner, polled every 15 s.
  It is a table of series (dataset × symbol × candle interval) with the last
  finished check's file counts, and the running check's progress
  ($lib/history). A file is on disk only once its sha256 matched the
  archive's, so "present" means verified.

  Actions: stop, start, delete (InstanceActions); the data folder is kept.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { createPoll } from '$stores/poll';
  import Badge from '$components/ui/Badge.svelte';
  import InstanceActions from '$components/data/InstanceActions.svelte';
  import { fmtBytes } from '$lib/coverage';
  import { DATASET_LABELS, cycleLine, historyRows, historyTotals, type HistoryRow } from '$lib/history';
  import type { BotStatusResponse, HistoryStatus, Instance } from '$lib/types/spawner';

  let { instance, onchanged }: { instance: Instance; onchanged?: () => void } = $props();

  // The parent re-keys this card when the container changes.
  const fixed = untrack(() => ({
    botId: instance.bot_id,
    running: instance.container?.state === 'running',
    symbols: Array.isArray(instance.params?.symbols) ? (instance.params!.symbols as string[]) : [],
  }));
  const running = fixed.running;
  const status = running
    ? createPoll<BotStatusResponse<HistoryStatus>>(`/api/spawner/bots/${encodeURIComponent(fixed.botId)}/status`, 15_000)
    : null;
  const statusError = status?.error;
  onMount(() => {
    status?.start();
    return () => status?.stop();
  });

  let now = $state(Date.now());
  onMount(() => {
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(tick);
  });

  let doc = $derived(status && $status?.ok && $status.status?.kind === 'history' ? $status.status : null);
  let rows = $derived(doc ? historyRows(doc) : []);
  let totals = $derived(historyTotals(rows));
  let errors = $derived(doc?.recent_errors?.slice(-3).reverse() ?? []);

  function range(r: HistoryRow): string {
    if (!r.first) return '—';
    return r.first === r.last ? r.first : `${r.first} → ${r.last}`;
  }

  function stateText(r: HistoryRow): string {
    if (r.state === 'failing') return `${r.errors} failing`;
    if (r.state === 'empty') return 'none published';
    if (r.state === 'waiting') return `${r.available - r.present} not yet published`;
    return 'complete';
  }
</script>

<article class="hist" data-testid="history-card" data-instance={instance.name}>
  <header class="head">
    <h3 class="name">{instance.name}</h3>
    <Badge variant={running ? 'green' : 'amber'}>{instance.container?.state ?? 'no container'}</Badge>
    <span class="meta">{instance.template ?? 'unknown template'} · {fixed.symbols.join(', ') || '—'}</span>
  </header>

  {#if running}
    {#if doc}
      <p class="line" data-testid="history-cycle">
        <span class:busy={doc.cycle.running}>{cycleLine(doc, now)}</span>
        {#if rows.length}
          <span>{totals.files.toLocaleString('en-US')} files, {fmtBytes(totals.bytes)} · from {doc.start}</span>
        {/if}
      </p>
      {#if rows.length}
        <div class="table-wrap">
          <table class="series" aria-label="Archive files held by {instance.name}">
            <thead>
              <tr>
                <th>Symbol</th><th>Data</th><th>Interval</th><th class="r">Files</th><th>Covers</th><th class="r">Size</th><th>State</th>
              </tr>
            </thead>
            <tbody>
              {#each rows as r (r.key)}
                <tr>
                  <td>{r.symbol}</td>
                  <td>{DATASET_LABELS[r.dataset] ?? r.dataset}</td>
                  <td>{r.interval ?? '—'}</td>
                  <td class="r" title="{r.expected} planned, {r.not_published} never published (before the symbol listed, say)">
                    {r.present.toLocaleString('en-US')} / {r.available.toLocaleString('en-US')}
                  </td>
                  <td class="muted">{range(r)}</td>
                  <td class="r">{fmtBytes(r.bytes)}</td>
                  <td class="state {r.state}">{stateText(r)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      {#if errors.length}
        <ul class="errors" aria-label="Recent download errors">
          {#each errors as e (`${e.file}:${e.at_ms}`)}
            <li><code>{e.file}</code> {e.error}</li>
          {/each}
        </ul>
      {/if}
    {:else}
      <p class="line" role="status">
        {#if $statusError}
          Live status unavailable — {$statusError}
        {:else if $status?.ok && $status.status}
          This instance's /status is not a history recorder's.
        {:else}
          Loading live status…
        {/if}
      </p>
    {/if}
  {:else}
    <p class="line warn">Not running. Start it to fetch what's new; the files already downloaded stay in the lake.</p>
  {/if}

  <InstanceActions {instance} {running} noun="history recorder" {onchanged} />
</article>

<style>
  .hist {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    background: var(--bg2);
    border: 1px solid var(--b2);
    border-radius: var(--r-md);
    min-width: 0;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .name {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--t1);
  }
  .meta {
    font-size: 11px;
    color: var(--t3);
  }
  .line {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    margin: 0;
    font-size: 11px;
    color: var(--t2);
  }
  .busy {
    color: var(--cyan);
  }
  .warn {
    color: var(--amber);
  }
  .table-wrap {
    overflow-x: auto;
  }
  .series {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .series th {
    text-align: left;
    font-size: 9px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--t3);
    padding: 3px 4px;
    border-bottom: 1px solid var(--b1);
    white-space: nowrap;
  }
  .series td {
    padding: 3px 4px;
    border-bottom: 1px solid var(--b1);
    color: var(--t1);
    white-space: nowrap;
  }
  .r {
    text-align: right;
  }
  .series td.muted {
    color: var(--t3);
  }
  .state.complete {
    color: var(--green);
  }
  .state.waiting,
  .state.empty {
    color: var(--t2);
  }
  .state.failing {
    color: var(--red);
    font-weight: 600;
  }
  .errors {
    margin: 0;
    padding-left: 16px;
    font-size: 10px;
    color: var(--amber);
  }
  .errors code {
    color: var(--t1);
  }
</style>
