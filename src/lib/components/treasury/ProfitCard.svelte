<script lang="ts">
  /**
   * One registry account's honest profit-vs-deposits card — purely
   * presentational. The `/profit` fetch per window (7d / 30d / all) is owned by
   * the /treasury page (a page-level map keyed by account) so the aggregate
   * TOTAL card sums the SAME responses these cards render; this component just
   * renders the slice it's handed: profit (= net-worth delta minus net inflows),
   * deposits in, withdrawals out. Null figures (no snapshots inside the window /
   * no DB) render as "—" — never an invented zero.
   */
  import Badge from '$components/ui/Badge.svelte';
  import Skeleton from '$components/ui/Skeleton.svelte';
  import type { ProfitResponse, TreasuryAccount } from '$lib/types/spawner';
  import type { AccountSeries } from '$lib/treasury/rollup';
  import { PROFIT_WINDOWS, WINDOW_LABELS, type ProfitWindow } from '$lib/treasury/windows';
  import { classVariant, fmtMoney, fmtSignedMoney, moneyTone } from '$lib/treasury/cards';

  let { account, series, profits = {}, loading = false, error = null } = $props<{
    account: TreasuryAccount;
    /** This account's snapshot series (for current value + currency). */
    series: AccountSeries | undefined;
    /** This account's loaded /profit responses per window (owned by the page). */
    profits?: Partial<Record<ProfitWindow, ProfitResponse>>;
    /** True while the page is (re-)fetching this account's /profit windows. */
    loading?: boolean;
    /** Non-null when the page's /profit fetch for this account failed. */
    error?: string | null;
  }>();

  let currency = $derived(series?.currency ?? 'USD');
  // Prefer the full-history window's end snapshot; fall back to the series.
  let current = $derived(profits.all?.end_net_worth ?? series?.latest ?? null);
</script>

<div class="card">
  <div class="head">
    <div class="names">
      <span class="dn">{account.display_name ?? account.account_id}</span>
      <span class="id mono">{account.account_id}</span>
    </div>
    <div class="tags">
      <Badge variant={classVariant(account.account_class)}>{account.account_class}</Badge>
      {#if account.venue}<span class="venue">{account.venue}</span>{/if}
    </div>
  </div>

  <div class="current">
    <span class="cur-label">Current value</span>
    <span class="cur-value mono">{fmtMoney(current, currency)}</span>
  </div>

  {#if loading}
    <Skeleton lines={3} height="12px" />
  {:else if error}
    <p class="err">GET /api/spawner/profit failed ({error}).</p>
  {:else}
    <table class="wins">
      <thead>
        <tr>
          <th class="w"></th>
          <th>Profit</th>
          <th>In</th>
          <th>Out</th>
        </tr>
      </thead>
      <tbody>
        {#each PROFIT_WINDOWS as w (w)}
          {@const p = profits[w]}
          <tr>
            <td class="w">{WINDOW_LABELS[w]}</td>
            <td
              class="mono profit {moneyTone(p?.profit)}"
              title={p?.profit == null
                ? 'No snapshots inside this window yet'
                : 'Net-worth change minus net inflows — what the account actually earned'}
            >
              {fmtSignedMoney(p?.profit, currency)}
            </td>
            <td class="mono flow" title="Deposits into the account in this window">
              {fmtMoney(p?.deposits_in, currency)}
            </td>
            <td class="mono flow" title="Withdrawals out of the account in this window">
              {fmtMoney(p?.withdrawals_out, currency)}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    background: var(--bg2);
    border: 1px solid var(--b2);
    border-radius: var(--r-md);
    min-width: 0;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
    flex-wrap: wrap;
  }
  .names {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .dn {
    font-size: 12px;
    font-weight: 600;
    color: var(--t1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .id {
    font-size: 9px;
    color: var(--t3);
  }
  .tags {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .venue {
    font-size: 9px;
    color: var(--t3);
  }
  .current {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .cur-label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--t3);
  }
  .cur-value {
    font-size: 16px;
    font-weight: 700;
    color: var(--t1);
  }
  .mono {
    font-family: var(--mono, 'SF Mono', 'Fira Code', monospace);
  }
  .wins {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }
  .wins th {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--t3);
    font-weight: 600;
    text-align: right;
    padding: 2px 4px;
    border-bottom: 1px solid var(--b1);
  }
  .wins td {
    text-align: right;
    padding: 3px 4px;
    border-bottom: 1px solid var(--b1);
    white-space: nowrap;
  }
  .wins tr:last-child td {
    border-bottom: none;
  }
  .w {
    text-align: left !important;
    color: var(--t3);
    font-size: 10px;
    text-transform: uppercase;
  }
  .profit {
    font-weight: 700;
  }
  .profit.pos {
    color: var(--green, #16c784);
  }
  .profit.neg {
    color: var(--red, #ea3943);
  }
  .profit.flat {
    color: var(--t2);
  }
  .flow {
    color: var(--t2);
  }
  .err {
    margin: 0;
    font-size: 10px;
    color: var(--red, #ea3943);
  }
</style>
