/**
 * Treasury TOTAL "profit vs deposits" aggregation (D5) — pure (no Svelte, no
 * fetch) so the money math stays vitest-coverable (aggregate.test.ts).
 *
 * The /treasury page lifts the per-account `/profit` fetches out of ProfitCard
 * into a page-level map keyed by account, then feeds the REAL accounts' loaded
 * responses through this helper. Because the TOTAL is summed from the SAME
 * `ProfitResponse` objects each visible card renders, the total equals the sum
 * of the cards BY CONSTRUCTION — never a separately-fetched figure that could
 * drift from what's on screen.
 *
 * Honesty rules (mirroring ProfitCard's per-window cells):
 *  - a null figure ("—" on a card: no snapshots inside that window, or no DB)
 *    is EXCLUDED from the sum, never coerced to 0;
 *  - a window with NO contributing account stays null (an honest "—" total),
 *    distinct from a genuine $0.00 total where accounts did report and netted
 *    to zero.
 */

import type { ProfitResponse } from '$lib/types/spawner';
import { PROFIT_WINDOWS, type ProfitWindow } from '$lib/treasury/windows';

/** One window's aggregate across the real accounts. */
export interface WindowTotal {
  /** Σ of each account's non-null `profit`; null when no account had data. */
  profit: number | null;
  /** Σ of each account's non-null `deposits_in`; null when no account had data. */
  deposits: number | null;
  /** How many accounts contributed a non-null profit figure to this window. */
  profitContributors: number;
}

export type ProfitTotals = Record<ProfitWindow, WindowTotal>;

/**
 * Sum profit and deposits across the given accounts' loaded /profit responses,
 * per window. Each element is one account's window→response map (an account
 * still loading / errored contributes an empty map and is simply skipped —
 * the page gates the total's display on all-loaded, so partial maps only occur
 * transiently).
 */
export function aggregateProfitTotals(
  accounts: ReadonlyArray<Partial<Record<ProfitWindow, ProfitResponse | undefined>>>,
): ProfitTotals {
  const out = {} as ProfitTotals;
  for (const w of PROFIT_WINDOWS) {
    let profitSum = 0;
    let profitHas = false;
    let depositSum = 0;
    let depositHas = false;
    let contributors = 0;
    for (const acc of accounts) {
      const p = acc[w];
      if (!p) continue;
      if (p.profit != null && Number.isFinite(p.profit)) {
        profitSum += p.profit;
        profitHas = true;
        contributors += 1;
      }
      if (p.deposits_in != null && Number.isFinite(p.deposits_in)) {
        depositSum += p.deposits_in;
        depositHas = true;
      }
    }
    out[w] = {
      profit: profitHas ? profitSum : null,
      deposits: depositHas ? depositSum : null,
      profitContributors: contributors,
    };
  }
  return out;
}

/**
 * True when the contributing accounts are NOT all denominated in one currency.
 * `aggregateProfitTotals` sums bare numbers with no unit awareness (the
 * `/profit` payload carries no currency), so a mixed-denomination set (e.g. a
 * USD spot account + a BTC-denominated cold-storage backbone — the M4 treasury
 * goal) would add unlike currencies into one meaningless figure. The page uses
 * this to SUPPRESS the numeric total and show a caveat instead of presenting a
 * bogus number as authoritative money. Empty / blank codes are ignored; a
 * single distinct currency (or none) is consistent.
 */
export function hasCurrencyMismatch(currencies: readonly string[]): boolean {
  const distinct = new Set<string>();
  for (const c of currencies) {
    if (c) distinct.add(c);
  }
  return distinct.size > 1;
}

/** One real account's state as the TOTAL card sees it. */
export interface ProfitContributor {
  profits: Partial<Record<ProfitWindow, ProfitResponse | undefined>>;
  /** Non-null ⇒ this account's /profit load failed — excluded from the total. */
  error: string | null | undefined;
  /** Denomination of this account (from its net-worth series; 'USD' fallback). */
  currency: string;
}

/** Everything the TOTAL card needs, derived honestly from the contributors. */
export interface ProfitTotalsView {
  totals: ProfitTotals;
  /** Real accounts actually summed (errored ones excluded). */
  accountCount: number;
  /** Real accounts dropped because their /profit load failed. */
  erroredCount: number;
  /** Display currency (first contributor's; 'USD' fallback). */
  currency: string;
  /** True when contributors span >1 currency — figures must be suppressed. */
  currencyMismatch: boolean;
}

/**
 * Compose the honest TOTAL view from the real accounts' states. An ERRORED
 * account is excluded from the sum, the count, AND the currency set (its card
 * shows the error, not numbers — folding it in would make the total present as
 * whole while silently omitting it), and reported separately via `erroredCount`
 * so the card can caveat "excludes N that failed to load". The currency guard
 * flags a mixed-denomination set so the page can suppress a meaningless bare
 * sum. Kept pure so both behaviours are vitest-covered.
 */
export function buildProfitTotalsView(
  contributors: readonly ProfitContributor[],
): ProfitTotalsView {
  const ok = contributors.filter((c) => c.error == null);
  const errored = contributors.length - ok.length;
  const currencies = ok.map((c) => c.currency);
  return {
    totals: aggregateProfitTotals(ok.map((c) => c.profits)),
    accountCount: ok.length,
    erroredCount: errored,
    currency: currencies[0] ?? 'USD',
    currencyMismatch: hasCurrencyMismatch(currencies),
  };
}
