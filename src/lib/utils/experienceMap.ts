/**
 * Pure helpers for the Experience Map (UMAP view) — separated for unit
 * testing. Color scales + the seeded PRNG that keeps the UMAP layout stable
 * across refreshes of the same dataset.
 */

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Diverging loss→gain scale for reward, clamped to ±bound. */
export function rewardColor(r: number, bound: number): string {
  const t = Math.max(-1, Math.min(1, bound > 0 ? r / bound : 0));
  if (t >= 0) {
    // gray → green
    const g = Math.round(125 + t * 75);
    return `rgb(${Math.round(90 - t * 68)}, ${g}, ${Math.round(115 - t * 0)})`;
  }
  // gray → red
  const rr = Math.round(125 - t * 109);
  return `rgb(${rr}, ${Math.round(90 + t * 33)}, ${Math.round(115 + t * 48)})`;
}

/** Sequential dim-gray → cyan scale for confidence 0..1; null = neutral. */
export function confidenceColor(c: number | null | undefined): string {
  if (c == null) return '#3a415c';
  const t = Math.max(0, Math.min(1, c));
  return `rgb(${Math.round(40 + t * 0)}, ${Math.round(90 + t * 139)}, ${Math.round(120 + t * 135)})`;
}

const REGIME_PALETTE = [
  '#00e5ff', '#b388ff', '#f0b90b', '#ff6d92',
  '#7bd88f', '#ff9f43', '#54a0ff', '#c8d6e5',
];

/** Stable categorical color for a regime label; null = neutral. */
export function regimeColor(regime: string | null | undefined): string {
  if (!regime) return '#3a415c';
  let h = 0;
  for (let i = 0; i < regime.length; i++) h = (h * 31 + regime.charCodeAt(i)) | 0;
  return REGIME_PALETTE[Math.abs(h) % REGIME_PALETTE.length];
}
