<!--
  EdgeDetail — one edge expanded in place on /edges.

  Backtest-run history (status / started / finished / params) with a RESULTS
  view for the selected run (EdgeResultsView), plus the "Run backtest" flow:
  a small JSON params editor prefilled with {"days":60,"symbols":[...scope]}
  that POSTs /edges/:id/backtest, inserts an optimistic "running" row, and
  polls the runs list every 10s while any run is in flight (polling stops as
  soon as none are).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Badge from '$components/ui/Badge.svelte';
  import Skeleton from '$components/ui/Skeleton.svelte';
  import EmptyState from '$components/ui/EmptyState.svelte';
  import EdgeResultsView from './EdgeResultsView.svelte';
  import { createPoll } from '$stores/poll';
  import { spawner } from '$api/spawner';
  import { ApiError } from '$api/client';
  import { fmtDateTime } from '$lib/utils/format';
  import { defaultBacktestParams, runStatusVariant } from '$lib/utils/edgeResults';
  import type { Edge, EdgeBacktestRun, EdgeBacktestsResponse } from '$lib/types/spawner';

  let { edge, openRunner = false, onRunsChange } = $props<{
    edge: Edge;
    /** Parent asks the params editor to open (row-level "Run" button). */
    openRunner?: boolean;
    /** Fires with the fetched runs so the portfolio row can stay current. */
    onRunsChange?: (runs: EdgeBacktestRun[]) => void;
  }>();

  const RUNS_LIMIT = 20;
  const POLL_MS = 10_000;
  // The component is instantiated per edge (keyed {#each} + {#if} on /edges),
  // so capturing edge.edge_id once at init is intentional — the poll URL never
  // needs to track a prop change.
  // svelte-ignore state_referenced_locally
  const runsPoll = createPoll<EdgeBacktestsResponse>(
    `/api/spawner/edges/${encodeURIComponent(edge.edge_id)}/backtests?limit=${RUNS_LIMIT}`,
    POLL_MS,
  );

  // ─── Runs (fetched + optimistic) ─────────────────────────────────────
  //
  // A just-launched run appears instantly as an optimistic "running" row;
  // the poll's real row (same run_id) replaces it on the next fetch.
  let optimistic = $state<EdgeBacktestRun[]>([]);
  let fetched = $derived<EdgeBacktestRun[]>($runsPoll?.runs ?? []);
  let runs = $derived<EdgeBacktestRun[]>([
    ...optimistic.filter((o) => !fetched.some((r) => r.id === o.id)),
    ...fetched,
  ]);
  let anyRunning = $derived(runs.some((r) => r.status === 'running'));
  let dbEnabled = $derived($runsPoll?.db_enabled !== false);

  // One immediate load; the interval only runs while something is in flight.
  onMount(() => {
    runsPoll.refresh();
    return () => runsPoll.stop();
  });

  // Poll every 10s while any run is running; stop as soon as none are (the
  // cleanup runs when anyRunning flips false — and on unmount).
  $effect(() => {
    if (!anyRunning) return;
    runsPoll.start();
    return () => runsPoll.stop();
  });

  // Keep the parent's latest-run summary in sync with what we fetched.
  $effect(() => {
    if ($runsPoll) onRunsChange?.(fetched);
  });

  // ─── Selected run (for the RESULTS view) ─────────────────────────────
  let selectedRunId = $state<string | null>(null);
  let selectedRun = $derived<EdgeBacktestRun | null>(
    runs.find((r) => r.id === selectedRunId) ??
      runs.find((r) => r.status !== 'running') ??
      runs[0] ??
      null,
  );

  // ─── Run-backtest params editor ──────────────────────────────────────
  let runnerOpen = $state(false);
  // Initial prefill only, by design — the user's edits must not be clobbered
  // if the parent re-renders.
  // svelte-ignore state_referenced_locally
  let paramsText = $state(defaultBacktestParams(edge.asset_scope));
  let launching = $state(false);
  let runnerError = $state<string | null>(null);

  // Row-level "Run" button on /edges expands the detail with the editor open.
  $effect(() => {
    if (openRunner && edge.backtest_image) runnerOpen = true;
  });

  function toggleRunner() {
    runnerOpen = !runnerOpen;
    runnerError = null;
  }

  async function launchBacktest() {
    if (launching) return;
    let params: Record<string, unknown> | undefined;
    const text = paramsText.trim();
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('params must be a JSON object');
        }
        params = parsed as Record<string, unknown>;
      } catch (e) {
        runnerError = `Invalid params JSON: ${e instanceof Error ? e.message : String(e)}`;
        return;
      }
    }
    launching = true;
    runnerError = null;
    try {
      const res = await spawner.runBacktest(edge.edge_id, params);
      optimistic = [
        {
          id: res.run_id,
          edge_id: edge.edge_id,
          container_id: res.container_id ?? null,
          status: 'running',
          params: params ?? null,
          results: null,
          started_at: new Date().toISOString(),
          finished_at: null,
        },
        ...optimistic,
      ];
      selectedRunId = res.run_id;
      runnerOpen = false;
      runsPoll.refresh();
    } catch (e) {
      runnerError =
        e instanceof ApiError
          ? `${e.status} ${e.statusText}${e.body ? ` — ${e.body}` : ''}`
          : String(e);
    } finally {
      launching = false;
    }
  }

  function paramsSummary(p: Record<string, unknown> | null): string {
    if (!p || Object.keys(p).length === 0) return 'defaults';
    return JSON.stringify(p);
  }
</script>

