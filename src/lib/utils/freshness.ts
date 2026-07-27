/**
 * Freshness — pure helpers behind the staleness indicators (M4).
 *
 * Kept out of the component so the rules are unit-testable. The component is
 * a thin renderer over these.
 *
 * ## Why a unit is involved at all
 *
 * The platform publishes timestamps in BOTH resolutions, which is a real
 * 1000x hazard for any shared indicator:
 *   - `/exchanges` renders `v.updated` in epoch SECONDS (its `agoSecs` helper)
 *     — that value comes straight from the bots' `/status`, which stamps
 *     `updated` in seconds (verified against the live spot bot).
 *   - the cockpit's `generated_at` and the poll store's `updatedAt` are
 *     epoch MILLISECONDS.
 *
 * Passing one where the other is expected does not throw — it silently renders
 * an age that is wrong by a factor of 1000, in either direction, which is
 * exactly the class of "looks fine, is a lie" bug this stage exists to remove.
 * So the default is `'auto'`: epoch seconds and epoch milliseconds are
 * unambiguously separable by magnitude for any plausible date, and detecting
 * beats trusting each call site to remember.
 */

export type TimeUnit = 'ms' | 's' | 'auto';

export type FreshnessState = 'fresh' | 'stale' | 'unknown';

/**
 * Above this, a value must be milliseconds; below it, seconds.
 *
 * 1e11 seconds is the year 5138; 1e11 ms is 1973. Every real timestamp this
 * app will ever see falls cleanly on one side.
 */
const MS_THRESHOLD = 1e11;

/**
 * Normalize a timestamp to epoch milliseconds.
 *
 * Returns `null` for anything that cannot be trusted — missing, non-finite,
 * or non-positive. `null` means "unverifiable", never "old": a missing stamp
 * must not be rendered as a huge age.
 */
export function toEpochMs(value: number | null | undefined, unit: TimeUnit = 'auto'): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  if (unit === 'ms') return value;
  if (unit === 's') return value * 1000;
  return value >= MS_THRESHOLD ? value : value * 1000;
}

/**
 * Classify freshness.
 *
 * `unknown` when there is no usable stamp — the honest answer when we cannot
 * tell, and deliberately distinct from `stale` so the UI can say "unknown"
 * rather than implying data is old.
 *
 * A stamp in the FUTURE counts as fresh: clock skew between the bot and this
 * host must not make live data look stale (the same rule the spawner's
 * staleness guard uses server-side).
 */
export function freshnessState(
  updatedMs: number | null,
  nowMs: number,
  staleAfterMs: number
): FreshnessState {
  if (updatedMs == null) return 'unknown';
  const age = nowMs - updatedMs;
  if (age < 0) return 'fresh';
  return age > staleAfterMs ? 'stale' : 'fresh';
}

/**
 * Human age, e.g. `12s` / `4m` / `2h` / `3d`.
 *
 * Clamped at zero so a skewed clock reads `0s`, never a negative age.
 */
export function formatAge(ageMs: number): string {
  const s = Math.max(0, Math.floor(ageMs / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Should the indicator show a problem?
 *
 * An error is only escalated once it has PERSISTED — `consecutiveErrors`
 * counts failures in a row. A single transient blip on a 5s poll must not
 * flap the banner; an operator who learns the banner cries wolf stops reading
 * it, which is worse than not having it.
 *
 * Staleness, by contrast, escalates on its own: data that is genuinely old is
 * old regardless of whether the last request happened to succeed.
 */
export function shouldWarn(
  state: FreshnessState,
  consecutiveErrors: number,
  errorThreshold = 2
): boolean {
  if (state === 'stale') return true;
  return consecutiveErrors >= errorThreshold;
}
