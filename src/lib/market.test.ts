import { describe, expect, it } from 'vitest';
import { byCoin, completeness, intervalMinutes, intervalsOf } from './market';

const row = (symbol: string, interval: string, bars: number, first: string, last: string) => ({
  symbol,
  interval,
  bars,
  first,
  last,
});

describe('intervalMinutes', () => {
  it('parses the labels janus uses', () => {
    expect(intervalMinutes('1m')).toBe(1);
    expect(intervalMinutes('5m')).toBe(5);
    expect(intervalMinutes('4h')).toBe(240);
    expect(intervalMinutes('1d')).toBe(1440);
    expect(intervalMinutes('tick')).toBeNull();
  });
});

describe('completeness', () => {
  it('BTCUSDT 1m on oryx, 2026-10-26: 49,805 bars over 34.6 days', () => {
    const c = completeness(row('BTCUSDT', '1m', 49_805, '2026-09-22T00:54:00Z', '2026-10-26T14:58:00Z'));
    expect(c).not.toBeNull();
    expect(c!).toBeGreaterThan(0.999);
    expect(c!).toBeLessThanOrEqual(1);
  });
  it('a half-empty span reads as half', () => {
    expect(completeness(row('X', '1h', 13, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'))).toBeCloseTo(13 / 25);
  });
  it('unknown interval or missing span is null, never 0', () => {
    expect(completeness(row('X', 'tick', 5, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'))).toBeNull();
    expect(completeness({ symbol: 'X', interval: '1m', bars: 0, first: null, last: null })).toBeNull();
  });
});

describe('byCoin / intervalsOf', () => {
  it('pivots intervals per symbol and keeps the newest bar', () => {
    const rows = [
      row('ETHUSDT', '5m', 10, '2026-10-01T00:00:00Z', '2026-10-26T14:50:00Z'),
      row('BTCUSDT', '5m', 10, '2026-10-01T00:00:00Z', '2026-10-26T14:50:00Z'),
      row('BTCUSDT', '1m', 50, '2026-10-01T00:00:00Z', '2026-10-26T14:58:00Z'),
    ];
    const coins = byCoin(rows);
    expect(coins.map((c) => c.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(Object.keys(coins[0].intervals).sort()).toEqual(['1m', '5m']);
    expect(coins[0].last).toBe('2026-10-26T14:58:00Z');
    expect(intervalsOf(rows)).toEqual(['1m', '5m']);
  });
});
