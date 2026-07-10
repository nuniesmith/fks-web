/**
 * Treasury roll-up math (P0.2). Pure — no Svelte, no chart, no fetch — so it
 * stays unit-testable under vitest (see rollup.test.ts).
 */

/** One point of a time series. `time` is UTC seconds (or any monotonic number). */
export interface RollupPoint {
  time: number;
  value: number;
}

/**
 * Carry-forward TOTAL across several per-bot series.
 *
 * The total at time T sums each bot's LAST-KNOWN value at or before T — NOT
 * just the bots that happened to report in that tick. Bots sample on offset
 * clocks and drop out across restarts, so a naive per-tick sum produces
 * artificial dips (a bot that reported at t2 but not t3 would "lose" its
 * whole value at t3). Carry-forward holds each bot's contribution flat until
 * its next report.
 *
 * Ramp-in: before a bot's FIRST report its contribution is 0 — there is no
 * value to carry forward — so the total "ramps in" over the leading region
 * as bots come online. This is honest (we genuinely don't know the earlier
 * value), but it means the left edge of the total understates history that
 * predates a bot's first snapshot.
 *
 * Preconditions: each input series is sorted ascending by `time` with no
 * duplicate times within one series (the panel's groupByBot guarantees both).
 * Output: one point per DISTINCT timestamp across all series, ascending.
 *
 * Complexity: O(B·T + Σn log Σn) for B series and T distinct timestamps.
 * Generic over the time brand so lightweight-charts' UTCTimestamp survives
 * the round-trip.
 */
export function carryForwardTotal<T extends number>(
  series: ReadonlyArray<ReadonlyArray<{ time: T; value: number }>>,
): { time: T; value: number }[] {
  // Sorted union of every timestamp any bot reported at.
  const times = new Set<T>();
  for (const s of series) for (const p of s) times.add(p.time);
  const ticks = [...times].sort((a, b) => a - b);

  // Walk the ticks advancing one pointer per series; `last[i]` is series i's
  // last-known value (0 until its first report — the ramp-in above).
  const ptr = new Array<number>(series.length).fill(0);
  const last = new Array<number>(series.length).fill(0);

  const out: { time: T; value: number }[] = [];
  for (const t of ticks) {
    let total = 0;
    for (let i = 0; i < series.length; i++) {
      const s = series[i];
      while (ptr[i] < s.length && s[ptr[i]].time <= t) {
        last[i] = s[ptr[i]].value;
        ptr[i]++;
      }
      total += last[i];
    }
    out.push({ time: t, value: total });
  }
  return out;
}
