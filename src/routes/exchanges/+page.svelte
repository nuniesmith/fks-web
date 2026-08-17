<script lang="ts">
  /**
   * /exchanges — the BACKING page: the spot venues (Kraken / KuCoin /
   * Crypto.com) that are the platform's backbone, plus the future BTC
   * hardware wallet (placeholder until integrated). Trading types built on
   * top of this base (crypto futures, CME/COMEX, …) live on /futures.
   *
   * Data: GET /api/exchanges/status (adapter → the bots' :9091 /status
   * documents), polled every 10s. "Real" totals exclude venues reporting
   * mode="paper" (paper cash is notional, not money).
   */
  import Panel from '$lib/components/ui/Panel.svelte';
  import Badge from '$lib/components/ui/Badge.svelte';
  import AsyncSection from '$lib/components/ui/AsyncSection.svelte';
  import StatCard from '$lib/components/ui/StatCard.svelte';
  import Freshness from '$lib/components/ui/Freshness.svelte';
  import NetWorthHistory from '$lib/components/exchanges/NetWorthHistory.svelte';
  import { createPoll } from '$lib/stores/poll';
  import { fmtDollar, fmtMoney, fmtPct, fmtFixed } from '$lib/utils/format';
  import { modeVariant } from '$lib/utils/mode';
  import type { ExchangesStatus, VenueStatus } from '$lib/types/exchanges';

  const status = createPoll<ExchangesStatus>('/api/exchanges/status', 10_000);
  // Aliased at top level so Svelte auto-subscribes ($statusUpdatedAt).
  // `$status.updatedAt` would read a field off the DATA, not the store.
  const statusUpdatedAt = status.updatedAt;
  // Q-1: `updatedAt` alone cannot tell "still asking" from "asked and was
  // refused" — both leave it null. Without the error store, a status server that
  // is permanently refusing would shimmer a skeleton forever instead of raising
  // the outage. See AsyncSection's "bounded by construction" note.
  const statusError = status.error;

  // 3x the 10s poll — the cockpit precedent (3x its 5s poll). Two missed ticks
  // is jitter; three means the page is showing a frozen snapshot.
  //
  // This is load-bearing: AsyncSection's error branch only covers a poll that
  // has never produced a spot document. After one success the store holds the
  // last payload forever with no visual difference, so a dead status server
  // renders as a calm one.
  const PAGE_STALE_AFTER_MS = 30_000;

  // Per-venue account-snapshot age. MEASURED, not assumed: sampling the live
  // spot bot every 15s for 20 minutes gave 12 refresh intervals across its
  // three venues, every one 299-301s. So the true period is 300s.
  //
  // 540s (1.8x the period), tracking the BotVenueStale Prometheus rule so the
  // UI and the pager keep telling the same story. This was 900s to match that
  // rule's OLD threshold; fks #244 lowered the rule to 540s (aligning it with
  // the spawner sampler, which REFUSES to record a reading older than 600s =
  // 2x its 300s interval) and this constant was not moved with it. That left a
  // ~6-minute window where the sampler had stopped recording and the pager had
  // fired while this page still rendered the venue green — the exact
  // "screen says fine while it isn't" failure this indicator exists to catch.
  //
  // Deliberately NOT damped to match the alert's `for: 10m`: amber here is a
  // leading visual warning, so it appears before the page does. Erring toward
  // warning early is the safe direction; erring toward green is not.
  //
  // An earlier estimate of "~90-95s" was wrong: it read the SAMPLER's tick
  // spacing as the venue's refresh cadence. Two monotonically-growing age
  // observations bound the period only from below and cannot tell a healthy
  // long cycle from a stalled one, which is the failure this very indicator
  // exists to catch.
  const VENUE_STALE_AFTER_MS = 540_000;
  $effect(() => {
    status.start();
    return () => status.stop();
  });

  let spot = $derived($status?.spot ?? null);

  /** Backing venues = the spot bot's venues (futures venues live on /futures). */
  let venues = $derived(spot?.exchanges ?? []);

  /** Real net worth = non-paper backing venues only (paper cash is notional). */
  let realNetWorth = $derived(
    venues.filter((v) => v.mode !== 'paper').reduce((s, v) => s + v.total_value, 0),
  );
  let hasRealVenue = $derived(venues.some((v) => v.mode !== 'paper'));

  /**
   * The bot may be configured to report more venues than it did in this
   * snapshot (e.g. one is mid-restart) — `expected_venues` mirrors the
   * backend's own `venue_set_is_complete` check. Advisory only: never
   * fabricate a corrected total, just flag that the total may be short.
   */
  let expectedVenues = $derived(spot?.expected_venues);
  let venueSetIncomplete = $derived(
    expectedVenues != null && expectedVenues > 0 && venues.length < expectedVenues,
  );

  function venueKey(v: VenueStatus): string {
    return `${v.exchange}:${v.mode}`;
  }
</script>

<svelte:head>
  <title>Exchanges — FKS Terminal</title>
</svelte:head>

