import { describe, expect, it } from 'vitest';
import {
  aggregateProfitTotals,
  buildProfitTotalsView,
  hasCurrencyMismatch,
  type ProfitContributor,
} from './aggregate';
import type { ProfitResponse } from '$lib/types/spawner';
import type { ProfitWindow } from '$lib/treasury/windows';

/** A minimal /profit response — only the fields the aggregation reads matter. */
function profit(overrides: Partial<ProfitResponse> = {}): ProfitResponse {
  return {
    account_id: 'acct',
    since: null,
    db_enabled: true,
    start_ts: null,
    end_ts: null,
    start_net_worth: null,
    end_net_worth: null,
    delta: null,
    deposits_in: null,
    withdrawals_out: null,
    net_inflows: null,
    profit: null,
    transfers: 0,
    ...overrides,
  };
}

function windows(
  entries: Partial<Record<ProfitWindow, ProfitResponse>>,
): Partial<Record<ProfitWindow, ProfitResponse>> {
  return entries;
}

describe('aggregateProfitTotals', () => {
  it('sums profit and deposits across accounts per window (the by-construction total)', () => {
    const a = windows({
      '7d': profit({ profit: 100, deposits_in: 500 }),
      '30d': profit({ profit: 300, deposits_in: 1500 }),
      all: profit({ profit: 1000, deposits_in: 5000 }),
    });
    const b = windows({
      '7d': profit({ profit: 25, deposits_in: 0 }),
      '30d': profit({ profit: -50, deposits_in: 200 }),
      all: profit({ profit: 400, deposits_in: 800 }),
    });
    const totals = aggregateProfitTotals([a, b]);
    expect(totals['7d'].profit).toBe(125);
    expect(totals['7d'].deposits).toBe(500);
    expect(totals['30d'].profit).toBe(250);
    expect(totals['30d'].deposits).toBe(1700);
    expect(totals.all.profit).toBe(1400);
    expect(totals.all.deposits).toBe(5800);
  });

  it('excludes null figures from the sum (never coerces "—" to 0)', () => {
    // account b has no snapshots in 7d → null profit AND null deposits.
    const a = windows({ '7d': profit({ profit: 100, deposits_in: 500 }) });
    const b = windows({ '7d': profit({ profit: null, deposits_in: null }) });
    const totals = aggregateProfitTotals([a, b]);
    expect(totals['7d'].profit).toBe(100); // b's null did not drag it to 100+0 spuriously; and not NaN
    expect(totals['7d'].deposits).toBe(500);
    expect(totals['7d'].profitContributors).toBe(1);
  });

  it('keeps a window null when NO account contributed (honest "—", not $0)', () => {
    const a = windows({ '7d': profit({ profit: null, deposits_in: null }) });
    const b = windows({ '7d': profit({ profit: null, deposits_in: null }) });
    const totals = aggregateProfitTotals([a, b]);
    expect(totals['7d'].profit).toBeNull();
    expect(totals['7d'].deposits).toBeNull();
    expect(totals['7d'].profitContributors).toBe(0);
  });

  it('distinguishes a genuine $0 total from no-data null', () => {
    const a = windows({ '7d': profit({ profit: 50, deposits_in: 0 }) });
    const b = windows({ '7d': profit({ profit: -50, deposits_in: 0 }) });
    const totals = aggregateProfitTotals([a, b]);
    expect(totals['7d'].profit).toBe(0); // real zero — both reported and netted out
    expect(totals['7d'].deposits).toBe(0);
    expect(totals['7d'].profitContributors).toBe(2);
  });

  it('skips accounts still loading / errored (empty window map)', () => {
    const loaded = windows({ '7d': profit({ profit: 100, deposits_in: 500 }) });
    const pending = windows({});
    const totals = aggregateProfitTotals([loaded, pending]);
    expect(totals['7d'].profit).toBe(100);
    expect(totals['7d'].profitContributors).toBe(1);
  });

  it('ignores non-finite figures defensively', () => {
    const a = windows({ '7d': profit({ profit: Number.NaN, deposits_in: Infinity }) });
    const b = windows({ '7d': profit({ profit: 10, deposits_in: 20 }) });
    const totals = aggregateProfitTotals([a, b]);
    expect(totals['7d'].profit).toBe(10);
    expect(totals['7d'].deposits).toBe(20);
    expect(totals['7d'].profitContributors).toBe(1);
  });

  it('returns a null total for every window when there are no accounts', () => {
    const totals = aggregateProfitTotals([]);
    for (const w of ['7d', '30d', 'all'] as ProfitWindow[]) {
      expect(totals[w].profit).toBeNull();
      expect(totals[w].deposits).toBeNull();
      expect(totals[w].profitContributors).toBe(0);
    }
  });
});

