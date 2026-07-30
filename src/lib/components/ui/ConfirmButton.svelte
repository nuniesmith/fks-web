<!--
  ConfirmButton — the shared two-step confirm for destructive actions.

  WHY THIS EXISTS: every destructive control in this app hand-rolls its own
  two-step (`/settings` delete ×2), and every hand-rolled one arms on click 1 and
  accepts click 2 IMMEDIATELY. That is auto-DISARM, not arm-DELAY: one double-tap
  — or one phone that turns a single press into two `click` events — deletes.
  A shared primitive that copied that shape would spread the regression, so the
  ARMING COOLDOWN is the reason this component is worth having at all. The
  decision logic lives in `./confirmButton.ts` because vitest can't load
  `.svelte` here (no Svelte plugin in `vitest.config.ts`).

  SAFETY PROPERTIES, all of them load-bearing:
    1. A confirm click inside `ARM_COOLDOWN_MS` of arming is SWALLOWED — the
       action does not run, and the click does not re-arm or extend the window.
    2. The button disarms itself after `disarmMs`, so a hot destructive control
       is never left armed on a screen the operator walked away from.
    3. Escape disarms (from anywhere, while armed) and so does losing focus —
       both are the SAFE direction, and neither calls `preventDefault`, so this
       component never swallows a keystroke meant for an input.
    4. `type="button"`: it can never submit or reset a parent form. Half-typed
       operator input (an API secret, a kill phrase) survives every click here.
    5. Under `(pointer: coarse)` it takes a 44px floor AND ships its own 12px
       margin. Enlarging a no-undo control without separating it from its
       neighbours makes mis-taps MORE likely — that exact mistake shipped in the
       alert-ack cluster and needed a follow-up fix, so here the size and the
       separation are in the same rule and cannot be adopted apart.

  Usage:
    <ConfirmButton label="Delete" confirmLabel="Confirm delete?"
                   busy={deleting} busyLabel="Deleting…"
                   onconfirm={() => reallyDelete(id)} />
