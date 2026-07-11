/**
 * Profit-card + treasury-table presentation helpers — pure (no Svelte, no
 * fetch) so the money formatting and the paper/real account split stay
 * vitest-coverable (cards.test.ts).
 */

import type { TreasuryAccount } from '$lib/types/spawner';
import { classifyBot, isPaper } from '$lib/treasury/accountClass';

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
