<script lang="ts">
  /**
   * NetWorthHistoryPanel — the "net worth of EVERYTHING" view (treasury P0.2).
   *
   * Backed by the spawner's db-gated `GET /net-worth` (proxied at
   * /api/spawner/net-worth), which reads the append-only `net_worth_snapshots`
   * table in ruby_db. Unlike exchanges/NetWorthHistory (Prometheus, 30-day
   * retention) this is the years-horizon record.
   *
   * The primary line is the carry-forward TOTAL across bots (see
   * $lib/treasury/rollup.ts): at each tick it sums every bot's last-known
   * value, so offset samplers and restart gaps don't produce artificial dips.
   * Per-bot lines are secondary and toggleable from the legend, which groups
   * bots by account class ($lib/treasury/accountClass.ts). Paper-class bots
   * (fake balances, e.g. crypto-funding's 10 000 USDT) are EXCLUDED from the
   * headline TOTAL by default — the headline is "Real net worth" — with a
   * toggle to fold them in.
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
  import {
    classifyBot,
    isPaper,
    CLASS_LABELS,
    CLASS_ORDER,
    type AccountClass,
  } from '$lib/treasury/accountClass';
  import { carryForwardTotal } from '$lib/treasury/rollup';

  // One plotted line per bot, plus the latest value for the legend.
  interface BotSeries {
    botId: string;
    accountClass: AccountClass;
    color: string;
    latest: number;
    currency: string;
    points: { time: UTCTimestamp; value: number }[];
  }

  interface LegendGroup {
    cls: AccountClass;
    label: string;
    bots: BotSeries[];
  }

  // Theme accents, cycled one-per-bot (matches exchanges/NetWorthHistory).
  const PALETTE = ['#22d3ee', '#a78bfa', '#34d399', '#f59e0b', '#f472b6', '#60a5fa', '#f87171'];
  // The TOTAL line gets the brand accent (--accent) so it reads as primary.
  const TOTAL_COLOR = '#5b6ef5';

  let loading = $state(true);
  let errored = $state(false);
  let botSeries = $state<BotSeries[]>([]);
  /** Fold paper-class bots into the headline TOTAL (off by default). */
  let includePaper = $state(false);
  /** Per-bot lines hidden via legend clicks (TOTAL is never hideable). */
  let hiddenBots = $state<ReadonlySet<string>>(new Set());
  let hasData = $derived(botSeries.length > 0);
  let hasPaper = $derived(botSeries.some((b) => isPaper(b.accountClass)));

  // Bots feeding the headline TOTAL: paper is excluded unless toggled in.
  let totalInputs = $derived(botSeries.filter((b) => includePaper || !isPaper(b.accountClass)));
  let totalPoints = $derived(carryForwardTotal(totalInputs.map((b) => b.points)));
  let totalLatest = $derived(
    totalPoints.length > 0 ? totalPoints[totalPoints.length - 1].value : null
  );
  // The sampler denominates every row in one currency (USD today); take the
  // label from the first contributing bot.
  let totalCurrency = $derived(totalInputs[0]?.currency ?? 'USD');

  // Legend rows grouped under their account class, real money first.
  let legendGroups = $derived.by<LegendGroup[]>(() => {
    const by = new Map<AccountClass, BotSeries[]>();
    for (const b of botSeries) {
      const arr = by.get(b.accountClass);
      if (arr) arr.push(b);
      else by.set(b.accountClass, [b]);
    }
    return CLASS_ORDER.filter((c) => by.has(c)).map((c) => ({
      cls: c,
      label: CLASS_LABELS[c],
      bots: by.get(c)!,
    }));
  });

  let chartEl: HTMLDivElement | undefined = $state();
  let chart: IChartApi | null = null;
  let lines: ISeriesApi<'Line'>[] = [];
  // Redraws race only through ensureChart's dynamic import; the sequence
  // token lets the newest draw win.
  let drawSeq = 0;

  /**
   * Group flat snapshot rows into one ascending, de-duped series per bot.
   * lightweight-charts rejects non-increasing times, so a collision on the same
   * whole second keeps the latest value. Ascending + de-duped is also the
   * precondition carryForwardTotal relies on. Pure — no chart / DOM access.
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
        accountClass: classifyBot(botId),
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

  /** Full redraw: per-bot lines first (secondary), TOTAL last so it's on top. */
  async function draw(
    bots: BotSeries[],
    total: { time: UTCTimestamp; value: number }[],
    hidden: ReadonlySet<string>
  ) {
    const seq = ++drawSeq;
    await ensureChart();
    if (seq !== drawSeq) return;
    const c = chart;
    if (!c) return;
    clearLines();
    for (const b of bots) {
      const s = c.addLineSeries({
        color: b.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        visible: !hidden.has(b.botId),
        title: b.botId,
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });
      s.setData(b.points);
      lines.push(s);
    }
    if (total.length > 0) {
      const s = c.addLineSeries({
        color: TOTAL_COLOR,
        lineWidth: 3,
        priceLineVisible: false,
        lastValueVisible: true,
        title: 'TOTAL',
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });
      s.setData(total);
      lines.push(s);
    }
    c.timeScale().fitContent();
  }

  // Redraw whenever the data, the paper toggle (via totalPoints), or a legend
  // visibility toggle changes. Reads are synchronous so they're all tracked.
  $effect(() => {
    const bots = botSeries;
    const total = totalPoints;
    const hidden = hiddenBots;
    if (!chartEl || bots.length === 0) return;
    void draw(bots, total, hidden);
  });

  async function load() {
    loading = true;
    errored = false;
    try {
      // 5000 = the endpoint's hard cap; the default 500 is too shallow once
      // several bots are sampled every few minutes.
      botSeries = groupByBot(await spawner.netWorth({ limit: 5000 }));
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

  function toggleBot(botId: string) {
    const next = new Set(hiddenBots);
    if (next.has(botId)) next.delete(botId);
    else next.add(botId);
    hiddenBots = next;
  }

  function money(value: number, currency: string): string {
    const n = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return currency === 'USD' ? `$${n}` : `${n} ${currency}`;
  }
</script>

<Panel title="Net-worth history — total roll-up">
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
      <div class="nwp-total">
        <span class="nwp-total-swatch"></span>
        <span class="nwp-total-label">
          {includePaper ? 'Net worth (incl. paper)' : 'Real net worth'}
        </span>
        <span class="nwp-total-val">
          {totalLatest != null ? money(totalLatest, totalCurrency) : '—'}
        </span>
        {#if hasPaper}
          <label class="nwp-paper-toggle">
            <input type="checkbox" bind:checked={includePaper} />
            include paper
          </label>
        {/if}
      </div>
      <div class="nwp-groups">
        {#each legendGroups as g (g.cls)}
          <div class="nwp-group">
            <span class="nwp-class">
              {g.label}{#if isPaper(g.cls) && !includePaper}<span class="nwp-excl">
                  · excluded from total</span
                >{/if}
            </span>
            {#each g.bots as b (b.botId)}
              <button
                type="button"
                class="nwp-item"
                class:nwp-off={hiddenBots.has(b.botId)}
                onclick={() => toggleBot(b.botId)}
                title={hiddenBots.has(b.botId) ? `Show ${b.botId}` : `Hide ${b.botId}`}
                aria-pressed={!hiddenBots.has(b.botId)}
              >
                <span class="nwp-swatch" style:background={b.color}></span>
                <span class="nwp-bot">{b.botId}</span>
                <span class="nwp-val">{money(b.latest, b.currency)}</span>
              </button>
            {/each}
          </div>
        {/each}
      </div>
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
    flex-direction: column;
    gap: 6px;
    padding: 8px 4px 2px;
  }
  .nwp-total {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--b1, #1a1a2e);
  }
  .nwp-total-swatch {
    width: 18px;
    height: 3px;
    border-radius: 2px;
    background: var(--accent, #5b6ef5);
    flex-shrink: 0;
  }
  .nwp-total-label {
    color: var(--t2, #9aa4b2);
  }
  .nwp-total-val {
    color: var(--t1, #e6e9ef);
    font-size: 13px;
    font-weight: 700;
  }
  .nwp-paper-toggle {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    color: var(--t2, #9aa4b2);
    cursor: pointer;
    user-select: none;
  }
  .nwp-paper-toggle input {
    accent-color: var(--accent, #5b6ef5);
    cursor: pointer;
  }
  .nwp-groups {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .nwp-group {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  .nwp-class {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--t3, #454870);
  }
  .nwp-excl {
    text-transform: none;
    letter-spacing: 0;
    color: var(--amber, #f0a500);
  }
  .nwp-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-family: inherit;
    color: var(--t2, #9aa4b2);
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  .nwp-item.nwp-off {
    opacity: 0.4;
  }
  .nwp-item.nwp-off .nwp-bot {
    text-decoration: line-through;
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
