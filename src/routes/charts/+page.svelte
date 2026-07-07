<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { createSSE } from '$stores/sse';
  import { api } from '$api/client';
  import { focusSymbol } from '$stores/focusSymbol';
  import Panel from '$components/ui/Panel.svelte';
  import DrawingTools from '$components/ui/DrawingTools.svelte';
  import IndicatorPane from '$components/ui/IndicatorPane.svelte';
  import RustIndicatorPane from '$components/ui/RustIndicatorPane.svelte';
  import EmptyState from '$components/ui/EmptyState.svelte';
  import type { IChartApi, ISeriesApi } from 'lightweight-charts';
  import {
    parseRustCatalog,
    rustOnlyIndicators,
    defaultParams,
    type RustIndicator,
    type RustCatalogResponse,
  } from '$lib/charts/rustIndicators';

  // ─── Types ─────────────────────────────────────────────────────────────────
  interface CandleBar {
    timestamp: number; // ms
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
  }

  interface CandleData {
    time: any;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }

  interface BarUpdate {
    time: number | string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
  }

  interface AssetSearchResult {
    symbol: string;
    name?: string;
    type?: string;
    exchange?: string;
  }

  interface AssetInfo {
    type?: string;
    source?: string;
    source_chain?: string[];
    ws_url?: string;
    provider_symbols?: Record<string, string>;
  }

  interface IndicatorPoint {
    time: number;
    value: number;
  }

  // ─── Kraken WS interval mapping ────────────────────────────────────────────
  const TF_TO_KRAKEN: Record<string, number> = {
    '1m': 1, '5m': 5, '15m': 15, '30m': 30,
    '1h': 60, '4h': 240, '1D': 1440, '1W': 10080,
  };

  // ─── Binance WS interval mapping ───────────────────────────────────────────
  const TF_TO_BINANCE: Record<string, string> = {
    '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
    '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w',
  };

  // ─── State ─────────────────────────────────────────────────────────────────
  let symbol = $state('MGC');
  let interval = $state('5m');

  // API symbol: strips slash — BTC/USD → BTC, MGC → MGC
  let apiSymbol = $derived(symbol.includes('/') ? symbol.split('/')[0] : symbol);
  // Kraken ticker format: BTC/USD or BTC → BTC/USD
  let krakenTicker = $derived(
    symbol.includes('/') ? symbol : `${symbol}/USD`
  );

  // Asset routing (REG-C)
  let assetInfo = $state<AssetInfo>({});
  let isCrypto = $derived(
    symbol.includes('/') ||
    assetInfo.source === 'kraken' ||
    assetInfo.source === 'binance' ||
    (assetInfo.source_chain ?? [])[0] === 'kraken' ||
    (assetInfo.source_chain ?? [])[0] === 'binance'
  );
  // Active data source ('kraken' | 'binance' | 'sse' | 'none')
  let activeSource = $state<'kraken' | 'binance' | 'sse' | 'none'>('none');
  let dataSource = $derived(
    activeSource === 'binance' ? 'Binance WS'
    : activeSource === 'kraken' ? 'Kraken WS'
    : isCrypto ? 'Kraken WS'
    : 'SSE bars'
  );

  // Kraken WS connection state
  let krakenWS = $state<WebSocket | null>(null);
  let krakenConnected = $state(false);
  let krakenReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let krakenFailTimer: ReturnType<typeof setTimeout> | null = null;

  // Binance WS connection state (fallback)
  let binanceWS = $state<WebSocket | null>(null);
  let binanceConnected = $state(false);
  let binanceReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let binanceReconnectDelay = 1000; // ms, doubles on each failure (cap 30 s)

  // Chart instances
  let chartContainer: HTMLDivElement = $state(null!);
  let rsiChartEl: HTMLDivElement | null = $state(null);
  let chart: IChartApi | null = $state(null);
  let rsiChart: IChartApi | null = null;
  let macdChartEl: HTMLDivElement | null = $state(null);
  let macdChart: IChartApi | null = null;

  // Primary series
  let candleSeries: ISeriesApi<'Candlestick'> | null = $state(null);

  // Overlay series
  let ema9Series: any = null;
  let ema21Series: any = null;
  let volumeSeries: any = null;
  let bbUpperSeries: any = null;
  let bbMidSeries: any = null;
  let bbLowSeries: any = null;
  let rsiSeries: any = null;

  // MACD sub-pane series
  let macdHistSeries: any = null;
  let macdLineSeries: any = null;
  let macdSignalSeries: any = null;

  // ATR price overlay
  let atrSeries: any = null;

  // Extra server-computed overlays
  let sma20Series: any = null;
  let vwapSeries: any = null;
  let wmaSeries: any = null;
  let dcUpperSeries: any = null;
  let dcMidSeries: any = null;
  let dcLowSeries: any = null;
  let kcUpperSeries: any = null;
  let kcMidSeries: any = null;
  let kcLowSeries: any = null;

  // Candle cache for client-side indicators
  let candles = $state<CandleData[]>([]);

  // SSE bars (futures)
  let barSSE: ReturnType<typeof createSSE<BarUpdate>> | null = null;

  // Indicator toggle state
  let showEma9 = $state(false);
  let showEma21 = $state(false);
  let showVolume = $state(false);
  let showBB = $state(false);
  let showRSI = $state(false);
  let showMACD = $state(false);
  let showATR  = $state(false);
  let showSMA20 = $state(false);
  let showVWAP = $state(false);
  let showWMA = $state(false);
  let showDonchian = $state(false);
  let showKeltner = $state(false);
  let drawingActive = $state(false);

  // Oscillator sub-pane picker (generic, catalog-driven)
  interface OscMeta { id: string; label: string; keys: string[]; }
  let oscillatorCatalog = $state<OscMeta[]>([]);
  let activeOscillators = $state<OscMeta[]>([]);

  // ── Rust indicators-ta catalog (janus) — merged into the Indicators dropdown ─
  // `rustCatalog` holds only the Rust-ONLY descriptors (TS-covered concepts are
  // deduped out); janus unreachable → empty → the dropdown shows just the TS
  // set (no regression). `activeRustIds` are enabled ones; `rustParams` holds
  // per-indicator tunables keyed by descriptor param name (editable on-chart).
  let rustCatalog = $state<RustIndicator[]>([]);
  let activeRustIds = $state<string[]>([]);
  let rustParams = $state<Record<string, Record<string, number>>>({});
  const rustById = (id: string): RustIndicator | undefined => rustCatalog.find((r) => r.id === id);
  const activeRustIndicators = $derived(
    activeRustIds.map((id) => rustById(id)).filter((r): r is RustIndicator => !!r),
  );
  // TradingView-style "Indicators" dropdown (replaces the old chip row + picker)
  let indMenuOpen = $state(false);

  // ── Indicator parameters (TW-style editable settings) ──────────────────────
  // Persisted alongside the toggle booleans in fks_chart_indicators (additive
  // `params` key, so pre-existing saved layouts still load).
  interface OverlayParams {
    ema9: { period: number };
    ema21: { period: number };
    sma20: { period: number };
    wma: { period: number };
    bb: { period: number; std: number };
    atr: { period: number };
    donchian: { period: number };
    keltner: { period: number; mult: number };
    rsi: { period: number };
    macd: { fast: number; slow: number; signal: number };
  }
  const DEFAULT_PARAMS: OverlayParams = {
    ema9: { period: 9 }, ema21: { period: 21 }, sma20: { period: 20 },
    wma: { period: 20 }, bb: { period: 20, std: 2 }, atr: { period: 14 },
    donchian: { period: 20 }, keltner: { period: 20, mult: 2 },
    rsi: { period: 14 }, macd: { fast: 12, slow: 26, signal: 9 },
  };
  function mergeParams(p?: Partial<OverlayParams>): OverlayParams {
    const base = structuredClone(DEFAULT_PARAMS) as any;
    for (const k of Object.keys(base)) {
      const o = (p as any)?.[k];
      if (o && typeof o === 'object') base[k] = { ...base[k], ...o };
    }
    return base as OverlayParams;
  }
  let indParams = $state<OverlayParams>(structuredClone(DEFAULT_PARAMS));
  // Per-oscillator-pane params (stoch/willr/cci/adx), by catalog id.
  let oscParams = $state<Record<string, number[]>>({});
  // Which oscillator panes take params, and what they mean (obv has none).
  const OSC_PARAM_DEFS: Record<string, { names: string[]; defaults: number[] }> = {
    stoch: { names: ['%K Length', '%D Smoothing'], defaults: [14, 3] },
    willr: { names: ['Length'], defaults: [14] },
    cci:   { names: ['Length'], defaults: [20] },
    adx:   { names: ['Length'], defaults: [14] },
  };

  // Inline legend/pane parameter editor (one open at a time, by indicator id)
  let editorId = $state<string | null>(null);
  let editorDraft = $state<Record<string, number>>({});

  // Indicator presets + layout persistence (C3)
  let presetMenuOpen = $state(false);
  let persistReady = $state(false); // gate persistence until the initial restore runs

  interface IndicatorState {
    ema9: boolean; ema21: boolean; volume: boolean; bb: boolean;
    atr: boolean; sma20: boolean; vwap: boolean; wma: boolean;
    donchian: boolean; keltner: boolean; rsi: boolean; macd: boolean;
    oscillators: string[];
    params?: Partial<OverlayParams>;
    oscParams?: Record<string, number[]>;
    // Rust indicators-ta selections + per-indicator tunables (janus-backed).
    rustIndicators?: string[];
    rustParams?: Record<string, Record<string, number>>;
  }
  const BLANK_INDICATORS: IndicatorState = {
    ema9: false, ema21: false, volume: false, bb: false, atr: false,
    sma20: false, vwap: false, wma: false, donchian: false, keltner: false,
    rsi: false, macd: false, oscillators: [],
  };
  const INDICATOR_PRESETS: { id: string; label: string; state: Partial<IndicatorState> }[] = [
    { id: 'clean',    label: 'Clean',    state: {} },
    { id: 'trend',    label: 'Trend',    state: { ema9: true, ema21: true, sma20: true } },
    { id: 'bands',    label: 'Bands',    state: { bb: true, keltner: true } },
    { id: 'momentum', label: 'Momentum', state: { rsi: true, macd: true } },
    { id: 'volume',   label: 'Volume',   state: { volume: true, vwap: true } },
    { id: 'full',     label: 'Full',     state: { ema9: true, ema21: true, bb: true, volume: true, rsi: true, macd: true } },
  ];

  // Crosshair OHLC readout (updated on hover)
  let hoverBar = $state<{ o: number; h: number; l: number; c: number; chg: number } | null>(null);
  const fmtP = (n: number): string =>
    n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : n >= 1 ? n.toFixed(2)
    : n.toFixed(5);

  // Logarithmic vs linear price scale
  // TradingView-style price-scale state (fks_chart_scale in localStorage).
  // PriceScaleMode: 0=Regular, 1=Logarithmic, 2=Percent, 3=Indexed to 100.
  // Logarithmic is the DEFAULT for new sessions (user preference); autoScale
  // keeps the axis fitted to visible data while panning/zooming, until the
  // user drags the price scale (the menu's Auto entry restores it).
  let scaleMode = $state(1);
  let scaleAuto = $state(true);
  let scaleMenuOpen = $state(false);

  // Loading state
  let loading = $state(true);
  let indicatorLoading = $state(false);
  let barsError = $state(false); // true when the historical-bars fetch fails (vs. just empty)

  // Dynamic history backfill (fires when zooming/panning near the oldest bar).
  // Plain lets — nothing renders off them; loadSeq invalidates in-flight
  // backfills when the chart is reloaded for a new symbol/interval.
  let backfillBusy = false;
  let backfillDone = false;
  // Widened (×4 up to the server's 365-day cap) when a page comes back empty,
  // so a >window data gap doesn't end the history; reset after a full page.
  let backfillWindowDays = 30;
  let loadSeq = 0;

  // Auto-focus symbol from strip SSE
  let ignoreNextFocusChange = false;
  $effect(() => {
    const unsub = focusSymbol.subscribe((sym) => {
      if (sym && sym !== symbol && !ignoreNextFocusChange) {
        symbol = sym;
        if (chart) loadChart();
      }
      ignoreNextFocusChange = false;
    });
    return unsub;
  });

  // RSI pane init when it mounts
  $effect(() => {
    if (showRSI && rsiChartEl && !rsiChart) {
      initRSIChart();
    }
    if (!showRSI && rsiChart) {
      rsiChart.remove();
      rsiChart = null;
      rsiSeries = null;
    }
  });

  // MACD pane init when it mounts
  $effect(() => {
    if (showMACD && macdChartEl && !macdChart) {
      initMACDChart();
    }
    if (!showMACD && macdChart) {
      macdChart.remove();
      macdChart = null;
      macdHistSeries = null;
      macdLineSeries = null;
      macdSignalSeries = null;
    }
  });

  // Persist the active indicator layout whenever it changes — but only after the
  // initial restore has run, so we never overwrite the saved set with defaults.
  $effect(() => {
    const _track = [
      showEma9, showEma21, showVolume, showBB, showATR, showSMA20,
      showVWAP, showWMA, showDonchian, showKeltner, showRSI, showMACD,
      activeOscillators, JSON.stringify(indParams), JSON.stringify(oscParams),
      activeRustIds, JSON.stringify(rustParams),
    ];
    if (persistReady && _track.length) saveIndicatorState();
  });

  // ─── Timeframes ────────────────────────────────────────────────────────────
  const timeframes = [
    { id: '1m', label: '1m' }, { id: '5m', label: '5m' },
    { id: '15m', label: '15m' }, { id: '30m', label: '30m' },
    { id: '1h', label: '1H' }, { id: '4h', label: '4H' },
    { id: '1D', label: '1D' }, { id: '1W', label: '1W' },
  ];

  // ─── Quick picks ───────────────────────────────────────────────────────────
  const quickPicks = ['MGC', 'MES', 'MNQ', 'MCL', 'BTC/USD', 'ETH/USD', 'SOL/USD'];

  // ─── Symbol search ─────────────────────────────────────────────────────────
  let searchQuery = $state('');
  let searchResults = $state<AssetSearchResult[]>([]);
  let showDropdown = $state(false);
  let searchTimeout: ReturnType<typeof setTimeout> | null = null;

  // ─── EMA (client-side) ─────────────────────────────────────────────────────
  function calcEMA(data: CandleData[], period: number): { time: any; value: number }[] {
    if (data.length < period) return [];
    const k = 2 / (period + 1);
    const result: { time: any; value: number }[] = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += data[i].close;
    let ema = sum / period;
    result.push({ time: data[period - 1].time, value: ema });
    for (let i = period; i < data.length; i++) {
      ema = data[i].close * k + ema * (1 - k);
      result.push({ time: data[i].time, value: ema });
    }
    return result;
  }

  // ─── Overlay management ───────────────────────────────────────────────────
  function addEma9() {
    if (!chart || ema9Series) return;
    ema9Series = chart.addLineSeries({
      color: '#00e5ff', lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, title: `EMA ${indParams.ema9.period}`,
    });
    ema9Series.setData(calcEMA(candles, indParams.ema9.period));
  }
  function removeEma9() {
    if (!chart || !ema9Series) return;
    chart.removeSeries(ema9Series);
    ema9Series = null;
  }

  function addEma21() {
    if (!chart || ema21Series) return;
    ema21Series = chart.addLineSeries({
      color: '#b388ff', lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, title: `EMA ${indParams.ema21.period}`,
    });
    ema21Series.setData(calcEMA(candles, indParams.ema21.period));
  }
  function removeEma21() {
    if (!chart || !ema21Series) return;
    chart.removeSeries(ema21Series);
    ema21Series = null;
  }

  function addVolume() {
    if (!chart || volumeSeries) return;
    volumeSeries = chart.addHistogramSeries({
      color: '#26a69a80', priceFormat: { type: 'volume' },
      priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false,
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false });
    volumeSeries.setData(candles.map((c) => ({
      time: c.time, value: c.volume,
      color: c.close >= c.open ? '#16c78440' : '#ea394340',
    })));
  }
  function removeVolume() {
    if (!chart || !volumeSeries) return;
    chart.removeSeries(volumeSeries);
    volumeSeries = null;
  }

  function refreshOverlays() {
    if (showEma9 && ema9Series) ema9Series.setData(calcEMA(candles, indParams.ema9.period));
    if (showEma21 && ema21Series) ema21Series.setData(calcEMA(candles, indParams.ema21.period));
    if (showVolume && volumeSeries) {
      volumeSeries.setData(candles.map((c) => ({
        time: c.time, value: c.volume,
        color: c.close >= c.open ? '#16c78440' : '#ea394340',
      })));
    }
  }

  function updateCandleCache(candle: CandleData) {
    const last = candles.length - 1;
    if (last >= 0 && candles[last].time === candle.time) {
      candles[last] = candle;
      candles = candles; // trigger reactivity
    } else {
      candles = [...candles, candle];
    }
    refreshOverlays();
    // Live-update RSI series if open
    if (showRSI && rsiSeries && candles.length >= 14) {
      // We don't recalc server-side RSI on every tick — that would be too many API calls.
      // The RSI pane shows the last server fetch; a refresh button can be used.
    }
  }

  // ─── Server-side indicators ────────────────────────────────────────────────
  async function loadBBands() {
    if (!chart) return;
    // Remove stale series
    if (bbUpperSeries) { chart.removeSeries(bbUpperSeries); bbUpperSeries = null; }
    if (bbMidSeries)   { chart.removeSeries(bbMidSeries);   bbMidSeries = null; }
    if (bbLowSeries)   { chart.removeSeries(bbLowSeries);   bbLowSeries = null; }
    if (!showBB) return;

    try {
      const { period, std } = indParams.bb;
      const res = await api.get<{ indicators?: Record<string, IndicatorPoint[]> }>(
        `/api/chart/${encodeURIComponent(apiSymbol)}/indicators?interval=${interval}&days_back=5&indicators=bb:${period}:${std}`
      );
      const ind = res.indicators ?? {};
      if (ind.bb_upper?.length && chart) {
        const lineOpts = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
        bbUpperSeries = chart.addLineSeries({ ...lineOpts, color: '#ffa72680', lineWidth: 1, title: 'BB+' });
        bbUpperSeries.setData(ind.bb_upper);
        bbMidSeries = chart.addLineSeries({ ...lineOpts, color: '#ffa72640', lineWidth: 1, lineStyle: 2 });
        bbMidSeries.setData(ind.bb_middle ?? []);
        bbLowSeries = chart.addLineSeries({ ...lineOpts, color: '#ffa72680', lineWidth: 1, title: 'BB-' });
        bbLowSeries.setData(ind.bb_lower ?? []);
      }
    } catch (e) {
      console.warn('[charts] BBands load failed:', e);
    }
  }

  async function initRSIChart() {
    if (!rsiChartEl) return;
    const { createChart } = await import('lightweight-charts');
    if (rsiChart) rsiChart.remove();

    rsiChart = createChart(rsiChartEl, {
      layout: {
        background: { type: 'solid' as any, color: '#07070d' },
        textColor: '#8890b8',
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        fontSize: 9,
      },
      grid: { vertLines: { color: '#1a1a2e' }, horzLines: { color: '#0d0d1a' } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: '#1a1a2e', minimumWidth: 40 },
      timeScale: { borderColor: '#1a1a2e', timeVisible: true, secondsVisible: false },
      handleScale: false,
      handleScroll: false,
    });

    rsiSeries = rsiChart.addLineSeries({
      color: '#6366f1', lineWidth: 1,
      priceLineVisible: false, lastValueVisible: true,
    });

    // Overbought / oversold reference lines
    const rsiRef = rsiChart.addLineSeries({
      color: '#ea394330', lineWidth: 1, lineStyle: 1,
      priceLineVisible: false, lastValueVisible: false,
    });

    await loadRSIData(rsiRef);

    // Sync time scale with main chart
    if (chart) {
      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (range && rsiChart) rsiChart.timeScale().setVisibleLogicalRange(range);
      });
      rsiChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (range && chart) chart.timeScale().setVisibleLogicalRange(range);
      });
    }
  }

  async function loadRSIData(refSeries?: any) {
    if (!rsiSeries) return;
    indicatorLoading = true;
    try {
      const res = await api.get<{ indicators?: Record<string, IndicatorPoint[]> }>(
        `/api/chart/${encodeURIComponent(apiSymbol)}/indicators?interval=${interval}&days_back=5&indicators=rsi:${indParams.rsi.period}`
      );
      const rsiData = res.indicators?.rsi ?? [];
      rsiSeries.setData(rsiData);
      rsiChart?.timeScale().fitContent();

      // Overbought/oversold dashed reference lines
      if (refSeries && rsiData.length > 1) {
        const times = [rsiData[0].time, rsiData[rsiData.length - 1].time];
        refSeries.setData(
          [...times.map((t) => ({ time: t, value: 70 })),
           ...times.map((t) => ({ time: t, value: 30 }))]
            .sort((a, b) => a.time - b.time)
        );
      }
    } catch (e) {
      console.warn('[charts] RSI load failed:', e);
    } finally {
      indicatorLoading = false;
    }
  }

  // ─── ATR overlay (server-side, price axis) ─────────────────────────────────
  async function loadATR() {
    if (!chart) return;
    if (atrSeries) { chart.removeSeries(atrSeries); atrSeries = null; }
    if (!showATR) return;
    indicatorLoading = true;
    try {
      const res = await api.get<{ indicators?: Record<string, IndicatorPoint[]> }>(
        `/api/chart/${encodeURIComponent(apiSymbol)}/indicators?interval=${interval}&days_back=5&indicators=atr:${indParams.atr.period}`
      );
      const atrData = res.indicators?.atr ?? [];
      if (atrData.length && chart) {
        atrSeries = chart.addLineSeries({
          color: '#f59e0b',
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
          title: `ATR ${indParams.atr.period}`,
          priceScaleId: 'atr',
        });
        chart.priceScale('atr').applyOptions({
          scaleMargins: { top: 0.8, bottom: 0 },
          borderVisible: false,
        });
        atrSeries.setData(atrData);
      }
    } catch (e) {
      console.warn('[charts] ATR load failed:', e);
    } finally {
      indicatorLoading = false;
    }
  }

  // ─── SMA / VWAP overlays (server-side) ─────────────────────────────────────
  async function loadSMA20() {
    if (!chart) return;
    if (sma20Series) { chart.removeSeries(sma20Series); sma20Series = null; }
    if (!showSMA20) return;
    indicatorLoading = true;
    try {
      const p = indParams.sma20.period;
      const res = await api.get<{ indicators?: Record<string, IndicatorPoint[]> }>(
        `/api/chart/${encodeURIComponent(apiSymbol)}/indicators?interval=${interval}&days_back=5&indicators=sma${p}`
      );
      const data = res.indicators?.[`sma${p}`] ?? [];
      if (data.length && chart) {
        sma20Series = chart.addLineSeries({
          color: '#eab308', lineWidth: 1,
          priceLineVisible: false, lastValueVisible: false,
          crosshairMarkerVisible: false, title: `SMA ${p}`,
        });
        sma20Series.setData(data);
      }
    } catch (e) {
      console.warn('[charts] SMA load failed:', e);
    } finally {
      indicatorLoading = false;
    }
  }

  async function loadVWAP() {
    if (!chart) return;
    if (vwapSeries) { chart.removeSeries(vwapSeries); vwapSeries = null; }
    if (!showVWAP) return;
    indicatorLoading = true;
    try {
      const res = await api.get<{ indicators?: Record<string, IndicatorPoint[]> }>(
        `/api/chart/${encodeURIComponent(apiSymbol)}/indicators?interval=${interval}&days_back=5&indicators=vwap`
      );
      const data = res.indicators?.vwap ?? [];
      if (data.length && chart) {
        vwapSeries = chart.addLineSeries({
          color: '#e879f9', lineWidth: 1,
          priceLineVisible: false, lastValueVisible: false,
          crosshairMarkerVisible: false, title: 'VWAP',
        });
        vwapSeries.setData(data);
      }
    } catch (e) {
      console.warn('[charts] VWAP load failed:', e);
    } finally {
      indicatorLoading = false;
    }
  }

  async function loadWMA() {
    if (!chart) return;
    if (wmaSeries) { chart.removeSeries(wmaSeries); wmaSeries = null; }
    if (!showWMA) return;
    indicatorLoading = true;
    try {
      const p = indParams.wma.period;
      const res = await api.get<{ indicators?: Record<string, IndicatorPoint[]> }>(
        `/api/chart/${encodeURIComponent(apiSymbol)}/indicators?interval=${interval}&days_back=5&indicators=wma${p}`
      );
      const data = res.indicators?.[`wma${p}`] ?? [];
      if (data.length && chart) {
        wmaSeries = chart.addLineSeries({
          color: '#34d399', lineWidth: 1,
          priceLineVisible: false, lastValueVisible: false,
          crosshairMarkerVisible: false, title: `WMA ${p}`,
        });
        wmaSeries.setData(data);
      }
    } catch (e) {
      console.warn('[charts] WMA load failed:', e);
    } finally {
      indicatorLoading = false;
    }
  }

  async function loadDonchian() {
    if (!chart) return;
    if (dcUpperSeries) { chart.removeSeries(dcUpperSeries); dcUpperSeries = null; }
    if (dcMidSeries)   { chart.removeSeries(dcMidSeries);   dcMidSeries = null; }
    if (dcLowSeries)   { chart.removeSeries(dcLowSeries);   dcLowSeries = null; }
    if (!showDonchian) return;
    try {
      const res = await api.get<{ indicators?: Record<string, IndicatorPoint[]> }>(
        `/api/chart/${encodeURIComponent(apiSymbol)}/indicators?interval=${interval}&days_back=5&indicators=donchian:${indParams.donchian.period}`
      );
      const ind = res.indicators ?? {};
      if (ind.dc_upper?.length && chart) {
        const lineOpts = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
        dcUpperSeries = chart.addLineSeries({ ...lineOpts, color: '#38bdf880', lineWidth: 1, title: 'DC+' });
        dcUpperSeries.setData(ind.dc_upper);
        dcMidSeries = chart.addLineSeries({ ...lineOpts, color: '#38bdf840', lineWidth: 1, lineStyle: 2 });
        dcMidSeries.setData(ind.dc_middle ?? []);
        dcLowSeries = chart.addLineSeries({ ...lineOpts, color: '#38bdf880', lineWidth: 1, title: 'DC-' });
        dcLowSeries.setData(ind.dc_lower ?? []);
      }
    } catch (e) {
      console.warn('[charts] Donchian load failed:', e);
    }
  }

  async function loadKeltner() {
    if (!chart) return;
    if (kcUpperSeries) { chart.removeSeries(kcUpperSeries); kcUpperSeries = null; }
    if (kcMidSeries)   { chart.removeSeries(kcMidSeries);   kcMidSeries = null; }
    if (kcLowSeries)   { chart.removeSeries(kcLowSeries);   kcLowSeries = null; }
    if (!showKeltner) return;
    try {
      const { period, mult } = indParams.keltner;
      const res = await api.get<{ indicators?: Record<string, IndicatorPoint[]> }>(
        `/api/chart/${encodeURIComponent(apiSymbol)}/indicators?interval=${interval}&days_back=5&indicators=keltner:${period}:${mult}`
      );
      const ind = res.indicators ?? {};
      if (ind.kc_upper?.length && chart) {
        const lineOpts = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
        kcUpperSeries = chart.addLineSeries({ ...lineOpts, color: '#c084fc80', lineWidth: 1, title: 'KC+' });
        kcUpperSeries.setData(ind.kc_upper);
        kcMidSeries = chart.addLineSeries({ ...lineOpts, color: '#c084fc40', lineWidth: 1, lineStyle: 2 });
        kcMidSeries.setData(ind.kc_middle ?? []);
        kcLowSeries = chart.addLineSeries({ ...lineOpts, color: '#c084fc80', lineWidth: 1, title: 'KC-' });
        kcLowSeries.setData(ind.kc_lower ?? []);
      }
    } catch (e) {
      console.warn('[charts] Keltner load failed:', e);
    }
  }

  // ─── MACD sub-pane ─────────────────────────────────────────────────────────
  async function initMACDChart() {
    if (!macdChartEl) return;
    const { createChart } = await import('lightweight-charts');
    if (macdChart) macdChart.remove();

    macdChart = createChart(macdChartEl, {
      layout: {
        background: { type: 'solid' as any, color: '#07070d' },
        textColor: '#8890b8',
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        fontSize: 9,
      },
      grid: { vertLines: { color: '#1a1a2e' }, horzLines: { color: '#0d0d1a' } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: '#1a1a2e', minimumWidth: 40 },
      timeScale: { borderColor: '#1a1a2e', timeVisible: true, secondsVisible: false },
      handleScale: false,
      handleScroll: false,
    });

    // Histogram bars (green above zero, red below)
    macdHistSeries = macdChart.addHistogramSeries({
      priceLineVisible: false,
      lastValueVisible: false,
    });
    // Zero reference line on the histogram
    macdHistSeries.createPriceLine({
      price: 0,
      color: '#444466',
      lineWidth: 1,
      lineStyle: 0,
      axisLabelVisible: false,
    });

    // MACD line (blue)
    macdLineSeries = macdChart.addLineSeries({
      color: '#2196f3',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      title: 'MACD',
    });

    // Signal line (orange)
    macdSignalSeries = macdChart.addLineSeries({
      color: '#ff9800',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      title: 'Signal',
    });

    await loadMACDData();

    // Sync time scale with main chart (bi-directional)
    if (chart) {
      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (range && macdChart) macdChart.timeScale().setVisibleLogicalRange(range);
      });
      macdChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (range && chart) chart.timeScale().setVisibleLogicalRange(range);
      });
    }
  }

  async function loadMACDData() {
    if (!macdHistSeries || !macdLineSeries || !macdSignalSeries) return;
    indicatorLoading = true;
    try {
      const { fast, slow, signal } = indParams.macd;
      const res = await api.get<{ indicators?: Record<string, IndicatorPoint[]> }>(
        `/api/chart/${encodeURIComponent(apiSymbol)}/indicators?interval=${interval}&days_back=5&indicators=macd:${fast}:${slow}:${signal}`
      );
      const ind = res.indicators ?? {};
      // Histogram bars: green above zero, red below
      const histData = (ind.macd_hist ?? []).map((p: IndicatorPoint) => ({
        time: p.time,
        value: p.value,
        color: p.value >= 0 ? '#26a69a80' : '#ef535080',
      }));
      macdHistSeries.setData(histData);
      macdLineSeries.setData(ind.macd_line ?? []);
      macdSignalSeries.setData(ind.macd_signal ?? []);
      macdChart?.timeScale().fitContent();
    } catch (e) {
      console.warn('[charts] MACD load failed:', e);
    } finally {
      indicatorLoading = false;
    }
  }

  // ─── Asset registry lookup (REG-C) ────────────────────────────────────────
  async function lookupAsset(sym: string) {
    const short = sym.split('/')[0];
    try {
      const data = await api.get<AssetInfo>(`/api/assets/${encodeURIComponent(short)}`);
      assetInfo = data;
    } catch {
      // Fallback heuristic: slash means crypto
      assetInfo = sym.includes('/')
        ? { type: 'crypto', source: 'kraken', source_chain: ['kraken'] }
        : { type: 'futures', source: 'rithmic', source_chain: ['rithmic'] };
    }
  }

  // ─── Kraken WebSocket (CHART-B) ────────────────────────────────────────────
  function disconnectKrakenWS() {
    if (krakenReconnectTimer) { clearTimeout(krakenReconnectTimer); krakenReconnectTimer = null; }
    if (krakenFailTimer)      { clearTimeout(krakenFailTimer);      krakenFailTimer = null; }
    if (krakenWS) {
      krakenWS.onclose = null; // prevent auto-reconnect
      krakenWS.close();
      krakenWS = null;
    }
    krakenConnected = false;
  }

  function connectKrakenWS(ticker: string) {
    disconnectKrakenWS();
    const minutes = TF_TO_KRAKEN[interval] ?? 1;

    const ws = new WebSocket('wss://ws.kraken.com/v2');
    krakenWS = ws;

    // 5-second guard: if no OHLC data arrives, fall back to Binance
    krakenFailTimer = setTimeout(() => {
      krakenFailTimer = null;
      if (activeSource !== 'kraken' && isCrypto) {
        console.warn('[KrakenWS] 5 s timeout — falling back to Binance');
        disconnectKrakenWS();
        connectBinanceWS(symbol, interval);
      }
    }, 5000);

    ws.onopen = () => {
      krakenConnected = true;
      ws.send(JSON.stringify({
        method: 'subscribe',
        params: { channel: 'ohlc', symbol: [ticker], interval: minutes },
      }));
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as any;
        if (msg.channel === 'ohlc' && Array.isArray(msg.data)) {
          // First OHLC frame confirms Kraken is delivering data — cancel fallback timer
          if (krakenFailTimer) { clearTimeout(krakenFailTimer); krakenFailTimer = null; }
          activeSource = 'kraken';
          for (const bar of msg.data) {
            // interval_begin is the candle open time
            const time = Math.floor(new Date(bar.interval_begin as string).getTime() / 1000);
            const candle: CandleData = {
              time: time as any,
              open: parseFloat(bar.open),
              high: parseFloat(bar.high),
              low: parseFloat(bar.low),
              close: parseFloat(bar.close),
              volume: parseFloat(bar.volume ?? bar.volume_buy ?? '0'),
            };
            if (candleSeries) candleSeries.update(candle);
            updateCandleCache(candle);
          }
        }
      } catch { /* ignore malformed */ }
    };

    ws.onerror = () => {
      console.warn('[KrakenWS] connection error for', ticker);
      // Cancel fail timer and immediately switch to Binance
      if (krakenFailTimer) { clearTimeout(krakenFailTimer); krakenFailTimer = null; }
      if (activeSource !== 'binance' && isCrypto) {
        disconnectKrakenWS();
        connectBinanceWS(symbol, interval);
      }
    };

    ws.onclose = () => {
      krakenConnected = false;
      if (activeSource === 'kraken') {
        // Was actively delivering — attempt a Kraken reconnect cycle
        activeSource = 'none';
        if (krakenWS === ws && isCrypto) {
          krakenReconnectTimer = setTimeout(() => {
            if (isCrypto) connectKrakenWS(ticker);
          }, 5000);
        }
      }
      // activeSource === 'binance' → Binance already running, leave it alone
      // activeSource === 'none'    → fail timer already scheduled the fallback
    };
  }

  // ─── Binance WebSocket (fallback) ──────────────────────────────────────────
  /**
   * Map an FKS symbol to a Binance lowercase USDT pair.
   * Uses `provider_symbols.binance` from the registry when available;
   * otherwise derives it from the base symbol (e.g. BTC/USD → btcusdt).
   */
  function toBinanceSymbol(sym: string): string {
    const regSym = assetInfo.provider_symbols?.binance;
    if (regSym) return regSym.toLowerCase();
    const base = sym.includes('/') ? sym.split('/')[0] : sym;
    const norm = base.toUpperCase() === 'XBT' ? 'BTC' : base.toUpperCase();
    return `${norm.toLowerCase()}usdt`;
  }

  function disconnectBinanceWS() {
    if (binanceReconnectTimer) { clearTimeout(binanceReconnectTimer); binanceReconnectTimer = null; }
    if (binanceWS) {
      binanceWS.onclose = null; // prevent auto-reconnect
      binanceWS.close();
      binanceWS = null;
    }
    binanceConnected = false;
  }

  function connectBinanceWS(sym: string, tf: string) {
    disconnectBinanceWS();
    binanceReconnectDelay = 1000; // reset back-off for new connection session

    const binanceSymbol = toBinanceSymbol(sym);
    const binanceInterval = TF_TO_BINANCE[tf] ?? '1m';
    const url = `wss://stream.binance.com:9443/ws/${binanceSymbol}@kline_${binanceInterval}`;
    console.info('[BinanceWS] connecting:', url);

    const ws = new WebSocket(url);
    binanceWS = ws;

    ws.onopen = () => {
      binanceConnected = true;
      activeSource = 'binance';
      binanceReconnectDelay = 1000; // reset on successful open
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as any;
        if (msg.e === 'kline' && msg.k) {
          const k = msg.k;
          const candle: CandleData = {
            time: Math.floor(k.t / 1000) as any,
            open:   parseFloat(k.o),
            high:   parseFloat(k.h),
            low:    parseFloat(k.l),
            close:  parseFloat(k.c),
            volume: parseFloat(k.v),
          };
          if (candleSeries) candleSeries.update(candle);
          updateCandleCache(candle);
        }
      } catch { /* ignore malformed */ }
    };

    ws.onerror = () => console.warn('[BinanceWS] connection error for', binanceSymbol);

    ws.onclose = () => {
      binanceConnected = false;
      if (binanceWS === ws && isCrypto) {
        // Exponential back-off, capped at 30 s
        const delay = binanceReconnectDelay;
        binanceReconnectDelay = Math.min(binanceReconnectDelay * 2, 30_000);
        binanceReconnectTimer = setTimeout(() => {
          if (isCrypto) connectBinanceWS(sym, tf);
        }, delay);
      }
    };
  }

  // ─── SSE bars (futures) ────────────────────────────────────────────────────
  function connectBarSSE() {
    if (barSSE) barSSE.disconnect();
    barSSE = createSSE<BarUpdate>(`/sse/bars/${symbol}`, { eventName: 'bar' });
    barSSE.subscribe((bar: BarUpdate | null) => {
      if (!bar || !candleSeries) return;
      try {
        const time = typeof bar.time === 'number'
          ? bar.time
          : Math.floor(new Date(bar.time).getTime() / 1000);
        const candle: CandleData = {
          time: time as any,
          open: bar.open, high: bar.high, low: bar.low, close: bar.close,
          volume: bar.volume ?? 0,
        };
        candleSeries.update(candle);
        updateCandleCache(candle);
      } catch { /* ignore */ }
    });
    barSSE.connect();
  }

  function disconnectLiveData() {
    disconnectKrakenWS();   // also cancels krakenFailTimer
    disconnectBinanceWS();
    if (barSSE) { barSSE.disconnect(); barSSE = null; }
    activeSource = 'none';
  }

  // ─── History backfill ──────────────────────────────────────────────────────
  // When the visible range nears the oldest loaded bar, fetch older candles
  // and prepend them. Local overlays (EMA/volume) recompute over the merged
  // series; server-computed overlays keep their original window.
  //
  // A single visible-range event runs a fetch *burst*: after each successful
  // prepend the CURRENT visible logical range is re-checked, and fetching
  // continues while the left edge is still starved (barsBefore < threshold) —
  // so one big zoom-out fills the whole gap instead of loading one page per
  // user interaction. Bounded by BACKFILL_MAX_PAGES per burst; empty pages
  // widen the days window (gap crossing) and count against the same cap, so
  // the exhausted case (common here — QuestDB only has recent data) converges
  // in ≤3 requests and then never refires (backfillDone).
  const BACKFILL_TRIGGER_BARS = 30;
  const BACKFILL_MAX_PAGES = 12;

  async function maybeBackfill(range: any) {
    if (!range || backfillBusy || backfillDone || !candleSeries || candles.length === 0) return;
    const first = candleSeries.barsInLogicalRange(range);
    if (!first || first.barsBefore > BACKFILL_TRIGGER_BARS) return;

    backfillBusy = true;
    const seq = loadSeq;
    try {
      for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
        if (backfillDone || !candleSeries || candles.length === 0) return;
        const oldestSec = candles[0].time as number;
        const res = await fetch(
          `/bars/${encodeURIComponent(apiSymbol)}/candles?interval=${interval}&days_back=${backfillWindowDays}&limit=1000&before=${oldestSec * 1000}`,
          { headers: { Accept: 'application/json' } }
        );
        const data = await res.json();
        if (seq !== loadSeq) return; // chart was reloaded while we were fetching
        // Anchor check: if the array head moved while we awaited (reload race,
        // any external mutation), this batch was computed against stale state.
        if (candles.length === 0 || (candles[0].time as number) !== oldestSec) return;

        const older: CandleData[] = (Array.isArray(data.candles) ? (data.candles as CandleBar[]) : [])
          .map((c) => ({
            time: Math.floor(c.timestamp / 1000) as any,
            open: c.open, high: c.high, low: c.low, close: c.close,
            volume: c.volume ?? 0,
          }))
          .filter((c) => (c.time as number) < oldestSec); // drop any seam duplicate

        if (older.length === 0) {
          // Empty page ≠ end of history: a data gap wider than the window looks
          // identical. Widen the window (up to the server's 365-day cap) before
          // declaring the history exhausted. Widening retries continue within
          // this burst (they count toward the page cap).
          if (backfillWindowDays < 365) {
            backfillWindowDays = Math.min(365, backfillWindowDays * 4);
            continue;
          }
          backfillDone = true; // nothing within a full year behind the cutoff
          return;
        }
        backfillWindowDays = 30; // gap crossed (or normal page) — reset the window
        candles = [...older, ...candles];
        candleSeries.setData(candles);
        refreshOverlays();

        // Re-check the CURRENT visible range (prepending shifts logical
        // indices; the event's range is stale). Keep fetching while the left
        // edge is still starved — e.g. after a single deep zoom-out.
        const now = chart?.timeScale().getVisibleLogicalRange();
        const info = now && candleSeries ? candleSeries.barsInLogicalRange(now) : null;
        if (!info || info.barsBefore > BACKFILL_TRIGGER_BARS) return;
      }
    } catch {
      // transient failure — retry on the next range change
    } finally {
      if (seq === loadSeq) backfillBusy = false;
    }
  }

  // ─── Main chart load ───────────────────────────────────────────────────────
  async function loadChart() {
    if (!chartContainer) return;
    loading = true;
    barsError = false;
    loadSeq += 1;
    backfillBusy = false;
    backfillDone = false;
    backfillWindowDays = 30;

    // Tear down BEFORE the dynamic import: the old chart's visible-range
    // subscription must die in the same macrotask as the loadSeq bump, or a
    // range event during the await could start a backfill that captures the
    // new seq while anchored to the old symbol's candles.
    disconnectLiveData();
    ema9Series = null; ema21Series = null; volumeSeries = null;
    bbUpperSeries = null; bbMidSeries = null; bbLowSeries = null;
    atrSeries = null; sma20Series = null; vwapSeries = null;
    wmaSeries = null;
    dcUpperSeries = null; dcMidSeries = null; dcLowSeries = null;
    kcUpperSeries = null; kcMidSeries = null; kcLowSeries = null;
    if (chart) chart.remove();
    chart = null;
    candleSeries = null;

    const { createChart } = await import('lightweight-charts');

    chart = createChart(chartContainer, {
      layout: {
        background: { type: 'solid' as any, color: '#07070d' },
        textColor: '#8890b8',
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        fontSize: 11,
      },
      grid: { vertLines: { color: '#1a1a2e' }, horzLines: { color: '#1a1a2e' } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: '#1a1a2e' },
      timeScale: { borderColor: '#1a1a2e', timeVisible: true, secondsVisible: false },
    });

    candleSeries = chart.addCandlestickSeries({
      upColor: '#16c784', downColor: '#ea3943',
      borderUpColor: '#16c784', borderDownColor: '#ea3943',
      wickUpColor: '#16c784', wickDownColor: '#ea3943',
    });

    // Crosshair OHLC readout — reflect the hovered bar (cleared on leave).
    const cs: any = candleSeries;
    chart.subscribeCrosshairMove((param: any) => {
      const d = cs ? param?.seriesData?.get(cs) : null;
      if (d && typeof d.close === 'number') {
        const chg = d.open ? ((d.close - d.open) / d.open) * 100 : 0;
        hoverBar = { o: d.open, h: d.high, l: d.low, c: d.close, chg };
      } else {
        hoverBar = null;
      }
    });

    // Keep the chosen price-scale mode + auto-fit across reloads.
    chart.applyOptions({ rightPriceScale: { mode: scaleMode as any, autoScale: scaleAuto } });

    // Resolve asset data source
    await lookupAsset(symbol);

    // Fetch historical bars
    try {
      const res = await fetch(
        `/bars/${encodeURIComponent(apiSymbol)}/candles?interval=${interval}&days_back=30&limit=5000`,
        { headers: { Accept: 'application/json' } }
      );
      const data = await res.json();

      if (Array.isArray(data.candles) && data.candles.length > 0) {
        candles = (data.candles as CandleBar[]).map((c) => ({
          time: Math.floor(c.timestamp / 1000) as any,
          open: c.open, high: c.high, low: c.low, close: c.close,
          volume: c.volume ?? 0,
        }));
        candleSeries?.setData(candles);
        chart?.timeScale().fitContent();
        // Older history loads on demand as the user zooms/pans toward the left edge.
        chart?.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
          void maybeBackfill(range);
        });
      } else {
        candles = [];
      }
    } catch (e) {
      console.warn('[charts] Failed to load bars:', e);
      candles = [];
      barsError = true;
    } finally {
      loading = false;
    }

    // Re-add active overlays
    if (showEma9) addEma9();
    if (showEma21) addEma21();
    if (showVolume) addVolume();
    if (showBB) await loadBBands();
    if (showATR) await loadATR();
    if (showSMA20) await loadSMA20();
    if (showVWAP) await loadVWAP();
    if (showWMA) await loadWMA();
    if (showDonchian) await loadDonchian();
    if (showKeltner) await loadKeltner();

    // Reconnect RSI if open
    if (showRSI) {
      if (rsiChart) {
        // Just reload data for existing RSI chart
        await loadRSIData();
        // Re-wire time scale sync
        chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
          if (range && rsiChart) rsiChart.timeScale().setVisibleLogicalRange(range);
        });
      }
    }

    // Reconnect MACD if open
    if (showMACD) {
      if (macdChart) {
        await loadMACDData();
        chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
          if (range && macdChart) macdChart.timeScale().setVisibleLogicalRange(range);
        });
      }
    }

    // Connect live data feed — honour the registry source_chain order
    if (isCrypto) {
      const chain = assetInfo.source_chain ?? ['kraken'];
      if (chain[0] === 'binance') {
        // Asset explicitly lists Binance as primary source
        connectBinanceWS(symbol, interval);
      } else {
        // Kraken is primary; connectKrakenWS will auto-fall-back to Binance
        // after 5 s if no data arrives (or immediately on error)
        connectKrakenWS(krakenTicker);
      }
    } else {
      connectBarSSE();
    }
  }

  // ─── Indicator toggles ─────────────────────────────────────────────────────
  function toggleEma9() {
    showEma9 = !showEma9;
    if (showEma9) addEma9(); else removeEma9();
  }
  function toggleEma21() {
    showEma21 = !showEma21;
    if (showEma21) addEma21(); else removeEma21();
  }
  function toggleVolume() {
    showVolume = !showVolume;
    if (showVolume) addVolume(); else removeVolume();
  }
  async function toggleBB() {
    showBB = !showBB;
    await loadBBands();
  }
  async function toggleRSI() {
    showRSI = !showRSI;
    if (showRSI) {
      await tick(); // let DOM mount rsiChartEl
      // $effect handles initRSIChart when rsiChartEl becomes available
    }
  }
  async function toggleMACD() {
    showMACD = !showMACD;
    if (showMACD) {
      await tick(); // let DOM mount macdChartEl
      // $effect handles initMACDChart when macdChartEl becomes available
    }
  }
  async function toggleATR() {
    showATR = !showATR;
    await loadATR();
  }
  async function toggleSMA20() {
    showSMA20 = !showSMA20;
    await loadSMA20();
  }
  async function toggleVWAP() {
    showVWAP = !showVWAP;
    await loadVWAP();
  }
  async function toggleWMA() {
    showWMA = !showWMA;
    await loadWMA();
  }
  async function toggleDonchian() {
    showDonchian = !showDonchian;
    await loadDonchian();
  }
  async function toggleKeltner() {
    showKeltner = !showKeltner;
    await loadKeltner();
  }

  // ─── Oscillator sub-pane picker (catalog-driven) ───────────────────────────
  async function loadOscillatorCatalog() {
    try {
      const cat = await api.get<{ id: string; label: string; pane: string; keys: string[] }[]>(
        '/api/indicators/catalog'
      );
      const buttoned = new Set(['rsi', 'macd', 'atr']);
      oscillatorCatalog = (cat ?? [])
        .filter((c) => c.pane === 'separate' && !buttoned.has(c.id))
        .map((c) => ({ id: c.id, label: c.label, keys: c.keys }));
    } catch {
      oscillatorCatalog = [];
    }
  }
  function addOscillator(m: OscMeta) {
    if (!activeOscillators.some((x) => x.id === m.id)) {
      activeOscillators = [...activeOscillators, m];
    }
  }
  function removeOscillator(id: string) {
    activeOscillators = activeOscillators.filter((x) => x.id !== id);
    if (editorId === `osc:${id}`) editorId = null;
  }

  // ── Rust indicators-ta catalog (janus) ──────────────────────────────────────
  // Fetch janus's Rust catalog and keep only the Rust-ONLY descriptors (TS wins
  // for concepts already wired). Failure/empty → rustCatalog stays [] so the
  // dropdown degrades to exactly today's TS indicators.
  async function loadRustCatalog() {
    try {
      const resp = await api.get<RustCatalogResponse>('/api/janus/indicators/catalog');
      rustCatalog = rustOnlyIndicators(parseRustCatalog(resp));
    } catch {
      rustCatalog = [];
    }
  }
  function addRustIndicator(id: string) {
    if (!rustById(id)) return;
    if (!activeRustIds.includes(id)) activeRustIds = [...activeRustIds, id];
  }
  function removeRustIndicator(id: string) {
    activeRustIds = activeRustIds.filter((x) => x !== id);
    if (editorId === `rust:${id}`) editorId = null;
  }

  // ─── TW-style Indicators menu ──────────────────────────────────────────────
  // One dropdown, grouped Overlays / Oscillators. Clicking toggles the entry
  // (active rows are checked); the menu stays open for multi-add and closes on
  // outside click or Esc.
  interface MenuItem { id: string; label: string; color: string; active: boolean; ta?: boolean; }

  // Rust-only descriptors split by pane, marked `ta` (from the indicators-ta
  // crate). Appended after the TS entries within each group.
  let rustOverlayMenu = $derived<MenuItem[]>(
    rustCatalog
      .filter((r) => r.category === 'Overlay')
      .map((r) => ({ id: `rust:${r.id}`, label: r.display_name, color: '#22d3ee', active: activeRustIds.includes(r.id), ta: true })),
  );
  let rustOscMenu = $derived<MenuItem[]>(
    rustCatalog
      .filter((r) => r.category === 'Oscillator')
      .map((r) => ({ id: `rust:${r.id}`, label: r.display_name, color: '#22d3ee', active: activeRustIds.includes(r.id), ta: true })),
  );

  let overlayMenu = $derived<MenuItem[]>([
    { id: 'ema9',     label: `EMA ${indParams.ema9.period}`,   color: '#00e5ff', active: showEma9 },
    { id: 'ema21',    label: `EMA ${indParams.ema21.period}`,  color: '#b388ff', active: showEma21 },
    { id: 'sma20',    label: `SMA ${indParams.sma20.period}`,  color: '#eab308', active: showSMA20 },
    { id: 'wma',      label: `WMA ${indParams.wma.period}`,    color: '#34d399', active: showWMA },
    { id: 'vwap',     label: 'VWAP',                           color: '#e879f9', active: showVWAP },
    { id: 'bb',       label: `Bollinger Bands (${indParams.bb.period}, ${indParams.bb.std})`, color: '#ffa726', active: showBB },
    { id: 'donchian', label: `Donchian (${indParams.donchian.period})`, color: '#38bdf8', active: showDonchian },
    { id: 'keltner',  label: `Keltner (${indParams.keltner.period}, ${indParams.keltner.mult})`, color: '#c084fc', active: showKeltner },
    { id: 'volume',   label: 'Volume',                         color: '#26a69a', active: showVolume },
    { id: 'atr',      label: `ATR ${indParams.atr.period}`,    color: '#f59e0b', active: showATR },
  ]);

  // Live label for a catalog oscillator: base name + current params (the
  // catalog label bakes in the defaults, e.g. "Stochastic (14, 3)").
  const OSC_BASE_LABELS: Record<string, string> = {
    stoch: 'Stochastic', willr: 'Williams %R', cci: 'CCI', adx: 'ADX',
  };
  function oscLabel(m: OscMeta): string {
    const def = OSC_PARAM_DEFS[m.id];
    if (!def) return m.label;
    const p = oscParams[m.id] ?? def.defaults;
    return `${OSC_BASE_LABELS[m.id] ?? m.label} (${p.join(', ')})`;
  }

  let oscillatorMenu = $derived<MenuItem[]>([
    { id: 'rsi',  label: `RSI ${indParams.rsi.period}`, color: '#6366f1', active: showRSI },
    { id: 'macd', label: `MACD (${indParams.macd.fast}, ${indParams.macd.slow}, ${indParams.macd.signal})`, color: '#2196f3', active: showMACD },
    ...oscillatorCatalog.map((m) => ({
      id: `osc:${m.id}`,
      label: oscLabel(m),
      color: '#22d3ee',
      active: activeOscillators.some((x) => x.id === m.id),
    })),
  ]);

  async function toggleIndicator(id: string) {
    if (id.startsWith('osc:')) {
      const oid = id.slice(4);
      if (activeOscillators.some((x) => x.id === oid)) removeOscillator(oid);
      else {
        const m = oscillatorCatalog.find((x) => x.id === oid);
        if (m) addOscillator(m);
      }
      return;
    }
    if (id.startsWith('rust:')) {
      const rid = id.slice(5);
      if (activeRustIds.includes(rid)) removeRustIndicator(rid);
      else addRustIndicator(rid);
      return;
    }
    switch (id) {
      case 'ema9': toggleEma9(); break;
      case 'ema21': toggleEma21(); break;
      case 'sma20': await toggleSMA20(); break;
      case 'wma': await toggleWMA(); break;
      case 'vwap': await toggleVWAP(); break;
      case 'bb': await toggleBB(); break;
      case 'donchian': await toggleDonchian(); break;
      case 'keltner': await toggleKeltner(); break;
      case 'volume': toggleVolume(); break;
      case 'atr': await toggleATR(); break;
      case 'rsi': await toggleRSI(); break;
      case 'macd': await toggleMACD(); break;
    }
    if (editorId === id && !isIndicatorActive(id)) editorId = null;
  }

  function isIndicatorActive(id: string): boolean {
    return [...overlayMenu, ...oscillatorMenu, ...rustOverlayMenu, ...rustOscMenu]
      .find((m) => m.id === id)?.active ?? false;
  }

  // ─── On-chart legend (active overlays) + inline param editor ───────────────
  // Each active price-pane overlay gets a legend row: label, gear (edit params
  // in place), X (remove). VWAP / Volume have no free parameters — the editor
  // shows them as display-only.
  interface ParamField { key: string; label: string; step?: number; }
  interface LegendItem {
    id: string; label: string; color: string;
    fields: ParamField[]; // empty → display-only note
    note?: string;
  }

  const PERIOD: ParamField = { key: 'period', label: 'Length' };
  let legendItems = $derived<LegendItem[]>([
    ...(showEma9  ? [{ id: 'ema9',  label: `EMA ${indParams.ema9.period}`,  color: '#00e5ff', fields: [PERIOD] }] : []),
    ...(showEma21 ? [{ id: 'ema21', label: `EMA ${indParams.ema21.period}`, color: '#b388ff', fields: [PERIOD] }] : []),
    ...(showSMA20 ? [{ id: 'sma20', label: `SMA ${indParams.sma20.period}`, color: '#eab308', fields: [PERIOD] }] : []),
    ...(showWMA   ? [{ id: 'wma',   label: `WMA ${indParams.wma.period}`,   color: '#34d399', fields: [PERIOD] }] : []),
    ...(showVWAP  ? [{ id: 'vwap',  label: 'VWAP', color: '#e879f9', fields: [], note: 'Cumulative session VWAP — no parameters' }] : []),
    ...(showBB    ? [{ id: 'bb',    label: `BB (${indParams.bb.period}, ${indParams.bb.std})`, color: '#ffa726',
                       fields: [PERIOD, { key: 'std', label: 'StdDev', step: 0.1 }] }] : []),
    ...(showDonchian ? [{ id: 'donchian', label: `Donchian (${indParams.donchian.period})`, color: '#38bdf8', fields: [PERIOD] }] : []),
    ...(showKeltner  ? [{ id: 'keltner',  label: `Keltner (${indParams.keltner.period}, ${indParams.keltner.mult})`, color: '#c084fc',
                       fields: [PERIOD, { key: 'mult', label: 'Multiplier', step: 0.1 }] }] : []),
    ...(showVolume ? [{ id: 'volume', label: 'Volume', color: '#26a69a', fields: [], note: 'Bar volume — no parameters' }] : []),
    ...(showATR    ? [{ id: 'atr', label: `ATR ${indParams.atr.period}`, color: '#f59e0b', fields: [PERIOD] }] : []),
  ]);

  const clampPeriod = (v: number, def: number): number =>
    Number.isFinite(v) ? Math.min(500, Math.max(2, Math.round(v))) : def;
  const clampFactor = (v: number, def: number): number =>
    Number.isFinite(v) ? Math.min(10, Math.max(0.1, Math.round(v * 10) / 10)) : def;

  function openEditor(id: string) {
    if (editorId === id) { editorId = null; return; }
    editorDraft = { ...(indParams as any)[id] };
    editorId = id;
  }

  // Apply the draft params for `id`, clamp, persist, and reload that overlay/pane.
  async function applyEditor(id: string) {
    const cur = (indParams as any)[id] as Record<string, number>;
    const next: Record<string, number> = {};
    for (const [k, v] of Object.entries(cur)) {
      const draft = Number(editorDraft[k]);
      next[k] = k === 'std' || k === 'mult' ? clampFactor(draft, v) : clampPeriod(draft, v);
    }
    (indParams as any)[id] = next;
    editorId = null;
    await reloadIndicator(id);
  }

  // Recompute/refetch a single indicator after a param change.
  async function reloadIndicator(id: string) {
    switch (id) {
      case 'ema9':
        if (ema9Series) {
          ema9Series.applyOptions({ title: `EMA ${indParams.ema9.period}` });
          ema9Series.setData(calcEMA(candles, indParams.ema9.period));
        }
        break;
      case 'ema21':
        if (ema21Series) {
          ema21Series.applyOptions({ title: `EMA ${indParams.ema21.period}` });
          ema21Series.setData(calcEMA(candles, indParams.ema21.period));
        }
        break;
      case 'sma20': await loadSMA20(); break;
      case 'wma': await loadWMA(); break;
      case 'bb': await loadBBands(); break;
      case 'donchian': await loadDonchian(); break;
      case 'keltner': await loadKeltner(); break;
      case 'atr': await loadATR(); break;
      case 'rsi': await loadRSIData(); break;
      case 'macd': await loadMACDData(); break;
    }
  }

  // Remove an indicator from its legend/pane X (same as toggling it off).
  async function removeIndicator(id: string) {
    if (isIndicatorActive(id)) await toggleIndicator(id);
    if (editorId === id) editorId = null;
  }

  // ─── Indicator presets + layout persistence (C3) ───────────────────────────
  function currentIndicatorState(): IndicatorState {
    return {
      ema9: showEma9, ema21: showEma21, volume: showVolume, bb: showBB,
      atr: showATR, sma20: showSMA20, vwap: showVWAP, wma: showWMA,
      donchian: showDonchian, keltner: showKeltner, rsi: showRSI, macd: showMACD,
      oscillators: activeOscillators.map((m) => m.id),
      params: $state.snapshot(indParams),
      oscParams: $state.snapshot(oscParams),
      rustIndicators: [...activeRustIds],
      rustParams: $state.snapshot(rustParams),
    };
  }

  function saveIndicatorState() {
    try {
      localStorage.setItem('fks_chart_indicators', JSON.stringify(currentIndicatorState()));
    } catch { /* unavailable */ }
  }

  function readSavedIndicatorState(): IndicatorState | null {
    try {
      const raw = localStorage.getItem('fks_chart_indicators');
      if (!raw) return null;
      const p = JSON.parse(raw) as Partial<IndicatorState>;
      return {
        ...BLANK_INDICATORS,
        ...p,
        oscillators: Array.isArray(p.oscillators) ? p.oscillators.map(String) : [],
        params: mergeParams(p.params),
        oscParams: typeof p.oscParams === 'object' && p.oscParams !== null ? p.oscParams : {},
        rustIndicators: Array.isArray(p.rustIndicators) ? p.rustIndicators.map(String) : [],
        rustParams: typeof p.rustParams === 'object' && p.rustParams !== null ? p.rustParams : {},
      };
    } catch {
      return null;
    }
  }

  // Reconcile the chart to a desired indicator set (used by presets + restore).
  async function applyIndicatorState(s: IndicatorState) {
    // Restore saved params first (presets omit them → current params stay).
    if (s.params) indParams = mergeParams(s.params);
    if (s.oscParams) oscParams = { ...s.oscParams };
    // Client overlays (synchronous add/remove).
    showEma9 = s.ema9;     if (s.ema9) addEma9(); else removeEma9();
    showEma21 = s.ema21;   if (s.ema21) addEma21(); else removeEma21();
    showVolume = s.volume; if (s.volume) addVolume(); else removeVolume();
    // Server overlays — each loader checks its own show* flag and (re)loads.
    showBB = s.bb;             await loadBBands();
    showATR = s.atr;           await loadATR();
    showSMA20 = s.sma20;       await loadSMA20();
    showVWAP = s.vwap;         await loadVWAP();
    showWMA = s.wma;           await loadWMA();
    showDonchian = s.donchian; await loadDonchian();
    showKeltner = s.keltner;   await loadKeltner();
    // Sub-panes: the $effects on showRSI/showMACD init/tear-down the panes.
    showRSI = s.rsi;
    showMACD = s.macd;
    if (s.rsi || s.macd) await tick();
    // Oscillator panes (only those present in the loaded catalog).
    activeOscillators = oscillatorCatalog.filter((m) => s.oscillators.includes(m.id));
    // Rust indicators — restore params first, then re-enable those still present
    // in the (possibly changed / empty) Rust catalog. Missing ids are dropped so
    // a shrunken/unreachable catalog never leaves a dangling pane.
    if (s.rustParams) rustParams = { ...s.rustParams };
    const rustAvail = new Set(rustCatalog.map((r) => r.id));
    activeRustIds = (s.rustIndicators ?? []).filter((id) => rustAvail.has(id));
    saveIndicatorState();
  }

  function applyPreset(p: { state: Partial<IndicatorState> }) {
    presetMenuOpen = false;
    void applyIndicatorState({ ...BLANK_INDICATORS, ...p.state });
  }

  // ─── Chart export / screenshot ─────────────────────────────────────────────
  function exportChart() {
    const canvas = chartContainer.querySelector('canvas');
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `fks-chart-${symbol}-${new Date().toISOString().slice(0, 10)}.png`;
    link.href = (canvas as HTMLCanvasElement).toDataURL('image/png');
    link.click();
  }

  // ─── Symbol search ─────────────────────────────────────────────────────────
  async function handleSearch(query: string) {
    searchQuery = query;
    if (searchTimeout) clearTimeout(searchTimeout);
    if (query.length < 1) { searchResults = []; showDropdown = false; return; }
    searchTimeout = setTimeout(async () => {
      try {
        const data = await api.get<{ results?: AssetSearchResult[]; assets?: AssetSearchResult[] }>(
          `/api/assets/search?q=${encodeURIComponent(query)}`
        );
        searchResults = data.results ?? data.assets ?? [];
        showDropdown = searchResults.length > 0;
      } catch { searchResults = []; showDropdown = false; }
    }, 250);
  }

  function selectResult(result: AssetSearchResult) {
    setSymbol(result.symbol);
    searchQuery = ''; showDropdown = false;
  }

  function handleSearchKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      const q = searchQuery.trim().toUpperCase();
      if (q) { setSymbol(q); searchQuery = ''; showDropdown = false; }
    }
    if (e.key === 'Escape') showDropdown = false;
  }

  // Persist symbol+timeframe to localStorage and reflect them in the URL (shareable).
  function persistChartState() {
    try {
      localStorage.setItem('fks_chart_symbol', symbol);
      localStorage.setItem('fks_chart_tf', interval);
      history.replaceState(null, '', `?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(interval)}`);
    } catch { /* unavailable */ }
  }

  function setSymbol(s: string) {
    ignoreNextFocusChange = true;
    symbol = s;
    persistChartState();
    focusSymbol.set(s);
    loadChart();
  }

  function switchTimeframe(tf: string) {
    interval = tf;
    persistChartState();
    loadChart();
  }

  const SCALE_MODES = [
    { mode: 0, label: 'Regular' },
    { mode: 2, label: 'Percent' },
    { mode: 3, label: 'Indexed to 100' },
    { mode: 1, label: 'Logarithmic' },
  ];

  function saveScaleState() {
    try {
      localStorage.setItem('fks_chart_scale', JSON.stringify({ mode: scaleMode, auto: scaleAuto }));
    } catch { /* unavailable */ }
  }

  function applyScale() {
    chart?.applyOptions({ rightPriceScale: { mode: scaleMode as any, autoScale: scaleAuto } });
    saveScaleState();
  }

  function setScaleMode(mode: number) {
    scaleMode = mode;
    applyScale();
  }

  // Dragging the price scale silently disables lightweight-charts' autoScale
  // without touching our state — sync from the chart when opening the menu so
  // the Auto checkmark reflects reality (TW behavior).
  function toggleScaleMenu() {
    if (!scaleMenuOpen) {
      const cur = chart?.priceScale('right')?.options();
      if (cur && typeof cur.autoScale === 'boolean') scaleAuto = cur.autoScale;
    }
    scaleMenuOpen = !scaleMenuOpen;
  }

  function toggleAutoScale() {
    scaleAuto = !scaleAuto;
    applyScale();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────
  onMount(() => {
    // URL params (?symbol=&tf=) win for shareable links; else the last-viewed
    // values (localStorage). Persist whatever we resolve.
    try {
      const params = new URLSearchParams(window.location.search);
      try {
        const sc = localStorage.getItem('fks_chart_scale');
        if (sc) {
          const parsed = JSON.parse(sc);
          if ([0, 1, 2, 3].includes(parsed?.mode)) scaleMode = parsed.mode;
          if (typeof parsed?.auto === 'boolean') scaleAuto = parsed.auto;
        }
      } catch { /* corrupted pref — keep defaults */ }
      const ss = params.get('symbol') || localStorage.getItem('fks_chart_symbol');
      const st = params.get('tf') || params.get('interval') || localStorage.getItem('fks_chart_tf');
      if (ss) { symbol = ss; focusSymbol.set(ss); localStorage.setItem('fks_chart_symbol', ss); }
      if (st) { interval = st; localStorage.setItem('fks_chart_tf', st); }
    } catch { /* unavailable */ }
    // Load the chart + oscillator catalog, then restore the saved indicator
    // layout (the catalog is needed to rebuild oscillator panes). persistReady
    // gates the persistence effect until this restore has completed.
    Promise.all([loadChart(), loadOscillatorCatalog(), loadRustCatalog()]).then(() => {
      const saved = readSavedIndicatorState();
      if (saved) applyIndicatorState(saved).finally(() => { persistReady = true; });
      else persistReady = true;
    });

    const ro = new ResizeObserver(() => {
      if (chart && chartContainer) {
        chart.applyOptions({
          width: chartContainer.clientWidth,
          height: chartContainer.clientHeight,
        });
      }
      if (rsiChart && rsiChartEl) {
        rsiChart.applyOptions({
          width: rsiChartEl.clientWidth,
          height: rsiChartEl.clientHeight,
        });
      }
      if (macdChart && macdChartEl) {
        macdChart.applyOptions({
          width: macdChartEl.clientWidth,
          height: macdChartEl.clientHeight,
        });
      }
    });
    ro.observe(chartContainer);

    const handleOutsideClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('.symbol-search-wrap')) showDropdown = false;
      if (!t.closest('.ind-picker')) { indMenuOpen = false; presetMenuOpen = false; scaleMenuOpen = false; }
    };
    document.addEventListener('click', handleOutsideClick);
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { indMenuOpen = false; presetMenuOpen = false; scaleMenuOpen = false; editorId = null; }
    };
    document.addEventListener('keydown', handleEsc);

    return () => {
      ro.disconnect();
      document.removeEventListener('click', handleOutsideClick);
      document.removeEventListener('keydown', handleEsc);
    };
  });

  onDestroy(() => {
    disconnectLiveData();
    if (searchTimeout) clearTimeout(searchTimeout);
    chart?.remove(); chart = null;
    rsiChart?.remove(); rsiChart = null;
    macdChart?.remove(); macdChart = null;
  });
