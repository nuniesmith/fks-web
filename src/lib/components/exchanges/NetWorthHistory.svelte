<script lang="ts">
  /**
   * Net-worth history panel for /exchanges. Draws a line chart of the spot
   * bot's `fks_bot_net_worth_usd` over a selectable range (24h / 7d / 30d) by
   * querying the existing Prometheus range proxy at /api/metrics/query_range
   * (hooks.server.ts → Prometheus /api/v1/query_range). Prometheus retains the
   * metric for 30 days, so this needs no backend of its own.
   *
   * Optional per-exchange breakdown overlays `fks_bot_exchange_total_usd`
   * (one line per `exchange` label) when those series exist.
   *
   * Honest empty state: on a fresh deploy (bot not yet scraped) the range query
   * returns no series → we show "no net-worth history yet" rather than a flat $0.
   *
   * ── Two net-worth series exist on this platform, and they can legitimately
   * disagree during an incident — that is expected, not a bug, as long as both
   * are honest about it (audit 2026-07-31, gap 18):
   *   1. DB-backed (`/treasury`, `NetWorthHistoryPanel` on `/bots`): the
   *      spawner sampler REFUSES to write a row while a bot's venues are
   *      stale, so a bad incident renders as a genuine GAP in the line.
   *   2. Prometheus-backed (this component): `fks_bot_net_worth_usd` is
   *      exported by the bot itself and scraped on Prometheus' own cadence
   *      regardless of whether the spawner sampler trusts the venue data. It
   *      does not gap — during the same incident it can keep exporting the
   *      bot's last-known (stale) figure, which draws as a smooth, complete
   *      line that looks like nothing happened. This chart was previously
   *      unaware of the sampling-paused alerts and drew that misleading line
   *      with no annotation; it now shows the same banner the DB-backed charts
   *      show, so an operator sees "trust this less right now" on BOTH series
   *      during an incident instead of only one.
   */
  import { onDestroy } from 'svelte';
  import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
  import Panel from '$lib/components/ui/Panel.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import Skeleton from '$lib/components/ui/Skeleton.svelte';
  import { api } from '$lib/api/client';
  import { alertInbox } from '$lib/stores/alertInbox';
  import { fmtMoney } from '$lib/utils/format';
  import {
    promRangeToLine,
    promRangeByLabel,
    promRangeHasData,
    type PromRangeResponse,
    type LinePoint,
  } from '$lib/utils/prometheus';

  // The spot bot is the platform's backbone number. `fks_bot_net_worth_usd`
  // also carries the (paper) futures bot, so both queries pin market="spot".
  const NET_WORTH_QUERY = 'fks_bot_net_worth_usd{market="spot"}';
  const EXCHANGE_QUERY = 'fks_bot_exchange_total_usd{market="spot"}';

  // Range → window seconds + step (kept well under Prometheus' 11k-point cap:
  // 24h/5m=288, 7d/1h=168, 30d/6h=120 points).
  const ranges = [
    { id: '24h', label: '24h', windowSec: 24 * 3600, stepSec: 300 },
    { id: '7d', label: '7d', windowSec: 7 * 24 * 3600, stepSec: 3600 },
    { id: '30d', label: '30d', windowSec: 30 * 24 * 3600, stepSec: 21600 },
  ] as const;
  type RangeId = (typeof ranges)[number]['id'];

  let selected = $state<RangeId>('24h');
  let showBreakdown = $state(false);
  let loading = $state(true);
  let errored = $state(false);
  let hasData = $state(false);
  let latest = $state<number | null>(null);

  // ── Gap 18: bypassed the sampling-paused guard ─────────────────────────────
  //
  // This chart draws from Prometheus, not from the spawner's gap-guarded
  // `net_worth_snapshots` table, so it never gapped during a staleness
  // incident — it just kept drawing whatever `fks_bot_net_worth_usd` last
  // reported, smooth and complete, with nothing telling the operator the
  // underlying venue data was untrustworthy. `/treasury` and `/bots` already
  // show an amber banner for the same condition; this mirrors that.
  //
  // Keyed off `alerts.some(...)`, NOT `unackedCount`/`describeChip`: an ack
  // zeroes the StatusBar chip while the alert is still firing, and with the
  // ack store down the inbox still returns the full `alerts` array — exactly
  // the degraded state this banner has to survive. Twin of the same block in
  // $components/bots/NetWorthHistoryPanel.svelte and
  // src/routes/treasury/+page.svelte — keep the alertname list in sync across
  // all three.
  const SAMPLING_PAUSED_ALERTS = ['NetWorthSamplingPausedTooLong', 'BotAllVenuesStale'];

  // Deduped by (url, interval) with the StatusBar's poll — no extra traffic.
  $effect(() => {
    alertInbox.start();
    return () => alertInbox.stop();
  });

  let samplingPaused = $derived(
    ($alertInbox?.alerts ?? []).some((a) => SAMPLING_PAUSED_ALERTS.includes(a.labels.alertname)),
  );

  // Palette for per-exchange breakdown lines (theme accents, cycled).
  const breakdownColors = ['#22d3ee', '#a78bfa', '#34d399', '#f59e0b', '#f472b6', '#60a5fa'];

  let chartEl: HTMLDivElement | undefined = $state();
  let chart: IChartApi | null = null;
  let totalSeries: ISeriesApi<'Line'> | null = null;
  let breakdownSeries: ISeriesApi<'Line'>[] = [];
  let resizeObs: ResizeObserver | null = null;
  let loadSeq = 0;

  function rangeFor(id: RangeId) {
    return ranges.find((r) => r.id === id) ?? ranges[0];
  }

  async function queryRange(query: string, windowSec: number, stepSec: number): Promise<PromRangeResponse> {
    const end = Math.floor(Date.now() / 1000);
    const start = end - windowSec;
    return api.get<PromRangeResponse>(
      `/api/metrics/query_range?query=${encodeURIComponent(query)}&start=${start}&end=${end}&step=${stepSec}`,
    );
  }

  function toChartData(points: LinePoint[]) {
    return points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }));
  }

  async function ensureChart() {
    if (chart || !chartEl) return;
    const { createChart } = await import('lightweight-charts');
    chart = createChart(chartEl, {
      autoSize: true,
      layout: {
        background: { type: 'solid' as any, color: 'transparent' },
        textColor: '#8890b8',
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        fontSize: 10,
      },
      grid: { vertLines: { color: '#1a1a2e' }, horzLines: { color: '#12121f' } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: '#1a1a2e', minimumWidth: 56 },
      timeScale: { borderColor: '#1a1a2e', timeVisible: true, secondsVisible: false },
      handleScale: false,
      handleScroll: false,
    });
    totalSeries = chart.addLineSeries({
      color: '#22d3ee',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: 'Net worth',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
  }

  function clearBreakdown() {
    for (const s of breakdownSeries) {
      try {
        chart?.removeSeries(s);
      } catch {
        /* series already gone */
      }
    }
    breakdownSeries = [];
  }

  async function load() {
    const seq = ++loadSeq;
    loading = true;
    errored = false;
    const { windowSec, stepSec } = rangeFor(selected);
    try {
      const [totalResp, breakdownResp] = await Promise.all([
        queryRange(NET_WORTH_QUERY, windowSec, stepSec),
        showBreakdown
          ? queryRange(EXCHANGE_QUERY, windowSec, stepSec)
          : Promise.resolve(null as PromRangeResponse | null),
      ]);
      if (seq !== loadSeq) return; // a newer load superseded this one

      hasData = promRangeHasData(totalResp);
      if (!hasData) {
        latest = null;
        loading = false;
        return;
      }

      await ensureChart();
      if (seq !== loadSeq || !chart || !totalSeries) return;

      const line = promRangeToLine(totalResp);
      totalSeries.setData(toChartData(line));
      latest = line.length ? line[line.length - 1].value : null;

      clearBreakdown();
      if (showBreakdown && breakdownResp) {
        const perExchange = promRangeByLabel(breakdownResp, 'exchange');
        perExchange.forEach((s, i) => {
          const series = chart!.addLineSeries({
            color: breakdownColors[i % breakdownColors.length],
            lineWidth: 1,
            lineStyle: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            title: s.key,
          });
          series.setData(toChartData(s.points));
          breakdownSeries.push(series);
        });
      }
      chart.timeScale().fitContent();
      loading = false;
    } catch {
      if (seq !== loadSeq) return;
      errored = true;
      loading = false;
    }
  }

  // Observe container resize so the chart tracks the responsive layout.
  $effect(() => {
    if (chartEl && !resizeObs && chart) {
      resizeObs = new ResizeObserver(() => chart?.timeScale().fitContent());
      resizeObs.observe(chartEl);
    }
  });

  // (Re)load whenever the range or breakdown toggle changes.
  $effect(() => {
    void selected;
    void showBreakdown;
    load();
  });

  onDestroy(() => {
    resizeObs?.disconnect();
    resizeObs = null;
    chart?.remove();
    chart = null;
    totalSeries = null;
    breakdownSeries = [];
  });

</script>

<Panel title="Net worth history">
  {#snippet header()}
    <div class="nw-controls">
      {#if latest !== null}
        <span class="nw-latest">{fmtMoney(latest)}</span>
      {/if}
      <button
        type="button"
        class="nw-toggle"
        class:on={showBreakdown}
        onclick={() => (showBreakdown = !showBreakdown)}
        title="Overlay per-exchange totals (fks_bot_exchange_total_usd)"
      >
        per-exchange
      </button>
      <div class="nw-ranges" role="group" aria-label="History range">
        {#each ranges as r (r.id)}
          <button
            type="button"
            class="nw-range"
            class:active={selected === r.id}
            onclick={() => (selected = r.id)}
          >
            {r.label}
          </button>
        {/each}
      </div>
    </div>
  {/snippet}

  {#if samplingPaused}
    <p class="nw-paused" role="status" data-testid="sampling-paused">
      <strong>Net-worth sampling is paused.</strong> Bots are reporting stale venue figures. This
      chart is Prometheus-scraped, not spawner-gated, so it does NOT gap the way `/treasury` does —
      it may keep drawing a flat, stale figure through the incident instead. Don't read a smooth
      line here as "nothing happened".
      <a href="/monitoring">Open /monitoring</a> for the firing alert.
    </p>
  {/if}

  <div class="nw-body">
    <!-- Chart element always mounted so lightweight-charts can attach; overlays
         sit on top for the loading / empty / error states. -->
    <div class="nw-chart" bind:this={chartEl}></div>

    {#if loading && !hasData}
      <div class="nw-overlay"><Skeleton height="220px" /></div>
    {:else if errored}
      <div class="nw-overlay">
        <EmptyState
          icon="⚠️"
          title="Couldn't load net-worth history"
          variant="error"
          hint="The Prometheus range query (/api/metrics/query_range) failed. Check that fks_prometheus is reachable."
        />
      </div>
    {:else if !hasData}
      <div class="nw-overlay">
        <EmptyState
          icon="📈"
          title="No net-worth history yet"
          hint="Prometheus collects it as the spot bot runs. This fills in once fks_bot_net_worth_usd has been scraped from the spot-portfolio bot."
        />
      </div>
    {/if}
  </div>
</Panel>

<style>
  .nw-paused {
    margin: 0 0 8px;
    padding: 7px 9px;
    font-size: 11px;
    line-height: 1.45;
    color: var(--amber, #f0a500);
    background: var(--bg2, #16161f);
    border: 1px solid var(--amber, #f0a500);
    border-radius: var(--r-md, 6px);
  }
  .nw-paused a {
    color: inherit;
  }
  .nw-controls {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .nw-latest {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--cyan, #22d3ee);
  }
  .nw-ranges {
    display: inline-flex;
    gap: 2px;
    background: var(--bg2, #12121f);
    border: 1px solid var(--bg3, #1f2530);
    border-radius: 6px;
    padding: 2px;
  }
  .nw-range,
  .nw-toggle {
    background: transparent;
    border: none;
    color: var(--t2, #9aa4b2);
    font: inherit;
    font-size: 0.75rem;
    padding: 3px 9px;
    border-radius: 4px;
    cursor: pointer;
  }
  .nw-range:hover,
  .nw-toggle:hover {
    color: var(--t1, #e6e9ef);
  }
  .nw-range.active {
    background: var(--bg3, #1f2530);
    color: var(--cyan, #22d3ee);
  }
  .nw-toggle {
    border: 1px solid var(--bg3, #1f2530);
    border-radius: 6px;
  }
  .nw-toggle.on {
    color: var(--cyan, #22d3ee);
    border-color: var(--cyan, #22d3ee);
  }
  .nw-body {
    position: relative;
    min-height: 240px;
  }
  .nw-chart {
    width: 100%;
    height: 240px;
  }
  .nw-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg1, #0b0b13);
  }
</style>
