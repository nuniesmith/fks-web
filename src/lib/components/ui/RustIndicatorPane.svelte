<script lang="ts">
  // Renders a Rust `indicators-ta` indicator (from janus) on the /charts page.
  // Series come from GET /api/janus/indicators/compute (epoch-SECONDS time, to
  // match lightweight-charts + the chart's TS output). Two render modes, chosen
  // by the descriptor's category:
  //   • Overlay    → line series drawn on the MAIN chart's price scale (no own
  //                  chart); just a legend/header strip with gear + ×.
  //   • Oscillator → its own sub-chart pane, time-scale-synced to the main chart
  //                  (mirrors IndicatorPane), every response key as a line.
  // Self-contained lifecycle (mount/reload on symbol|interval|param change/
  // destroy) so new Rust indicators need no bespoke per-indicator code. The
  // param editor is descriptor-driven (min/max/default/kind), so tuning a param
  // re-issues compute with the new value.
  import { onMount, onDestroy } from "svelte";
  import { api } from "$api/client";
  import type { IChartApi } from "lightweight-charts";
  import {
    computeQuery,
    computeLines,
    clampParam,
    type RustIndicator,
    type ComputeResponse,
  } from "$lib/charts/rustIndicators";

  let {
    symbol,
    interval,
    indicator,
    mainChart,
    params = {},
    onparams,
    onremove,
  }: {
    symbol: string;
    interval: string;
    indicator: RustIndicator;
    mainChart: IChartApi | null;
    /** Current param values keyed by descriptor param name. */
    params?: Record<string, number>;
    /** Called with the new param map when the user applies the inline editor. */
    onparams?: (p: Record<string, number>) => void;
    onremove: () => void;
  } = $props();

  const isOverlay = $derived(indicator.category === "Overlay");
  const apiSymbol = (s: string) => (s.includes("/") ? s.split("/")[0] : s);

  let el: HTMLDivElement = $state(null!);
  let ownChart: IChartApi | null = null;
  let series: any[] = [];
  let loading = $state(true);
  let empty = $state(false);
  let errored = $state(false);
  let ready = $state(false); // overlay: mainChart present; oscillator: own chart built
  let rangeHandler: ((r: any) => void) | null = null;
  let ro: ResizeObserver | null = null;

  // Inline param editor (gear) — descriptor-driven.
  let editorOpen = $state(false);
  let draft = $state<Record<string, number>>({});

  const PALETTE = ["#22d3ee", "#f472b6", "#a3e635", "#fbbf24", "#fb923c", "#6366f1"];

  function paramValue(name: string, def: number): number {
    const v = params?.[name];
    return v == null ? def : v;
  }

  function openEditor() {
    if (editorOpen) {
      editorOpen = false;
      return;
    }
    const d: Record<string, number> = {};
    for (const p of indicator.params) d[p.name] = paramValue(p.name, p.default);
    draft = d;
    editorOpen = true;
  }

  function applyEditor() {
    const next: Record<string, number> = {};
    for (const p of indicator.params) next[p.name] = clampParam(p, Number(draft[p.name]));
    editorOpen = false;
    onparams?.(next);
  }

  function targetChart(): IChartApi | null {
    return isOverlay ? mainChart : ownChart;
  }

  function clearSeries() {
    const t = targetChart();
    for (const s of series) {
      try {
        t?.removeSeries(s);
      } catch {
        /* already gone */
      }
    }
    series = [];
  }

  async function load() {
    const chart = targetChart();
    if (!chart) return;
    loading = true;
    errored = false;
    try {
      const qs = computeQuery({ symbol: apiSymbol(symbol), indicator, interval, params, daysBack: 5 });
      const res = await api.get<ComputeResponse>(`/api/janus/indicators/compute?${qs}`);
      clearSeries();
      const lines = computeLines(res);
      let any = false;
      lines.forEach(({ key, points }, ci) => {
        const s = chart.addLineSeries({
          color: PALETTE[ci % PALETTE.length],
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
          title: key,
          // Overlays share the price axis; oscillators own their pane.
          priceScaleId: isOverlay ? "right" : undefined,
        });
        s.setData(points as any);
        series.push(s);
        if (points.length) any = true;
      });
      empty = !any;
      if (!isOverlay) ownChart?.timeScale().fitContent();
    } catch (e) {
      // janus 4xx/502 → this one indicator shows an error; the chart is fine.
      console.warn("[RustIndicatorPane] compute failed", indicator.id, e);
      errored = true;
      empty = true;
      clearSeries();
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    if (isOverlay) {
      // No own chart — draw straight onto the main chart. Ready once it exists.
      ready = !!mainChart;
      return;
    }
    const { createChart } = await import("lightweight-charts");
    ownChart = createChart(el, {
      layout: {
        background: { type: "solid" as any, color: "#07070d" },
        textColor: "#8890b8",
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        fontSize: 9,
      },
      grid: { vertLines: { color: "#1a1a2e" }, horzLines: { color: "#0d0d1a" } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: "#1a1a2e", minimumWidth: 44 },
      timeScale: { borderColor: "#1a1a2e", timeVisible: true, secondsVisible: false },
      handleScale: false,
      handleScroll: false,
    });
    // Follow the main chart's visible range (one-directional → no feedback loop).
    if (mainChart && ownChart) {
      rangeHandler = (range: any) => {
        if (range && ownChart) ownChart.timeScale().setVisibleLogicalRange(range);
      };
      mainChart.timeScale().subscribeVisibleLogicalRangeChange(rangeHandler);
      const r = mainChart.timeScale().getVisibleLogicalRange();
      if (r) ownChart.timeScale().setVisibleLogicalRange(r);
    }
    if (el && ownChart) {
      ro = new ResizeObserver(() => {
        if (ownChart && el) ownChart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      });
      ro.observe(el);
    }
    ready = true;
  });

  onDestroy(() => {
    if (ro) {
      ro.disconnect();
      ro = null;
    }
    // Overlay series live on the main chart — remove them explicitly on teardown.
    if (isOverlay) clearSeries();
    if (mainChart && rangeHandler) {
      try {
        mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(rangeHandler);
      } catch {
        /* gone */
      }
    }
    if (ownChart) {
      try {
        ownChart.remove();
      } catch {
        /* gone */
      }
      ownChart = null;
    }
  });

  // (Re)load whenever symbol / interval / params change, once the target chart
  // exists. Params are stringified so a value tweak re-issues compute.
  $effect(() => {
    const _key = `${symbol}|${interval}|${JSON.stringify(params)}`;
    if (ready) {
      void _key;
      load();
    }
  });