-->
<script lang="ts">
  import {
    ARM_COOLDOWN_MS,
    AUTO_DISARM_MS,
    confirmPhase,
    decideConfirmClick,
  } from './confirmButton';

  interface Props {
    /** Resting text (step 1). */
    label: string;
    /** Armed text (step 2) — say what will happen, not just "Confirm". */
    confirmLabel?: string;
    /** Text while the action is in flight. Defaults to `label`. */
    busyLabel?: string;
    /** Action in flight: the button is disabled and cannot be re-armed. */
    busy?: boolean;
    /** Disabled for any other reason (no permission, nothing to act on, …). */
    disabled?: boolean;
    /** Runs ONLY on an accepted second click. May be async. */
    onconfirm: () => unknown;
    /**
     * Auto-disarm window. Clamped to leave a usable slice after the cooldown,
     * so a too-small value degrades to "harder to fire", never to "no cooldown".
     */
    disarmMs?: number;
    /** Optional element id (handy for tests and `aria-describedby`). */
    id?: string;
    /** Accessible name when the visible label is not self-describing. */
    ariaLabel?: string;
  }

  let {
    label,
    confirmLabel = 'Confirm?',
    busyLabel,
    busy = false,
    disabled = false,
    onconfirm,
    disarmMs = AUTO_DISARM_MS,
    id,
    ariaLabel,
  }: Props = $props();

  /**
   * The cooldown is deliberately NOT a prop. It is the one property that makes
   * this primitive safer than the two-steps it replaces, so no call site gets to
   * tune it to 0 and quietly re-introduce single-gesture deletes.
   */
  const cooldownMs = ARM_COOLDOWN_MS;
  // Guarantee a real confirm window exists after the cooldown; otherwise every
  // click would only ever re-arm and the control would be dead-but-safe.
  let armedWindowMs = $derived(Math.max(cooldownMs + 400, disarmMs));

  /** `Date.now()` at arming; null = idle. The AUTHORITY for every decision. */
  let armedAt = $state<number | null>(null);
  /**
   * Repaint clock. Advanced only when a phase boundary is reached, because the
   * timers exist to re-render — they are never trusted to gate the action (a
   * backgrounded iOS tab suspends them, and a suspended timer must not leave a
   * button that still accepts a confirm armed minutes ago).
   */
  let clock = $state(0);

  let phase = $derived(confirmPhase(armedAt, clock, cooldownMs, armedWindowMs));

  let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  let disarmTimer: ReturnType<typeof setTimeout> | undefined;

  function clearTimers(): void {
    if (cooldownTimer !== undefined) clearTimeout(cooldownTimer);
    if (disarmTimer !== undefined) clearTimeout(disarmTimer);
    cooldownTimer = undefined;
    disarmTimer = undefined;
  }

  function disarm(): void {
    clearTimers();
    armedAt = null;
    clock = Date.now();
  }

  function arm(now: number): void {
    clearTimers();
    armedAt = now;
    clock = now;
    cooldownTimer = setTimeout(() => {
      clock = Date.now();
    }, cooldownMs);
    disarmTimer = setTimeout(disarm, armedWindowMs);
  }

  function handleClick(): void {
    if (busy || disabled) return;
    const now = Date.now();
    switch (decideConfirmClick(armedAt, now, cooldownMs, armedWindowMs)) {
      // The double-fire guard: no action, no re-arm, no extension.
      case 'ignore':
        return;
      case 'arm':
        arm(now);
        return;
      case 'confirm':
        disarm();
        void onconfirm();
        return;
    }
  }

  // Escape disarms from anywhere while armed — the operator should not have to
  // find the button again to stand down. No preventDefault/stopPropagation: an
  // Escape aimed at a dialog still reaches it, and no other key is touched.
  $effect(() => {
    if (phase === 'idle') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') disarm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Never leak a pending timer into a destroyed component.
  $effect(() => () => clearTimers());

  let text = $derived(busy ? (busyLabel ?? label) : phase === 'idle' ? label : confirmLabel);
</script>

<button
  {id}
  type="button"
  class="confirm-btn {phase}"
  aria-label={ariaLabel}
  aria-disabled={phase === 'arming' ? 'true' : undefined}
  title={phase === 'idle'
    ? label
    : phase === 'arming'
      ? 'Arming — a click right now is ignored (double-tap guard)'
      : 'Click again to confirm · Escape to stand down'}
  disabled={busy || disabled}
  onclick={handleClick}
  onblur={() => {
    if (phase !== 'idle') disarm();
  }}
>
  {text}
</button>

<style>
  .confirm-btn {
    all: unset;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px 10px;
    font-size: 11px;
    font-weight: 600;
    color: var(--t2);
    border: 1px solid var(--b1);
    border-radius: var(--r);
    cursor: pointer;
    white-space: nowrap;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .confirm-btn:hover:not(:disabled) {
    color: var(--red);
    border-color: var(--t2);
  }
  .confirm-btn:focus-visible {
    outline: 2px solid var(--cyan);
    outline-offset: 2px;
  }
  /* Armed-but-not-yet-accepting: deliberately NOT the hot red of `armed`, so the
     one state where a click does nothing does not look like the one where a
     click destroys something. */
  .confirm-btn.arming {
    color: var(--amber);
    border-color: var(--amber-brd);
    cursor: progress;
  }
  .confirm-btn.armed {
    color: var(--red);
    background: var(--red-dim);
    border-color: var(--red-brd);
  }
  .confirm-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  @media (pointer: coarse) {
    /* The 44px floor and its separation are ONE rule on purpose: a thumb-sized
       button 6px from its neighbours is a worse mis-tap risk than a small one.
       The margin lives on this element (not on a host's `gap`) so the guarantee
       travels with the primitive into every future call site. */
    .confirm-btn {
      min-height: 44px;
      min-width: 64px;
      padding: 0 14px;
      font-size: 12px;
      margin: 12px;
    }
  }
</style>
