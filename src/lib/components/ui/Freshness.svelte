<script lang="ts">
  /**
   * Freshness — how old is this data, and can we even tell?
   *
   * The M4 premise: a dead feed must not look like a quiet market. A frozen
   * number renders identically to a correct one, so the age has to be on
   * screen next to it.
   *
   * Three honest states, never collapsed into two:
   *   fresh    — data is current (age shown, muted)
   *   stale    — data is older than `staleAfterMs` (amber, age shown)
   *   unknown  — no usable timestamp. NOT "old": we cannot tell, and saying
   *              "unknown" is honest where a huge age would be a fabrication.
   *
   * Errors escalate only once they PERSIST (see `shouldWarn`) so a single
   * transient poll blip does not flap the indicator.
   *
   * `updated` accepts epoch seconds or milliseconds — the platform publishes
   * both, and the unit is auto-detected by magnitude rather than trusted to
   * each call site. See $lib/utils/freshness.
   */
  import { onMount } from 'svelte';
  import {
    toEpochMs,
    freshnessState,
    formatAge,
    shouldWarn,
    type TimeUnit
  } from '$lib/utils/freshness';

  let {
    updated = null,
    unit = 'auto' as TimeUnit,
    staleAfterMs = 120_000,
    consecutiveErrors = 0,
    label = 'updated',
    compact = false
  } = $props<{
    /** Epoch seconds or milliseconds; `null` when the source publishes none. */
    updated?: number | null;
    unit?: TimeUnit;
    /** Age beyond which this reads as stale. */
    staleAfterMs?: number;
    /** Failures in a row from the caller's poll; 0 when healthy. */
    consecutiveErrors?: number;
    label?: string;
    compact?: boolean;
  }>();

  // A local clock so the age counts UP between fetches. Without it a frozen
  // feed shows a frozen age, which is the same lie one level up.
  let now = $state(Date.now());
  onMount(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  let updatedMs = $derived(toEpochMs(updated, unit));
  let freshState = $derived(freshnessState(updatedMs, now, staleAfterMs));
  let warn = $derived(shouldWarn(freshState, consecutiveErrors));
  let age = $derived(updatedMs == null ? null : formatAge(now - updatedMs));

  let title = $derived(
    updatedMs == null
      ? 'This source publishes no timestamp, so its age cannot be verified'
      : `${label}: ${new Date(updatedMs).toLocaleTimeString()}` +
          (freshState === 'stale' ? ' — older than expected' : '')
  );
</script>

<span
  class="freshness"
  class:warn
  class:unknown={freshState === 'unknown'}
  class:compact
  {title}
  role="status"
>
  <span class="dot" aria-hidden="true"></span>
  {#if freshState === 'unknown'}
    <span class="txt">age unknown</span>
  {:else}
    <span class="txt">{compact ? age : `${label} ${age} ago`}</span>
  {/if}
  {#if consecutiveErrors >= 2}
    <span class="txt err">· not refreshing</span>
  {/if}
</span>

<style>
  .freshness {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 9px;
    color: var(--t3);
    white-space: nowrap;
  }

  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--green);
    flex-shrink: 0;
  }

  /* Amber, not red: stale data is a warning, not a failure — and red is
     reserved for money-critical states elsewhere in the shell. */
  .warn .dot {
    background: var(--amber);
  }
  .warn {
    color: var(--amber);
  }

  /* Unknown is deliberately GREY, not amber — we are not asserting a problem,
     only that we cannot tell. */
  .unknown .dot {
    background: var(--t3);
  }

  .err {
    font-weight: 600;
  }

  .compact {
    gap: 3px;
  }
</style>
