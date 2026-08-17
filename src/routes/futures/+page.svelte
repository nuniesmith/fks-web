<script lang="ts">
  /**
   * /futures — trading types built ON TOP of the backing accounts
   * (/exchanges). Each type pairs a venue with a data source. Live today:
   * crypto futures via the kucoin-futures funding bot (paper). Planned:
   * CME/COMEX regular futures and further types — placeholder cards until
   * their integrations exist.
   *
   * Data: GET /api/exchanges/status (same poll as /exchanges); this page
   * reads the `funding` document.
   */
  import { onMount } from 'svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import Badge from '$lib/components/ui/Badge.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import AsyncSection from '$lib/components/ui/AsyncSection.svelte';
  import StatCard from '$lib/components/ui/StatCard.svelte';
  import MiniChart from '$lib/components/ui/MiniChart.svelte';
  import { createPoll } from '$lib/stores/poll';
  import { api } from '$api/client';
  import { fmtDollar, fmtMoney, fmtPct, fmtFixed, fmtInt } from '$lib/utils/format';
  import { modeVariant } from '$lib/utils/mode';
  import type { ExchangesStatus, VenueStatus, PositionStatus } from '$lib/types/exchanges';
  import type { RithmicPositionsView, RithmicPosition } from '$lib/types/rithmic';

  const status = createPoll<ExchangesStatus>('/api/exchanges/status', 10_000);
  // Q-1: aliased at top level so Svelte auto-subscribes ($statusUpdatedAt /
  // $statusError). `$status.updatedAt` would read a field off the DATA, not the
  // store. Both are needed to tell "still asking" (skeleton) from "asked and
  // got nothing" (red outage): `updatedAt` is null in BOTH cases, so keying the
  // skeleton on it alone would shimmer forever against a refusing status server
  // — a calm animation over an unobserved book.
  //
  // NOT a freshness indicator. See the guard-rail at the venue-meta render site
  // below: nothing on this page may threshold `v.updated`.
  const statusUpdatedAt = status.updatedAt;
  const statusError = status.error;
  $effect(() => {
    status.start();
    return () => status.stop();
  });

  let funding = $derived($status?.funding ?? null);
  let fundingVenues = $derived(funding?.exchanges ?? []);

  // ── Rithmic capability gate + futures charts ──────────────────────────────
  // The connector (fks #182) writes candles_futures with venue-tagged symbols
  // (rithmic:MESU6). The Rithmic section lights up only when a broker
  // credential exists (capabilities.rithmic); the chart fills once the
  // connector runs — honest empty states until then.
  let rithmicEnabled = $state(false);
  let futuresSymbols = $state<string[]>([]);
  let selectedFuture = $state<string | null>(null);

  // Read-only positions book (fks #183). Polled only once Rithmic is enabled;
  // the adapter returns an honest empty/disconnected view when the connector
  // isn't running (it's `rithmic` profile-gated), so this never errors.
  const positions = createPoll<RithmicPositionsView>('/api/rithmic/positions', 15_000);
  $effect(() => {
    if (!rithmicEnabled) return;
    positions.start();
    return () => positions.stop();
  });
  let posView = $derived($positions ?? null);
  let openPositions = $derived(posView?.positions ?? []);
  let acctSummary = $derived(posView?.account_summary ?? null);

  onMount(async () => {
    try {
      const caps = await api.get<{ rithmic?: boolean }>('/api/capabilities');
      rithmicEnabled = caps?.rithmic === true;
    } catch { /* gated off */ }
    try {
      const res = await api.get<{ symbols?: string[] }>('/api/futures/symbols');
      futuresSymbols = res?.symbols ?? [];
      if (futuresSymbols.length) selectedFuture = futuresSymbols[0];
    } catch { /* none yet */ }
  });

  function posDirVariant(p: RithmicPosition): 'green' | 'red' | 'default' {
    if (p.net_quantity > 0) return 'green';
    if (p.net_quantity < 0) return 'red';
    return 'default';
  }

  /** Trading types not integrated yet — rendered as placeholder cards. */
  const PLANNED_TYPES = [
    {
      name: 'CME / COMEX futures',
      blurb: 'Regular futures — MES, MNQ, MGC, SIL, … Manual trading co-pilot first.',
      dataSource: 'Rithmic (planned)',
    },
    {
      name: 'Additional trading types',
      blurb: 'Each new type plugs in as a venue + data source pair on top of the backing accounts.',
      dataSource: 'per type',
    },
  ];

  /**
   * Age of a funding-bot venue's LAST TRADE EVENT — not a poll age.
   *
   * The paper funding bot marks its book on trade events, so a healthy idle
   * bot legitimately reports 15+ hours here. See the render site below and the
   * gating comment at `exchanges/[exchange]/+page.svelte:79,171`.
   */
  function agoSecs(epochSecs: number): string {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - epochSecs));
    if (s < 90) return `${s}s ago`;
    if (s < 5400) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  }

  function dirLabel(p: PositionStatus): string {
    return p.dir > 0 ? 'LONG' : 'SHORT';
  }

  function venueKey(v: VenueStatus): string {
    return `${v.exchange}:${v.mode}`;
  }
