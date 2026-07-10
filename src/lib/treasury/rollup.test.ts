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
