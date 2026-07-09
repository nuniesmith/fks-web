<script lang="ts">
  /**
   * NetWorthHistoryPanel — durable per-bot net-worth history.
   *
   * Backed by the spawner's db-gated `GET /net-worth` (proxied at
   * /api/spawner/net-worth), which reads the append-only `net_worth_snapshots`
   * table in ruby_db. Unlike exchanges/NetWorthHistory (Prometheus, 30-day
   * retention) this is the years-horizon record. One line per bot_id, plotted
   * oldest → newest (the endpoint already returns rows in that order).
   *
   * The endpoint returns a flat array with no db_enabled flag, so "no database
   * configured" and "no samples yet" both surface as the same honest empty
   * state rather than an error.
   */
  import { onDestroy, onMount } from 'svelte';
  import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
  import Panel from '$components/ui/Panel.svelte';
  import EmptyState from '$components/ui/EmptyState.svelte';
  import Skeleton from '$components/ui/Skeleton.svelte';
  import { spawner } from '$api/spawner';
  import type { NetWorthSnapshot } from '$lib/types/spawner';

  // One plotted line per bot, plus the latest value for the legend.
  interface BotSeries {
    botId: string;
    color: string;
    latest: number;
    currency: string;
    points: { time: UTCTimestamp; value: number }[];
  }

  // Theme accents, cycled one-per-bot (matches exchanges/NetWorthHistory).
  const PALETTE = ['#22d3ee', '#a78bfa', '#34d399', '#f59e0b', '#f472b6', '#60a5fa', '#f87171'];

  let loading = $state(true);
  let errored = $state(false);
  let botSeries = $state<BotSeries[]>([]);
  let hasData = $derived(botSeries.length > 0);

  let chartEl: HTMLDivElement | undefined = $state();
  let chart: IChartApi | null = null;
  let lines: ISeriesApi<'Line'>[] = [];

  /**
   * Group flat snapshot rows into one ascending, de-duped series per bot.
   * lightweight-charts rejects non-increasing times, so a collision on the same
   * whole second keeps the latest value. Pure — no chart / DOM access.
   */
  function groupByBot(rows: NetWorthSnapshot[]): BotSeries[] {
    const groups = new Map<string, NetWorthSnapshot[]>();
    for (const r of rows) {
      const arr = groups.get(r.bot_id);
      if (arr) arr.push(r);
      else groups.set(r.bot_id, [r]);
    }
    const out: BotSeries[] = [];
    let i = 0;
    for (const [botId, rs] of groups) {
      const bySecond = new Map<number, number>();
      for (const r of rs) {
        const t = Math.floor(new Date(r.ts).getTime() / 1000);
        if (Number.isFinite(t) && Number.isFinite(r.net_worth)) bySecond.set(t, r.net_worth);
      }
      const points = [...bySecond.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([time, value]) => ({ time: time as UTCTimestamp, value }));
      if (points.length === 0) continue;
      out.push({
        botId,
        color: PALETTE[i % PALETTE.length],
        latest: points[points.length - 1].value,
        currency: rs[rs.length - 1].currency || 'USD',
        points,
      });
      i++;
    }
    return out.sort((a, b) => a.botId.localeCompare(b.botId));
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
    });
  }

  function clearLines() {
    for (const s of lines) {
      try {
        chart?.removeSeries(s);
      } catch {
        /* already removed */
      }
    }
    lines = [];
  }

  async function render() {
    if (botSeries.length === 0) return;
    await ensureChart();
    const c = chart;
    if (!c) return;
    clearLines();
    for (const b of botSeries) {
      const s = c.addLineSeries({
        color: b.color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        title: b.botId,
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });
      s.setData(b.points);
      lines.push(s);
    }
    c.timeScale().fitContent();
  }

  async function load() {
    loading = true;
    errored = false;
    try {
      botSeries = groupByBot(await spawner.netWorth());
      await render();
    } catch {
      errored = true;
    } finally {
      loading = false;
    }
  }

  onMount(load);

  onDestroy(() => {
    chart?.remove();
    chart = null;
    lines = [];
  });

  function money(value: number, currency: string): string {
    const n = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return currency === 'USD' ? `$${n}` : `${n} ${currency}`;
  }
</script>

<Panel title="Net-worth history (durable)">
  {#snippet header()}
    <button
      type="button"
      class="nwp-refresh"
      onclick={load}
      title="Reload net-worth snapshots"
      aria-label="Refresh net-worth history"
    >
      ↻
    </button>
  {/snippet}

  <div class="nwp-body">
    <!-- Chart element stays mounted so lightweight-charts can attach; the
         loading / empty / error overlays sit on top. -->
    <div class="nwp-chart" bind:this={chartEl}></div>

    {#if loading && !hasData}
      <div class="nwp-overlay"><Skeleton height="200px" /></div>
    {:else if errored}
      <div class="nwp-overlay">
        <EmptyState
          icon="⚠️"
          title="Couldn't load net-worth history"
          variant="error"
          hint="GET /api/spawner/net-worth failed. Check that the spawner is reachable."
        />
      </div>
    {:else if !hasData}
      <div class="nwp-overlay">
        <EmptyState
          icon="📈"
          title="No net-worth history yet"
          hint="The spawner sampler appends a row per running bot every few minutes into net_worth_snapshots (ruby_db). Fills in once a bot has been sampled — needs the spawner DB configured."
        />
      </div>
    {/if}
  </div>

  {#if hasData}
    <div class="nwp-legend">
      {#each botSeries as b (b.botId)}
        <span class="nwp-item">
          <span class="nwp-swatch" style:background={b.color}></span>
          <span class="nwp-bot" title={b.botId}>{b.botId}</span>
          <span class="nwp-val">{money(b.latest, b.currency)}</span>
        </span>
      {/each}
    </div>
  {/if}
</Panel>

<style>
  .nwp-refresh {
    background: transparent;
    border: 1px solid var(--b2, #2a2a3e);
    color: var(--t2, #9aa4b2);
    font-size: 12px;
    line-height: 1;
    padding: 2px 7px;
    border-radius: var(--r, 4px);
    cursor: pointer;
  }
  .nwp-refresh:hover {
    color: var(--t1, #e6e9ef);
    border-color: var(--cyan, #22d3ee);
  }
  .nwp-body {
    position: relative;
    min-height: 220px;
  }
  .nwp-chart {
    width: 100%;
    height: 220px;
  }
  .nwp-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg1, #0b0b13);
  }
  .nwp-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    padding: 8px 4px 2px;
  }
  .nwp-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--t2, #9aa4b2);
  }
  .nwp-swatch {
    width: 9px;
    height: 9px;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .nwp-bot {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nwp-val {
    color: var(--t1, #e6e9ef);
    font-weight: 600;
  }
</style>