</script>

{#if isOverlay}
  <!-- Overlay: legend/header strip only; the lines live on the main chart. -->
  <div class="rust-overlay-row" role="group" aria-label="{indicator.display_name} indicator">
    <span class="ov-dot"></span>
    <span class="ov-label">{indicator.display_name}</span>
    <span class="ov-badge" title="From the Rust indicators-ta crate">ta</span>
    {#if errored}<span class="ov-err" title="compute failed">!</span>{/if}
    <span class="ov-actions">
      {#if indicator.params.length > 0}
        <button class="ov-btn" onclick={openEditor} title="Settings — {indicator.display_name}" aria-label="Edit {indicator.display_name} settings">⚙</button>
      {/if}
      <button class="ov-btn ov-x" onclick={onremove} title="Remove {indicator.display_name}" aria-label="Remove {indicator.display_name}">×</button>
    </span>
    {#if editorOpen}
      <div class="rust-editor">
        {#each indicator.params as p (p.name)}
          <label class="editor-field">
            <span>{p.name}</span>
            <input
              type="number"
              step={p.kind === "Integer" ? 1 : 0.1}
              min={p.min}
              max={p.max}
              bind:value={draft[p.name]}
            />
          </label>
        {/each}
        <div class="editor-actions">
          <button class="editor-apply" onclick={applyEditor}>Apply</button>
          <button class="editor-cancel" onclick={() => (editorOpen = false)}>Cancel</button>
        </div>
      </div>
    {/if}
  </div>
{:else}
  <!-- Oscillator: its own sub-pane. -->
  <div class="ind-pane" role="region" aria-label="{indicator.display_name} indicator">
    <div class="pane-head">
      <span class="pane-label">{indicator.display_name} <span class="ov-badge" title="From the Rust indicators-ta crate">ta</span></span>
      <span class="pane-actions">
        {#if indicator.params.length > 0}
          <button class="pane-gear" onclick={openEditor} title="Settings — {indicator.display_name}" aria-label="Edit {indicator.display_name} settings">⚙</button>
        {/if}
        <button class="pane-x" onclick={onremove} title="Remove {indicator.display_name}" aria-label="Remove {indicator.display_name}">×</button>
      </span>
    </div>
    {#if editorOpen}
      <div class="pane-editor">
        {#each indicator.params as p (p.name)}
          <label class="editor-field">
            <span>{p.name}</span>
            <input
              type="number"
              step={p.kind === "Integer" ? 1 : 0.1}
              min={p.min}
              max={p.max}
              bind:value={draft[p.name]}
            />
          </label>
        {/each}
        <div class="editor-actions">
          <button class="editor-apply" onclick={applyEditor}>Apply</button>
          <button class="editor-cancel" onclick={() => (editorOpen = false)}>Cancel</button>
        </div>
      </div>
    {/if}
    <div class="pane-chart" bind:this={el}></div>
    {#if !loading && empty}
      <div class="pane-empty">{errored ? "compute failed" : "no data"}</div>
    {/if}
  </div>
{/if}

<style>
  /* ── Overlay legend strip (lines are on the main chart) ─────────────────── */
  .rust-overlay-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    font-size: 10px;
    color: var(--t2, #b8c0e0);
    border-top: 1px solid var(--b1, #1a1a2e);
    flex-shrink: 0;
  }
  .ov-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #22d3ee;
  }
  .ov-label {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--t3, #8890b8);
  }
  .ov-err {
    color: var(--red, #ea3943);
    font-weight: 700;
  }
  .ov-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .ov-btn {
    background: none;
    border: none;
    color: var(--t3, #8890b8);
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
  }
  .ov-btn:hover {
    color: var(--t1, #e6e9f5);
  }
  .ov-x:hover {
    color: var(--red, #ea3943);
  }

  /* "ta" badge — marks Rust-crate indicators. */
  .ov-badge {
    font-size: 8px;
    line-height: 1;
    padding: 1px 3px;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--cyan, #00e5ff);
    border: 1px solid var(--cyan, #00e5ff);
    opacity: 0.75;
  }

  /* ── Oscillator sub-pane (mirrors IndicatorPane) ────────────────────────── */
  .ind-pane {
    position: relative;
    height: 110px;
    border-top: 1px solid var(--b1, #1a1a2e);
    flex-shrink: 0;
  }
  .pane-head {
    position: absolute;
    top: 2px;
    left: 6px;
    right: 6px;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    pointer-events: none;
  }
  .pane-label {
    font-size: 9px;
    color: var(--t3, #8890b8);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .pane-actions {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .pane-gear,
  .pane-x {
    background: none;
    border: none;
    color: var(--t3, #8890b8);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
  }
  .pane-gear {
    font-size: 11px;
  }
  .pane-gear:hover {
    color: var(--t1, #e6e9f5);
  }
  .pane-x:hover {
    color: var(--red, #ea3943);
  }

  /* ── Inline editor (shared by both modes) ───────────────────────────────── */
  .pane-editor,
  .rust-editor {
    position: absolute;
    top: 18px;
    left: 6px;
    z-index: 3;
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    background: var(--bg1, #0a0a12);
    border: 1px solid var(--b2, #1a1a2e);
    border-radius: var(--r, 4px);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
  }
  .editor-field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 10px;
    color: var(--t3, #8890b8);
  }
  .editor-field input {
    width: 64px;
    padding: 1px 4px;
    font-size: 10px;
    font-family: inherit;
    color: var(--t1, #e6e9f5);
    background: var(--bg2, #0c0f14);
    border: 1px solid var(--b2, #1a1a2e);
    border-radius: var(--r, 4px);
  }
  .editor-field input:focus {
    border-color: var(--accent, #6366f1);
    outline: none;
  }
  .editor-actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }
  .editor-apply,
  .editor-cancel {
    all: unset;
    cursor: pointer;
    padding: 2px 8px;
    font-size: 10px;
    border-radius: var(--r, 4px);
    border: 1px solid var(--b2, #1a1a2e);
    color: var(--t2, #b8c0e0);
  }
  .editor-apply {
    color: var(--t1, #e6e9f5);
    background: var(--accent-dim, rgba(99, 102, 241, 0.15));
  }
  .editor-apply:hover {
    background: var(--accent, #6366f1);
  }
  .editor-cancel:hover {
    background: var(--bg3, #161b24);
  }
  .pane-chart {
    width: 100%;
    height: 100%;
  }
  .pane-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    color: var(--t3, #8890b8);
    pointer-events: none;
  }
</style>
