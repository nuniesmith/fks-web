<script lang="ts">
  /**
   * /treasury headline — the carry-forward "Real net worth" number plus a
   * sparkline of its history.
   *
   * Same math as /bots' NetWorthHistoryPanel (shared via
   * $lib/treasury/rollup.ts): at each tick the total sums every account's
   * last-known value, so offset samplers and restart gaps don't dip. Paper
   * accounts (per `paperIds` — registry class first, stopgap fallback) are
   * EXCLUDED by default; a toggle folds them in for reference.
   */
  import { onDestroy } from 'svelte';
  import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
  import Panel from '$components/ui/Panel.svelte';
  import EmptyState from '$components/ui/EmptyState.svelte';
  import Skeleton from '$components/ui/Skeleton.svelte';
  import { carryForwardTotal, type AccountSeries } from '$lib/treasury/rollup';
  import { fmtMoney } from '$lib/treasury/cards';

  let { series, paperIds, loading, error, onRefresh } = $props<{
    series: AccountSeries[];
    paperIds: ReadonlySet<string>;
    loading: boolean;
    error: string | null;
    onRefresh: () => void;
  }>();

  let includePaper = $state(false);

  let inputs = $derived(
    (series as AccountSeries[]).filter((s) => includePaper || !paperIds.has(s.accountId)),
  );
  let totalPoints = $derived(carryForwardTotal(inputs.map((s) => s.points)));
  let latest = $derived(
    totalPoints.length > 0 ? totalPoints[totalPoints.length - 1].value : null,
  );
  // The sampler denominates every row in one currency (USD today).
  let currency = $derived(inputs[0]?.currency ?? 'USD');
  let hasPaper = $derived((series as AccountSeries[]).some((s) => paperIds.has(s.accountId)));
  let hasData = $derived(series.length > 0);

  // ── Sparkline (lightweight-charts, static — no scroll/scale traps on phone) ─

  let chartEl: HTMLDivElement | undefined = $state();
  let chart: IChartApi | null = null;
  let area: ISeriesApi<'Area'> | null = null;
  let drawSeq = 0;

  async function draw(points: { time: number; value: number }[]) {
    const seq = ++drawSeq;
    if (!chartEl) return;
    if (!chart) {
      const { createChart } = await import('lightweight-charts');
      // The dynamic import is the only await — newest draw wins the race.
      if (seq !== drawSeq || !chartEl) return;
      chart = createChart(chartEl, {
        autoSize: true,
        layout: {
          background: { type: 'solid' as any, color: 'transparent' },
          textColor: '#8890b8',
          fontFamily: "'SF Mono', 'Fira Code', monospace",
          fontSize: 9,
        },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        crosshair: {
          vertLine: { visible: false, labelVisible: false },
          horzLine: { visible: false, labelVisible: false },
        },
        handleScroll: false,
        handleScale: false,
        rightPriceScale: { visible: false },
        leftPriceScale: { visible: false },
        timeScale: { visible: false },
      });
    }
    if (seq !== drawSeq) return;
    if (!area) {
      area = chart.addAreaSeries({
        lineColor: '#5b6ef5',
        topColor: 'rgba(91, 110, 245, 0.28)',
        bottomColor: 'rgba(91, 110, 245, 0.02)',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
    }
    area.setData(points as { time: UTCTimestamp; value: number }[]);
    chart.timeScale().fitContent();
  }

  $effect(() => {
    const points = totalPoints;
    if (!chartEl) return;
    if (points.length === 0) {
      // e.g. only paper accounts exist and the toggle just excluded them.
      area?.setData([]);
      return;
    }
    void draw(points);
  });

  onDestroy(() => {
    chart?.remove();
    chart = null;
    area = null;
  });
</script>

<Panel title="Real net worth — carry-forward total">
  {#snippet header()}
    {#if hasPaper}
      <label class="paper-toggle">
        <input type="checkbox" bind:checked={includePaper} />
        include paper
      </label>
    {/if}
    <button
      type="button"
      class="refresh"
      onclick={onRefresh}
      title="Reload net-worth snapshots"
      aria-label="Refresh net worth"
    >
      ↻
    </button>
  {/snippet}

  <div class="body">
    <div class="figures">
      <span class="label">{includePaper ? 'Net worth (incl. paper)' : 'Real net worth'}</span>
      <span class="value">{latest != null ? fmtMoney(latest, currency) : '—'}</span>
      {#if hasData}
        <span class="sub">
          across {inputs.length} account{inputs.length === 1 ? '' : 's'}
          {#if hasPaper && !includePaper}· paper excluded{/if}
        </span>
      {/if}
    </div>

    <div class="spark-wrap">
      <div class="spark" bind:this={chartEl}></div>
      {#if loading && !hasData}
        <div class="overlay"><Skeleton height="90px" lines={1} /></div>
      {:else if error}
        <div class="overlay">
          <EmptyState
            icon="⚠️"
            title="Couldn't load net-worth history"
            variant="error"
            hint={`GET /api/spawner/net-worth failed (${error}). Check that the spawner is reachable.`}
          />
        </div>
      {:else if !hasData}
        <div class="overlay">
          <EmptyState
            icon="📈"
            title="No net-worth history yet"
            hint="The spawner sampler (or a manual snapshot below) appends rows into net_worth_snapshots — needs the spawner DB configured."
          />
        </div>
      {/if}
    </div>
  </div>
</Panel>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .figures {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 4px 0;
  }
  .label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--t3);
  }
  .value {
    font-size: 26px;
    font-weight: 700;
    color: var(--t1);
    font-family: var(--mono, 'SF Mono', 'Fira Code', monospace);
    line-height: 1.15;
  }
  .sub {
    font-size: 10px;
    color: var(--t3);
  }
  .spark-wrap {
    position: relative;
    min-height: 110px;
  }
  .spark {
    width: 100%;
    height: 110px;
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg1);
  }
  .paper-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    color: var(--t2);
    cursor: pointer;
    user-select: none;
  }
  .paper-toggle input {
    accent-color: var(--accent, #5b6ef5);
    cursor: pointer;
  }
  .refresh {
    background: transparent;
    border: 1px solid var(--b2);
    color: var(--t2);
    font-size: 12px;
    line-height: 1;
    padding: 2px 7px;
    border-radius: var(--r);
    cursor: pointer;
  }
  .refresh:hover {
    color: var(--t1);
    border-color: var(--cyan, #22d3ee);
  }
</style>
