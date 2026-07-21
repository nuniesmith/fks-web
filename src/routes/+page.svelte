<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { createSSE } from '$stores/sse';
  import { createPoll } from '$stores/poll';
  import { spawner } from '$api/spawner';
  import { ApiError } from '$api/client';
  import { focusSymbol } from '$stores/focusSymbol';
  import { POLL_INTERVAL_MS } from '$lib/config';
  import Badge from '$components/ui/Badge.svelte';
  import StatCard from '$components/ui/StatCard.svelte';
  import ProgressBar from '$components/ui/ProgressBar.svelte';
  import Skeleton from '$components/ui/Skeleton.svelte';
  import Panel from '$components/ui/Panel.svelte';
  import EmptyState from '$components/ui/EmptyState.svelte';
  import { fmtMoney, realNetWorthFromRows } from '$lib/treasury/cards';
  import { formatStaleAge, type StaleAccount } from '$lib/treasury/rollup';
  import type { StripData } from '$lib/types';
  import {
    fmtPrice,
    fmtPct,
    fmtDollar,
    fmtConfidence,
    scoreColor,
    signalVariant,
    riskVariant,
    regimeVariant,
    directionVariant,
  } from '$lib/utils/format';
  import type { PageData } from './$types';

  // ─── Server data (SSR prefetch) ────────────────────────────────────
  // Populated by +page.server.ts before first paint; client-side poll
  // stores take over on their first tick and these become unreferenced.
  let { data }: { data: PageData } = $props();

  // ─── Types ──────────────────────────────────────────────────────────
  // StripData is imported from $lib/types

  interface MarketAsset {
    symbol: string;
    name: string;
    price: number;
    score: number;
    cnn_signal?: string;
    asset_class?: string;
    age?: number;
    change_pct?: number;
  }

  interface OpenTrade {
    id: number;
    asset: string;
    direction: string;
    entry: number;
    pnl: number;
    contracts?: number;
    strategy?: string;
  }

  interface RecentSignal {
    symbol?: string;
    direction?: string;
    strategy?: string;
    confidence?: number;
    timestamp?: string;
  }

  interface FactoryStatus {
    status?: string;
    healthy?: boolean;
    workers?: Record<string, string>;
    providers?: Record<string, { state?: string; failures?: number }>;
    gap_count?: number;
    last_gap_scan?: string;
    uptime_seconds?: number;
  }

  // ─── SSE: Strip Stats ───────────────────────────────────────────────
  const stripSSE = createSSE<StripData>('/sse/strip');
  let strip = $derived($stripSSE);

  // ─── Poll: Market Scores ────────────────────────────────────────────
  const scoresStore = createPoll<MarketAsset[]>('/api/pipeline/scores/json', 30_000, {
    transform(raw: unknown): MarketAsset[] {
      if (raw && typeof raw === 'object' && 'assets' in raw) {
        return (raw as any).assets ?? [];
      }
      if (Array.isArray(raw)) return raw;
      return [];
    },
  });
  // Fall back to SSR-prefetched scores until the poll fires for the first time.
  let assets = $derived($scoresStore ?? (data.initialScores as MarketAsset[] | null) ?? []);

  // ─── Poll: Active Trades ────────────────────────────────────────────
  const tradesStore = createPoll<OpenTrade[]>('/api/trades/open', 5_000, {
    transform(raw: unknown): OpenTrade[] {
      if (Array.isArray(raw)) return raw;
      if (raw && typeof raw === 'object' && 'trades' in raw) return (raw as any).trades ?? [];
      return [];
    },
  });
  // Fall back to SSR-prefetched trades until the poll fires for the first time.
  let trades = $derived($tradesStore ?? (data.initialTrades as OpenTrade[] | null) ?? []);

  // ─── Poll: Recent Signals ──────────────────────────────────────────
  const signalsStore = createPoll<RecentSignal[]>('/api/db/redis/get/fks:memories:new', 10_000, {
    transform(raw: unknown): RecentSignal[] {
      if (Array.isArray(raw)) return raw;
      if (raw && typeof raw === 'object') {
        if ('value' in raw) {
          const val = (raw as any).value;
          if (typeof val === 'string') {
            try { const p = JSON.parse(val); return Array.isArray(p) ? p : [p]; } catch { return []; }
          }
          return Array.isArray(val) ? val : [val];
        }
        return [raw as RecentSignal];
      }
      return [];
    },
  });
  let signals = $derived($signalsStore ?? []);

  // ─── Poll: Factory Status ──────────────────────────────────────────
  const factoryStore = createPoll<FactoryStatus>('/factory/status', POLL_INTERVAL_MS, {
    transform(raw: unknown): FactoryStatus {
      if (raw && typeof raw === 'object') return raw as FactoryStatus;
      return { status: 'unknown' };
    },
  });
  // Fall back to SSR-prefetched factory status until the poll fires for the first time.
  let factory = $derived(
    $factoryStore ??
    (data.initialFactory as FactoryStatus | null) ??
    ({ status: 'unknown' } as FactoryStatus)
  );

  function factoryColor(f: FactoryStatus): string {
    if (!f || f.status === 'unknown' || f.status === 'not_started') return 'var(--dim)';
    if (f.status === 'error' || f.healthy === false) return 'var(--red)';
    if (f.gap_count && f.gap_count > 0) return 'var(--yellow)';
    return 'var(--green)';
  }

  function factoryLabel(f: FactoryStatus): string {
    if (!f || f.status === 'unknown') return 'Offline';
    if (f.status === 'not_started') return 'Not Started';
    if (f.status === 'error' || f.healthy === false) return 'Error';
    if (f.gap_count && f.gap_count > 0) return `${f.gap_count} Gap${f.gap_count > 1 ? 's' : ''}`;
    return 'Healthy';
  }

  function factoryVariant(f: FactoryStatus): 'green' | 'amber' | 'red' | 'default' {
    if (!f || f.status === 'unknown' || f.status === 'not_started') return 'default';
    if (f.status === 'error' || f.healthy === false) return 'red';
    if (f.gap_count && f.gap_count > 0) return 'amber';
    return 'green';
  }

  // ─── Money snapshot ─────────────────────────────────────────────────
  // Replaces the old "AI Brief" panel (which polled the unmapped
  // /api/grok/briefing → a permanently-empty panel behind a live-looking
  // Refresh button). This shows the SAME "Real net worth" figure as the
  // /treasury headline: the exact spawner /net-worth data + registry, run
  // through the shared realNetWorthFromRows() roll-up (paper excluded).
  let moneyLatest = $state<number | null>(null);
  let moneyCurrency = $state('USD');
  let moneyRealCount = $state(0);
  // Stale REAL accounts whose frozen carry-forward balance is still summed into
  // moneyLatest — surfaced with the SAME ⚠ caveat the /treasury headline shows,
  // so the landing page can't read a possibly-overstated total as live money.
  let moneyStale = $state<StaleAccount[]>([]);
  let moneyStaleValue = $state(0);
  let moneyLoading = $state(true);
  let moneyError = $state<string | null>(null);
  // TODO(Phase A): once /api/cockpit/live-status ships, add a red LIVE chip
  // here (linking to /cockpit) when the live twin reports an armed bot. That
  // feed is not built yet, so no chip is rendered — no fake liveness.

  async function loadMoney() {
    moneyLoading = true;
    moneyError = null;
    try {
      // Same query the /treasury headline uses (limit 5000 = endpoint cap)
      // and the same accounts registry, so the totals cannot diverge.
      const [rows, acctRes] = await Promise.all([
        spawner.netWorth({ limit: 5000 }),
        spawner.accounts(),
      ]);
      const snap = realNetWorthFromRows(rows, acctRes.accounts ?? []);
      moneyLatest = snap.latest;
      moneyCurrency = snap.currency;
      moneyRealCount = snap.realCount;
      moneyStale = snap.stale;
      moneyStaleValue = snap.staleValue;
    } catch (e: unknown) {
      moneyError = e instanceof ApiError ? `${e.status} ${e.statusText}` : String(e);
      console.warn('[overview/money]', e);
    } finally {
      moneyLoading = false;
    }
  }

  // ─── Phone layout (single scroll region on small screens) ───────────
  // On phone the PAGE owns the one vertical scroll, so the Market Overview
  // panel must NOT be `fill` (a fill panel is height-constrained with its
  // own inner scroller — that would collapse to ~0px inside the stacked,
  // page-scrolled column). Desktop keeps fill=true (pixel-unchanged).
  let isPhone = $state(false);
  let phoneMq: MediaQueryList | undefined;
  const onPhoneChange = (e: MediaQueryListEvent) => { isPhone = e.matches; };

  // ─── Helpers ────────────────────────────────────────────────────────
  // ─── Helpers imported from $lib/utils/format ────────────────────────
  // fmtPrice, fmtPct, fmtDollar, fmtConfidence, scoreColor,
  // signalVariant, riskVariant, regimeVariant, directionVariant

  // ─── Lifecycle ──────────────────────────────────────────────────────
  onMount(() => {
    stripSSE.connect();
    scoresStore.start();
    tradesStore.start();
    signalsStore.start();
    factoryStore.start();
    void loadMoney();
    phoneMq = window.matchMedia('(max-width: 760px)');
    isPhone = phoneMq.matches;
    phoneMq.addEventListener('change', onPhoneChange);
  });

  onDestroy(() => {
    stripSSE.disconnect();
    scoresStore.stop();
    tradesStore.stop();
    signalsStore.stop();
    factoryStore.stop();
    phoneMq?.removeEventListener('change', onPhoneChange);
  });

  function openAsset(symbol: string) {
    focusSymbol.set(symbol);
    void goto('/trading');
  }
