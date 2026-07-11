import { describe, expect, it } from 'vitest';
import {
  fmtMoney,
  fmtSignedMoney,
  isPaperAccount,
  kindVariant,
  moneyTone,
  paperAccountIds,
  selectProfitAccounts,
} from './cards';
import type { TreasuryAccount } from '$lib/types/spawner';

function account(overrides: Partial<TreasuryAccount> = {}): TreasuryAccount {
  return {
    account_id: 'acct',
    display_name: null,
    tier: 1,
    account_class: 'personal-crypto',
    venue: null,
    role: 'watch',
    firm: null,
    compliance_flag: 'manual-mirror',
    risk_caps: {},
    sizing: {},
    active: true,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

describe('fmtMoney', () => {
  it('renders USD with symbol and thousands separators', () => {
    expect(fmtMoney(1234.5)).toBe('$1,234.50');
  });

  it('suffixes non-USD currencies', () => {
    expect(fmtMoney(99.9, 'CAD')).toBe('99.90 CAD');
  });

  it('renders null / NaN as an honest dash — never an invented $0', () => {
    expect(fmtMoney(null)).toBe('—');
    expect(fmtMoney(undefined)).toBe('—');
    expect(fmtMoney(Number.NaN)).toBe('—');
  });
});

describe('fmtSignedMoney', () => {
  it('signs profits and losses', () => {
    expect(fmtSignedMoney(12.34)).toBe('+$12.34');
    expect(fmtSignedMoney(-5)).toBe('-$5.00');
  });

  it('renders flat and no-data distinctly', () => {
    expect(fmtSignedMoney(0)).toBe('$0.00');
    expect(fmtSignedMoney(null)).toBe('—');
  });
});

describe('moneyTone', () => {
  it('maps sign to tone; null / 0 stay neutral', () => {
    expect(moneyTone(3)).toBe('pos');
    expect(moneyTone(-3)).toBe('neg');
    expect(moneyTone(0)).toBe('flat');
    expect(moneyTone(null)).toBe('flat');
  });
});

describe('kindVariant', () => {
  it('colours in-flows green, out-flows red, moves cool, unknowns neutral', () => {
    expect(kindVariant('deposit')).toBe('green');
    expect(kindVariant('withdrawal')).toBe('red');
    expect(kindVariant('payout')).toBe('cyan');
    expect(kindVariant('sweep')).toBe('purple');
    expect(kindVariant('mystery')).toBe('default');
  });
});

describe('selectProfitAccounts', () => {
  it('keeps only ACTIVE accounts WITH snapshots, split paper from real', () => {
    const accounts = [
      account({ account_id: 'real-1' }),
      account({ account_id: 'paper-1', account_class: 'paper' }),
      account({ account_id: 'inactive', active: false }),
      account({ account_id: 'no-snaps' }),
    ];
    const ids = new Set(['real-1', 'paper-1', 'inactive']);
    const { real, paper } = selectProfitAccounts(accounts, ids);
    expect(real.map((a) => a.account_id)).toEqual(['real-1']);
    expect(paper.map((a) => a.account_id)).toEqual(['paper-1']);
  });

  it('preserves registry order within each group', () => {
    const accounts = [
      account({ account_id: 'b' }),
      account({ account_id: 'a' }),
    ];
    const { real } = selectProfitAccounts(accounts, new Set(['a', 'b']));
    expect(real.map((a) => a.account_id)).toEqual(['b', 'a']);
  });
});

describe('isPaperAccount / paperAccountIds', () => {
  it('flags paper by registry class', () => {
    expect(isPaperAccount(account({ account_class: 'paper' }))).toBe(true);
    expect(isPaperAccount(account())).toBe(false);
  });

  it('registry class wins over the client-side stopgap', () => {
    // The stopgap table calls crypto-funding paper — but if the registry
    // reclassifies it as real, the registry is the source of truth.
    const registry = [account({ account_id: 'crypto-funding', account_class: 'personal-crypto' })];
    expect(paperAccountIds(['crypto-funding'], registry).has('crypto-funding')).toBe(false);
  });

  it('unregistered ids fall back to the stopgap table', () => {
    const out = paperAccountIds(['crypto-funding', 'crypto-spot', 'new-bot'], []);
    expect(out.has('crypto-funding')).toBe(true); // stopgap: paper
    expect(out.has('crypto-spot')).toBe(false); // stopgap: real
    expect(out.has('new-bot')).toBe(false); // unclassified = treated real
  });
});
