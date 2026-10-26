import { describe, expect, it } from 'vitest';
import { calendar, completeShare, dayWindow, fmtBytes, fmtDuration } from './coverage';
import type { Coverage } from '$lib/types/spawner';

function cov(over: Partial<Coverage>): Coverage {
  return {
    days: [],
    files: [],
    gaps: [],
    unreadable_gap_lines: 0,
    first_day: null,
    last_day: null,
    total_days: 0,
    total_bytes: 0,
    ...over,
  };
}

const file = (day: string, stream: string, closed = true, bytes = 100) => ({
  symbol: 'BTCUSDT',
  stream,
  day,
  bytes,
  closed,
});

describe('dayWindow', () => {
  it('ends at today, oldest first, across a month boundary', () => {
    expect(dayWindow('2026-11-02', 4)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });
});

describe('calendar', () => {
  const today = '2026-10-29';

  it('marks before / complete / gaps / partial / missing / open', () => {
    const c = cov({
      first_day: '2026-10-24',
      files: [
        // 24: complete
        file('2026-10-24', 'bookTicker'),
        file('2026-10-24', 'markPrice'),
        // 25: all present, but 5 minutes of gaps
        file('2026-10-25', 'bookTicker'),
        file('2026-10-25', 'markPrice'),
        // 26: markPrice missing
        file('2026-10-26', 'bookTicker'),
        // 27: nothing at all
        // 28: never gzipped
        file('2026-10-28', 'bookTicker', false),
        file('2026-10-28', 'markPrice'),
        // 29 (today): open
        file('2026-10-29', 'bookTicker', false, 9000),
      ],
      gaps: [
        { day: '2026-10-24', group: 'public', count: 1, seconds: 0.7, reasons: { startup: 1 } },
        { day: '2026-10-25', group: 'public', count: 3, seconds: 300, reasons: { disconnect: 3 } },
      ],
    });
    const cells = calendar(c, today, 7);
    const state = Object.fromEntries(cells.map((x) => [x.day, x.state]));
    expect(state).toEqual({
      '2026-10-23': 'before',
      '2026-10-24': 'complete',
      '2026-10-25': 'gaps',
      '2026-10-26': 'partial',
      '2026-10-27': 'missing',
      '2026-10-28': 'partial',
      '2026-10-29': 'open',
    });
    const byDay = Object.fromEntries(cells.map((x) => [x.day, x]));
    expect(byDay['2026-10-25'].reasons).toEqual(['gaps 5m 0s']);
    expect(byDay['2026-10-26'].reasons).toEqual(['no BTCUSDT/markPrice']);
    expect(byDay['2026-10-28'].reasons[0]).toMatch(/not closed/);
    expect(byDay['2026-10-29'].bytes).toBe(9000);
    // complete / (complete + gaps + partial + missing + partial) — before and open excluded
    expect(completeShare(cells)).toBeCloseTo(1 / 5);
  });

  it('a startup gap of a second is not a mark against the day', () => {
    const c = cov({
      first_day: '2026-10-27',
      files: [file('2026-10-27', 'bookTicker')],
      gaps: [{ day: '2026-10-27', group: 'public', count: 1, seconds: 1.2, reasons: { startup: 1 } }],
    });
    expect(calendar(c, '2026-10-28', 2).map((x) => x.state)).toEqual(['complete', 'open']);
  });

  it('a recorder with no files yet is all before, and has no share', () => {
    const cells = calendar(cov({}), today, 3);
    expect(cells.every((x) => x.state === 'before')).toBe(true);
    expect(completeShare(cells)).toBeNull();
  });
});

describe('formatting', () => {
  it('durations and sizes', () => {
    expect(fmtDuration(0.68)).toBe('0.7s');
    expect(fmtDuration(42)).toBe('42s');
    expect(fmtDuration(3725)).toBe('1h 2m');
    expect(fmtBytes(415_000_000)).toBe('415 MB');
    expect(fmtBytes(9_100_000_000)).toBe('9.1 GB');
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(null)).toBe('—');
  });
});