</script>

<svelte:head>
  <title>Overview — FKS Terminal</title>
</svelte:head>

<div class="page">

  <!-- ═══════════════════════════════════════════════════════════════════
       TOP: Strip-style stat row
       ═══════════════════════════════════════════════════════════════════ -->
  <div class="stat-strip">
    <StatCard
      label="Focus"
      value={strip?.focus?.symbol ?? '—'}
      color="cyan"
    />
    <StatCard
      label="Day P&L (janus)"
      value={fmtDollar(strip?.pnl?.daily)}
      color={(strip?.pnl?.daily ?? 0) >= 0 ? 'green' : 'red'}
    />
    <StatCard
      label="Equity (janus)"
      value={strip?.equity != null ? '$' + strip.equity.toLocaleString() : '—'}
      color="default"
    />
    <div class="stat-badge-card">
      <span class="stat-badge-label">Risk</span>
      <Badge variant={riskVariant(strip?.risk?.dd_pct)}>
        {strip?.risk?.dd_pct != null ? `DD ${strip.risk.dd_pct.toFixed(1)}%` : '—'}
      </Badge>
    </div>
    <div class="stat-badge-card">
      <span class="stat-badge-label">Regime</span>
      <Badge variant={regimeVariant(strip?.regime?.label)}>
        {strip?.regime?.label ?? '—'}
      </Badge>
    </div>
    <div class="stat-badge-card">
      <span class="stat-badge-label">Factory</span>
      <Badge variant={factoryVariant(factory)}>
        <span class="factory-dot" style="background:{factoryColor(factory)}"></span>
        {factoryLabel(factory)}
      </Badge>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════════
       MIDDLE: Two-column content area
       ═══════════════════════════════════════════════════════════════════ -->
  <div class="body">

    <!-- ─── LEFT (60%): Market Overview Table ──────────────────────── -->
    <div class="pane pane-left">
      <Panel title="Market Overview" badge="30s poll" noPad fill={!isPhone}>
          {#if assets.length === 0}
            <Skeleton lines={6} />
          {:else}
            <div class="tbl-wrap">
            <table class="tbl">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Name</th>
                  <th>Price</th>
                  <th>Score</th>
                  <th>Signal</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {#each assets as asset}
                  <tr
                    class="tbl-row-link"
                    tabindex="0"
                    role="button"
                    aria-label="View {asset.symbol} in Trading workspace"
                    onclick={() => openAsset(asset.symbol)}
                    onkeydown={(e: KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openAsset(asset.symbol);
                      }
                    }}
                  >
                    <td class="accent">{asset.symbol}</td>
                    <td class="muted name-cell">{asset.name ?? '—'}</td>
                    <td>{fmtPrice(asset.price)}</td>
                    <td class="score-cell">
                      <ProgressBar
                        value={asset.score ?? 0}
                        color={scoreColor(asset.score ?? 0)}
                        height="5px"
                        label={asset.score?.toFixed(0) ?? '—'}
                      />
                    </td>
                    <td>
                      {#if asset.cnn_signal}
                        <Badge variant={signalVariant(asset.cnn_signal)}>
                          {asset.cnn_signal}
                        </Badge>
                      {:else}
                        <span class="muted">—</span>
                      {/if}
                    </td>
                    <td class="muted">{asset.age != null ? asset.age + 'd' : '—'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
            </div>
          {/if}
      </Panel>
    </div>

    <!-- ─── RIGHT (40%): Quick Panels ─────────────────────────────── -->
    <div class="pane pane-right">

      <!-- Panel 1: Money snapshot (real net worth — mirrors /treasury) -->
      <Panel title="Money">
        {#snippet header()}
          <button class="btn-refresh" onclick={loadMoney} disabled={moneyLoading} aria-label="Refresh net worth">
            {moneyLoading ? '⟳' : '↻'} Refresh
          </button>
        {/snippet}
          {#if moneyLoading && moneyLatest == null && !moneyError}
            <Skeleton lines={2} />
          {:else if moneyError}
            <EmptyState
              icon="⚠️"
              title="Couldn't load net worth"
              variant="error"
              hint={`GET /api/spawner/net-worth failed (${moneyError}). Check that the spawner is reachable.`}
            />
          {:else}
            <div class="money">
              <span class="money-label">Real net worth</span>
              <span class="money-value">{fmtMoney(moneyLatest, moneyCurrency)}</span>
              <span class="money-sub">
                {#if moneyLatest != null}
                  across {moneyRealCount} account{moneyRealCount === 1 ? '' : 's'} · paper excluded
                {:else}
                  No net-worth snapshots yet.
                {/if}
              </span>
              {#if moneyStale.length > 0}
                <span
                  class="money-stale"
                  title={moneyStale.map((s) => `${s.accountId} — as of ${formatStaleAge(s.ageSeconds)} ago`).join('\n')}
                >
                  ⚠ includes {fmtMoney(moneyStaleValue, moneyCurrency)} from {moneyStale.length} stale
                  account{moneyStale.length === 1 ? '' : 's'} — oldest as of {formatStaleAge(moneyStale[0].ageSeconds)} ago
                </span>
              {/if}
              <a class="money-link" href="/treasury">Open treasury →</a>
            </div>
          {/if}
      </Panel>

      <!-- Panel 2: Active Trades (janus paper) -->
      <Panel title="Active Trades (janus paper)" badge="5s poll">
          <p class="paper-note">
            janus simulated/paper trades — not real money. Real balances live on
            <a href="/treasury">treasury</a>, <a href="/exchanges">exchanges</a> & <a href="/cockpit">cockpit</a>.
          </p>
          {#if trades.length === 0}
            <EmptyState icon="∅" title="No open trades" hint="Open positions will appear here." />
          {:else}
            <ul class="compact-list">
              {#each trades as trade}
                <li class="compact-item">
                  <span class="compact-symbol">{trade.asset}</span>
                  <Badge variant={directionVariant(trade.direction)}>
                    {trade.direction?.toUpperCase() ?? '—'}
                  </Badge>
                  <span class="compact-detail">@ {fmtPrice(trade.entry)}</span>
                  <span
                    class="compact-pnl"
                    class:green={(trade.pnl ?? 0) >= 0}
                    class:red={(trade.pnl ?? 0) < 0}
                  >
                    {fmtDollar(trade.pnl)}
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
      </Panel>

      <!-- Panel 3: Data Factory -->
      <Panel title="Data Factory" badge="30s poll">
          {#if factory.status === 'unknown'}
            <EmptyState icon="∅" title="Factory status unavailable" hint="The data factory isn't reporting status." />
          {:else}
            <ul class="compact-list">
              <li class="compact-item">
                <span class="compact-symbol">Status</span>
                <Badge variant={factoryVariant(factory)}>
                  {factoryLabel(factory)}
                </Badge>
              </li>
              {#if factory.gap_count != null}
                <li class="compact-item">
                  <span class="compact-symbol">Data Gaps</span>
                  <span class:red={factory.gap_count > 0} class:green={factory.gap_count === 0}>
                    {factory.gap_count}
                  </span>
                </li>
              {/if}
              {#if factory.last_gap_scan}
                <li class="compact-item">
                  <span class="compact-symbol">Last Scan</span>
                  <span class="muted">{factory.last_gap_scan}</span>
                </li>
              {/if}
              {#if factory.providers}
                {#each Object.entries(factory.providers) as [name, prov]}
                  <li class="compact-item">
                    <span class="compact-symbol">{name}</span>
                    <Badge variant={prov.state === 'closed' ? 'green' : prov.state === 'half_open' ? 'amber' : 'red'}>
                      {prov.state ?? '?'}
                    </Badge>
                  </li>
                {/each}
              {/if}
            </ul>
          {/if}
      </Panel>

      <!-- Panel 4: Recent Signals -->
      <Panel title="Recent Signals" badge="10s poll">
          {#if signals.length === 0}
            <EmptyState icon="∅" title="No recent signals" hint="Signals appear here as the brain emits them." />
          {:else}
            <ul class="compact-list">
              {#each signals as sig}
                <li class="compact-item">
                  <span class="compact-symbol">{sig.symbol ?? '—'}</span>
                  {#if sig.direction}
                    <Badge variant={directionVariant(sig.direction)}>
                      {sig.direction.toUpperCase()}
                    </Badge>
                  {/if}
                  {#if sig.strategy}
                    <span class="compact-detail">{sig.strategy}</span>
                  {/if}
                  <span class="compact-conf muted">
                    {fmtConfidence(sig.confidence)}
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
      </Panel>

    </div><!-- /.pane-right -->
  </div><!-- /.body -->
</div><!-- /.page -->

<style>
  /* ═══════════════════════════════════════════════════════════════════
     Layout
     ═══════════════════════════════════════════════════════════════════ */
  .page {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .pane {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
    gap: 0;
  }

  .pane-left {
    flex: 6;
    border-right: 1px solid var(--b1);
    min-width: 0;
    /* Single scroll region: the lone `fill` Market Overview panel owns the
       scroll (its sticky thead pins to the panel body). No pane-level
       overflow — that was a redundant second scroller. */
    padding: 8px;
  }

  .pane-right {
    flex: 4;
    min-width: 240px;
    max-width: 480px;
    overflow-y: auto;
    padding: 8px;
    gap: 8px;
  }

  /* ═══════════════════════════════════════════════════════════════════
     Stat Strip (top row)
     ═══════════════════════════════════════════════════════════════════ */
  .stat-strip {
    display: flex;
    align-items: stretch;
    gap: 8px;
    padding: 8px 10px;
    background: var(--bg0);
    border-bottom: 1px solid var(--b1);
    flex-shrink: 0;
    overflow-x: auto;
  }

  .stat-badge-card {
    background: var(--bg2);
    border: 1px solid var(--b2);
    border-radius: var(--r-md);
    padding: 10px 14px;
    min-width: 100px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .stat-badge-label {
    font-size: 9px;
    font-weight: 600;
    color: var(--t3);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    line-height: 1;
  }

  .factory-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    margin-right: 4px;
    vertical-align: middle;
  }

  /* Panel chrome is now handled by the <Panel> component */

  /* ═══════════════════════════════════════════════════════════════════
     Market Overview Table
     ═══════════════════════════════════════════════════════════════════ */
  .tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }

  .tbl th {
    text-align: left;
    padding: 6px 8px;
    color: var(--t3);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--b2);
    white-space: nowrap;
    position: sticky;
    top: 0;
    background: var(--bg2);
    z-index: 1;
  }

  .tbl td {
    padding: 5px 8px;
    border-bottom: 1px solid var(--b1);
    white-space: nowrap;
  }

  .tbl-row-link {
    cursor: pointer;
    transition: background 0.1s ease;
  }

  .tbl-row-link:hover {
    background: var(--bg3);
  }

  .name-cell {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .score-cell {
    min-width: 100px;
  }

  /* ═══════════════════════════════════════════════════════════════════
     Money snapshot
     ═══════════════════════════════════════════════════════════════════ */
  .btn-refresh {
    all: unset;
    cursor: pointer;
    font-size: 9px;
    color: var(--t3);
    padding: 2px 8px;
    border-radius: var(--r);
    background: var(--bg3);
    margin-left: auto;
    transition: color 0.12s, background 0.12s;
  }

  .btn-refresh:hover:not(:disabled) {
    color: var(--cyan);
    background: var(--bg0);
  }

  .btn-refresh:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .money {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 2px;
  }
  .money-label {
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--t3);
  }
  .money-value {
    font-size: 24px;
    font-weight: 700;
    color: var(--t1);
    font-variant-numeric: tabular-nums;
    line-height: 1.15;
  }
  .money-sub {
    font-size: 10px;
    color: var(--t3);
  }
  /* Same honesty caveat wording/tone as TreasuryHeadline's `.stale`. */
  .money-stale {
    font-size: 10px;
    color: var(--amber, #f0a500);
    cursor: help;
  }
  .money-link {
    margin-top: 4px;
    font-size: 11px;
    color: var(--cyan);
    text-decoration: none;
    width: fit-content;
  }
  .money-link:hover {
    text-decoration: underline;
  }
  .paper-note {
    margin: 0 0 6px;
    font-size: 10px;
    line-height: 1.5;
    color: var(--t3);
  }
  .paper-note a {
    color: var(--cyan);
    text-decoration: none;
  }
  .paper-note a:hover {
    text-decoration: underline;
  }

  /* ═══════════════════════════════════════════════════════════════════
     Compact Lists (trades, signals)
     ═══════════════════════════════════════════════════════════════════ */
  .compact-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .compact-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 4px;
    border-bottom: 1px solid var(--b1);
    font-size: 11px;
  }

  .compact-item:last-child {
    border-bottom: none;
  }

  .compact-symbol {
    font-weight: 700;
    color: var(--accent);
    min-width: 40px;
  }

  .compact-detail {
    color: var(--t3);
    font-size: 10px;
  }

  .compact-pnl {
    margin-left: auto;
    font-weight: 600;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .compact-conf {
    margin-left: auto;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }


  /* ═══════════════════════════════════════════════════════════════════
     Utility
     ═══════════════════════════════════════════════════════════════════ */
  .accent { color: var(--accent); }
  .muted  { color: var(--t3); }
  .green  { color: var(--green); }
  .red    { color: var(--red); }

  /* Table x-scroll wrapper. Desktop: a plain block (overflow visible), so it
     is NOT a scroll container and the sticky thead still pins to the `fill`
     panel body — desktop stays pixel-identical. Phone: it owns the horizontal
     scroll for the 6-col table (which can't fit 390px) while the PAGE owns the
     single vertical scroll. */
  .tbl-wrap {
    width: 100%;
  }

  /* ═══════════════════════════════════════════════════════════════════
     Phone (≤760px, the repo breakpoint): stack the two panes and hand the
     ONE vertical scroll to the page. All rules scoped to this query so the
     desktop layout is untouched. Market Overview drops `fill` in markup
     (isPhone) so it grows with its content instead of collapsing.
     ═══════════════════════════════════════════════════════════════════ */
  @media (max-width: 760px) {
    .page {
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .body {
      flex-direction: column;
      overflow: visible;
      min-height: 0;
    }
    .pane-left {
      border-right: none;
      min-width: 0;
    }
    .pane-right {
      max-width: none;
      min-width: 0;
      overflow-y: visible;
    }
    .tbl-wrap {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    /* On phone the panel is fill=false (grows to content) and the PAGE owns
       the one vertical scroll, while `.tbl-wrap` becomes the x-scroller — which
       CSS promotes to overflow:auto on BOTH axes, making it the sticky thead's
       scroll container. With no internal vertical scroll the header can't
       usefully pin (it would resolve against tbl-wrap and scroll off with the
       rows), so drop sticky here and let it flow with the table. Desktop keeps
       overflow:visible → the thead still pins to the fill panel body. */
    .tbl th {
      position: static;
    }
  }

</style>
