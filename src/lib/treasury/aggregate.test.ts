import { describe, expect, it } from 'vitest';
import { aggregateProfitTotals } from './aggregate';
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
