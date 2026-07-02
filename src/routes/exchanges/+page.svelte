<script lang="ts">
  /**
   * /exchanges — per-exchange balances + total net worth across the crypto
   * bots (spot portfolio: Kraken / KuCoin / Crypto.com; futures funding
   * paper). Data: GET /api/exchanges/status (adapter → the bots' :9091
   * /status documents), polled every 10s.
   *
   * "Real" totals exclude venues reporting mode="paper" (the futures paper
   * account is notional cash, not money).
   */
  import Panel from '$lib/components/ui/Panel.svelte';
  import Badge from '$lib/components/ui/Badge.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import StatCard from '$lib/components/ui/StatCard.svelte';
  import { createPoll } from '$lib/stores/poll';
  import { fmtDollar, fmtPct, fmtFixed, fmtInt } from '$lib/utils/format';
  import type { ExchangesStatus, VenueStatus, PositionStatus } from '$lib/types/exchanges';

  const status = createPoll<ExchangesStatus>('/api/exchanges/status', 10_000);
  $effect(() => {
    status.start();
    return () => status.stop();
  });

  let spot = $derived($status?.spot ?? null);
  let funding = $derived($status?.funding ?? null);

  /** All venues from both bots, spot first. */
  let venues = $derived([...(spot?.exchanges ?? []), ...(funding?.exchanges ?? [])]);

  /** Real net worth = non-paper venues only (paper cash is notional). */
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

  function dirLabel(p: PositionStatus): string {
    return p.dir > 0 ? 'LONG' : 'SHORT';
  }

  function venueKey(v: VenueStatus): string {
    return `${v.exchange}:${v.mode}`;
  }
</script>

<div class="exchanges-page">
  {#if !spot && !funding}
    <EmptyState
      icon="🛰"
      title="No crypto bot status available"
      hint="Neither the spot-portfolio nor the funding bot's status server responded. Check that the bots are running with BOT_STATUS_PORT enabled and that CRYPTO_SPOT_INTERNAL_URL / CRYPTO_FUNDING_INTERNAL_URL point at them."
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
      {#if funding}
        <StatCard
          label="Futures paper PnL"
          value={fmtDollar(funding.pnl_usd)}
          color={funding.pnl_usd >= 0 ? 'green' : 'red'}
        />
        <StatCard label="Futures W / L" value={`${fmtInt(funding.wins)} / ${fmtInt(funding.losses)}`} />
      {/if}
    </div>

    {#if venues.length > 0}
      <div class="venue-grid">
        {#each venues as v (venueKey(v))}
          <Panel title={v.exchange}>
            <div class="venue-head">
              <Badge variant={modeVariant(v.mode)}>{v.mode}</Badge>
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
      </div>
    {/if}

    {#if funding}
      <Panel title={`Futures — ${funding.bot} (${funding.mode})`}>
        <div class="venue-meta">
          <span>{fmtInt(funding.signals_total)} signals</span>
          <span>{fmtInt(funding.trades_total)} trades</span>
          <span>win rate {fmtPct(funding.win_rate * 100)}</span>
        </div>
        {#if funding.positions.length > 0}
          <table class="holdings">
            <thead>
              <tr><th>Symbol</th><th>Dir</th><th>Entry</th><th>Mark</th><th>Return</th></tr>
            </thead>
            <tbody>
              {#each funding.positions as p (p.symbol)}
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
    {/if}
  {/if}
</div>

<style>
  .exchanges-page {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
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
