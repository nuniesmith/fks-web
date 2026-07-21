import { describe, expect, it } from 'vitest';
import {
  fmtMoney,
  fmtSignedMoney,
  isPaperAccount,
  kindVariant,
  moneyTone,
  paperAccountIds,
  realNetWorthFromRows,
  selectProfitAccounts,
} from './cards';
import type { SnapshotRowLike } from './rollup';
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

describe('realNetWorthFromRows (the / overview ⇄ /treasury headline parity fn)', () => {
  function row(bot_id: string, ts: string, net_worth: number): SnapshotRowLike {
    return { bot_id, ts, net_worth, currency: 'USD' };
  }

  it('carries forward each real account and EXCLUDES paper', () => {
    const rows = [
      row('real-a', '2026-07-01T00:00:00Z', 1000),
      row('real-a', '2026-07-03T00:00:00Z', 1500),
      row('real-b', '2026-07-02T00:00:00Z', 500),
      row('paper-x', '2026-07-03T00:00:00Z', 9999),
    ];
    const accounts = [
      account({ account_id: 'real-a', account_class: 'personal-crypto' }),
      account({ account_id: 'real-b', account_class: 'personal-crypto' }),
      account({ account_id: 'paper-x', account_class: 'paper' }),
    ];
    // At the last tick real-a=1500 (carried) + real-b=500 (carried) = 2000;
    // paper-x's 9999 is excluded — proving the / snapshot mirrors the headline.
    const res = realNetWorthFromRows(rows, accounts);
    expect(res.latest).toBe(2000);
    expect(res.realCount).toBe(2);
    expect(res.currency).toBe('USD');
  });

  it('is an honest null (never $0) when there are no rows', () => {
    const res = realNetWorthFromRows([], []);
    expect(res.latest).toBeNull();
    expect(res.realCount).toBe(0);
    expect(res.currency).toBe('USD');
  });

  it('excludes unregistered paper via the stopgap table', () => {
    // crypto-funding is paper per the stopgap even with no registry entry.
    const rows = [
      row('crypto-spot', '2026-07-01T00:00:00Z', 300),
      row('crypto-funding', '2026-07-01T00:00:00Z', 10000),
    ];
    const res = realNetWorthFromRows(rows, []);
    expect(res.latest).toBe(300);
    expect(res.realCount).toBe(1);
  });
});
