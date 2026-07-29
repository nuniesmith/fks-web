<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$api/client';
  import { alertInbox, describeChip, promDownStreak } from '$lib/stores/alertInbox';
  import Freshness from '$lib/components/ui/Freshness.svelte';
  import { formatAge, freshnessState, toEpochMs } from '$lib/utils/freshness';

  // ─── State ────────────────────────────────────────────────────────────────

  type DotState = 'ok' | 'warn' | 'down' | 'unknown';

  interface HealthState {
    redis: string;
    janus: string;
    feed: string;
  }

  const HEALTH_POLL_MS = 15_000;

  /**
   * R5 — after this long with no SUCCESSFUL /api/health, the dots stop
   * asserting anything and go grey. Three missed 15s ticks: one dropped
   * response is not an outage, but a dead adapter or a phone that lost the
   * network is visible in under a minute instead of never.
   */
  const HEALTH_STALE_AFTER_MS = 45_000;

  let health = $state<HealthState>({ redis: '—', janus: '—', feed: '—' });
  let lastFetch = $state<Date | null>(null);
  /** Consecutive failed health fetches; reset by any success. */
  let healthErrors = $state(0);

  /**
   * Local clock so ages count UP between fetches. Without it a frozen feed
   * renders a frozen age, which is the same lie one level further down — the
   * exact reason `Freshness.svelte` carries its own ticker.
   */
  let now = $state(Date.now());

  /**
   * Fallback reference for the alert chip before its first successful poll, so
   * the chip does not flash grey during the ~200ms before the first response.
   * Read at component init (not onMount) so SSR renders the quiet state too.
   */
  const mountedAt = Date.now();

  const inboxUpdatedAt = alertInbox.updatedAt;

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** Classify a raw health value string into a dot state. */
  function classify(val: string): DotState {
    if (!val || val === '—') return 'unknown';
    const v = val.toLowerCase();
    if (
      v === 'ok' ||
      v === 'connected' ||
      v === 'up' ||
      v === 'ready' ||
      v === 'healthy' ||
      v === 'running'
    ) {
      return 'ok';
    }
    if (
      v === 'degraded' ||
      v === 'slow' ||
      v === 'warn' ||
      v === 'warning' ||
      v === 'partial'
    ) {
      return 'warn';
    }
    return 'down';
  }

  /** Map a dot state to its CSS colour variable. */
  function dotColor(state: DotState): string {
    switch (state) {
      case 'ok':      return 'var(--green)';
      case 'warn':    return 'var(--amber)';
      case 'down':    return 'var(--red)';
      case 'unknown': return 'var(--t3)';
    }
  }

  /** Map a dot state to an accessible label. */
  function dotLabel(service: string, state: DotState): string {
    const stateStr = state === 'ok' ? 'healthy' : state === 'warn' ? 'degraded' : state === 'down' ? 'down' : 'unknown';
    return `${service}: ${stateStr}`;
  }

  // ─── Derived ─────────────────────────────────────────────────────────────

  /**
   * R5 — how old the health snapshot is. `lastFetch` advances on SUCCESS only
   * (same rule as `poll.updatedAt`), so this grows without bound while
   * /api/health is unanswered and there is nothing else to key off: a dead
   * adapter never sends a payload to classify.
   */
  let healthMs = $derived(toEpochMs(lastFetch?.getTime() ?? null, 'ms'));
  let healthFreshness = $derived(freshnessState(healthMs, now, HEALTH_STALE_AFTER_MS));

  /**
   * True once the last-good values can no longer be vouched for. The dots then
   * render GREY (`unknown`) rather than keeping their last colour — "we cannot
   * tell" is not the same claim as "healthy", and it is not "broken" either, so
   * it is deliberately not red. Matches `Freshness.svelte`'s three states.
   */
  let healthUnknown = $derived(healthFreshness !== 'fresh');

  let redisState  = $derived<DotState>(healthUnknown ? 'unknown' : classify(health.redis));
  let janusState  = $derived<DotState>(healthUnknown ? 'unknown' : classify(health.janus));
  let feedState   = $derived<DotState>(healthUnknown ? 'unknown' : classify(health.feed));

  /**
   * Worst-wins aggregate for the phone layout, where three separate health
   * items do not fit (they pushed the logout button off a 375px viewport).
   * Severity order down > warn > unknown > ok — a degraded service must never
   * be hidden behind a healthy sibling just because it sorts later.
   */
  const SEVERITY: Record<DotState, number> = { down: 3, warn: 2, unknown: 1, ok: 0 };

  let worstState = $derived(
    [redisState, janusState, feedState].reduce<DotState>(
      (worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst),
      'ok'
    )
  );

  /**
   * Names the services that are NOT ok, so the phone dot still says what broke
   * — and, when the feed itself has gone quiet, says THAT instead of reciting
   * three stale per-service verdicts as if they were current.
   */
  let worstLabel = $derived.by(() => {
    if (healthUnknown) {
      return healthMs == null
        ? 'health status unknown — no successful check yet; the dashboard cannot see the backends'
        : `health data stale ${formatAge(now - healthMs)} — the dashboard cannot see the backends`;
    }
    const bad = [
      ['Redis', redisState],
      ['Janus', janusState],
      ['Feed', feedState]
    ].filter(([, s]) => s !== 'ok');
    if (bad.length === 0) return 'All systems healthy';
    return bad.map(([name, s]) => dotLabel(name as string, s as DotState)).join(', ');
  });

  /** Aggregate text. Unknown is its own glyph — it is not a claim of DEGRADED. */
  let aggText = $derived(
    worstState === 'ok' ? 'OK' : worstState === 'unknown' ? '?' : 'DEGRADED'
  );

  // ─── Alert chip (R3) ─────────────────────────────────────────────────────

  /**
   * Three states, not two: a count, `unknown` (grey — Prometheus or our own
   * poll is dead, so a quiet chip would be a lie on every page), or hidden.
   * All the honesty rules live in `describeChip` so they are unit-testable.
   */
  let chip = $derived(
    describeChip({
      inbox: $alertInbox,
      updatedAt: $inboxUpdatedAt,
      since: mountedAt,
      promDownStreak: $promDownStreak,
      nowMs: now
    })
  );

  // ─── Data Fetching ────────────────────────────────────────────────────────

  async function fetchHealth(): Promise<void> {
    try {
      const data = await api.get<Record<string, unknown>>('/api/health');
      health = {
        redis: String((data as any).redis ?? '—'),
        janus: String((data as any).janus ?? '—'),
        feed:  String((data as any).feed  ?? '—'),
      };
      lastFetch = new Date();
      healthErrors = 0;
    } catch {
      // R5: a failure must not be silent. The values stay put for one grace
      // period, but `lastFetch` deliberately does NOT advance — so once the
      // gap passes HEALTH_STALE_AFTER_MS every dot greys out and the Freshness
      // line reports the age. Only a real success can turn a dot green again;
      // the old comment here claimed the dots would recover "on the next
      // successful fetch cycle or after restart", which meant a dead adapter
      // or a backgrounded phone showed a green footer forever.
      healthErrors += 1;
    }
  }

  onMount(() => {
    // Fetch immediately so dots are not stuck on grey at boot.
    fetchHealth();

    // Keep the shared alert-inbox poll warm app-wide so the unacked chip is
    // live on every page (the /monitoring page + cockpit panel share this poll).
    alertInbox.start();

    const interval = setInterval(fetchHealth, HEALTH_POLL_MS);
    // 1s tick so the staleness thresholds above fire on their own, without
    // waiting for a fetch that may never come back.
    const tick = setInterval(() => (now = Date.now()), 1_000);
    return () => {
      clearInterval(interval);
      clearInterval(tick);
      alertInbox.stop();
    };
  });
