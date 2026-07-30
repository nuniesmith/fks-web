/**
 * ConfirmButton — the pure two-step-confirm state machine.
 *
 * Split out of `ConfirmButton.svelte` so the safety property can be unit-tested:
 * `vitest.config.ts` deliberately does NOT load the Svelte plugin, so a `.svelte`
 * module is unreachable from `npm run test:unit`.
 *
 * WHY A COOLDOWN EXISTS AT ALL (the whole reason this module is not two lines):
 * every hand-rolled two-step in this app arms on click 1 and accepts click 2
 * IMMEDIATELY. Its window is auto-DISARM, not arm-DELAY. So a double-tap, a
 * fat-finger double-fire, or a phone that delivers two `click`s from one press
 * DELETES on a single gesture — strictly worse than the native `confirm()`
 * dialog it replaced, whose second step lands in a different place on screen.
 * A shared primitive without an arming cooldown would multiply that regression
 * across every destructive control in the app, so the cooldown is the point.
 *
 * The two functions below take `now` as an argument on purpose: the component's
 * timers are only there to repaint. Every ACCEPT decision is re-derived from
 * real timestamps at click time, so a throttled/backgrounded tab (iOS Safari
 * suspends timers when the phone locks) can never leave a stale-armed button
 * that accepts a confirm the operator armed an hour ago.
 */

/**
 * How long an armed button IGNORES confirm clicks. ~600ms is above the OS
 * double-tap threshold (Chrome/iOS treat ≤500ms as a double-tap) and below the
 * ~700ms it takes to re-aim deliberately, so it costs a deliberate operator
 * nothing and costs an accidental double-fire the whole action.
 */
export const ARM_COOLDOWN_MS = 600;

/**
 * How long the button stays armed before disarming itself. Matches the 4s the
 * `/settings` hand-rolled flow already used — a hot destructive control must not
 * be left armed on a screen the operator walked away from.
 */
export const AUTO_DISARM_MS = 4000;

/** What a click on the button should do. */
export type ConfirmDecision =
  /** Not armed (or the window lapsed): this click only arms it. */
  | 'arm'
  /** Armed but still inside the cooldown: swallow it. THE safety property. */
  | 'ignore'
  /** Armed and ripe: run the destructive action. */
  | 'confirm';

/** What the button should LOOK like. `armed` ⇔ a click would confirm. */
export type ConfirmPhase = 'idle' | 'arming' | 'armed';

/**
 * Decide what a click does, from the arm timestamp and the current clock.
 *
 * @param armedAt `Date.now()` when the button was armed, or `null` when idle.
 * @param now     `Date.now()` at the moment of the click.
 *
 * Fails toward "nothing happened" in every degenerate case: a null/NaN/negative
 * elapsed, a clock that stepped backwards (NTP, DST on a naive clock), and a
 * `cooldownMs >= disarmMs` misconfiguration all resolve to `ignore`/`arm` and
 * never to `confirm`.
 */
export function decideConfirmClick(
  armedAt: number | null,
  now: number,
  cooldownMs: number = ARM_COOLDOWN_MS,
  disarmMs: number = AUTO_DISARM_MS,
): ConfirmDecision {
  if (armedAt === null || !Number.isFinite(armedAt)) return 'arm';
  const elapsed = now - armedAt;
  // A clock we cannot reason about must not be able to fire the action.
  if (!Number.isFinite(elapsed)) return 'ignore';
  // The cooldown. Checked BEFORE the lapse check so a negative elapsed
  // (clock stepped back) is swallowed rather than treated as "long ago".
  if (elapsed < cooldownMs) return 'ignore';
  // The window lapsed while a timer was throttled: re-arm, never accept.
  if (elapsed >= disarmMs) return 'arm';
  return 'confirm';
}

/**
 * The render phase for the same inputs.
 *
 * Kept in this module (rather than derived from the component's timer flags) so
 * that "the button LOOKS hot" and "a click would fire" cannot drift apart —
 * pinned by the `phase === 'armed' ⇔ decision === 'confirm'` test.
 */
export function confirmPhase(
  armedAt: number | null,
  now: number,
  cooldownMs: number = ARM_COOLDOWN_MS,
  disarmMs: number = AUTO_DISARM_MS,
): ConfirmPhase {
  return decideConfirmClick(armedAt, now, cooldownMs, disarmMs) === 'confirm'
    ? 'armed'
    : armedAt !== null && Number.isFinite(armedAt) && now - armedAt < cooldownMs
      ? 'arming'
      : 'idle';
}
