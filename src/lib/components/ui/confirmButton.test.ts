import { describe, expect, it } from 'vitest';
import {
  ARM_COOLDOWN_MS,
  AUTO_DISARM_MS,
  confirmPhase,
  decideConfirmClick,
  type ConfirmDecision,
} from './confirmButton';

/**
 * The two-step confirm state machine.
 *
 * The property under test is the one the app did not have anywhere: an armed
 * destructive button must IGNORE a confirm click that arrives inside the arming
 * cooldown. Everything else here exists to stop that guard from being satisfied
 * by a button that simply never confirms — a "safe" control the operator cannot
 * use is its own outage, so every deny case is paired with a positive control.
 */

const T0 = 1_800_000_000_000; // a fixed, arbitrary epoch-ms

/** Click at `T0 + elapsed` on a button armed at `T0`. */
const at = (elapsed: number, cooldown = ARM_COOLDOWN_MS, disarm = AUTO_DISARM_MS): ConfirmDecision =>
  decideConfirmClick(T0, T0 + elapsed, cooldown, disarm);

describe('decideConfirmClick — the arming cooldown', () => {
  it('a first click only arms', () => {
    expect(decideConfirmClick(null, T0)).toBe('arm');
  });

  it('SWALLOWS a confirm click fired in the same tick as arming', () => {
    // The literal double-fire: two click events from one press.
    expect(at(0)).toBe('ignore');
  });

  it('swallows every click across the whole double-tap band', () => {
    // 500ms is the OS double-tap threshold on Chrome/iOS; the cooldown has to
    // cover it end to end, not just the 0ms case.
    for (const elapsed of [0, 1, 40, 120, 250, 400, 500, ARM_COOLDOWN_MS - 1]) {
      expect(at(elapsed), `${elapsed}ms after arming must not confirm`).toBe('ignore');
    }
  });

  it('accepts the moment the cooldown elapses, and for the rest of the window', () => {
    // The positive control for the guard above: this is what makes it a DELAY
    // and not a refusal.
    expect(at(ARM_COOLDOWN_MS)).toBe('confirm');
    expect(at(ARM_COOLDOWN_MS + 1)).toBe('confirm');
    expect(at(1500)).toBe('confirm');
    expect(at(AUTO_DISARM_MS - 1)).toBe('confirm');
  });

  it('an ignored click neither re-arms nor extends the window', () => {
    // `armedAt` is the only state, so a swallowed click cannot move the clock:
    // the confirm still becomes available 600ms after the ORIGINAL arm, and the
    // auto-disarm still lands at 4s. Pinned because a naive fix ("treat the
    // early click as a fresh arm") would let a burst of taps hold a live-money
    // button armed indefinitely.
    expect(at(100)).toBe('ignore'); // swallowed…
    expect(at(700)).toBe('confirm'); // …and the window is measured from T0
    expect(at(AUTO_DISARM_MS)).toBe('arm'); // …and still lapses on time
  });
});

describe('decideConfirmClick — auto-disarm', () => {
  it('a lapsed window re-arms instead of confirming', () => {
    // The throttled-tab case: iOS suspends timers when the phone locks, so the
    // disarm timeout may not have run. A click must never be accepted against a
    // stale arm, no matter how long ago it was.
    expect(at(AUTO_DISARM_MS)).toBe('arm');
    expect(at(AUTO_DISARM_MS + 1)).toBe('arm');
    expect(at(60 * 60 * 1000)).toBe('arm');
  });
});

describe('decideConfirmClick — degenerate clocks and configs fail closed', () => {
  it('a clock that stepped backwards does not confirm', () => {
    expect(at(-1)).toBe('ignore');
    expect(at(-60_000)).toBe('ignore');
  });

  it('NaN/Infinity anywhere never yields confirm', () => {
    expect(decideConfirmClick(NaN, T0)).toBe('arm'); // unusable arm ⇒ re-arm
    expect(decideConfirmClick(Infinity, T0)).toBe('arm');
    // An elapsed we cannot reason about is swallowed, not accepted.
    expect(decideConfirmClick(T0, NaN)).toBe('ignore');
    expect(decideConfirmClick(T0, Infinity)).toBe('ignore');
  });

  it('cooldown >= disarm window is dead-but-safe, never open', () => {
    // A future call site that mis-tunes the timings must lose the ability to
    // confirm, not the guard. Swept across the whole range so no single elapsed
    // value can slip through.
    for (let elapsed = 0; elapsed <= 12_000; elapsed += 37) {
      expect(at(elapsed, 5_000, 4_000), `elapsed=${elapsed}`).not.toBe('confirm');
    }
  });
});

describe('confirmPhase — what it looks like is what it does', () => {
  it('armed ⇔ a click would confirm, at every millisecond of the window', () => {
    // The drift this forbids: a button painted hot red while clicks are still
    // being swallowed (operator taps, nothing happens, taps harder) — or worse,
    // painted resting while a click would delete.
    for (let elapsed = -500; elapsed <= AUTO_DISARM_MS + 500; elapsed += 1) {
      const armed = confirmPhase(T0, T0 + elapsed) === 'armed';
      const fires = at(elapsed) === 'confirm';
      expect(armed, `elapsed=${elapsed}`).toBe(fires);
    }
  });

  it('idle before arming and after the window lapses; arming inside the cooldown', () => {
    expect(confirmPhase(null, T0)).toBe('idle');
    expect(confirmPhase(T0, T0)).toBe('arming');
    expect(confirmPhase(T0, T0 + ARM_COOLDOWN_MS - 1)).toBe('arming');
    expect(confirmPhase(T0, T0 + ARM_COOLDOWN_MS)).toBe('armed');
    expect(confirmPhase(T0, T0 + AUTO_DISARM_MS)).toBe('idle');
  });

  it('the cooldown is long enough to matter and short enough to use', () => {
    // Guard on the constants themselves: dropping the cooldown to 0 would make
    // every test above pass vacuously (`elapsed < 0` is never true), and the
    // primitive would silently become the thing it was built to replace.
    expect(ARM_COOLDOWN_MS).toBeGreaterThanOrEqual(500);
    expect(ARM_COOLDOWN_MS).toBeLessThanOrEqual(800);
    expect(AUTO_DISARM_MS).toBeGreaterThan(ARM_COOLDOWN_MS * 2);
  });
});