</script>

<footer class="statusbar" role="status" aria-live="polite" aria-label="System health status">
  <!-- Phone-only aggregate. The three per-service items below do not fit on a
       375px viewport and pushed the logout control off-screen entirely. -->
  <span class="status-item status-agg" aria-label={worstLabel}>
    <span
      class="dot"
      class:dot-pulse={worstState === 'ok'}
      style="background: {dotColor(worstState)}"
    ></span>
    {aggText}
  </span>

  <span class="status-item" aria-label={dotLabel('Redis', redisState)}>
    <span
      class="dot"
      class:dot-pulse={redisState === 'ok'}
      style="background: {dotColor(redisState)}"
    ></span>
    Redis
    <!-- The value is suppressed while unknown: a frozen "ok" beside a grey dot
         is the very claim we just withdrew. -->
    {#if !healthUnknown && health.redis !== '—'}
      <span class="health-val">{health.redis}</span>
    {/if}
  </span>

  <span class="status-item" aria-label={dotLabel('Janus', janusState)}>
    <span
      class="dot"
      class:dot-pulse={janusState === 'ok'}
      style="background: {dotColor(janusState)}"
    ></span>
    Janus
    {#if !healthUnknown && health.janus !== '—'}
      <span class="health-val">{health.janus}</span>
    {/if}
  </span>

  <span class="status-item" aria-label={dotLabel('Feed', feedState)}>
    <span
      class="dot"
      class:dot-pulse={feedState === 'ok'}
      style="background: {dotColor(feedState)}"
    ></span>
    Feed
    {#if !healthUnknown && health.feed !== '—'}
      <span class="health-val">{health.feed}</span>
    {/if}
  </span>

  <!-- R5: the age of the health snapshot itself, on screen next to the dots.
       Amber once stale (the age IS old and we can measure it) while the dots go
       grey (the verdicts are no longer claims we can make) — the same split
       Freshness draws between 'stale' and 'unknown'. -->
  <span class="status-item">
    <Freshness
      updated={lastFetch?.getTime() ?? null}
      unit="ms"
      staleAfterMs={HEALTH_STALE_AFTER_MS}
      consecutiveErrors={healthErrors}
      label="health"
    />
  </span>

  {#if chip.state}
    <a
      class="alert-chip"
      class:critical={chip.state === 'critical'}
      class:warning={chip.state === 'warning'}
      class:unknown={chip.state === 'unknown'}
      href="/monitoring"
      title={chip.title}
      aria-label={chip.title}
    >
      {chip.label}
    </a>
  {/if}

  <span class="status-right">
    FKS Terminal · SvelteKit
  </span>

  <form method="POST" action="/logout" class="logout-form">
    <button type="submit" class="logout-btn" title="Sign out of FKS Terminal">
      <span aria-hidden="true">⏻</span>
      <span class="logout-label">logout</span>
    </button>
  </form>
</footer>

<style>
  .statusbar {
    /* Grow by the bottom safe-area inset so the logout button clears the iOS
       home indicator; --bg1 fills the indicator zone. env() is 0 on desktop. */
    height: calc(var(--status-h) + env(safe-area-inset-bottom, 0px));
    padding-bottom: env(safe-area-inset-bottom, 0px);
    background: var(--bg1);
    border-top: 1px solid var(--b1);
    display: flex;
    align-items: center;
    padding-left: 12px;
    padding-right: 12px;
    gap: 16px;
    font-size: 10px;
    color: var(--t3);
    flex-shrink: 0;
  }

  .status-item {
    display: flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }

  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    flex-shrink: 0;
    transition: background 0.4s ease;
  }

  /* Subtle breathing animation when service is healthy */
  .dot-pulse {
    animation: breathe 3s ease-in-out infinite;
  }

  @keyframes breathe {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.55; }
  }

  .health-val {
    font-size: 9px;
    color: var(--t3);
    opacity: 0.7;
  }

  .alert-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 9px;
    font-weight: 600;
    line-height: 1;
    padding: 2px 6px;
    border-radius: var(--r);
    text-decoration: none;
    white-space: nowrap;
    border: 1px solid transparent;
    transition: filter 0.15s ease;
  }
  .alert-chip:hover { filter: brightness(1.15); }
  .alert-chip.critical {
    color: var(--red);
    background: var(--red-dim, rgba(220, 60, 60, 0.12));
    border-color: var(--red-brd, rgba(220, 60, 60, 0.4));
  }
  .alert-chip.warning {
    color: var(--amber);
    background: var(--amber-dim, rgba(200, 150, 0, 0.1));
    border-color: var(--amber-brd, rgba(200, 150, 0, 0.35));
  }
  /* Honest grey. "We cannot see the alert feed" is not an alarm and must not
     compete with a real one — but it must not be invisible either, which is
     what it was before R3. */
  .alert-chip.unknown {
    color: var(--t3);
    background: transparent;
    border-color: var(--b1);
    font-weight: 500;
  }

  .status-right {
    margin-left: auto;
    color: var(--t3);
  }

  .logout-form {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .logout-btn {
    display: flex;
    align-items: center;
    gap: 3px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r);
    color: var(--t3);
    font-family: inherit;
    font-size: 9px;
    padding: 1px 5px;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
    white-space: nowrap;
    line-height: 1;
    height: 16px;
  }

  .logout-btn:hover {
    color: var(--red);
    border-color: var(--red-brd);
    background: var(--red-dim);
  }

  .logout-label {
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  /* The aggregate is desktop-hidden; the phone layout below swaps them. */
  .status-agg {
    display: none;
  }

  /* ── Phone frame ───────────────────────────────────────────────────────────
     Without this breakpoint the bar had NO responsive rule at all: three
     health items plus "FKS Terminal · SvelteKit" overflowed a 375px viewport
     and pushed logout — the only sign-out control in the app — off-screen.
     Mirrors the proven Strip fallback (Strip.svelte:175-193). */
  @media (max-width: 640px) {
    .status-agg {
      display: inline-flex;
    }
    /* The three per-service items collapse into .status-agg above. */
    .status-item:not(.status-agg) {
      display: none;
    }
    /* Frees the row for the alert chip + logout. */
    .status-right {
      display: none;
    }
    .logout-form {
      margin-left: auto;
    }
  }

  /* Touch targets. The logout button is 16px tall — well under the 44px
     minimum — and is the one control a phone user genuinely needs to hit.
     The bar itself is only --status-h (24px), so it has to grow to hold a
     real target. Safe: the shell sizes the workspace with `flex:1;
     min-height:0` (+layout.svelte), so it simply yields the extra pixels,
     and --status-h has no other consumer in the tree. */
  @media (pointer: coarse) {
    .statusbar {
      height: auto;
      min-height: calc(44px + env(safe-area-inset-bottom, 0px));
    }
    .logout-btn {
      height: 44px;
      min-width: 44px;
      padding: 0 10px;
      font-size: 11px;
    }
    .alert-chip {
      min-height: 44px;
      display: inline-flex;
      align-items: center;
    }
  }
</style>
