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

/**
 * The subset of a net-worth snapshot row `groupSnapshots` needs. Structural
 * (rather than importing NetWorthSnapshot) so this module stays free of
 * $lib/types and trivially testable.
 */
export interface SnapshotRowLike {
  bot_id: string;
  /** ISO-8601 timestamp. */
  ts: string;
  net_worth: number;
  currency: string;
}

/** One account's cleaned net-worth series, ready for plotting / roll-up. */
export interface AccountSeries {
  /** The snapshot rows' bot_id — the logical account id. */
  accountId: string;
  /** Last (most recent) value of the series. */
  latest: number;
  /** Denomination, from the group's most recent raw row ('USD' fallback). */
  currency: string;
  /** Ascending by time (UTC seconds), de-duped per whole second. */
  points: RollupPoint[];
}

/**
 * Group flat `GET /net-worth` rows into one ascending, de-duped series per
 * account (factored out of the /bots NetWorthHistoryPanel so /treasury can
 * share it). A timestamp collision on the same whole second keeps the latest
 * value — lightweight-charts rejects non-increasing times, and ascending +
 * de-duped is also the precondition `carryForwardTotal` relies on. Rows with
 * a non-finite value or unparseable timestamp are dropped; accounts left with
 * no valid points are omitted. Output is sorted by accountId. Pure — no
 * chart / DOM / fetch.
 */
export function groupSnapshots(rows: readonly SnapshotRowLike[]): AccountSeries[] {
  const groups = new Map<string, SnapshotRowLike[]>();
  for (const r of rows) {
    const arr = groups.get(r.bot_id);
    if (arr) arr.push(r);
    else groups.set(r.bot_id, [r]);
  }
  const out: AccountSeries[] = [];
  for (const [accountId, rs] of groups) {
    const bySecond = new Map<number, number>();
    for (const r of rs) {
      const t = Math.floor(new Date(r.ts).getTime() / 1000);
      if (Number.isFinite(t) && Number.isFinite(r.net_worth)) bySecond.set(t, r.net_worth);
    }
    const points = [...bySecond.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([time, value]) => ({ time, value }));
    if (points.length === 0) continue;
    out.push({
      accountId,
      latest: points[points.length - 1].value,
      currency: rs[rs.length - 1].currency || 'USD',
      points,
    });
  }
  return out.sort((a, b) => a.accountId.localeCompare(b.accountId));
}

// ─── Staleness (dead-account carry-forward guard) ───────────────────────────

/**
 * How long an account's newest snapshot may age before its carried-forward
 * balance stops reading as CURRENT money in the headline total.
 *
 * `carryForwardTotal` deliberately holds each account's last-known value flat
 * (the ramp-in / restart-gap fix), which means an account whose watcher is
 * decommissioned — or whose funds are moved out without a final ~0 snapshot —
 * keeps contributing its final value to "Real net worth" forever, silently
 * overstating it (audit 2026-07-11). We don't drop the value (we can't prove
 * the money moved, and dropping a merely-restarted bot would UNDERSTATE), but
 * we surface it as stale so the figure stops silently reading as fresh.
 *
 * Mirrors the advisor's `ACCOUNT_STALE_HOURS` (fks-state
 * crates/advisor/src/model.rs): 6h is loose enough that a routine restart
 * doesn't flag, tight enough that a dead account's carried balance is caught.
 */
export const ACCOUNT_STALE_SECONDS = 6 * 3600;

/** One carried-forward account whose most recent snapshot has gone stale. */
export interface StaleAccount {
  accountId: string;
  /** Its last-known value — still summed into the carry-forward total. */
  value: number;
  /** Whole seconds since its most recent snapshot. */
  ageSeconds: number;
}

/**
 * The subset of `series` whose newest snapshot is older than `maxAgeSeconds`
 * before `nowSeconds`. These accounts are still carried into
 * `carryForwardTotal`, so the headline must surface them explicitly rather
 * than presenting a dead account's frozen balance as live net worth. Sorted
 * oldest-first (the worst offender leads). Empty series are skipped. Pure —
 * `nowSeconds` is injectable so the rule stays deterministically testable.
 */
export function staleAccounts(
  series: readonly AccountSeries[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
  maxAgeSeconds: number = ACCOUNT_STALE_SECONDS,
): StaleAccount[] {
  const out: StaleAccount[] = [];
  for (const s of series) {
    const last = s.points[s.points.length - 1];
    if (!last) continue;
    const ageSeconds = nowSeconds - last.time;
    if (ageSeconds > maxAgeSeconds) {
      out.push({ accountId: s.accountId, value: s.latest, ageSeconds });
    }
  }
  return out.sort((a, b) => b.ageSeconds - a.ageSeconds);
}

/**
 * Human age for a stale annotation: "8h" under 48h, "3d" beyond — the web
 * mirror of the advisor's `account_age_note` wording. `seconds` is expected to
 * already exceed `ACCOUNT_STALE_SECONDS` (≥ 6h), so sub-hour output never
 * shows; negative (clock-skew) ages clamp to "0h".
 */
export function formatStaleAge(seconds: number): string {
  const hours = Math.max(0, seconds) / 3600;
  return hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}
