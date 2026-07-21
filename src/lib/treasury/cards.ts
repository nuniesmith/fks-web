/**
 * Profit-card + treasury-table presentation helpers — pure (no Svelte, no
 * fetch) so the money formatting and the paper/real account split stay
 * vitest-coverable (cards.test.ts).
 */

import type { TreasuryAccount } from '$lib/types/spawner';
import { classifyBot, isPaper } from '$lib/treasury/accountClass';
import {
  carryForwardTotal,
  groupSnapshots,
  staleAccounts,
  type SnapshotRowLike,
  type StaleAccount,
} from '$lib/treasury/rollup';

/** Matches Badge.svelte's variant prop. */
export type BadgeVariant = 'default' | 'green' | 'red' | 'amber' | 'cyan' | 'purple';

// ─── Money formatting ──────────────────────────────────────────────────────

/**
 * "$1,234.56" (USD) / "1,234.56 EUR" (other) / "—" for null. Null figures
 * come straight from /profit's honest no-data answer — never render them 0.
 */
export function fmtMoney(value: number | null | undefined, currency = 'USD'): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const n = value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === 'USD' ? `$${n}` : `${n} ${currency}`;
}

/** Signed money: "+$12.34" / "-$5.00" / "$0.00" (flat) / "—" (no data). */
export function fmtSignedMoney(value: number | null | undefined, currency = 'USD'): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value === 0) return fmtMoney(0, currency);
  return `${value > 0 ? '+' : '-'}${fmtMoney(Math.abs(value), currency)}`;
}

export type MoneyTone = 'pos' | 'neg' | 'flat';

/** Colour tone for a signed figure; null/0 stay neutral. */
export function moneyTone(value: number | null | undefined): MoneyTone {
  if (value == null || !Number.isFinite(value) || value === 0) return 'flat';
  return value > 0 ? 'pos' : 'neg';
}

// ─── Badge variants ────────────────────────────────────────────────────────

/** transfers.kind → Badge variant (in-flows green, out-flows red, moves cool). */
export function kindVariant(kind: string): BadgeVariant {
  switch (kind) {
    case 'deposit':
      return 'green';
    case 'withdrawal':
      return 'red';
    case 'payout':
      return 'cyan';
    case 'sweep':
      return 'purple';
    default:
      return 'default';
  }
}

/** accounts.account_class → Badge variant. */
export function classVariant(cls: string): BadgeVariant {
  switch (cls) {
    case 'personal-crypto':
      return 'cyan';
    case 'cold-storage':
      return 'amber';
    case 'prop':
      return 'purple';
    case 'paper':
      return 'default';
    default:
      return 'default';
  }
}

/** accounts.tier → Badge variant (0 = cold backbone … 3 = prop copy-target). */
export function tierVariant(tier: number): BadgeVariant {
  switch (tier) {
    case 0:
      return 'amber';
    case 1:
      return 'cyan';
    case 2:
      return 'green';
    case 3:
      return 'purple';
    default:
      return 'default';
  }
}

/** accounts.role → Badge variant. */
export function roleVariant(role: string): BadgeVariant {
  switch (role) {
    case 'bot-trade':
      return 'green';
    case 'human-trade-source':
      return 'cyan';
    case 'copy-target':
      return 'purple';
    default:
      return 'default'; // watch et al.
  }
}

/** accounts.compliance_flag → Badge variant (manual-mirror = caution amber). */
export function complianceVariant(flag: string): BadgeVariant {
  switch (flag) {
    case 'manual-mirror':
      return 'amber';
    case 'auto-fill':
      return 'green';
    default:
      return 'default';
  }
}

// ─── Paper / real account split ────────────────────────────────────────────

/** Registry-driven paper check (the server-side successor to accountClass.ts). */
export function isPaperAccount(account: Pick<TreasuryAccount, 'account_class'>): boolean {
  return account.account_class === 'paper';
}

export interface ProfitCardAccounts {
  real: TreasuryAccount[];
  paper: TreasuryAccount[];
}

