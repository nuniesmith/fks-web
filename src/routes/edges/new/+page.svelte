<!--
  /edges/new — register a hypothesis: stage 2 of the edge process
  (EDGE_PROCESS_2026-10-26 §2), written BEFORE any search.

  The five things §2 asks for, in order: the idea with its mechanism, the
  data and the holdout split, the parameters and their ranges (few), the
  baseline it must beat, and the metric net of costs (Kraken tier 1: 40 bps
  maker, 80 taker, plus a stated slippage).

  Registering freezes it: the database (fks 024) refuses any edit, and a
  change is a new hypothesis. The registration time is the database's
  clock, and the adapter records who registered it.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { spawner } from '$api/spawner';
  import { errorLines } from '$api/errors';
  import Panel from '$components/ui/Panel.svelte';
  import { BASELINES, emptyParam, paramSpecs, symbolList, type ParamRow } from '$lib/ladder';
  import type { Edge, Instance } from '$lib/types/spawner';

  let edges = $state<Edge[] | null>(null);
  let lakeFolders = $state<string[]>([]);
  let loadError = $state('');

  // ── The form ──────────────────────────────────────────────────────────────
  let edgeId = $state('');
  let newEdgeId = $state('');
  let newEdgeName = $state('');
  let newEdgeType = $state<'rule' | 'adaptive'>('rule');
  let idea = $state('');
  let symbols = $state('');
  let dataset = $state('');
  let holdout = $state('0.25');
  let params = $state<ParamRow[]>([emptyParam()]);
  let baseline = $state<string>(BASELINES[0].value);
  let baselineOther = $state('');
  let metric = $state('net return after fees');
  let maker = $state('40');
  let taker = $state('80');
  let slippage = $state('5');

  let submitting = $state(false);
  let serverErrors = $state<string[]>([]);
  let tried = $state(false);

  const NEW_EDGE = '__new__';
  let creatingEdge = $derived(edgeId === NEW_EDGE);
  let role = $derived(($page.data.user?.role as string | undefined) ?? null);
  let canOperate = $derived(role == null || role === 'admin' || role === 'operator');

  let parsedParams = $derived(paramSpecs(params));
  let symbolValues = $derived(symbolList(symbols));
  let baselineValue = $derived(baseline === 'other' ? baselineOther.trim() : baseline);

  let localErrors = $derived.by(() => {
    const out: string[] = [];
    if (!edgeId) out.push('Pick the edge this is about, or a new one');
    if (creatingEdge && !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(newEdgeId.trim())) {
      out.push('A new edge needs an id: lower-case letters, digits, - and _');
    }
    if (creatingEdge && !newEdgeName.trim()) out.push('A new edge needs a name');
    if (idea.trim().length < 20) out.push('The idea needs at least 20 characters: one sentence, with the mechanism');
    if (symbolValues.length === 0) out.push('Name at least one symbol');
    if (!dataset.trim()) out.push('Name the data: the lake folder and the date range');
    const h = Number(holdout);
    if (!(h >= 0.1 && h <= 0.5)) out.push('The holdout share is between 0.1 and 0.5');
    out.push(...parsedParams.errors);
    if (!baselineValue) out.push('Name the baseline it must beat');
    if (!metric.trim()) out.push('Name the metric');
    for (const [name, v] of [['maker', maker], ['taker', taker], ['slippage', slippage]] as const) {
      const n = Number(v);
      if (v.trim() === '' || !(n >= 0 && n <= 1000)) out.push(`The ${name} cost is 0 to 1000 bps`);
    }
    return out;
  });

  onMount(async () => {
    try {
      const [e, i] = await Promise.all([spawner.edges(), spawner.instances().catch(() => null)]);
      edges = (e.edges ?? []).filter((x) => x.active !== false);
      const wanted = $page.url.searchParams.get('edge');
      edgeId = wanted && edges.some((x) => x.edge_id === wanted) ? wanted : (edges[0]?.edge_id ?? NEW_EDGE);
      lakeFolders = ((i?.instances ?? []) as Instance[])
        .map((x) => x.data_dir?.replace(/^.*?\/raw\//, 'raw/') ?? '')
        .filter(Boolean);
    } catch (err) {
      loadError = errorLines(err).join('; ');
      edges = [];
      edgeId = NEW_EDGE;
    }
  });

  function addParam() {
    if (params.length < 12) params = [...params, emptyParam()];
  }
  function removeParam(i: number) {
    params = params.filter((_, j) => j !== i);
  }

  async function submit() {
    tried = true;
    serverErrors = [];
    if (localErrors.length) return;
    submitting = true;
    try {
      let target = edgeId;
      if (creatingEdge) {
        target = newEdgeId.trim();
        await spawner.upsertEdge({
          edge_id: target,
          display_name: newEdgeName.trim(),
          edge_type: newEdgeType,
          asset_scope: symbolValues,
          status: 'research',
        });
      }
      const res = await spawner.registerHypothesis(target, {
        idea: idea.trim(),
        symbols: symbolValues,
        dataset: dataset.trim(),
        holdout_share: Number(holdout),
        params: parsedParams.params,
        baseline: baselineValue,
        metric: metric.trim(),
        costs: { maker_bps: Number(maker), taker_bps: Number(taker), slippage_bps: Number(slippage) },
      });
      await goto(`/edges?hypothesis=${res.hypothesis.id}`);
    } catch (err) {
      serverErrors = errorLines(err);
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:head>
  <title>Register a hypothesis — FKS Terminal</title>
</svelte:head>

<div class="page-scroll page">
  <Panel title="Register a hypothesis">
    <form class="form" onsubmit={(e) => { e.preventDefault(); submit(); }} novalidate>
      <p class="lead">
        Stage 2 of the edge process: write it down <strong>before</strong> any search. A hypothesis written
        after the results is a description, not a test.
      </p>
      {#if loadError}<p class="warn" role="alert">Couldn't list the edges ({loadError}). You can still name a new one.</p>{/if}

      <fieldset>
        <legend>The edge</legend>
        <label>
          Edge
          <select bind:value={edgeId} disabled={edges === null} aria-label="Edge">
            {#each edges ?? [] as e (e.edge_id)}
              <option value={e.edge_id}>{e.display_name || e.edge_id} ({e.edge_id})</option>
            {/each}
            <option value={NEW_EDGE}>A new edge…</option>
          </select>
        </label>
        {#if creatingEdge}
          <div class="row">
            <label>Id <input bind:value={newEdgeId} placeholder="liq-fade" autocomplete="off" /></label>
            <label>Name <input bind:value={newEdgeName} placeholder="Liquidation fade" /></label>
            <label>
              Kind
              <select bind:value={newEdgeType} aria-label="Kind of edge">
                <option value="rule">A rule</option>
                <option value="adaptive">Adaptive (janus)</option>
              </select>
            </label>
          </div>
        {/if}
      </fieldset>

      <fieldset>
        <legend>1. The idea</legend>
        <label>
          One sentence, with the mechanism
          <textarea
            rows="3"
            bind:value={idea}
            placeholder="Liquidation cascades on BTCUSDT overshoot; fading the 5-minute move after a cluster above $5M earns the snap-back."
          ></textarea>
        </label>
      </fieldset>

      <fieldset>
        <legend>2. The data and the split</legend>
        <div class="row">
          <label>Symbols <input bind:value={symbols} placeholder="BTCUSDT" autocomplete="off" /></label>
          <label>
            Holdout share
            <input type="number" step="0.05" min="0.1" max="0.5" bind:value={holdout} />
          </label>
        </div>
        <label>
          Dataset: the lake folder and the date range
          <input bind:value={dataset} list="lake-folders" placeholder="raw/binance/usdm/btc 2026-10-27..2027-01-27" />
          <datalist id="lake-folders">
            {#each lakeFolders as f (f)}<option value={f}></option>{/each}
          </datalist>
        </label>
        <p class="hint">
          The holdout is the last part of the window: nothing touches it until it is scored once. EDGE_PROCESS
          proposes the last 25% (†, not confirmed yet). Use a dataset whose days are complete on the Data page.
        </p>
      </fieldset>

      <fieldset>
        <legend>3. The parameters and their ranges (keep them few)</legend>
        {#each params as p, i (i)}
          <div class="param" data-testid="param-row">
            <input class="name" bind:value={p.name} placeholder="name" aria-label="Parameter {i + 1} name" />
            <select bind:value={p.kind} aria-label="Parameter {i + 1} kind">
              <option value="range">range</option>
              <option value="choices">choices</option>
            </select>
            {#if p.kind === 'range'}
              <input bind:value={p.min} placeholder="min" inputmode="decimal" aria-label="Parameter {i + 1} min" />
              <input bind:value={p.max} placeholder="max" inputmode="decimal" aria-label="Parameter {i + 1} max" />
              <input bind:value={p.step} placeholder="step (optional)" inputmode="decimal" aria-label="Parameter {i + 1} step" />
            {:else}
              <input class="wide" bind:value={p.choices} placeholder="long, short" aria-label="Parameter {i + 1} choices" />
            {/if}
            <button type="button" class="btn" onclick={() => removeParam(i)} aria-label="Remove parameter {i + 1}">✕</button>
          </div>
        {/each}
        <button type="button" class="btn" onclick={addParam} disabled={params.length >= 12}>+ Parameter</button>
        <p class="hint">
          The 2026-09 optimizer tuned 64 parameters against about 13 trades, and its winner took none on the
          holdout. A parameter that ends up on its range's edge is the sign of a dead zone.
        </p>
      </fieldset>

      <fieldset>
        <legend>4. The baseline and 5. the metric</legend>
        <div class="row">
          <label>
            It must beat
            <select bind:value={baseline} aria-label="It must beat">
              {#each BASELINES as b (b.value)}<option value={b.value}>{b.label}</option>{/each}
              <option value="other">Something else…</option>
            </select>
          </label>
          {#if baseline === 'other'}
            <label>The baseline <input bind:value={baselineOther} /></label>
          {/if}
          <label>Metric <input bind:value={metric} /></label>
        </div>
        <div class="row">
          <label>Maker bps <input type="number" min="0" bind:value={maker} /></label>
          <label>Taker bps <input type="number" min="0" bind:value={taker} /></label>
          <label>Slippage bps <input type="number" min="0" bind:value={slippage} /></label>
        </div>
        <p class="hint">Use whichever baseline is harder. Costs default to Kraken tier 1, plus a stated slippage.</p>
      </fieldset>

      <p class="frozen" role="note">
        Registering freezes it. The database refuses any edit: to change it, withdraw it and register a new one.
      </p>

      {#if tried && localErrors.length}
        <div role="alert">
          <ul class="errors" aria-label="What to fix">
            {#each localErrors as line, i (i)}<li>{line}</li>{/each}
          </ul>
        </div>
      {/if}
      {#if serverErrors.length}
        <div role="alert">
          <ul class="errors" aria-label="The spawner refused it">
            {#each serverErrors as line, i (i)}<li>{line}</li>{/each}
          </ul>
        </div>
      {/if}

      <div class="submit">
        <button class="btn primary" type="submit" disabled={submitting || !canOperate}>
          {submitting ? 'Registering…' : 'Register, frozen from now'}
        </button>
        <a href="/edges">Cancel</a>
      </div>
    </form>
  </Panel>
</div>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: 820px;
    font-size: 12px;
    color: var(--t2);
  }
  .lead {
    margin: 0;
    line-height: 1.5;
  }
  fieldset {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 8px 10px;
    border: 1px solid var(--b1);
    border-radius: var(--r-md);
  }
  legend {
    padding: 0 4px;
    font-size: 11px;
    font-weight: 600;
    color: var(--t1);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1 1 160px;
    min-width: 0;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  input,
  select,
  textarea {
    min-height: 30px;
    padding: 4px 6px;
    background: var(--bg1);
    border: 1px solid var(--b2);
    border-radius: var(--r);
    color: var(--t1);
    font: inherit;
    min-width: 0;
  }
  .param {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .param input {
    flex: 1 1 80px;
  }
  .param .name {
    flex: 1 1 140px;
  }
  .param .wide {
    flex: 3 1 200px;
  }
  .hint {
    margin: 0;
    font-size: 10px;
    color: var(--t3);
    line-height: 1.4;
  }
  .frozen {
    margin: 0;
    padding: 6px 8px;
    border-left: 2px solid var(--amber);
    color: var(--t1);
  }
  .warn {
    margin: 0;
    color: var(--amber);
  }
  .errors {
    margin: 0;
    padding-left: 18px;
    color: var(--amber);
  }
  .submit {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .submit a {
    color: var(--t2);
  }
  .btn {
    min-height: 30px;
    padding: 3px 12px;
    background: transparent;
    border: 1px solid var(--b2);
    border-radius: var(--r);
    color: var(--t1);
    font: inherit;
    cursor: pointer;
    align-self: flex-start;
  }
  .btn:hover:not(:disabled) {
    border-color: var(--cyan);
    color: var(--cyan);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn.primary {
    border-color: var(--cyan);
    color: var(--cyan);
  }
  @media (pointer: coarse) {
    .btn,
    input,
    select {
      min-height: 44px;
    }
  }
</style>
