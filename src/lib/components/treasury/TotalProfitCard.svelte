<script lang="ts">
  /**
   * Aggregate "profit vs deposits" TOTAL card for REAL accounts (D5) — sits
   * above the per-account cards. Its figures are summed (in the page) from the
   * SAME `/profit` responses each visible card renders, so the total equals the
   * sum of the cards BY CONSTRUCTION.
   *
   * Stale propagation is mandatory: if any contributing REAL account's newest
   * net-worth snapshot has gone stale, its carried-forward balance still feeds
   * the current-value total, so this card carries the SAME amber "includes
   * stale" caveat TreasuryHeadline surfaces — the total never reads as silently
   * fresh money. `stale` is computed by the page via the shared rollup idiom.
   */
  import Skeleton from '$components/ui/Skeleton.svelte';
  import type { ProfitTotals } from '$lib/treasury/aggregate';
  import { PROFIT_WINDOWS, WINDOW_LABELS } from '$lib/treasury/windows';
  import { fmtMoney, fmtSignedMoney, moneyTone } from '$lib/treasury/cards';
  import { formatStaleAge, type StaleAccount } from '$lib/treasury/rollup';

  let {
    totals,
    currency = 'USD',
    accountCount,
    erroredCount = 0,
    currencyMismatch = false,
    loading = false,
    stale = [],
    staleValue = 0,
  } = $props<{
    /** Per-window aggregate across the CONTRIBUTING (non-errored) real accounts. */
    totals: ProfitTotals;
    currency?: string;
    /** How many real accounts actually feed the total (errored ones excluded). */
    accountCount: number;
    /** Real accounts whose /profit load failed — summed nowhere, caveated here. */
    erroredCount?: number;
    /** True when contributors span >1 currency; figures are then suppressed. */
    currencyMismatch?: boolean;
    /** True while any contributing card is still (re-)fetching. */
    loading?: boolean;
    /** Real accounts whose newest snapshot is stale (oldest-first). */
    stale?: StaleAccount[];
    /** Σ of the stale accounts' carried-forward values. */
    staleValue?: number;
  }>();
</script>

<div class="card total">
  <div class="head">
    <span class="title">All real accounts — total</span>
    <span class="sub">{accountCount} account{accountCount === 1 ? '' : 's'}</span>
  </div>

  {#if loading}
    <Skeleton lines={3} height="12px" />
  {:else if currencyMismatch}
    <p class="err">
      Accounts span multiple currencies — a single total would add unlike units,
      so the summed figures are hidden. See the per-account cards below.
    </p>
  {:else}
    <table class="wins">
      <thead>
        <tr>
          <th class="w"></th>
          <th>Profit</th>
          <th>Deposits in</th>
        </tr>
      </thead>
      <tbody>
        {#each PROFIT_WINDOWS as w (w)}
          {@const t = totals[w]}
          <tr>
            <td class="w">{WINDOW_LABELS[w]}</td>
            <td
              class="mono profit {moneyTone(t?.profit)}"
              title={t?.profit == null
                ? 'No real account had snapshots inside this window yet'
                : `Σ profit across ${t.profitContributors} contributing account${t.profitContributors === 1 ? '' : 's'}`}
            >
              {fmtSignedMoney(t?.profit, currency)}
            </td>
            <td class="mono flow" title="Σ deposits into the real accounts in this window">
              {fmtMoney(t?.deposits, currency)}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  {#if !loading && erroredCount > 0}
    <span class="excluded">
      ⚠ excludes {erroredCount} account{erroredCount === 1 ? '' : 's'} that failed to
      load — this total is NOT the full real-account picture
    </span>
  {/if}

  {#if !loading && !currencyMismatch && stale.length > 0}
    <span
      class="stale"
      title={stale.map((s: StaleAccount) => `${s.accountId} — as of ${formatStaleAge(s.ageSeconds)} ago`).join('\n')}
    >
      ⚠ {stale.length} stale account{stale.length === 1 ? '' : 's'} —
      {fmtMoney(staleValue, currency)} of carried balance is frozen, so these profit
      windows may be understated (oldest as of {formatStaleAge(stale[0].ageSeconds)} ago)
    </span>
  {/if}
</div>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    background: var(--bg2);
    border: 1px solid var(--b2);
    border-radius: var(--r-md);
    min-width: 0;
  }
  /* Distinguish the aggregate from the per-account grid below it. */
  .total {
    border-color: var(--accent, #5b6ef5);
    background: linear-gradient(180deg, var(--bg3) 0%, var(--bg2) 100%);
    margin-bottom: 8px;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .title {
    font-size: 12px;
    font-weight: 700;
    color: var(--t1);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .sub {
    font-size: 10px;
    color: var(--t3);
  }
  .mono {
    font-family: var(--mono, 'SF Mono', 'Fira Code', monospace);
  }
  .wins {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
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
    padding: 4px 4px;
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
  .stale {
    font-size: 10px;
    color: var(--amber, #f0a500);
    cursor: help;
  }
  .excluded {
    font-size: 10px;
    font-weight: 600;
    color: var(--red, #ea3943);
  }
  .err {
    margin: 0;
    font-size: 11px;
    line-height: 1.4;
    color: var(--amber, #f0a500);
  }
</style>
