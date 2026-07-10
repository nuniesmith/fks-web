<!--
  /edges — the EDGE PORTFOLIO page.

  Table of registered edges (from the spawner's db-gated GET /edges via the
  /api/spawner/* passthrough): name, type + status badges, asset-scope chips
  (empty scope = "all assets"), and a latest-run summary (status + finish
  time + the single best headline number). Rows expand in place to the
  EdgeDetail view (run history, RESULTS table, Run-backtest flow). Upsert
  (New / Edit) is a deliberately simple JSON editor v1 — the primary flows
  are LIST, RUN, RESULTS.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Panel from '$components/ui/Panel.svelte';
  import Badge from '$components/ui/Badge.svelte';
  import Skeleton from '$components/ui/Skeleton.svelte';
  import EmptyState from '$components/ui/EmptyState.svelte';
  import Modal from '$components/ui/Modal.svelte';
  import EdgeDetail from '$components/edges/EdgeDetail.svelte';
  import { spawner } from '$api/spawner';
  import { ApiError } from '$api/client';
  import { fmtDateTime } from '$lib/utils/format';
  import {
    edgeStatusVariant,
    edgeTypeVariant,
    runStatusVariant,
    latestRun,
    pickHeadline,
  } from '$lib/utils/edgeResults';
  import type { Edge, EdgeBacktestRun, UpsertEdgeRequest } from '$lib/types/spawner';

  // ─── Edge list ──────────────────────────────────────────────────────────

  let edges = $state<Edge[]>([]);
  let dbEnabled = $state(true);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  /**
   * edge_id → its latest backtest run. Missing key = still loading; null =
   * fetched, no runs. Filled by a per-edge fan-out after the list loads and
   * kept current by each expanded EdgeDetail's poll (onRunsChange).
   */
  let latestRuns = $state<Record<string, EdgeBacktestRun | null>>({});

  async function load() {
    loading = true;
    loadError = null;
    try {
      const res = await spawner.edges();
      edges = res.edges ?? [];
      dbEnabled = res.db_enabled !== false;
      void loadLatestRuns(edges);
    } catch (e) {
      loadError =
        e instanceof ApiError ? `${e.status} ${e.statusText}` : String(e);
    } finally {
      loading = false;
    }
  }

  async function loadLatestRuns(list: Edge[]) {
    await Promise.all(
      list.map(async (edge) => {
        try {
          const res = await spawner.edgeBacktests(edge.edge_id, 5);
          latestRuns[edge.edge_id] = latestRun(res.runs ?? []);
        } catch {
          latestRuns[edge.edge_id] = null;
        }
      }),
    );
  }

  onMount(load);

  // ─── Expand-in-place detail ─────────────────────────────────────────────

  let expandedId = $state<string | null>(null);
  /** Edge whose detail should open with the params editor already visible. */
  let runnerFor = $state<string | null>(null);

  function toggleDetail(id: string) {
    runnerFor = null;
    expandedId = expandedId === id ? null : id;
  }

  function openRunner(edge: Edge) {
    if (!edge.backtest_image) return;
    runnerFor = edge.edge_id;
    expandedId = edge.edge_id;
  }

  function handleRunsChange(edgeId: string, runs: EdgeBacktestRun[]) {
    latestRuns[edgeId] = latestRun(runs);
  }

  // ─── Upsert editor (New / Edit — simple JSON form, v1) ─────────────────

  let editorOpen = $state(false);
  let editorTitle = $state('New edge');
  let editorText = $state('');
  let editorError = $state<string | null>(null);
  let editorSaving = $state(false);

  const EDGE_TEMPLATE = {
    edge_id: '',
    display_name: '',
    edge_type: 'rule',
    asset_scope: [] as string[],
    status: 'research',
    backtest_image: null as string | null,
    validation_record: null as string | null,
    notes: null as string | null,
    active: true,
  };

  function openNewEdge() {
    editorTitle = 'New edge';
    editorText = JSON.stringify(EDGE_TEMPLATE, null, 2);
    editorError = null;
    editorOpen = true;
  }

  function openEditEdge(edge: Edge) {
    editorTitle = `Edit ${edge.edge_id}`;
    editorText = JSON.stringify(
      {
        edge_id: edge.edge_id,
        display_name: edge.display_name,
        edge_type: edge.edge_type,
        asset_scope: edge.asset_scope,
        status: edge.status,
        backtest_image: edge.backtest_image,
        validation_record: edge.validation_record,
        notes: edge.notes,
        active: edge.active,
      },
      null,
      2,
    );
    editorError = null;
    editorOpen = true;
  }

  async function saveEdge() {
    if (editorSaving) return;
    let body: UpsertEdgeRequest;
    try {
      const parsed: unknown = JSON.parse(editorText);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('must be a JSON object');
      }
      const p = parsed as Record<string, unknown>;
      if (typeof p.edge_id !== 'string' || !p.edge_id.trim()) {
        throw new Error('edge_id (non-empty string) is required');
      }
      if (typeof p.display_name !== 'string' || !p.display_name.trim()) {
        throw new Error('display_name (non-empty string) is required');
      }
      body = p as unknown as UpsertEdgeRequest;
    } catch (e) {
      editorError = `Invalid edge JSON: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    editorSaving = true;
    editorError = null;
    try {
      await spawner.upsertEdge(body);
      editorOpen = false;
      await load();
    } catch (e) {
      editorError =
        e instanceof ApiError
          ? `${e.status} ${e.statusText}${e.body ? ` — ${e.body}` : ''}`
          : String(e);
    } finally {
      editorSaving = false;
    }
  }
</script>

<svelte:head>
  <title>Edges — FKS Terminal</title>
</svelte:head>

<div class="page">
  <Panel title="Edge portfolio" fill>
    {#snippet header()}
      <button type="button" class="btn" onclick={load} disabled={loading} title="Reload the edge list">
        ↻ Refresh
      </button>
      <button type="button" class="btn new" onclick={openNewEdge} title="Register or update an edge (UPSERT)">
        ＋ New edge
      </button>
    {/snippet}

    {#if loading && edges.length === 0}
      <div class="skel-col">
        {#each Array(4) as _unused, i (i)}
          <Skeleton height="36px" />
        {/each}
      </div>
    {:else if loadError}
      <EmptyState
        icon="⚠️"
        title="Couldn't load the edge portfolio"
        variant="error"
        hint={`GET /api/spawner/edges failed (${loadError}). Check that the spawner is reachable.`}
      />
    {:else if !dbEnabled}
      <EmptyState
        icon="🗄️"
        title="Edge registry unavailable"
        hint="The spawner has no database configured — set SPAWNER_DATABASE_URL to enable the edge registry."
      />
    {:else if edges.length === 0}
      <EmptyState icon="∅" title="No edges registered yet">
        {#snippet action()}
          <button type="button" class="btn new" onclick={openNewEdge}>＋ New edge</button>
        {/snippet}
      </EmptyState>
    {:else}
      <div class="edge-table" role="table" aria-label="Registered edges">
        <div class="edge-head" role="row">
          <span role="columnheader">Edge</span>
          <span role="columnheader">Type</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Assets</span>
          <span role="columnheader">Latest run</span>
          <span role="columnheader" class="r">Actions</span>
        </div>
        {#each edges as edge (edge.edge_id)}
          <div class="edge-block" class:inactive={!edge.active}>
            <div class="edge-row" role="row">
              <span class="cell name" role="cell">
                <span class="display-name">{edge.display_name}</span>
                <span class="edge-id mono dim">{edge.edge_id}</span>
                {#if !edge.active}
                  <Badge variant="default">inactive</Badge>
                {/if}
              </span>
              <span class="cell" role="cell">
                <Badge variant={edgeTypeVariant(edge.edge_type)}>{edge.edge_type}</Badge>
              </span>
              <span class="cell" role="cell">
                <Badge variant={edgeStatusVariant(edge.status)}>{edge.status}</Badge>
              </span>
              <span class="cell chips" role="cell">
                {#if edge.asset_scope.length === 0}
                  <span class="chip all" title="Empty asset scope — the edge applies to all assets">all assets</span>
                {:else}
                  {#each edge.asset_scope as sym (sym)}
                    <span class="chip mono">{sym}</span>
                  {/each}
                {/if}
              </span>
              <span class="cell latest" role="cell">
                {#if !(edge.edge_id in latestRuns)}
                  <span class="dim">…</span>
                {:else}
                  {@const run = latestRuns[edge.edge_id]}
                  {#if !run}
                    <span class="dim">no runs</span>
                  {:else}
                    <Badge variant={runStatusVariant(run.status)}>{run.status}</Badge>
                    <span class="run-when dim" title={run.finished_at ? 'Finished' : 'Started'}>
                      {fmtDateTime(run.finished_at ?? run.started_at)}
                    </span>
                    {#if run.status === 'completed'}
                      {@const headline = pickHeadline(run.results)}
                      {#if headline}
                        <span class="headline mono" title="Best asset in the latest completed run">
                          {headline.symbol}
                          {headline.text}
                        </span>
                      {/if}
                    {/if}
                  {/if}
                {/if}
              </span>
              <span class="cell actions r" role="cell">
                <span
                  title={edge.backtest_image
                    ? `Run a backtest (${edge.backtest_image})`
                    : 'No backtest image registered for this edge — set backtest_image (Edit) to enable runs'}
                >
                  <button
                    type="button"
                    class="btn run"
                    disabled={!edge.backtest_image}
                    onclick={() => openRunner(edge)}
                  >
                    ▶ Run
                  </button>
                </span>
                <button type="button" class="btn" onclick={() => openEditEdge(edge)} title="Edit this edge (UPSERT)">
                  ✎ Edit
                </button>
                <button
                  type="button"
                  class="btn"
                  onclick={() => toggleDetail(edge.edge_id)}
                  aria-expanded={expandedId === edge.edge_id}
                >
                  {expandedId === edge.edge_id ? '▴ Close' : '▾ Details'}
                </button>
              </span>
            </div>
            {#if expandedId === edge.edge_id}
              <EdgeDetail
                {edge}
                openRunner={runnerFor === edge.edge_id}
                onRunsChange={(runs: EdgeBacktestRun[]) => handleRunsChange(edge.edge_id, runs)}
              />
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </Panel>
</div>

<Modal open={editorOpen} title={editorTitle} onclose={() => (editorOpen = false)}>
  <div class="editor">
    <p class="editor-hint">
      UPSERT (POST /api/spawner/edges), keyed by <code>edge_id</code>. JSON form v1 —
      <code>edge_id</code> + <code>display_name</code> required;
      <code>edge_type</code> is adaptive|rule; <code>status</code> is
      research|paper|live|retired; empty <code>asset_scope</code> = all assets.
    </p>
    <textarea class="editor-json" bind:value={editorText} rows="14" spellcheck="false"></textarea>
    {#if editorError}
      <p class="editor-err">{editorError}</p>
    {/if}
  </div>
  {#snippet actions()}
    <button type="button" class="btn" onclick={() => (editorOpen = false)} disabled={editorSaving}>
      Cancel
    </button>
    <button type="button" class="btn new" onclick={saveEdge} disabled={editorSaving}>
      {editorSaving ? 'Saving…' : 'Save edge'}
    </button>
  {/snippet}
</Modal>

<style>
  .page {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 8px;
    gap: 8px;
    overflow: auto;
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
    white-space: nowrap;
  }
  .btn:hover:not(:disabled) {
    border-color: var(--cyan, #22d3ee);
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .btn.new {
    border-color: var(--accent, #5b6ef5);
    color: var(--t1);
  }
  .btn.run {
    border-color: var(--green-brd, #16c78444);
    color: var(--green, #16c784);
  }
  .skel-col {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* ── Portfolio table ── */
  .edge-table {
    display: flex;
    flex-direction: column;
  }
  .edge-head {
    display: grid;
    grid-template-columns: 2fr 90px 90px 1.6fr 2.2fr 230px;
    gap: 8px;
    padding: 4px 8px;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--t3);
    font-weight: 600;
    border-bottom: 1px solid var(--b2);
  }
  .edge-block {
    border-bottom: 1px solid var(--b1);
  }
  .edge-block.inactive .edge-row {
    opacity: 0.55;
  }
  .edge-row {
    display: grid;
    grid-template-columns: 2fr 90px 90px 1.6fr 2.2fr 230px;
    gap: 8px;
    padding: 7px 8px;
    align-items: center;
    font-size: 11px;
  }
  .edge-row:hover {
    background: var(--bg2);
  }
  .cell {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .cell.name {
    flex-wrap: wrap;
  }
  .r {
    justify-content: flex-end;
    text-align: right;
  }
  .display-name {
    font-weight: 600;
    color: var(--t1);
  }
  .edge-id {
    font-size: 10px;
  }
  .mono {
    font-family: var(--mono, 'SF Mono', 'Fira Code', monospace);
  }
  .dim {
    color: var(--t3);
  }
  .chips {
    flex-wrap: wrap;
    row-gap: 3px;
  }
  .chip {
    font-size: 9px;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--bg3);
    border: 1px solid var(--b2);
    color: var(--t2);
    white-space: nowrap;
  }
  .chip.all {
    color: var(--cyan, #22d3ee);
    border-color: var(--cyan-brd, #22d3ee44);
    font-style: italic;
  }
  .latest {
    flex-wrap: wrap;
    row-gap: 3px;
  }
  .run-when {
    font-size: 10px;
    white-space: nowrap;
  }
  .headline {
    font-size: 10px;
    font-weight: 700;
    color: var(--t1);
    white-space: nowrap;
  }
  .actions {
    gap: 4px;
  }

  /* ── Upsert editor modal ── */
  .editor {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .editor-hint {
    margin: 0;
    font-size: 10px;
    color: var(--t3);
    line-height: 1.5;
  }
  .editor-hint code {
    color: var(--cyan, #22d3ee);
  }
  .editor-json {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg2);
    border: 1px solid var(--b2);
    border-radius: var(--r);
    color: var(--t1);
    font-family: var(--mono, 'SF Mono', 'Fira Code', monospace);
    font-size: 11px;
    padding: 8px;
    resize: vertical;
  }
  .editor-err {
    margin: 0;
    font-size: 11px;
    color: var(--red, #ea3943);
  }
</style>