<div class="detail">
  <div class="detail-head">
    <span class="d-title">Backtest runs</span>
    {#if anyRunning}
      <span class="polling" title="Refreshing every 10s while a run is in flight">polling…</span>
    {/if}
    <div class="d-actions">
      <button
        type="button"
        class="btn"
        onclick={() => runsPoll.refresh()}
        title="Reload the run list"
        aria-label="Refresh runs">↻</button
      >
      <span
        title={edge.backtest_image
          ? `Runs ${edge.backtest_image}`
          : 'No backtest image registered for this edge — set backtest_image (Edit) to enable runs'}
      >
        <button
          type="button"
          class="btn run"
          disabled={!edge.backtest_image}
          onclick={toggleRunner}
        >
          ▶ Run backtest
        </button>
      </span>
    </div>
  </div>

  {#if runnerOpen}
    <form
      class="runner"
      onsubmit={(e: SubmitEvent) => {
        e.preventDefault();
        launchBacktest();
      }}
    >
      <label class="runner-lbl" for="params-{edge.edge_id}">
        Params (JSON) — sent to <code>{edge.backtest_image}</code>
      </label>
      <textarea
        id="params-{edge.edge_id}"
        class="runner-params"
        bind:value={paramsText}
        rows="6"
        spellcheck="false"
      ></textarea>
      <div class="runner-actions">
        <button type="submit" class="btn run" disabled={launching}>
          {launching ? 'Launching…' : '▶ Launch'}
        </button>
        <button type="button" class="btn" onclick={toggleRunner} disabled={launching}>
          Cancel
        </button>
      </div>
      {#if runnerError}
        <p class="runner-err">{runnerError}</p>
      {/if}
    </form>
  {/if}

  {#if $runsPoll == null}
    <Skeleton lines={3} height="18px" />
  {:else if !dbEnabled}
    <EmptyState
      icon="🗄️"
      title="Backtest history unavailable"
      hint="The spawner has no database configured (SPAWNER_DATABASE_URL) — runs aren't recorded."
    />
  {:else if runs.length === 0}
    <EmptyState
      icon="∅"
      title="No backtests yet"
      hint={edge.backtest_image
        ? 'Run one with the ▶ Run backtest button above.'
        : 'This edge has no backtest_image registered, so it cannot be run yet.'}
    />
  {:else}
    <div class="run-list" role="listbox" aria-label="Backtest runs">
      {#each runs as r (r.id)}
        <button
          type="button"
          class="run-row"
          class:selected={selectedRun?.id === r.id}
          onclick={() => (selectedRunId = r.id)}
          role="option"
          aria-selected={selectedRun?.id === r.id}
        >
          <Badge variant={runStatusVariant(r.status)}>{r.status}</Badge>
          <span class="run-times mono">
            {fmtDateTime(r.started_at)}
            <span class="dim">→ {r.finished_at ? fmtDateTime(r.finished_at) : '…'}</span>
          </span>
          <span class="run-params dim" title={paramsSummary(r.params)}>
            {paramsSummary(r.params)}
          </span>
          {#if r.container_id}
            <span class="run-cid mono dim" title="Container ID">{r.container_id.slice(0, 12)}</span>
          {/if}
        </button>
      {/each}
    </div>

    {#if selectedRun}
      <div class="results-wrap">
        <span class="results-title">
          Results — run started {fmtDateTime(selectedRun.started_at)}
        </span>
        <EdgeResultsView run={selectedRun} />
      </div>
    {/if}
  {/if}
</div>

<style>
  .detail {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    background: var(--bg2);
    border-top: 1px solid var(--b1);
  }
  .detail-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .d-title {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    color: var(--t2);
  }
  .polling {
    font-size: 9px;
    color: var(--amber, #f0a500);
  }
  .d-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .btn {
    background: var(--bg3);
    border: 1px solid var(--b2);
    color: var(--t1);
    font-size: 11px;
    font-family: inherit;
    padding: 3px 10px;
    border-radius: var(--r);
    cursor: pointer;
  }
  .btn:hover:not(:disabled) {
    border-color: var(--cyan, #22d3ee);
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .btn.run {
    border-color: var(--green-brd, #16c78444);
    color: var(--green, #16c784);
  }
  .runner {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    background: var(--bg1);
    border: 1px solid var(--b2);
    border-radius: var(--r);
  }
  .runner-lbl {
    font-size: 10px;
    color: var(--t2);
  }
  .runner-lbl code {
    color: var(--cyan, #22d3ee);
  }
  .runner-params {
    background: var(--bg2);
    border: 1px solid var(--b2);
    border-radius: var(--r);
    color: var(--t1);
    font-family: var(--mono, 'SF Mono', 'Fira Code', monospace);
    font-size: 11px;
    padding: 6px 8px;
    resize: vertical;
  }
  .runner-actions {
    display: flex;
    gap: 6px;
  }
  .runner-err {
    margin: 0;
    font-size: 11px;
    color: var(--red, #ea3943);
  }
  .run-list {
    display: flex;
    flex-direction: column;
  }
  .run-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 8px;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--b1);
    border-left: 2px solid transparent;
    font-family: inherit;
    font-size: 11px;
    color: var(--t1);
    text-align: left;
    cursor: pointer;
  }
  .run-row:hover {
    background: var(--bg3);
  }
  .run-row.selected {
    background: var(--bg3);
    border-left-color: var(--accent, #5b6ef5);
  }
  .run-times {
    white-space: nowrap;
  }
  .run-params {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .run-cid {
    flex-shrink: 0;
  }
  .mono {
    font-family: var(--mono, 'SF Mono', 'Fira Code', monospace);
  }
  .dim {
    color: var(--t3);
  }
  .results-wrap {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .results-title {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    color: var(--t2);
  }
</style>
