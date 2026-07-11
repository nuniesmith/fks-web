import { describe, expect, it } from 'vitest';
import { carryForwardTotal } from './rollup';

const p = (time: number, value: number) => ({ time, value });

describe('carryForwardTotal', () => {
  it('returns an empty series for no input', () => {
    expect(carryForwardTotal([])).toEqual([]);
    expect(carryForwardTotal([[], []])).toEqual([]);
  });

  it('is the identity for a single series', () => {
    const a = [p(1, 100), p(2, 110), p(3, 90)];
    expect(carryForwardTotal([a])).toEqual(a);
  });

  it('carries each bot forward across restart gaps — no artificial dip', () => {
    // THE P0.2 correctness scenario: bot A reports at t1,t2,t4 (gap at t3 —
    // e.g. a restart); bot B reports at t3 only. A naive per-tick sum would
    // show t3 = B-only (A's value vanishes) and t4 = A-only (dip then jump).
    const a = [p(1, 100), p(2, 110), p(4, 120)];
    const b = [p(3, 50)];
    expect(carryForwardTotal([a, b])).toEqual([
      p(1, 100), // B hasn't reported yet → contributes 0 (ramp-in)
      p(2, 110),
      p(3, 160), // A carried forward (110) + B's 50 — not 50
      p(4, 170), // B carried forward (50) + A's fresh 120 — not 120
    ]);
  });

  it('sums bots that report on the same timestamp exactly once', () => {
    const a = [p(1, 10), p(2, 20)];
    const b = [p(1, 5), p(2, 7)];
    expect(carryForwardTotal([a, b])).toEqual([p(1, 15), p(2, 27)]);
  });

  it('ramps in: a late-starting bot contributes 0 before its first report', () => {
    const early = [p(1, 100), p(5, 100)];
    const late = [p(3, 40)];
    expect(carryForwardTotal([early, late])).toEqual([
      p(1, 100),
      p(3, 140),
      p(5, 140),
    ]);
  });

  it('emits one point per distinct timestamp across offset samplers', () => {
    // Two bots on offset clocks — the classic "samples never line up" case.
    const a = [p(10, 1), p(30, 2), p(50, 3)];
    const b = [p(20, 10), p(40, 20)];
    expect(carryForwardTotal([a, b])).toEqual([
      p(10, 1),
      p(20, 11),
      p(30, 12),
      p(40, 22),
      p(50, 23),
    ]);
  });
});

// ─── groupSnapshots (the /net-worth → per-account series extraction) ────────

import { groupSnapshots, type SnapshotRowLike } from './rollup';

const row = (
  bot_id: string,
  ts: string,
  net_worth: number,
  currency = 'USD',
): SnapshotRowLike => ({ bot_id, ts, net_worth, currency });

describe('groupSnapshots', () => {
  it('returns [] for no rows', () => {
    expect(groupSnapshots([])).toEqual([]);
  });

  it('groups per account, ascending by time, sorted by accountId', () => {
    const out = groupSnapshots([
      row('b', '2026-07-02T00:00:10Z', 20),
      row('a', '2026-07-02T00:00:05Z', 100),
      row('b', '2026-07-02T00:00:00Z', 10),
    ]);
    expect(out.map((s) => s.accountId)).toEqual(['a', 'b']);
    expect(out[1].points.map((p) => p.value)).toEqual([10, 20]);
    expect(out[1].points[0].time).toBeLessThan(out[1].points[1].time);
    expect(out[1].latest).toBe(20);
  });

  it('de-dupes same-second collisions keeping the LATEST value', () => {
    const out = groupSnapshots([
      row('a', '2026-07-02T00:00:00.100Z', 1),
      row('a', '2026-07-02T00:00:00.900Z', 2),
    ]);
    expect(out[0].points).toHaveLength(1);
    expect(out[0].points[0].value).toBe(2);
  });

  it('drops non-finite values and unparseable timestamps; omits emptied accounts', () => {
    const out = groupSnapshots([
      row('a', 'not-a-time', 5),
      row('a', '2026-07-02T00:00:00Z', Number.NaN),
      row('ok', '2026-07-02T00:00:00Z', 7),
    ]);
    expect(out.map((s) => s.accountId)).toEqual(['ok']);
  });

  it("takes currency from the group's most recent raw row, with USD fallback", () => {
    const out = groupSnapshots([
      row('a', '2026-07-02T00:00:00Z', 1, 'EUR'),
      row('a', '2026-07-02T00:01:00Z', 2, 'CAD'),
      row('b', '2026-07-02T00:00:00Z', 3, ''),
    ]);
    expect(out[0].currency).toBe('CAD');
    expect(out[1].currency).toBe('USD');
  });
});
