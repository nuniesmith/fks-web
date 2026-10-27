import { describe, expect, it } from 'vitest';
import { cycleLine, historyRows, historyTotals, isHistory } from './history';
import type { HistorySeries, HistoryStatus } from '$lib/types/spawner';

const series = (over: Partial<HistorySeries>): HistorySeries => ({
  dataset: 'klines',
  symbol: 'BTCUSDT',
  interval: '1h',
  expected: 10,
  present: 10,
  pending: 0,
  not_published: 0,
  errors: 0,
  bytes: 1000,
  first: '2026-01',
  last: '2026-10-26',
  ...over,
});

const NOW = Date.parse('2026-10-27T03:00:00Z');

const status = (over: Partial<HistoryStatus> = {}): HistoryStatus => ({
  bot_id: 'majors-history',
  kind: 'history',
  market: 'usdm',
  symbols: ['BTCUSDT'],
  datasets: ['klines'],
  intervals: ['1h'],
  start: '2026-01',
  started_at_ms: NOW - 3_600_000,
  updated_at_ms: NOW - 5_000,
  cycle: {
    running: false,
    started_at_ms: NOW - 1_800_000,
    finished_at_ms: NOW - 1_740_000,
    next_at_ms: NOW + 4 * 3_600_000,
    planned: 46,
    checked: 46,
    downloaded: 2,
    errors: 0,
  },
  last_success_ms: NOW - 1_740_000,
  downloads_total: 46,
  errors_total: 0,
  series: {},
  recent_errors: [],
  ...over,
});

describe('isHistory', () => {
  it('goes by the template family', () => {
    expect(isHistory({ template: 'history.binance-usdm' })).toBe(true);
    expect(isHistory({ template: 'recorder.binance-usdm' })).toBe(false);
    expect(isHistory({ template: null })).toBe(false);
  });
});

describe('historyRows', () => {
  it('sorts by symbol, then dataset, then interval in time order', () => {
    const rows = historyRows({
      series: {
        'metrics/BTCUSDT/-': series({ dataset: 'metrics', interval: null }),
        'klines/ETHUSDT/1h': series({ symbol: 'ETHUSDT' }),
        'klines/BTCUSDT/1d': series({ interval: '1d' }),
        'klines/BTCUSDT/1m': series({ interval: '1m' }),
        'fundingRate/BTCUSDT/-': series({ dataset: 'fundingRate', interval: null }),
      },
    });
    expect(rows.map((r) => r.key)).toEqual([
      'klines/BTCUSDT/1m',
      'klines/BTCUSDT/1d',
      'fundingRate/BTCUSDT/-',
      'metrics/BTCUSDT/-',
      'klines/ETHUSDT/1h',
    ]);
  });

  it('judges a series: failing beats waiting; never-published files do not count against it', () => {
    const [failing, waiting, complete, empty] = historyRows({
      series: {
        a: series({ symbol: 'A', errors: 1, present: 8, pending: 1 }),
        b: series({ symbol: 'B', present: 9, pending: 1 }),
        c: series({ symbol: 'C', present: 6, not_published: 4 }),
        d: series({ symbol: 'D', present: 0, not_published: 10 }),
      },
    });
    expect(failing.state).toBe('failing');
    expect(waiting.state).toBe('waiting');
    expect([complete.state, complete.available]).toEqual(['complete', 6]);
    expect(empty.state).toBe('empty');
  });

  it('copes with a status that has no series yet', () => {
    expect(historyRows({ series: {} })).toEqual([]);
  });
});

describe('cycleLine', () => {
  it('says how far a running check got, and when it is the first', () => {
    const running = { ...status().cycle, running: true, checked: 340, planned: 2400, downloaded: 12 };
    expect(cycleLine(status({ cycle: running }), NOW)).toBe('First check: 340 of 2,400 files, 12 new so far');
    expect(cycleLine(status({ cycle: running, series: { a: series({}) } }), NOW)).toBe(
      'Checking: 340 of 2,400 files, 12 new so far',
    );
  });

  it('says when the last check finished, what it found, and when the next is', () => {
    expect(cycleLine(status(), NOW)).toBe('Last check 29m 0s ago: 2 new · next in 4h 0m');
    const failed = { ...status().cycle, errors: 3, next_at_ms: NOW - 1 };
    expect(cycleLine(status({ cycle: failed }), NOW)).toBe('Last check 29m 0s ago: 2 new, 3 failed · next due now');
  });

  it('says so when nothing has run', () => {
    const none = { ...status().cycle, finished_at_ms: null, next_at_ms: null };
    expect(cycleLine(status({ cycle: none }), NOW)).toBe('No check has run yet');
  });
});

describe('historyTotals', () => {
  it('adds files and bytes, and counts failing series', () => {
    const rows = historyRows({
      series: { a: series({ errors: 2 }), b: series({ symbol: 'ETHUSDT', present: 3, bytes: 500 }) },
    });
    expect(historyTotals(rows)).toEqual({ files: 13, bytes: 1500, failing: 1 });
  });
});
