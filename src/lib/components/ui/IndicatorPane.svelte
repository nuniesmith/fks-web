<script lang="ts">
  // Generic oscillator sub-pane for /charts. One lightweight-charts instance per
  // indicator, time-scale-synced to the main chart, rendering each response key
  // as a line series. Self-contained lifecycle (create on mount, reload on
  // symbol/interval change, destroy on unmount) so the picker can add/remove any
  // separate-pane indicator from the catalog without bespoke per-indicator code.
  import { onMount, onDestroy } from 'svelte';
  import { api } from '$api/client';
  import type { IChartApi } from 'lightweight-charts';

  interface IndicatorPoint { time: number; value: number; }

  let {
    symbol,
    interval,
    id,
    label,
    keys,
    mainChart,
    params = [],
    paramNames = [],
    onparams,
    onremove,
  }: {
    symbol: string;
    interval: string;
    id: string;
    label: string;
    keys: string[];
    mainChart: IChartApi | null;
    /** Current indicator params (e.g. [14, 3] for Stochastic). Empty → not parameterizable. */
    params?: number[];
    /** Human labels for each param slot; length must match `params`. */
    paramNames?: string[];
    /** Called with the new params when the user applies the inline editor. */
    onparams?: (p: number[]) => void;
    onremove: () => void;
  } = $props();

  let el: HTMLDivElement = $state(null!);
  let chart: IChartApi | null = null;
  let series: any[] = [];
  let loading = $state(true);
  let empty = $state(false);
  let chartReady = $state(false);
  let rangeHandler: ((r: any) => void) | null = null;
  let ro: ResizeObserver | null = null;

  // Inline param editor (gear)
  let editorOpen = $state(false);
  let draft = $state<number[]>([]);

  const PALETTE = ['#6366f1', '#22d3ee', '#f472b6', '#a3e635', '#fbbf24', '#fb923c'];
  const apiSymbol = (s: string) => (s.includes('/') ? s.split('/')[0] : s);
  // Colon param scheme, e.g. stoch:14:3 (bare id when not parameterizable).
  let spec = $derived(params.length ? `${id}:${params.join(':')}` : id);

  function openEditor() {
    if (editorOpen) { editorOpen = false; return; }
    draft = [...params];
    editorOpen = true;
  }
  function applyEditor() {
    const next = draft.map((v, i) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(500, Math.max(1, n)) : params[i];
    });
    editorOpen = false;
    onparams?.(next);
  }

  async function load() {
    if (!chart) return;
    loading = true;
    try {
      const res = await api.get<{ indicators?: Record<string, IndicatorPoint[]> }>(
        `/api/chart/${encodeURIComponent(apiSymbol(symbol))}/indicators?interval=${interval}&days_back=5&indicators=${encodeURIComponent(spec)}`
      );
      const ind = res.indicators ?? {};
      for (const s of series) { try { chart.removeSeries(s); } catch { /* gone */ } }
      series = [];
      let any = false;
      keys.forEach((key, ci) => {
        const data = ind[key] ?? [];
        const s = chart!.addLineSeries({
          color: PALETTE[ci % PALETTE.length], lineWidth: 1,
          priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
          title: key,
        });
        s.setData(data as any);
        series.push(s);
        if (data.length) any = true;
      });
      empty = !any;
      chart.timeScale().fitContent();
    } catch (e) {
      console.warn('[IndicatorPane] load failed', id, e);
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    const { createChart } = await import('lightweight-charts');
    chart = createChart(el, {
      layout: {
        background: { type: 'solid' as any, color: '#07070d' },
        textColor: '#8890b8',
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        fontSize: 9,
      },
      grid: { vertLines: { color: '#1a1a2e' }, horzLines: { color: '#0d0d1a' } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: '#1a1a2e', minimumWidth: 44 },
      timeScale: { borderColor: '#1a1a2e', timeVisible: true, secondsVisible: false },
      handleScale: false,
      handleScroll: false,
    });
    // Follow the main chart's visible range (one-directional → no feedback loops
    // between multiple panes).
    if (mainChart && chart) {
      rangeHandler = (range: any) => { if (range && chart) chart.timeScale().setVisibleLogicalRange(range); };
      mainChart.timeScale().subscribeVisibleLogicalRangeChange(rangeHandler);
      const r = mainChart.timeScale().getVisibleLogicalRange();
      if (r) chart.timeScale().setVisibleLogicalRange(r);
    }
    if (el && chart) {
      ro = new ResizeObserver(() => {
        if (chart && el) chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      });
      ro.observe(el);
    }
    chartReady = true;
  });

  onDestroy(() => {
    if (ro) { ro.disconnect(); ro = null; }
    if (mainChart && rangeHandler) {
      try { mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(rangeHandler); } catch { /* gone */ }
    }
    if (chart) { try { chart.remove(); } catch { /* gone */ } chart = null; }
  });

  // Load once the chart exists, then reload whenever symbol/interval/params change.
  $effect(() => {
    const _key = `${symbol}|${interval}|${spec}`; // track symbol + interval + params
    if (chartReady) {
      void _key;
      load();
    }
  });
</script>

<div class="ind-pane" role="region" aria-label="{label} indicator">
  <div class="pane-head">
    <span class="pane-label">{label}</span>
    <span class="pane-actions">
      {#if paramNames.length > 0}
        <button class="pane-gear" onclick={openEditor} title="Settings — {label}" aria-label="Edit {label} settings">⚙</button>
      {/if}
      <button class="pane-x" onclick={onremove} title="Remove {label}" aria-label="Remove {label}">×</button>
    </span>
  </div>
  {#if editorOpen}
    <div class="pane-editor">
      {#each paramNames as name, i (name)}
        <label class="editor-field">
          <span>{name}</span>
          <input type="number" step="1" min="1" max="500" bind:value={draft[i]} />
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
    <div class="pane-empty">no data</div>
  {/if}
</div>

<style>
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
  .pane-gear { font-size: 11px; }
  .pane-gear:hover { color: var(--t1, #e6e9f5); }
  .pane-x:hover { color: var(--red, #ea3943); }
  .pane-editor {
    position: absolute;
    top: 18px;
    left: 6px;
    z-index: 3;
    display: flex;
    /* The pane is only 110px tall — keep the editor to a single row. */
    flex-direction: row;
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
    width: 56px;
    padding: 1px 4px;
    font-size: 10px;
    font-family: inherit;
    color: var(--t1, #e6e9f5);
    background: var(--bg2, #0c0f14);
    border: 1px solid var(--b2, #1a1a2e);
    border-radius: var(--r, 4px);
  }
  .editor-field input:focus { border-color: var(--accent, #6366f1); outline: none; }
  .editor-actions { display: flex; gap: 6px; justify-content: flex-end; }
  .editor-apply, .editor-cancel {
    all: unset;
    cursor: pointer;
    padding: 2px 8px;
    font-size: 10px;
    border-radius: var(--r, 4px);
    border: 1px solid var(--b2, #1a1a2e);
    color: var(--t2, #b8c0e0);
  }
  .editor-apply { color: var(--t1, #e6e9f5); background: var(--accent-dim, rgba(99,102,241,.15)); }
  .editor-apply:hover { background: var(--accent, #6366f1); }
  .editor-cancel:hover { background: var(--bg3, #161b24); }
  .pane-chart { width: 100%; height: 100%; }
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
