import { describe, expect, it } from 'vitest';
import { toEpochMs, freshnessState, formatAge, shouldWarn } from './freshness';

// Real values from the platform, so the unit hazard is tested against what the
// services actually publish rather than invented numbers.
const BOT_STATUS_SECONDS = 1_785_127_277; // live spot bot /status `updated`
const COCKPIT_MS = 1_785_127_277_000; // cockpit `generated_at`

describe('toEpochMs — the 1000x hazard', () => {
  it('auto-detects seconds vs milliseconds', () => {
    expect(toEpochMs(BOT_STATUS_SECONDS)).toBe(COCKPIT_MS);
    expect(toEpochMs(COCKPIT_MS)).toBe(COCKPIT_MS);
  });

  it('honours an explicit unit', () => {
    expect(toEpochMs(BOT_STATUS_SECONDS, 's')).toBe(COCKPIT_MS);
    expect(toEpochMs(COCKPIT_MS, 'ms')).toBe(COCKPIT_MS);
  });

  it('treats an unusable stamp as unverifiable, never as old', () => {
    // The critical case: null must NOT become epoch 0 and render as "56y ago".
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs(undefined)).toBeNull();
    expect(toEpochMs(0)).toBeNull();
    expect(toEpochMs(-5)).toBeNull();
    expect(toEpochMs(Number.NaN)).toBeNull();
    expect(toEpochMs(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('freshnessState', () => {
  const now = COCKPIT_MS;

  it('is fresh inside the window and stale past it', () => {
    expect(freshnessState(now - 10_000, now, 60_000)).toBe('fresh');
    expect(freshnessState(now - 60_000, now, 60_000)).toBe('fresh'); // boundary
    expect(freshnessState(now - 60_001, now, 60_000)).toBe('stale');
  });

  it('reports unknown — not stale — when there is no stamp', () => {
    expect(freshnessState(null, now, 60_000)).toBe('unknown');
  });

  it('treats clock skew into the future as fresh', () => {
    // A bot clock running ahead must not make live data look stale.
    expect(freshnessState(now + 30_000, now, 60_000)).toBe('fresh');
  });

  it('flags the 2026-07-22 blackout shape', () => {
    // 65 minutes without a refresh, against a 15-minute tolerance.
    expect(freshnessState(now - 65 * 60_000, now, 15 * 60_000)).toBe('stale');
  });
});

describe('formatAge', () => {
  it('scales units and never goes negative', () => {
    expect(formatAge(0)).toBe('0s');
    expect(formatAge(-5_000)).toBe('0s'); // skew clamps to zero
    expect(formatAge(12_000)).toBe('12s');
    expect(formatAge(5 * 60_000)).toBe('5m');
    expect(formatAge(3 * 3_600_000)).toBe('3h');
    expect(formatAge(3 * 86_400_000)).toBe('3d');
  });
});

describe('shouldWarn — flap resistance', () => {
  it('does not warn on a single transient error', () => {
    // A banner that cries wolf on one 5s-poll blip trains the operator to
    // ignore it, which is worse than no banner.
    expect(shouldWarn('fresh', 1)).toBe(false);
  });

  it('warns once errors persist', () => {
    expect(shouldWarn('fresh', 2)).toBe(true);
  });

  it('warns on staleness regardless of error count', () => {
    // Genuinely old data is old even if the last request succeeded.
    expect(shouldWarn('stale', 0)).toBe(true);
  });

  it('does not warn merely because a stamp is unknown', () => {
    expect(shouldWarn('unknown', 0)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds pinned to the MEASURED cadence, so a future edit that changes one
// without re-measuring trips a test instead of quietly crying wolf.
//
// Measurement (2026-07-28): the live spot bot sampled every 15s for 20 minutes
// yielded 12 per-venue refresh intervals across three venues — all 299-301s.
// True period = 300s. UI threshold = 3x = 900s, matching BotVenueStale (>900s).
// ─────────────────────────────────────────────────────────────────────────────
describe('measured venue cadence', () => {
  const PERIOD_MS = 300_000;
  const VENUE_STALE_AFTER_MS = 900_000;
  const now = 1_785_300_000_000;

  it('a venue refreshing on its normal 300s cycle never reads stale', () => {
    // Worst case within a healthy cycle: just before the next refresh lands.
    expect(freshnessState(now - PERIOD_MS, now, VENUE_STALE_AFTER_MS)).toBe('fresh');
    // Two missed cycles is still tolerated — jitter, not failure.
    expect(freshnessState(now - 2 * PERIOD_MS, now, VENUE_STALE_AFTER_MS)).toBe('fresh');
  });

  it('three missed cycles reads stale', () => {
    expect(freshnessState(now - 3 * PERIOD_MS - 1, now, VENUE_STALE_AFTER_MS)).toBe('stale');
  });

  it('the old 90s estimate would have cried wolf every single cycle', () => {
    // Guards the mistake this measurement corrected: a threshold derived from
    // the sampler's tick spacing rather than the venue's refresh period would
    // flag a perfectly healthy venue on every normal cycle.
    const WRONG = 3 * 95_000;
    expect(freshnessState(now - PERIOD_MS, now, WRONG)).toBe('stale');
  });

  it('the funding bot would be permanently stale under ANY of these', () => {
    // Which is why its venue is gated out of per-venue wiring entirely: it
    // marks on trade events, so 15h idle is correct, not broken.
    const FUNDING_IDLE_MS = 15 * 3_600_000;
    expect(freshnessState(now - FUNDING_IDLE_MS, now, VENUE_STALE_AFTER_MS)).toBe('stale');
  });
});
