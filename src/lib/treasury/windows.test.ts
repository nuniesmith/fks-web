import { describe, expect, it } from 'vitest';
import { etMidnightUtc, etWallClock, windowToSince } from './windows';

describe('etWallClock', () => {
  it('reads a UTC instant as ET wall-clock (EDT in summer)', () => {
    const w = etWallClock(new Date('2026-07-10T01:30:00Z'));
    expect(w).toEqual({ year: 2026, month: 7, day: 9, hour: 21, minute: 30 });
  });

  it('reads midnight as hour 0, not 24 (h23)', () => {
    const w = etWallClock(new Date('2026-01-15T05:00:00Z'));
    expect(w.hour).toBe(0);
    expect(w.day).toBe(15);
  });
});

describe('etMidnightUtc', () => {
  it('is UTC−4 during EDT (summer)', () => {
    expect(etMidnightUtc(2026, 7, 3).toISOString()).toBe('2026-07-03T04:00:00.000Z');
  });

  it('is UTC−5 during EST (winter)', () => {
    expect(etMidnightUtc(2026, 1, 15).toISOString()).toBe('2026-01-15T05:00:00.000Z');
  });
});

describe('windowToSince', () => {
  it("'all' has no since — full history", () => {
    expect(windowToSince('all')).toBeNull();
  });

  it('anchors 7d at ET midnight 7 ET-days back (UTC date ≠ ET date)', () => {
    // 2026-07-10 01:00Z is still 2026-07-09 21:00 ET → "today" is Jul 9 ET,
    // so 7d back = Jul 2 at ET midnight (04:00Z during EDT).
    const now = new Date('2026-07-10T01:00:00Z');
    expect(windowToSince('7d', now)).toBe('2026-07-02T04:00:00.000Z');
  });

  it('30d handles month underflow', () => {
    const now = new Date('2026-07-10T12:00:00Z'); // 08:00 ET, Jul 10
    expect(windowToSince('30d', now)).toBe('2026-06-10T04:00:00.000Z');
  });

  it('crosses the spring-forward boundary with per-date offsets', () => {
    // US DST 2026 starts Mar 8. Now = Mar 10 (EDT); 7 days back = Mar 3,
    // which is still EST → midnight is 05:00Z, not 04:00Z.
    const now = new Date('2026-03-10T12:00:00Z');
    expect(windowToSince('7d', now)).toBe('2026-03-03T05:00:00.000Z');
  });
});