/**
 * Which registry accounts get a profit card: ACTIVE accounts that actually
 * have net-worth snapshots (no snapshots ⇒ /profit has nothing to say).
 * Split paper from real so paper P&L can never visually mix with money.
 * Registry order (actives first, server-sorted) is preserved.
 */
export function selectProfitAccounts(
  accounts: readonly TreasuryAccount[],
  snapshotIds: ReadonlySet<string>,
): ProfitCardAccounts {
  const real: TreasuryAccount[] = [];
  const paper: TreasuryAccount[] = [];
  for (const a of accounts) {
    if (!a.active || !snapshotIds.has(a.account_id)) continue;
    (isPaperAccount(a) ? paper : real).push(a);
  }
  return { real, paper };
}

/**
 * The account ids whose series must be EXCLUDED from the headline "Real net
 * worth" total. The registry's account_class wins when the account is
 * registered; unregistered ids fall back to the client-side stopgap table
 * ($lib/treasury/accountClass.ts) so /treasury and /bots agree about e.g.
 * crypto-funding's fake 10 000 USDT until every bot is registered.
 */
export function paperAccountIds(
  ids: Iterable<string>,
  accounts: readonly TreasuryAccount[],
): Set<string> {
  const classById = new Map(accounts.map((a) => [a.account_id, a.account_class]));
  const out = new Set<string>();
  for (const id of ids) {
    const cls = classById.get(id);
    const paper = cls != null ? cls === 'paper' : isPaper(classifyBot(id));
    if (paper) out.add(id);
  }
  return out;
}

// ─── Real net-worth headline figure (shared: /treasury + / overview) ────────

/** The result of the carry-forward "Real net worth" roll-up. */
export interface RealNetWorth {
  /** Carry-forward total's most recent value; null when there is no data. */
  latest: number | null;
  /** Denomination of the total ('USD' fallback). */
  currency: string;
  /** How many REAL (non-paper) accounts contribute to the total. */
  realCount: number;
  /**
   * REAL accounts whose newest snapshot has gone stale — carry-forward keeps
   * their frozen balance in `latest` forever, so this is the same honesty
   * caveat `TreasuryHeadline.svelte` surfaces (oldest-first). Empty when none.
   */
  stale: StaleAccount[];
  /** Sum of the stale accounts' carried-forward values (0 when none). */
  staleValue: number;
}

/**
 * The /treasury headline "Real net worth" number, computed straight from raw
 * `GET /net-worth` rows plus the accounts registry — paper accounts excluded
 * exactly as `TreasuryHeadline.svelte` does (registry `account_class` wins,
 * `accountClass.ts` stopgap fallback for unregistered ids). Kept here as ONE
 * pure function so the `/` overview Money snapshot renders the SAME figure the
 * headline shows for the same snapshot data (parity, not a re-derivation).
 * Mirrors the headline's default (paper EXCLUDED — no `include paper` toggle)
 * AND its staleness caveat (`staleAccounts(inputs)`), so the / snapshot can't
 * present a possibly-overstated carried-forward total as fresh money while
 * /treasury flags it. `nowSeconds` is injectable for deterministic tests.
 */
export function realNetWorthFromRows(
  rows: readonly SnapshotRowLike[],
  accounts: readonly TreasuryAccount[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): RealNetWorth {
  const series = groupSnapshots(rows);
  const ids = new Set(series.map((s) => s.accountId));
  const paper = paperAccountIds(ids, accounts);
  const inputs = series.filter((s) => !paper.has(s.accountId));
  const totalPoints = carryForwardTotal(inputs.map((s) => s.points));
  const latest = totalPoints.length > 0 ? totalPoints[totalPoints.length - 1].value : null;
  const stale = staleAccounts(inputs, nowSeconds);
  const staleValue = stale.reduce((sum, a) => sum + a.value, 0);
  return {
    latest,
    currency: inputs[0]?.currency ?? 'USD',
    realCount: inputs.length,
    stale,
    staleValue,
  };
}
