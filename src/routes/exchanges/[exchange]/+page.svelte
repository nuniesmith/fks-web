<script lang="ts">
  /**
   * /exchanges/[exchange] — one venue in detail: balances, holdings vs
   * targets, drift, last rebalance, and the venue's recent trade events
   * (spot rebalance trades, or futures fills / funding-reversion paper
   * records on funding venues). Same 10s poll of /api/exchanges/status as
   * the overview; the venue and its events are selected client-side.
   */
  import { page } from '$app/stores';
  import Panel from '$lib/components/ui/Panel.svelte';
  import Badge from '$lib/components/ui/Badge.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import StatCard from '$lib/components/ui/StatCard.svelte';
  import Freshness from '$lib/components/ui/Freshness.svelte';
  import { createPoll } from '$lib/stores/poll';
  import { fmtPct, fmtFixed, fmtTime } from '$lib/utils/format';
  import { normalizeFuturesEvent } from '$lib/utils/tradeEvents';
  import type { ExchangesStatus, TradeEvent } from '$lib/types/exchanges';

  const status = createPoll<ExchangesStatus>('/api/exchanges/status', 10_000);
  // Aliased at top level so Svelte auto-subscribes ($statusUpdatedAt).
  const statusUpdatedAt = status.updatedAt;

  // 3x the 10s poll, matching the overview and the cockpit precedent.
  //
  // On the FUNDING venue's page this is deliberately the only freshness signal
  // there can be: that bot marks its book on trade events, so its own per-venue
  // stamp is legitimately hours old and any threshold on it would false-alarm
  // permanently. The page poll answers a different, answerable question — is
  // this page's data arriving at all?
  const PAGE_STALE_AFTER_MS = 30_000;

  // Per-venue account-snapshot age, for SPOT venues only. MEASURED: 12 refresh
  // intervals across the live spot bot's three venues, all 299-301s -> a 300s
  // period, and this is 3x it (matching the BotVenueStale rule at >900s).
  //
  // Gated on market !== 'futures' below: the funding bot marks its book on
  // TRADE EVENTS, so its snapshot is legitimately hours old while idle. A
  // threshold there would be permanently amber on a perfectly healthy bot,
  // which teaches the operator to ignore the indicator everywhere else.
  const VENUE_STALE_AFTER_MS = 900_000;
  $effect(() => {
    status.start();
    return () => status.stop();
  });

  let exchange = $derived($page.params.exchange ?? '');

  /** The bot document (spot first, then funding) whose venue list contains this exchange. */
  let venueDoc = $derived(
    [$status?.spot, $status?.funding].find((doc) =>
      (doc?.exchanges ?? []).some((v) => v.exchange === exchange),
    ) ?? null,
  );

  /** The venue's status row within that document. */
  let venue = $derived(venueDoc?.exchanges.find((v) => v.exchange === exchange) ?? null);

  /**
   * This venue's recent trade events (from the owning bot document), newest
   * first. Spot events carry a `venue` field (the spot bot is multi-venue) —
   * match it exactly. The funding bot's events (futures fills / paper records)
   * carry no `venue`, so venue-less events are attributed to the document's
   * venue when it reports exactly one (today it registers only
   * "kucoin-futures", so the attribution is unambiguous).
   */
  let events = $derived(
    [...((venueDoc?.recent_events as TradeEvent[] | undefined) ?? [])]
      .filter((e) => e.venue === exchange || (e.venue == null && venueDoc?.exchanges.length === 1))
      .reverse(),
  );

  /**
   * Futures (funding-bot) venues get their own event table: TradeEvents there
   * are live fills (`kind: "futures-fill"` — symbol/size/price) or
   * funding-reversion paper records (`action`/`sym`/`dir`/`*_px`/`ret_pct`),
   * which share almost no field names with spot rebalance trades.
   */
  let isFuturesVenue = $derived(venueDoc?.market === 'futures');

  /** The venue's events normalized for the futures table (unused on spot venues). */
  let futuresRows = $derived(isFuturesVenue ? events.map(normalizeFuturesEvent) : []);

  function usd(n: number): string {
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function modeVariant(mode: string): 'green' | 'cyan' | 'amber' {
    if (mode === 'live') return 'green';
    if (mode === 'paper') return 'amber';
    return 'cyan';
  }

  function epochLabel(secs: number | undefined | null): string {
    if (!secs) return '—';
    return fmtTime(new Date(secs * 1000).toISOString());
  }
</script>

<svelte:head>
  <title>{exchange} — Exchanges — FKS Terminal</title>
</svelte:head>

<div class="detail-page">
  <div class="crumbs">
    <a href="/exchanges">← Exchanges</a>
  </div>

  {#if !$status}
    <EmptyState icon="⏳" title="Loading venue status…" />
  {:else if !venue}
    <EmptyState
      icon="🛰"
      title={`No status for "${exchange}"`}
      hint="The bots report venues by exchange id (e.g. kraken, kucoin, cryptocom). Check the /exchanges overview for the venues currently reporting."
    />
  {:else}
    <div class="head-row">
      <h2 class="venue-name">{venue.exchange}</h2>
      <Badge variant={modeVariant(venue.mode)}>{venue.mode}</Badge>
      <Freshness
        updated={$statusUpdatedAt}
        unit="ms"
        staleAfterMs={PAGE_STALE_AFTER_MS}
        label="page"
        compact
      />
      {#if venue.triggered}
        <Badge variant="amber">rebalance triggered</Badge>
      {/if}
    </div>

    <div class="stat-row">
      <StatCard label="Total value" value={usd(venue.total_value)} color="cyan" />
      <StatCard label={`Cash (${venue.cash_asset})`} value={fmtFixed(venue.cash)} />
      <StatCard
        label="Max drift"
        value={fmtPct(venue.max_drift * 100)}
        color={venue.max_drift >= 0.25 ? 'amber' : 'default'}
      />
      <StatCard label="Last rebalance" value={epochLabel(venue.last_rebalance)} />
    </div>

    <Panel title="Holdings vs targets">
      {#if venue.holdings.length > 0}
        <table class="tbl">
          <thead>
            <tr><th>Asset</th><th>Qty</th><th>Price</th><th>Value</th><th>Weight</th><th>Target</th><th>Δ</th></tr>
          </thead>
          <tbody>
            {#each venue.holdings as h (h.asset)}
              <tr>
                <td>{h.asset}</td>
                <td>{fmtFixed(h.qty, 6)}</td>
                <td>{usd(h.price)}</td>
                <td>{usd(h.value)}</td>
                <td>{fmtPct(h.weight * 100)}</td>
                <td>{fmtPct(h.target_weight * 100)}</td>
                <td class:neg={Math.abs(h.weight - h.target_weight) >= 0.25}>
                  {fmtPct((h.weight - h.target_weight) * 100)}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="dim">No holdings (cash only).</p>
      {/if}
      <p class="dim">
        Snapshot updated {epochLabel(venue.updated)}.
        {#if !isFuturesVenue}
          <!-- Absolute time + a counting relative age are complementary, not a
               duplicated signal: one says WHEN, the other says HOW LONG AGO
               and keeps ticking while you watch it. -->
          <Freshness
            updated={venue.updated}
            unit="s"
            staleAfterMs={VENUE_STALE_AFTER_MS}
            label="age"
            compact
          />
        {/if}
      </p>
    </Panel>

    {#if isFuturesVenue}
      <Panel title="Recent trade events">
        {#if futuresRows.length > 0}
          <table class="tbl">
            <thead>
              <tr><th>Time</th><th>Event</th><th>Side</th><th>Symbol</th><th>Size</th><th>Price</th><th>Return</th></tr>
            </thead>
            <tbody>
              {#each futuresRows as r, i (`${r.ts}-${i}`)}
                <tr>
                  <td>{epochLabel(r.ts)}</td>
                  <td>{r.event}</td>
                  <td class:pos={r.side === 'Buy' || r.side === 'long'} class:neg={r.side === 'Sell' || r.side === 'short'}>
                    {r.side ?? '—'}
                  </td>
                  <td>{r.symbol ?? '—'}</td>
                  <td>{fmtFixed(r.size, 4)}</td>
                  <td>{r.price != null ? usd(r.price) : '—'}</td>
                  <td class:pos={r.ret_pct != null && r.ret_pct > 0} class:neg={r.ret_pct != null && r.ret_pct < 0}>
                    {r.ret_pct != null ? fmtPct(r.ret_pct) : '—'}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <p class="dim">No trade events for this venue in the bot's recent-event window.</p>
        {/if}
      </Panel>
    {:else}
      <Panel title="Recent rebalance trades">
        {#if events.length > 0}
          <table class="tbl">
            <thead>
              <tr><th>Time</th><th>Side</th><th>Asset</th><th>Volume</th><th>Price</th><th>USD</th><th>Mode</th></tr>
            </thead>
            <tbody>
              {#each events as e, i (e.ts ?? i)}
                <tr>
                  <td>{epochLabel(e.ts)}</td>
                  <td class:pos={e.side === 'Buy'} class:neg={e.side === 'Sell'}>{e.side ?? '—'}</td>
                  <td>{e.asset ?? '—'}</td>
                  <td>{fmtFixed(e.volume ?? null, 6)}</td>
                  <td>{e.price != null ? usd(e.price) : '—'}</td>
                  <td>{e.usd != null ? usd(e.usd) : '—'}</td>
                  <td>{e.live ? 'live' : 'dry-run'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <p class="dim">No rebalance trades for this venue in the bot's recent-event window.</p>
        {/if}
      </Panel>
    {/if}
  {/if}
</div>

<style>
  .detail-page {
    /* One scroll region (page archetype) — the rebalance-trades tables at
       the bottom were previously clipped by the overflow:hidden shell. */
    height: 100%;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
  }
  .crumbs a {
    color: var(--cyan, #22d3ee);
    text-decoration: none;
    font-size: 0.85rem;
  }
  .head-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .venue-name {
    margin: 0;
    font-size: 1.2rem;
    text-transform: capitalize;
    color: var(--t1);
  }
  .stat-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 12px;
  }
  table.tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
  }
  table.tbl th {
    text-align: left;
    color: var(--t2, #9aa4b2);
    font-weight: 500;
    padding: 3px 8px 3px 0;
    border-bottom: 1px solid var(--bg3, #1f2530);
  }
  table.tbl td {
    padding: 3px 8px 3px 0;
    border-bottom: 1px solid var(--bg2, #161b24);
  }
  .dim {
    color: var(--t3, #6b7280);
    font-size: 0.8rem;
  }
  .pos {
    color: var(--green, #16c784);
  }
  .neg {
    color: var(--red, #ea3943);
  }
</style>
