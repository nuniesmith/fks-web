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
  import {
    ALL_INTERVALS,
    BASELINES,
    FOLDER_RE,
    FUTURES_BASELINES,
    METRICS,
    datasetText,
    emptyParam,
    isFuturesFolder,
    lakeFolders,
    paramSpecs,
    symbolList,
    yesterday,
    type LakeFolder,
    type ParamRow,
  } from '$lib/ladder';
  import type { Edge, HypothesisEvidence, Instance } from '$lib/types/spawner';

  let edges = $state<Edge[] | null>(null);
  let folders = $state<LakeFolder[]>([]);
  let loadError = $state('');

  // ── The form ──────────────────────────────────────────────────────────────
  let edgeId = $state('');
  let newEdgeId = $state('');
  let newEdgeName = $state('');
  let newEdgeType = $state<'rule' | 'adaptive'>('rule');
  let idea = $state('');
  let symbols = $state('');
  let folder = $state('');
  let folderOther = $state('');
  let interval = $state('1d');
  let from = $state('');
  let to = $state(yesterday());
  let holdout = $state('0.25');
  let params = $state<ParamRow[]>([emptyParam()]);
  let baseline = $state<string>(BASELINES[0].value);
  let baselineOther = $state('');
  let metric = $state<string>(METRICS[0].value);
  let evidence = $state<HypothesisEvidence>('trades');
  let maker = $state<string | number>('40');
  let taker = $state<string | number>('80');
  let slippage = $state<string | number>('5');
  // Futures (a raw/cme/... folder): per contract instead of bps.
  let commission = $state<string | number>('1.50');
  let ticks = $state<string | number>('1');

  let submitting = $state(false);
  let serverErrors = $state<string[]>([]);
  let tried = $state(false);

  const NEW_EDGE = '__new__';
  const OTHER = '__other__';
  let creatingEdge = $derived(edgeId === NEW_EDGE);
  let role = $derived(($page.data.user?.role as string | undefined) ?? null);
  let canOperate = $derived(role == null || role === 'admin' || role === 'operator');

  let parsedParams = $derived(paramSpecs(params));
  let symbolValues = $derived(symbolList(symbols));
  let baselineValue = $derived(baseline === 'other' ? baselineOther.trim() : baseline);
  let folderValue = $derived(folder === OTHER ? folderOther.trim() : folder);
  let chosenFolder = $derived(folders.find((f) => f.path === folder) ?? null);
  let futures = $derived(isFuturesFolder(folderValue));
  let baselineChoices = $derived(futures ? FUTURES_BASELINES : BASELINES);
  let intervals = $derived(chosenFolder?.intervals.length ? chosenFolder.intervals : ALL_INTERVALS);
  // The form the search job reads: '<lake folder> <interval> <from>..<to>'.
  let dataset = $derived(datasetText(folderValue, interval, from, to));

  // `bind:value` on a number input hands back a number once it is edited (and
  // '' or null when cleared), so these fields are not always strings.
  function blank(v: unknown): boolean {
    return v === null || v === undefined || String(v).trim() === '';
  }

  let localErrors = $derived.by(() => {
    const out: string[] = [];
    if (!edgeId) out.push('Pick the edge this is about, or a new one');
    if (creatingEdge && !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(newEdgeId.trim())) {
      out.push('A new edge needs an id: lower-case letters, digits, - and _');
    }
    if (creatingEdge && !newEdgeName.trim()) out.push('A new edge needs a name');
    if (idea.trim().length < 20) out.push('The idea needs at least 20 characters: one sentence, with the mechanism');
    if (symbolValues.length === 0) out.push('Name at least one symbol');
    if (!FOLDER_RE.test(folderValue)) out.push('Pick the lake folder (raw/…) the data is in');
    if (!from || !to || to <= from) out.push('The data needs a start date before its end date');
    const h = Number(holdout);
    if (!(h >= 0.1 && h <= 0.5)) out.push('The holdout share is between 0.1 and 0.5');
    out.push(...parsedParams.errors);
    if (!baselineValue) out.push('Name the baseline it must beat');

    if (futures) {
      const c = Number(commission);
      const t = Number(ticks);
      if (blank(commission) || !(c >= 0 && c <= 1000)) out.push('The commission is 0 to 1000 dollars a contract');
      if (blank(ticks) || !(t >= 0 && t <= 100)) out.push('The slippage is 0 to 100 ticks a side');
    } else {
      for (const [name, v] of [['maker', maker], ['taker', taker], ['slippage', slippage]] as const) {
        const n = Number(v);
        if (blank(v) || !(n >= 0 && n <= 1000)) out.push(`The ${name} cost is 0 to 1000 bps`);
      }
    }
    return out;
  });

  onMount(async () => {
    try {
      const [e, i] = await Promise.all([spawner.edges(), spawner.instances().catch(() => null)]);
      edges = (e.edges ?? []).filter((x) => x.active !== false);
      const wanted = $page.url.searchParams.get('edge');
      edgeId = wanted && edges.some((x) => x.edge_id === wanted) ? wanted : (edges[0]?.edge_id ?? NEW_EDGE);
      folders = lakeFolders((i?.instances ?? []) as Instance[]);
      // An instance's folder first (history recorders before recorders), the
      // fixed CME folders only when no instance writes one.
      const first = folders.find((f) => f.history && !f.futures) ?? folders.find((f) => !f.futures) ?? folders[0];
      if (first) {
        folder = first.path;
        folderChanged();
      } else {
        folder = OTHER;
      }
    } catch (err) {
      loadError = errorLines(err).join('; ');
      edges = [];
      edgeId = NEW_EDGE;
    }
  });

  /** A folder brings its own bars, start and, for futures, the intraday baseline. */
  function folderChanged() {
    const f = folders.find((x) => x.path === folder);
    if (f?.intervals.length && !f.intervals.includes(interval)) interval = f.intervals.at(-1)!;
    if (f?.from) from = f.from;
    const choices = isFuturesFolder(folder === OTHER ? folderOther.trim() : folder) ? FUTURES_BASELINES : BASELINES;
    if (baseline !== 'other' && !choices.some((b) => b.value === baseline)) baseline = choices[0].value;
  }

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
        dataset,
        holdout_share: Number(holdout),
        params: parsedParams.params,
        baseline: baselineValue,
        metric,
        costs: futures
          ? {
              maker_bps: 0,
              taker_bps: 0,
              slippage_bps: 0,
              commission_usd_rt: Number(commission),
              slippage_ticks: Number(ticks),
            }
          : { maker_bps: Number(maker), taker_bps: Number(taker), slippage_bps: Number(slippage) },
        evidence,
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
        <div class="row">
          <label>
            Lake folder
            <select bind:value={folder} aria-label="Lake folder" onchange={folderChanged}>
              {#each folders as f (f.path)}<option value={f.path}
                  >{f.path}{f.futures ? ' (CME futures)' : f.history ? ' (history)' : ''}</option
                >{/each}
              <option value={OTHER}>Another folder…</option>
            </select>
          </label>
          {#if folder === OTHER}
            <label
              >Folder <input
                bind:value={folderOther}
                oninput={folderChanged}
                placeholder="raw/binance/spot/spot-history"
              /></label
            >
          {/if}
          <label>
            Bars
            <select bind:value={interval} aria-label="Bars">
              {#each intervals as iv (iv)}<option value={iv}>{iv}</option>{/each}
            </select>
          </label>
          <label>From <input type="date" bind:value={from} /></label>
          <label>To <input type="date" bind:value={to} /></label>
        </div>
        <p class="hint" data-testid="dataset-text">Recorded as: <code>{dataset || '—'}</code></p>
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
              {#each baselineChoices as b (b.value)}<option value={b.value}>{b.label}</option>{/each}
              <option value="other">Something else…</option>
            </select>
          </label>
          {#if baseline === 'other'}
            <label>The baseline <input bind:value={baselineOther} /></label>
          {/if}
          <label>
            Metric, net of costs
            <select bind:value={metric} aria-label="Metric">
              {#each METRICS as m (m.value)}<option value={m.value}>{m.label}</option>{/each}
            </select>
          </label>
        </div>
        {#if futures}
          <div class="row" data-testid="futures-costs">
            <label>Commission $ / contract, round turn <input type="number" min="0" step="0.01" bind:value={commission} /></label>
            <label>Slippage ticks / side <input type="number" min="0" step="0.5" bind:value={ticks} /></label>
          </div>
          <p class="hint">
            Futures are judged by the search job's <code>orb</code> family: one trade per session, against holding
            each session from open to close, paying this commission and slippage on every trade. Symbols are
            contracts: MES, MNQ, MGC (or ES, NQ, GC).
          </p>
        {:else}
          <div class="row">
            <label>Maker bps <input type="number" min="0" bind:value={maker} /></label>
            <label>Taker bps <input type="number" min="0" bind:value={taker} /></label>
            <label>Slippage bps <input type="number" min="0" bind:value={slippage} /></label>
          </div>
          <p class="hint">
            Use whichever baseline is harder. The search job computes these two baselines and these three metrics;
            costs default to Kraken tier 1, plus a stated slippage.
          </p>
        {/if}
      </fieldset>

      <fieldset>
        <legend>6. The evidence</legend>
        <label class="choice">
          <input type="radio" name="evidence" value="trades" bind:group={evidence} />
          Trades: the holdout has at least 30 trades
        </label>
        <label class="choice">
          <input type="radio" name="evidence" value="low-frequency" bind:group={evidence} />
          Low-frequency: at least 10 trades pooled over 3 or more coins, one parameter set, every coin trading
        </label>
        <p class="hint">
          Declare it now. A trend band trades a few times a year per coin, so it can't reach 30 on any history:
          it is judged across many coins instead. Choosing the path after seeing the trade count is what the
          freeze stops, so it can't change once registered.
        </p>
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
  .choice {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 11px;
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
