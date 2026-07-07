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
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import StatCard from '$lib/components/ui/StatCard.svelte';
  import NetWorthHistory from '$lib/components/exchanges/NetWorthHistory.svelte';
  import { createPoll } from '$lib/stores/poll';
  import { fmtDollar, fmtPct, fmtFixed } from '$lib/utils/format';
  import type { ExchangesStatus, VenueStatus } from '$lib/types/exchanges';

  const status = createPoll<ExchangesStatus>('/api/exchanges/status', 10_000);
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

  /** Plain USD for balances (fmtDollar force-signs, which is for PnL only). */
  function usd(n: number): string {
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function modeVariant(mode: string): 'green' | 'cyan' | 'amber' {
    if (mode === 'live') return 'green';
    if (mode === 'paper') return 'amber';
    return 'cyan'; // dry-run: real balances, no orders
  }

  function agoSecs(epochSecs: number): string {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - epochSecs));
    if (s < 90) return `${s}s ago`;
    if (s < 5400) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  }

  function venueKey(v: VenueStatus): string {
    return `${v.exchange}:${v.mode}`;
  }
</script>

<div class="exchanges-page">
  <p class="page-blurb">
    Backing accounts — the backbone the platform grows from. Trading types built
    on top (crypto futures, CME/COMEX, …) live under
    <a class="detail-link" href="/futures">Futures →</a>
  </p>

  {#if !spot}
    <!-- This page renders spot venues only, so gate on the spot document
         alone — with funding up but spot down, `!spot && !funding` used to
         render a silent $0.00 net worth instead of flagging the outage. -->
    <EmptyState
      icon="🛰"
      title="No spot-portfolio bot status available"
      hint="The spot-portfolio bot's status server didn't respond. Check that it is running with BOT_STATUS_PORT enabled and that CRYPTO_SPOT_INTERNAL_URL points at it. Futures status lives on /futures."
    />
  {:else}
    <div class="stat-row">
      <StatCard
        label={hasRealVenue ? 'Net worth (real venues)' : 'Net worth (paper only)'}
        value={usd(realNetWorth)}
        color="cyan"
      />
      {#if spot}
        <StatCard label="Spot PnL (since start)" value={fmtDollar(spot.pnl_usd)} color={spot.pnl_usd >= 0 ? 'green' : 'red'} />
      {/if}
    </div>

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
            <span class="venue-total">{usd(v.total_value)}</span>
          </div>
          <div class="venue-meta">
            <span>cash {fmtFixed(v.cash)} {v.cash_asset}</span>
            <span>drift {fmtPct(v.max_drift * 100)}</span>
            <span class="dim">updated {agoSecs(v.updated)}</span>
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
                    <td>{usd(h.value)}</td>
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
  {/if}
</div>

<style>
  .exchanges-page {
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
