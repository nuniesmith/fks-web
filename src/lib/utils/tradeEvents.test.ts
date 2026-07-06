import { describe, expect, it } from 'vitest';
import { isFuturesFill, normalizeFuturesEvent } from './tradeEvents';

describe('normalizeFuturesEvent', () => {
  it('maps a live futures fill (observe_fill shape)', () => {
    const row = normalizeFuturesEvent({
      kind: 'futures-fill',
      symbol: 'ETHUSDTM',
      side: 'Sell',
      price: 2000.5,
      size: 3,
      fee: 0.12,
      ts: 1_750_000_000,
    });
    expect(row).toEqual({
      ts: 1_750_000_000,
      event: 'fill',
      side: 'Sell',
      symbol: 'ETHUSDTM',
      size: 3,
      price: 2000.5,
      ret_pct: null,
    });
  });

  it('maps a funding-reversion paper entry (no size, no return)', () => {
    const row = normalizeFuturesEvent({
      t: 1_750_000_000_500,
      sym: 'ETHUSDTM',
      action: 'entry',
      dir: -1,
      entry_px: 2010,
      funding: 0.0003,
      pct: 0.97,
      ts: 1_750_000_000,
    });
    expect(row).toEqual({
      ts: 1_750_000_000,
      event: 'entry',
      side: 'short',
      symbol: 'ETHUSDTM',
      size: null,
      price: 2010,
      ret_pct: null,
    });
  });

  it('maps a stop exit: exit price wins, underscores prettified, return kept', () => {
    const row = normalizeFuturesEvent({
      t: 1_750_003_600_000,
      sym: 'ETHUSDTM',
      action: 'stop_exit',
      dir: 1,
      entry_px: 2010,
      exit_px: 1909.5,
      ret_pct: -5,
      ts: 1_750_003_600,
    });
    expect(row.event).toBe('stop exit');
    expect(row.side).toBe('long');
    expect(row.price).toBe(1909.5);
    expect(row.ret_pct).toBe(-5);
    expect(row.size).toBeNull();
  });

  it('derives epoch seconds from the ms `t` when `ts` is missing', () => {
    const row = normalizeFuturesEvent({ t: 1_750_000_001_999, sym: 'X', action: 'exit', dir: 1 });
    expect(row.ts).toBe(1_750_000_001);
  });

  it('keeps a zero return (a break-even exit is not a missing field)', () => {
    const row = normalizeFuturesEvent({ sym: 'X', action: 'exit', dir: -1, ret_pct: 0, exit_px: 5 });
    expect(row.ret_pct).toBe(0);
  });

  it('degrades unknown shapes to a labelled row of em-dash nulls', () => {
    const row = normalizeFuturesEvent({ ts: 1 });
    expect(row).toEqual({
      ts: 1,
      event: '—',
      side: null,
      symbol: null,
      size: null,
      price: null,
      ret_pct: null,
    });
  });
});

describe('isFuturesFill', () => {
  it('matches only the futures-fill kind', () => {
    expect(isFuturesFill({ kind: 'futures-fill' })).toBe(true);
    expect(isFuturesFill({ action: 'entry' })).toBe(false);
    expect(isFuturesFill({ event: 'rebalance_trade' })).toBe(false);
  });
});