<div class="exchanges-page">
  <p class="page-blurb">
    Backing accounts — the backbone the platform grows from. Trading types built
    on top (crypto futures, CME/COMEX, …) live under
    <a class="detail-link" href="/futures">Futures →</a>
  </p>

  <!-- Q-1: three-way, not two-way. `{#if !spot}` alone made the outage copy the
       GUARANTEED first paint — it was in the first byte of SSR HTML, before any
       fetch was attempted, on every single load. That trains the operator to
       read "status server didn't respond" as startup noise, which is the one
       reading that must never become habitual.

       Still gated on the SPOT document alone: this page renders spot venues
       only, and with funding up but spot down, `!spot && !funding` used to
       render a silent $0.00 net worth instead of flagging the outage. -->
  <AsyncSection
    data={spot}
    updatedAt={$statusUpdatedAt}
    error={$statusError}
    errorIcon="🛰"
    errorTitle="No spot-portfolio bot status available"
    errorHint="The spot-portfolio bot's status server didn't respond. Check that it is running with BOT_STATUS_PORT enabled and that CRYPTO_SPOT_INTERNAL_URL points at it. Futures status lives on /futures."
    lines={3}
    height="52px"
  >
    {#snippet children(spotDoc)}
      <Freshness
        updated={$statusUpdatedAt}
        unit="ms"
        staleAfterMs={PAGE_STALE_AFTER_MS}
        label="page"
      />
      <div class="stat-row">
        <StatCard
          label={hasRealVenue ? 'Net worth (real venues)' : 'Net worth (paper only)'}
          value={fmtMoney(realNetWorth)}
          color="cyan"
        />
        <!-- `spotDoc` is AsyncSection's non-null hand-back, so the old
             redundant `{#if spot}` type guard is gone. Do not reintroduce it:
             it existed only to re-narrow what the outer branch already knew. -->
        <StatCard label="Spot PnL (since start)" value={fmtDollar(spotDoc.pnl_usd)} color={spotDoc.pnl_usd >= 0 ? 'green' : 'red'} />
      </div>
      {#if venueSetIncomplete}
        <p class="venue-incomplete">
          ⚠ {venues.length}/{expectedVenues} venues reporting in this snapshot — the total above may
          be understated until the rest report back in.
        </p>
      {/if}

      <!-- History panel: the spot bot's net worth over time, straight from
           Prometheus (fks_bot_net_worth_usd) via the /api/metrics/query_range
           proxy — complements the live StatCard above with a trend. -->
      <NetWorthHistory />

      <div class="venue-grid">
        {#each venues as v (venueKey(v))}
          <Panel title={v.exchange}>
            <div class="venue-head">
              <Badge variant={modeVariant(v.mode)}>{v.mode}</Badge>
              <a class="detail-link" href={`/exchanges/${v.exchange}`}>details →</a>
              <span class="venue-total">{fmtMoney(v.total_value)}</span>
            </div>
            <div class="venue-meta">
              <span>cash {fmtFixed(v.cash)} {v.cash_asset}</span>
              <span>drift {fmtPct(v.max_drift * 100)}</span>
              <Freshness
                updated={v.updated}
                unit="s"
                staleAfterMs={VENUE_STALE_AFTER_MS}
                label="updated"
              />
            </div>
            {#if v.holdings.length > 0}
              <table class="holdings">
                <thead>
                  <tr><th>Asset</th><th>Qty</th><th>Value</th><th>Weight / target</th></tr>
                </thead>
                <tbody>
                  {#each v.holdings as h (h.asset)}
                    <tr>
                      <td>{h.asset}</td>
                      <td>{fmtFixed(h.qty, 6)}</td>
                      <td>{fmtMoney(h.value)}</td>
                      <td>{fmtPct(h.weight * 100)} / {fmtPct(h.target_weight * 100)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {:else}
              <p class="dim">No holdings (cash only).</p>
            {/if}
          </Panel>
        {/each}

        <!-- Hardware wallet — placeholder until the integration exists. The
             BTC cold-storage backbone sits alongside the exchange venues. -->
        <Panel title="Hardware wallet">
          <div class="venue-head">
            <Badge variant="default">not connected</Badge>
            <span class="venue-total dim">—</span>
          </div>
          <div class="venue-meta">
            <span>BTC cold storage</span>
          </div>
          <p class="dim">
            Planned: read-only balance via xpub/descriptor — the long-term BTC
            backbone the exchange accounts feed into. No integration yet.
          </p>
        </Panel>
      </div>
    {/snippet}
  </AsyncSection>
</div>

<style>
  .exchanges-page {
    /* One scroll region (page archetype) — below-fold venue rows were
       previously clipped by the overflow:hidden shell. */
    height: 100%;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
  }
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
  .venue-incomplete {
    margin: 0;
    padding: 6px 10px;
    font-size: 0.78rem;
    color: var(--amber, #f0a500);
    background: var(--amber-dim, rgba(240, 165, 0, 0.1));
    border: 1px solid var(--amber-brd, rgba(240, 165, 0, 0.25));
    border-radius: var(--r, 4px);
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
</style>
