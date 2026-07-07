import { describe, expect, it } from 'vitest';
import { confidenceColor, mulberry32, regimeColor, rewardColor } from './experienceMap';

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });
  it('yields values in [0,1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('rewardColor', () => {
  it('differs for gains vs losses and clamps at the bound', () => {
    expect(rewardColor(1, 1)).not.toEqual(rewardColor(-1, 1));
    expect(rewardColor(5, 1)).toEqual(rewardColor(1, 1)); // clamped
  });
  it('handles a zero bound without NaN', () => {
    expect(rewardColor(0.1, 0)).toMatch(/^rgb\(/);
  });
});

describe('confidenceColor', () => {
  it('returns the neutral color for null', () => {
    expect(confidenceColor(null)).toBe('#3a415c');
    expect(confidenceColor(undefined)).toBe('#3a415c');
  });
  it('is monotone-bright toward 1', () => {
    expect(confidenceColor(0)).not.toEqual(confidenceColor(1));
  });
});

describe('regimeColor', () => {
  it('is stable per label and neutral for null', () => {
    expect(regimeColor('trending')).toEqual(regimeColor('trending'));
    expect(regimeColor(null)).toBe('#3a415c');
  });
});