</script>

<svelte:head>
  <title>Futures — FKS Terminal</title>
</svelte:head>

<div class="page-scroll futures-page">
  <p class="page-blurb">
    Trading types built on top of the
    <a class="detail-link" href="/exchanges">backing accounts</a> — each pairs a
    venue with a data source.
  </p>

  <!-- ── Rithmic futures (capability-gated) ─────────────────────────── -->
  <Panel title="Rithmic Futures">
    {#snippet header()}
      <Badge variant={rithmicEnabled ? 'green' : 'default'}>
        {rithmicEnabled ? 'connected' : 'not configured'}
      </Badge>
    {/snippet}
    {#if !rithmicEnabled}
      <EmptyState
        icon="🎛"
        title="Rithmic not configured"
        hint="Add Rithmic broker credentials in Settings to enable the futures feed. Read-only: positions, order history, and DOM/book data — never autonomous orders."
      />
    {:else if futuresSymbols.length === 0}
      <EmptyState
        icon="📡"
        title="Rithmic connected — no futures data yet"
        hint="Start the rithmic-connector (rithmic compose profile) with your credentials to fill candles_futures. Symbols appear here once bars arrive."
      />
    {:else}
      <div class="fut-picker">
        {#each futuresSymbols as s (s)}
          <button class="btn-ghost" class:active={selectedFuture === s}
            onclick={() => (selectedFuture = s)}>{s.replace('rithmic:', '')}</button>
        {/each}
      </div>
      {#if selectedFuture}
        <div class="fut-chart">
          <MiniChart symbol={selectedFuture} interval="1m" />
        </div>
      {/if}
    {/if}
  </Panel>

  <!-- ── Rithmic positions (read-only, capability-gated) ─────────────── -->
  {#if rithmicEnabled}
    <Panel title="Rithmic Positions">
      {#snippet header()}
        <Badge variant={posView?.connected ? 'green' : 'default'}>
          {posView?.connected ? 'read-only' : 'connector idle'}
        </Badge>
      {/snippet}
      {#if acctSummary}
        <div class="stat-row">
          <StatCard
            label="Open PnL"
            value={fmtDollar(acctSummary.open_pnl)}
            color={acctSummary.open_pnl >= 0 ? 'green' : 'red'}
          />
          <StatCard
            label="Day PnL"
            value={fmtDollar(acctSummary.day_pnl)}
            color={acctSummary.day_pnl >= 0 ? 'green' : 'red'}
          />
          <StatCard label="Account balance" value={fmtDollar(acctSummary.account_balance)} />
        </div>
      {/if}
      {#if openPositions.length > 0}
        <table class="holdings">
          <thead>
            <tr>
              <th>Symbol</th><th>Dir</th><th>Net</th><th>Avg open</th>
              <th>Open PnL</th><th>Day PnL</th>
            </tr>
          </thead>
          <tbody>
            {#each openPositions as p (p.symbol)}
              <tr>
                <td>{p.symbol.replace('rithmic:', '')}</td>
                <td><Badge variant={posDirVariant(p)}>{p.direction.toUpperCase()}</Badge></td>
                <td>{fmtInt(p.net_quantity)}</td>
                <td>{fmtFixed(p.avg_open_price, 2)}</td>
                <td class:pos={p.open_pnl >= 0} class:neg={p.open_pnl < 0}>{fmtDollar(p.open_pnl)}</td>
                <td class:pos={p.day_pnl >= 0} class:neg={p.day_pnl < 0}>{fmtDollar(p.day_pnl)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <EmptyState
          icon="📃"
          title={posView?.connected ? 'No open positions' : 'Positions reader idle'}
          hint={posView?.connected
            ? 'The connector is up and reporting a flat book. Positions appear here as they open.'
            : 'Start the rithmic-connector with RITHMIC_ACCOUNT_ID / FCM_ID / IB_ID set to stream read-only positions. Never autonomous orders.'}
        />
      {/if}
    </Panel>
  {/if}

  <!-- ── Crypto futures (live today via the funding bot) ────────────── -->
  <!-- Q-1: three-way, not two-way. `{#if funding}` alone put "The funding bot's
       status server didn't respond" in the first byte of SSR HTML on every load,
       before any fetch was attempted — training the operator to read the outage
       as startup noise. Skeleton while asking; red only once we actually know. -->
  <AsyncSection
    data={funding}
    updatedAt={$statusUpdatedAt}
    error={$statusError}
    errorIcon="📉"
    errorTitle="No futures bot status available"
    errorHint="The funding bot's status server didn't respond. Check that it is running with BOT_STATUS_PORT enabled and that CRYPTO_FUNDING_INTERNAL_URL points at it."
    lines={3}
    height="52px"
  >
    {#snippet children(fundingDoc)}
      <div class="stat-row">
        <StatCard
          label="Futures paper PnL"
          value={fmtDollar(fundingDoc.pnl_usd)}
          color={fundingDoc.pnl_usd >= 0 ? 'green' : 'red'}
        />
        <StatCard label="Futures W / L" value={`${fmtInt(fundingDoc.wins)} / ${fmtInt(fundingDoc.losses)}`} />
        <StatCard label="Win rate" value={fmtPct(fundingDoc.win_rate * 100)} />
      </div>

      {#if fundingVenues.length > 0}
        <div class="venue-grid">
          {#each fundingVenues as v (venueKey(v))}
            <Panel title={`Crypto futures — ${v.exchange}`}>
              <div class="venue-head">
                <Badge variant={modeVariant(v.mode)}>{v.mode}</Badge>
                <a class="detail-link" href={`/exchanges/${v.exchange}`}>details →</a>
                <span class="venue-total">{fmtMoney(v.total_value)}</span>
              </div>
              <div class="venue-meta">
                <span>data source: exchange-apiws (KuCoin futures)</span>
                <!-- P4: `v.updated` is the last TRADE EVENT, not a poll stamp.
                     The paper funding bot marks its book on trade events, so a
                     healthy idle bot reads 15+ hours here and "updated 16h ago"
                     reads as breakage to a phone-glancing operator. The copy
                     names the mechanism instead.
                     GUARD-RAIL for the M7 Freshness sweep: apply Freshness to
                     this page's POLL `updatedAt` only — NEVER to `v.updated`.
                     Copy the gating comment from
                     `exchanges/[exchange]/+page.svelte:79,171`. Wiring Freshness
                     (or any threshold) here turns /futures permanently amber
                     during the Gate-A window and trains the operator to ignore
                     the amber that IS load-bearing on /exchanges and /cockpit. -->
                <span class="dim">marks on trade events — last {agoSecs(v.updated)}</span>
              </div>
            </Panel>
          {/each}
        </div>
      {/if}

      <Panel title={`Funding bot — ${fundingDoc.bot} (${fundingDoc.mode})`}>
        <div class="venue-meta">
          <span>{fmtInt(fundingDoc.signals_total)} signals</span>
          <span>{fmtInt(fundingDoc.trades_total)} trades</span>
          <span>win rate {fmtPct(fundingDoc.win_rate * 100)}</span>
        </div>
        {#if fundingDoc.positions.length > 0}
          <table class="holdings">
            <thead>
              <tr><th>Symbol</th><th>Dir</th><th>Entry</th><th>Mark</th><th>Return</th></tr>
            </thead>
            <tbody>
              {#each fundingDoc.positions as p (p.symbol)}
                <tr>
                  <td>{p.symbol}</td>
                  <td>
                    <Badge variant={p.dir > 0 ? 'green' : 'red'}>{dirLabel(p)}</Badge>
                  </td>
                  <td>{fmtFixed(p.entry_px, 4)}</td>
                  <td>{fmtFixed(p.mark_px, 4)}</td>
                  <td class:pos={p.ret_pct >= 0} class:neg={p.ret_pct < 0}>{fmtPct(p.ret_pct)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <p class="dim">No open positions.</p>
        {/if}
      </Panel>
    {/snippet}
  </AsyncSection>

  <!-- ── Planned trading types ──────────────────────────────────────── -->
  <div class="venue-grid">
    {#each PLANNED_TYPES as t (t.name)}
      <Panel title={t.name}>
        <div class="venue-head">
          <Badge variant="default">planned</Badge>
        </div>
        <div class="venue-meta">
          <span>data source: {t.dataSource}</span>
        </div>
        <p class="dim">{t.blurb}</p>
      </Panel>
    {/each}
  </div>
</div>

<style>
  .fut-picker {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .fut-chart {
    height: 320px;
  }
  /* Scroll story now owned by the shared .page-scroll archetype (M-3) —
     .futures-page carries only page-specific rules (currently none beyond
     the e2e locator anchor kept in markup). */
  .page-blurb {
    margin: 0;
    font-size: 0.8rem;
    color: var(--t2, #9aa4b2);
  }
  .stat-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
  }
  .venue-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 12px;
  }
  .venue-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .venue-total {
    font-size: 1.15rem;
    font-weight: 600;
    color: var(--t1);
  }
  .detail-link {
    margin-right: auto;
    margin-left: 10px;
    font-size: 0.78rem;
    color: var(--cyan, #22d3ee);
    text-decoration: none;
  }
  .page-blurb .detail-link {
    margin: 0;
  }
  .venue-meta {
    display: flex;
    gap: 14px;
    font-size: 0.8rem;
    color: var(--t2, #9aa4b2);
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .dim {
    color: var(--t3, #6b7280);
    font-size: 0.8rem;
  }
  table.holdings {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
  }
  table.holdings th {
    text-align: left;
    color: var(--t2, #9aa4b2);
    font-weight: 500;
    padding: 3px 8px 3px 0;
    border-bottom: 1px solid var(--bg3, #1f2530);
  }
  table.holdings td {
    padding: 3px 8px 3px 0;
    border-bottom: 1px solid var(--bg2, #161b24);
  }
  .pos {
    color: var(--green, #16c784);
  }
  .neg {
    color: var(--red, #ea3943);
  }
</style>