</script>

<svelte:head>
  <title>Charts — FKS Terminal</title>
</svelte:head>

<!-- ═══════════════════════════════════════════════════════════════════════ -->
<div class="page">
  <div class="chart-workspace">

    <!-- ── Toolbar ─────────────────────────────────────────────────────── -->
    <div class="toolbar" role="toolbar" aria-label="Chart controls">

      <!-- Symbol search -->
      <label class="lbl" for="chart-sym-search">SYMBOL</label>
      <div class="symbol-search-wrap" role="combobox" aria-expanded={showDropdown} aria-haspopup="listbox" aria-owns="chart-sym-dropdown" aria-controls="chart-sym-dropdown">
        <input
          id="chart-sym-search"
          type="text"
          class="input search-input"
          value={searchQuery || symbol}
          oninput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            searchQuery = v;
            handleSearch(v);
          }}
          onfocus={() => { searchQuery = ''; if (searchResults.length) showDropdown = true; }}
          onblur={() => setTimeout(() => { searchQuery = ''; }, 200)}
          onkeydown={handleSearchKey}
          placeholder="Search assets…"
          autocomplete="off"
          spellcheck="false"
          aria-autocomplete="list"
        />
        {#if showDropdown && searchResults.length > 0}
          <div class="search-dropdown" id="chart-sym-dropdown" role="listbox" aria-label="Asset search results">
            {#each searchResults as result}
              <button
                class="search-row"
                role="option"
                aria-selected={symbol === result.symbol}
                onclick={() => selectResult(result)}
              >
                <span class="sr-symbol">{result.symbol}</span>
                {#if result.name}<span class="sr-name">{result.name}</span>{/if}
                {#if result.type}<span class="sr-type">{result.type}</span>{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- TF tabs -->
      <div class="tf-tabs" role="radiogroup" aria-label="Timeframe">
        {#each timeframes as tf}
          <button
            class="tf-tab"
            class:active={interval === tf.id}
            onclick={() => switchTimeframe(tf.id)}
            aria-pressed={interval === tf.id ? 'true' : 'false'}
          >{tf.label}</button>
        {/each}
      </div>

      <!-- Indicators dropdown (TW-style: one button, grouped menu) -->
      <div class="ind-group ind-picker" aria-label="Indicators">
        <button class="ind-btn" class:active={indMenuOpen}
          onclick={() => { indMenuOpen = !indMenuOpen; presetMenuOpen = false; }}
          aria-expanded={indMenuOpen ? 'true' : 'false'} aria-haspopup="menu"
          title="Add or remove indicators">
          ƒ Indicators
          {#if indicatorLoading}<span class="ind-spin"></span>{/if}
        </button>
        {#if indMenuOpen}
          <div class="ind-menu ind-menu-groups" role="menu" aria-label="Indicators menu">
            <div class="ind-menu-head" role="presentation">Overlays</div>
            {#each [...overlayMenu, ...rustOverlayMenu] as item (item.id)}
              <button class="ind-menu-item" class:checked={item.active} role="menuitemcheckbox"
                aria-checked={item.active ? 'true' : 'false'}
                onclick={() => toggleIndicator(item.id)}>
                <span class="ind-dot" style="background:{item.color}"></span>
                <span class="ind-menu-label">{item.label}</span>
                {#if item.ta}<span class="ind-ta-badge" title="From the Rust indicators-ta crate">ta</span>{/if}
                {#if item.active}<span class="ind-menu-check" aria-hidden="true">✓</span>{/if}
              </button>
            {/each}
            <div class="ind-menu-head" role="presentation">Oscillators</div>
            {#each [...oscillatorMenu, ...rustOscMenu] as item (item.id)}
              <button class="ind-menu-item" class:checked={item.active} role="menuitemcheckbox"
                aria-checked={item.active ? 'true' : 'false'}
                onclick={() => toggleIndicator(item.id)}>
                <span class="ind-dot" style="background:{item.color}"></span>
                <span class="ind-menu-label">{item.label}</span>
                {#if item.ta}<span class="ind-ta-badge" title="From the Rust indicators-ta crate">ta</span>{/if}
                {#if item.active}<span class="ind-menu-check" aria-hidden="true">✓</span>{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Indicator presets -->
      <div class="ind-group ind-picker" aria-label="Indicator presets">
        <button class="ind-btn" onclick={() => { presetMenuOpen = !presetMenuOpen; indMenuOpen = false; }}
          aria-expanded={presetMenuOpen ? 'true' : 'false'} aria-haspopup="menu"
          title="Apply an indicator preset layout">☰ Presets</button>
        {#if presetMenuOpen}
          <div class="ind-menu" role="menu">
            {#each INDICATOR_PRESETS as p (p.id)}
              <button class="ind-menu-item" role="menuitem" onclick={() => applyPreset(p)}>{p.label}</button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Quick picks -->
      <div class="quick-picks">
        {#each quickPicks as s}
          <button
            class="btn-ghost"
            class:active={symbol === s}
            onclick={() => setSymbol(s)}
            aria-pressed={symbol === s ? 'true' : 'false'}
          >{s.replace('/USD', '')}</button>
        {/each}
      </div>

      <!-- Drawing tools toggle -->
      <button
        class="ind-btn ml-auto"
        class:active={drawingActive}
        onclick={() => { drawingActive = !drawingActive; }}
        title="Drawing tools"
        aria-label="Toggle drawing tools"
        aria-pressed={drawingActive ? 'true' : 'false'}
      >✏️ Draw</button>

      <!-- Price-scale options (TW-style: auto-fit + scale mode) -->
      <div class="ind-group ind-picker" aria-label="Price scale options">
        <button class="ind-btn" class:active={scaleMode !== 0}
          onclick={toggleScaleMenu}
          aria-expanded={scaleMenuOpen ? 'true' : 'false'} aria-haspopup="menu"
          title="Price scale options"
        >{SCALE_MODES.find((m) => m.mode === scaleMode)?.label === 'Logarithmic' ? 'Log' : SCALE_MODES.find((m) => m.mode === scaleMode)?.label ?? 'Scale'} ▾</button>
        {#if scaleMenuOpen}
          <div class="ind-menu" role="menu">
            <button class="ind-menu-item" role="menuitemcheckbox" aria-checked={scaleAuto ? 'true' : 'false'}
              onclick={toggleAutoScale}>
              <span class="ind-menu-label">Auto (fits data to screen)</span>
              {#if scaleAuto}<span class="ind-menu-check" aria-hidden="true">✓</span>{/if}
            </button>
            <div class="ind-menu-sep" aria-hidden="true"></div>
            {#each SCALE_MODES as m (m.mode)}
              <button class="ind-menu-item" role="menuitemradio" aria-checked={scaleMode === m.mode ? 'true' : 'false'}
                onclick={() => setScaleMode(m.mode)}>
                <span class="ind-menu-label">{m.label}</span>
                {#if scaleMode === m.mode}<span class="ind-menu-check" aria-hidden="true">✓</span>{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Screenshot / export -->
      <button
        class="ind-btn"
        onclick={exportChart}
        title="Export chart as PNG"
        aria-label="Download chart screenshot"
      >📷</button>

      <!-- Multi-chart -->
      <a href="/charts/grid" class="btn-ghost" title="Multi-chart grid">▦ Grid</a>

      <!-- Status badges -->
      <div class="status-badges">
        <span class="sym-badge">{symbol}</span>
        <span class="tf-badge">{interval}</span>
        {#if isCrypto}
          {#if activeSource === 'binance'}
            <span class="src-badge binance" class:connected={binanceConnected} title="Binance WS (fallback)">
              {binanceConnected ? '⬤ BNB' : '○ BNB'}
            </span>
          {:else}
            <span class="src-badge" class:connected={krakenConnected} title="Kraken WS">
              {krakenConnected ? '⬤ KRK' : '○ KRK'}
            </span>
          {/if}
        {:else}
          <span class="src-badge sse" title="SSE bars">SSE</span>
        {/if}
      </div>
    </div>

    <!-- ── Drawing toolbar ──────────────────────────────────────────────── -->
    <DrawingTools {chartContainer} {chart} bind:active={drawingActive} />

    <!-- ── Chart body ───────────────────────────────────────────────────── -->
    <div class="chart-body">
      <!-- Main candlestick chart -->
      <div class="chart-area" bind:this={chartContainer}>
        {#if loading}
          <div class="chart-overlay">
            <div class="spinner" role="status" aria-label="Loading chart"></div>
            <span>Loading {symbol} · {interval}…</span>
          </div>
        {/if}
        {#if !loading && candles.length === 0}
          <div class="chart-overlay">
            <EmptyState
              icon={barsError ? '⚠️' : '∅'}
              title={barsError ? 'Failed to load data' : 'No data'}
              variant={barsError ? 'error' : 'default'}
              hint={barsError
                ? `Couldn't reach the bars service for ${apiSymbol} · ${interval}.`
                : `No stored candles for ${apiSymbol} · ${interval}. Live ticks will populate as they arrive.`}
            />
          </div>
        {/if}
        {#if hoverBar}
          <div class="ohlc-readout" aria-hidden="true">
            <span class="k">O</span><span class="v">{fmtP(hoverBar.o)}</span>
            <span class="k">H</span><span class="v">{fmtP(hoverBar.h)}</span>
            <span class="k">L</span><span class="v">{fmtP(hoverBar.l)}</span>
            <span class="k">C</span><span class="v">{fmtP(hoverBar.c)}</span>
            <span class="chg" class:up={hoverBar.chg >= 0} class:down={hoverBar.chg < 0}
              >{hoverBar.chg >= 0 ? '+' : ''}{hoverBar.chg.toFixed(2)}%</span>
          </div>
        {/if}

        <!-- Active-overlay legend (TW-style, under the OHLC readout) -->
        {#if legendItems.length > 0}
          <div class="chart-legend" role="list" aria-label="Active overlays">
            {#each legendItems as item (item.id)}
              <div class="legend-row" role="listitem">
                <span class="ind-dot" style="background:{item.color}"></span>
                <span class="legend-label">{item.label}</span>
                <button class="legend-btn" title="Settings — {item.label}"
                  aria-label="Edit {item.label} settings"
                  onclick={() => openEditor(item.id)}>⚙</button>
                <button class="legend-btn legend-x" title="Remove {item.label}"
                  aria-label="Remove {item.label}"
                  onclick={() => removeIndicator(item.id)}>✕</button>
              </div>
              {#if editorId === item.id}
                <div class="legend-editor">
                  {#if item.fields.length > 0}
                    {#each item.fields as f (f.key)}
                      <label class="editor-field">
                        <span>{f.label}</span>
                        <input type="number" step={f.step ?? 1} min={f.step ? 0.1 : 2} max={f.step ? 10 : 500}
                          bind:value={editorDraft[f.key]} />
                      </label>
                    {/each}
                    <div class="editor-actions">
                      <button class="editor-apply" onclick={() => applyEditor(item.id)}>Apply</button>
                      <button class="editor-cancel" onclick={() => (editorId = null)}>Cancel</button>
                    </div>
                  {:else}
                    <div class="editor-note">{item.note}</div>
                    <div class="editor-actions">
                      <button class="editor-cancel" onclick={() => (editorId = null)}>Close</button>
                    </div>
                  {/if}
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>

      <!-- RSI sub-pane -->
      {#if showRSI}
        <div class="ind-pane" role="region" aria-label="RSI {indParams.rsi.period} indicator">
          <div class="pane-label">RSI</div>
          <div class="pane-controls">
            <span class="pane-title">RSI {indParams.rsi.period}</span>
            <button class="legend-btn" title="Settings — RSI" aria-label="Edit RSI settings"
              onclick={() => openEditor('rsi')}>⚙</button>
            <button class="legend-btn legend-x" title="Remove RSI pane" aria-label="Remove RSI pane"
              onclick={() => removeIndicator('rsi')}>✕</button>
          </div>
          {#if editorId === 'rsi'}
            <div class="legend-editor pane-editor">
              <label class="editor-field">
                <span>Length</span>
                <input type="number" step="1" min="2" max="500" bind:value={editorDraft.period} />
              </label>
              <div class="editor-actions">
                <button class="editor-apply" onclick={() => applyEditor('rsi')}>Apply</button>
                <button class="editor-cancel" onclick={() => (editorId = null)}>Cancel</button>
              </div>
            </div>
          {/if}
          <div class="pane-chart" bind:this={rsiChartEl}></div>
          <!-- Overbought/oversold markers -->
          <div class="rsi-levels" aria-hidden="true">
            <span class="rsi-level ob">70</span>
            <span class="rsi-level os">30</span>
          </div>
        </div>
      {/if}

      <!-- MACD sub-pane -->
      {#if showMACD}
        <div class="ind-pane macd-pane" role="region"
          aria-label="MACD ({indParams.macd.fast}, {indParams.macd.slow}, {indParams.macd.signal}) indicator">
          <div class="pane-label">MACD</div>
          <div class="pane-controls">
            <span class="pane-title">MACD ({indParams.macd.fast}, {indParams.macd.slow}, {indParams.macd.signal})</span>
            <button class="legend-btn" title="Settings — MACD" aria-label="Edit MACD settings"
              onclick={() => openEditor('macd')}>⚙</button>
            <button class="legend-btn legend-x" title="Remove MACD pane" aria-label="Remove MACD pane"
              onclick={() => removeIndicator('macd')}>✕</button>
          </div>
          {#if editorId === 'macd'}
            <div class="legend-editor pane-editor">
              <label class="editor-field">
                <span>Fast</span>
                <input type="number" step="1" min="2" max="500" bind:value={editorDraft.fast} />
              </label>
              <label class="editor-field">
                <span>Slow</span>
                <input type="number" step="1" min="2" max="500" bind:value={editorDraft.slow} />
              </label>
              <label class="editor-field">
                <span>Signal</span>
                <input type="number" step="1" min="2" max="500" bind:value={editorDraft.signal} />
              </label>
              <div class="editor-actions">
                <button class="editor-apply" onclick={() => applyEditor('macd')}>Apply</button>
                <button class="editor-cancel" onclick={() => (editorId = null)}>Cancel</button>
              </div>
            </div>
          {/if}
          <div class="pane-chart" bind:this={macdChartEl}></div>
        </div>
      {/if}

      <!-- Generic oscillator sub-panes (picker-driven) -->
      {#each activeOscillators as osc (osc.id)}
        <IndicatorPane
          {symbol}
          {interval}
          id={osc.id}
          label={oscLabel(osc)}
          keys={osc.keys}
          mainChart={chart}
          params={oscParams[osc.id] ?? OSC_PARAM_DEFS[osc.id]?.defaults ?? []}
          paramNames={OSC_PARAM_DEFS[osc.id]?.names ?? []}
          onparams={(p) => { oscParams = { ...oscParams, [osc.id]: p }; }}
          onremove={() => removeOscillator(osc.id)}
        />
      {/each}

      <!-- Rust indicators-ta panes/overlays (janus-computed) -->
      {#each activeRustIndicators as rust (rust.id)}
        <RustIndicatorPane
          symbol={apiSymbol}
          {interval}
          indicator={rust}
          mainChart={chart}
          params={rustParams[rust.id] ?? defaultParams(rust)}
          onparams={(p) => { rustParams = { ...rustParams, [rust.id]: p }; }}
          onremove={() => removeRustIndicator(rust.id)}
        />
      {/each}
    </div>
  </div>
</div>

<!-- ═══════════════════════════════════════════════════════════════════════ -->
<style>
  .page {
    display: flex;
    height: 100%;
    overflow: hidden;
  }

  .chart-workspace {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }

  /* ── Toolbar ─────────────────────────────────────────────────────────── */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--bg1);
    border-bottom: 1px solid var(--b2);
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .lbl {
    font-size: 9px;
    color: var(--t3);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    flex-shrink: 0;
  }

  .input {
    background: var(--bg2);
    border: 1px solid var(--b2);
    color: var(--t1);
    padding: 3px 8px;
    border-radius: var(--r);
    font-family: inherit;
    font-size: 12px;
  }
  .input:focus { border-color: var(--accent); outline: none; }

  /* Symbol typeahead */
  .symbol-search-wrap { position: relative; }
  .search-input { width: 140px; }
  .search-dropdown {
    position: absolute;
    top: 100%; left: 0;
    z-index: 200;
    min-width: 240px;
    max-height: 220px;
    overflow-y: auto;
    background: var(--bg1);
    border: 1px solid var(--b2);
    border-top: none;
    border-radius: 0 0 var(--r-md, 6px) var(--r-md, 6px);
    box-shadow: 0 8px 24px rgba(0,0,0,.6);
  }
  .search-row {
    all: unset;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    width: 100%;
    box-sizing: border-box;
    cursor: pointer;
    transition: background .1s;
  }
  .search-row:hover { background: var(--bg3); }
  .sr-symbol { font-size: 11px; font-weight: 600; color: var(--accent); min-width: 52px; }
  .sr-name { font-size: 10px; color: var(--t2); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sr-type { font-size: 8px; color: var(--t3); background: var(--bg3); padding: 1px 4px; border-radius: var(--r); text-transform: uppercase; }

  /* TF tabs */
  .tf-tabs { display: flex; gap: 2px; }
  .tf-tab {
    all: unset;
    padding: 2px 7px;
    font-size: 10px;
    color: var(--t3);
    border-radius: var(--r);
    cursor: pointer;
    font-family: inherit;
    transition: color .15s, background .15s;
  }
  .tf-tab:hover { color: var(--t2); background: var(--bg3); }
  .tf-tab.active { color: var(--t1); background: var(--accent-dim, rgba(99,102,241,.15)); }

  /* Indicator groups */
  .ind-group {
    display: flex;
    gap: 3px;
    padding-left: 8px;
    border-left: 1px solid var(--b1);
  }
  .ind-picker {
    position: relative;
  }
  .ind-menu {
    position: absolute;
    top: 100%;
    left: 8px;
    z-index: 20;
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    min-width: 150px;
    padding: 4px;
    background: var(--bg2, #0c0f14);
    border: 1px solid var(--b2, #1a1a2e);
    border-radius: var(--r, 4px);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
  }
  .ind-menu-sep {
    height: 1px;
    background: var(--b1);
    margin: 4px 0;
  }

  .ind-menu-item {
    all: unset;
    cursor: pointer;
    padding: 5px 8px;
    font-size: 11px;
    color: var(--t2, #b8c0e0);
    border-radius: var(--r, 4px);
    white-space: nowrap;
  }
  .ind-menu-item:hover:not(:disabled) {
    background: var(--bg3, #161b24);
    color: var(--t1, #e6e9f5);
  }
  .ind-menu-item:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .ind-menu-groups {
    min-width: 210px;
    max-height: 60vh;
    overflow-y: auto;
  }
  .ind-menu-head {
    padding: 6px 8px 3px;
    font-size: 9px;
    color: var(--t3, #8890b8);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .ind-menu-head:not(:first-child) {
    margin-top: 4px;
    border-top: 1px solid var(--b1, #1a1a2e);
  }
  .ind-menu-item {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ind-menu-label { flex: 1; }
  .ind-menu-item.checked { color: var(--t1, #e6e9f5); }
  .ind-menu-check { color: var(--accent, #6366f1); font-size: 10px; }
  /* "ta" badge — indicator sourced from the Rust indicators-ta crate (janus). */
  .ind-ta-badge {
    font-size: 8px;
    line-height: 1;
    padding: 1px 3px;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--cyan, #00e5ff);
    border: 1px solid var(--cyan, #00e5ff);
    opacity: 0.7;
  }

  /* ── On-chart overlay legend + inline param editor ─────────────────────── */
  .chart-legend {
    position: absolute;
    top: 30px; /* under the OHLC readout */
    left: 8px;
    z-index: 4;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    max-height: calc(100% - 60px);
    overflow-y: auto;
    pointer-events: none; /* don't block chart drags — rows re-enable */
  }
  .chart-legend .legend-row,
  .chart-legend .legend-editor { pointer-events: auto; }
  .legend-row {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 2px 6px;
    font-size: 10px;
    color: var(--t2, #b8c0e0);
    background: rgba(7, 7, 13, 0.72);
    border: 1px solid var(--b1, #1a1a2e);
    border-radius: var(--r, 4px);
    width: fit-content;
  }
  .legend-row .ind-dot { opacity: 1; }
  .legend-label { font-variant-numeric: tabular-nums; }
  .legend-btn {
    all: unset;
    cursor: pointer;
    padding: 0 2px;
    font-size: 10px;
    line-height: 1;
    color: var(--t3, #8890b8);
    opacity: 0.55;
    transition: opacity .15s, color .15s;
  }
  .legend-row:hover .legend-btn,
  .pane-controls:hover .legend-btn { opacity: 1; }
  .legend-btn:hover { color: var(--t1, #e6e9f5); }
  .legend-btn.legend-x:hover { color: var(--red, #ea3943); }
  .legend-editor {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: fit-content;
    padding: 6px 8px;
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
  .editor-note { font-size: 9px; color: var(--t3, #8890b8); max-width: 180px; }
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

  .ohlc-readout {
    position: absolute;
    top: 6px;
    left: 8px;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    font-size: 10px;
    background: rgba(7, 7, 13, 0.72);
    border: 1px solid var(--b1, #1a1a2e);
    border-radius: var(--r, 4px);
    pointer-events: none;
    font-variant-numeric: tabular-nums;
  }
  .ohlc-readout .k { color: var(--t3, #8890b8); }
  .ohlc-readout .v { color: var(--t1, #e6e9f5); margin-right: 3px; }
  .ohlc-readout .chg.up { color: var(--green, #16c784); }
  .ohlc-readout .chg.down { color: var(--red, #ea3943); }
  .ind-btn {
    all: unset;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 7px;
    font-size: 10px;
    color: var(--t3);
    border: 1px solid var(--b1);
    border-radius: var(--r);
    cursor: pointer;
    font-family: inherit;
    transition: all .15s;
    white-space: nowrap;
  }
  .ind-btn:hover { color: var(--t2); background: var(--bg3); border-color: var(--b2); }
  .ind-btn.active { color: var(--t1); background: var(--bg3); border-color: var(--b2); }
  .ind-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; opacity: .45; transition: opacity .15s; }
  .ind-menu-item.checked .ind-dot { opacity: 1; }
  .ind-spin {
    display: inline-block; width: 8px; height: 8px;
    border: 1px solid var(--b2); border-top-color: var(--accent);
    border-radius: 50%; animation: spin .7s linear infinite;
  }

  .ml-auto { margin-left: auto; }

  /* Quick picks */
  .quick-picks { display: flex; gap: 3px; }
  .btn-ghost {
    background: transparent;
    border: 1px solid var(--b1);
    color: var(--t3);
    padding: 2px 7px;
    border-radius: var(--r);
    cursor: pointer;
    font-family: inherit;
    font-size: 10px;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    transition: all .15s;
  }
  .btn-ghost:hover { background: var(--bg3); color: var(--t1); }
  .btn-ghost.active { background: var(--bg3); color: var(--accent); border-color: var(--b2); }

  /* Status badges */
  .status-badges {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: 4px;
    padding-left: 8px;
    border-left: 1px solid var(--b1);
  }
  .sym-badge {
    font-size: 13px;
    font-weight: 700;
    color: var(--accent);
  }
  .tf-badge { font-size: 10px; color: var(--t3); }
  .src-badge {
    font-size: 9px;
    color: var(--t3);
    font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .src-badge.connected { color: var(--green, #16c784); }
  .src-badge.sse { color: var(--cyan, #00e5ff); opacity: .6; }
  .src-badge.binance.connected { color: var(--yellow, #f0b90b); }

  /* ── Chart body ──────────────────────────────────────────────────────── */
  .chart-body {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .chart-area {
    flex: 1;
    min-height: 0;
    position: relative;
    background: var(--bg0);
  }
  .chart-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--t3);
    font-size: 12px;
    z-index: 10;
    pointer-events: none;
  }
  .spinner {
    width: 16px; height: 16px;
    border: 2px solid var(--b2);
    border-top-color: var(--cyan, #00e5ff);
    border-radius: 50%;
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── RSI sub-pane ────────────────────────────────────────────────────── */
  .ind-pane {
    height: 88px;
    flex-shrink: 0;
    border-top: 1px solid var(--b2);
    background: var(--bg0);
    display: flex;
    position: relative;
    overflow: hidden;
  }
  .pane-label {
    writing-mode: vertical-lr;
    transform: rotate(180deg);
    font-size: 8px;
    color: var(--t3);
    text-transform: uppercase;
    letter-spacing: .08em;
    padding: 4px 3px;
    background: var(--bg1);
    border-right: 1px solid var(--b1);
    flex-shrink: 0;
    opacity: .7;
  }
  .pane-chart {
    flex: 1;
    min-width: 0;
  }
  /* Pane header controls (title + settings/close, TW-style) */
  .pane-controls {
    position: absolute;
    top: 3px;
    left: 18px; /* clear of the vertical label strip */
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 1px 6px;
    background: rgba(7, 7, 13, 0.72);
    border: 1px solid var(--b1, #1a1a2e);
    border-radius: var(--r, 4px);
  }
  .pane-title {
    font-size: 9px;
    color: var(--t2, #b8c0e0);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-variant-numeric: tabular-nums;
  }
  .pane-editor {
    position: absolute;
    top: 24px;
    left: 18px;
    z-index: 4;
    /* Panes are short (88–100px, overflow hidden) — lay the editor out as one row. */
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }
  .rsi-levels {
    position: absolute;
    right: 44px; /* align roughly with price scale */
    top: 0; bottom: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    pointer-events: none;
  }
  .rsi-level {
    font-size: 8px;
    color: var(--t3);
    opacity: .5;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .rsi-level.ob { margin-top: 2px; }
  .rsi-level.os { margin-bottom: 2px; }

  /* ── MACD sub-pane ───────────────────────────────────────────────────────────────────────────── */
  .macd-pane {
    height: 100px; /* slightly taller than RSI for histogram readability */
  }
</style>
