/**
 * Resume-freshness guard (PWA T3.6) — pure, so the storm-avoidance logic is
 * vitest-coverable independently of the DOM `visibilitychange` wiring.
 *
 * iOS suspends installed PWAs aggressively: while backgrounded, `setInterval`
 * poll timers are frozen, so on resume the view can be showing numbers that
 * are up to a full poll-interval stale with no indication. The poll store
 * (`poll.ts`) listens for `document` becoming visible and fires an immediate
 * one-shot fetch — but ONLY when this guard says the data is old enough to be
 * worth refreshing. Rapid tab flips (background/foreground within a couple of
 * seconds) must NOT trigger a refresh storm across every shared poll engine,
 * hence the floor.
 */

/**
 * Minimum age of the last completed fetch before a visibility-resume is
 * allowed to trigger a fresh one. 3s comfortably clears rapid flips while
 * still refreshing anything genuinely stale from a real background suspend —
 * and it benefits long-interval polls (30s) most, which are the stalest on
 * resume.
 */
export const RESUME_MIN_INTERVAL_MS = 3_000;

/**
 * Should a visibility-resume trigger an immediate refresh?
 *
 * - `lastFetchAt == null` → no completed fetch yet; the normal acquire/immediate
 *   path owns the first fetch, so resume stays out of it (returns false).
 * - otherwise refresh iff at least `minIntervalMs` has elapsed since the last
 *   completed fetch (the storm floor).
 *
 * Pure and deterministic (`now` injected) — the DOM listener in `poll.ts`
 * supplies `Date.now()`.
 */
export function shouldRefreshOnResume(
  lastFetchAt: number | null,
  now: number,
  minIntervalMs: number = RESUME_MIN_INTERVAL_MS,
): boolean {
  if (lastFetchAt == null) return false;
  return now - lastFetchAt >= minIntervalMs;
}