describe('hasCurrencyMismatch', () => {
  it('is false for a single currency or none', () => {
    expect(hasCurrencyMismatch([])).toBe(false);
    expect(hasCurrencyMismatch(['USD'])).toBe(false);
    expect(hasCurrencyMismatch(['USD', 'USD', 'USD'])).toBe(false);
  });

  it('is true when denominations diverge', () => {
    expect(hasCurrencyMismatch(['USD', 'BTC'])).toBe(true);
    expect(hasCurrencyMismatch(['EUR', 'USD', 'USD'])).toBe(true);
  });

  it('ignores blank codes (they do not manufacture a mismatch)', () => {
    expect(hasCurrencyMismatch(['USD', '', 'USD'])).toBe(false);
  });
});

describe('buildProfitTotalsView', () => {
  function contrib(over: Partial<ProfitContributor> = {}): ProfitContributor {
    return { profits: {}, error: null, currency: 'USD', ...over };
  }

  it('excludes an ERRORED account from the sum AND the count, and reports it (HIGH fix)', () => {
    // Account A succeeds; account B's /profit 500'd — its stale-prev map must
    // NOT be folded in, and the count must not claim it.
    const a = contrib({
      profits: { '7d': profit({ profit: 100, deposits_in: 500 }) },
    });
    const b = contrib({
      // a stale-prev response lingering on an errored account
      profits: { '7d': profit({ profit: 9999, deposits_in: 9999 }) },
      error: '500 Internal Server Error',
    });
    const view = buildProfitTotalsView([a, b]);
    expect(view.totals['7d'].profit).toBe(100); // B's 9999 excluded, not summed
    expect(view.totals['7d'].profitContributors).toBe(1);
    expect(view.accountCount).toBe(1); // header matches the sum, not 2
    expect(view.erroredCount).toBe(1); // surfaced for the caveat
  });

  it('sums all when none errored; header count equals contributor count', () => {
    const view = buildProfitTotalsView([
      contrib({ profits: { '7d': profit({ profit: 100, deposits_in: 500 }) } }),
      contrib({ profits: { '7d': profit({ profit: 25, deposits_in: 0 }) } }),
    ]);
    expect(view.totals['7d'].profit).toBe(125);
    expect(view.accountCount).toBe(2);
    expect(view.erroredCount).toBe(0);
    expect(view.currencyMismatch).toBe(false);
  });

  it('flags a mixed-currency contributor set (MEDIUM fix) and picks currency from contributors only', () => {
    const view = buildProfitTotalsView([
      contrib({ currency: 'USD', profits: { '7d': profit({ profit: 100 }) } }),
      contrib({ currency: 'BTC', profits: { '7d': profit({ profit: 2 }) } }),
    ]);
    expect(view.currencyMismatch).toBe(true);
    expect(view.currency).toBe('USD'); // first contributor
  });

  it('does not let an errored foreign-currency account trip the mismatch guard', () => {
    // B is BTC but errored → excluded from the currency set → no false mismatch.
    const view = buildProfitTotalsView([
      contrib({ currency: 'USD', profits: { '7d': profit({ profit: 100 }) } }),
      contrib({ currency: 'BTC', error: 'boom' }),
    ]);
    expect(view.currencyMismatch).toBe(false);
    expect(view.currency).toBe('USD');
    expect(view.accountCount).toBe(1);
    expect(view.erroredCount).toBe(1);
  });

  it('all-errored → empty honest total (— everywhere), zero count, all flagged errored', () => {
    const view = buildProfitTotalsView([
      contrib({ error: 'a' }),
      contrib({ error: 'b' }),
    ]);
    expect(view.accountCount).toBe(0);
    expect(view.erroredCount).toBe(2);
    expect(view.totals['7d'].profit).toBeNull();
    expect(view.currency).toBe('USD');
  });
});
