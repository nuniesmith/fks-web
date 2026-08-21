/**
 * Shared alert-inbox poll (M3 Phase B). ONE poll on `/api/alerts/inbox` at 30s
 * (matches today's alert cadence) fanned out to every consumer — the
 * /monitoring inbox, the StatusBar chip, and the cockpit armed-alerts panel.
 * `createPoll` already dedupes by (url, interval), so importing this singleton
 * everywhere costs the backend 1× traffic, not N×.
 *
 * The StatusBar (always mounted in the shell) keeps the poll warm app-wide, so
 * the badge reflects unacked state on every page; individual pages also
 * `start()`/`stop()` it and call `alertInbox.refresh()` right after an ack so
 * both surfaces update without waiting for the next tick.
 *
 * ## R3 — a dead pager must not read as a quiet one
 *
 * The chip used to be a two-state affair: a count, or nothing. "Nothing" was
 * returned for FOUR different situations — genuinely zero unacked, Prometheus
 * unreachable, the ack store unreachable, and "we have not fetched anything
 * yet" — so on every page except /monitoring and /cockpit an outage was
 * pixel-identical to all-quiet. Prometheus being down also means Alertmanager
 * is receiving nothing, i.e. out-of-band paging is dead at the same moment,
 * which is exactly when the operator most needs the UI to admit it cannot see.
 *
 * So there is now a third state, `'unknown'`, rendered GREY — the same
 * distinction `Freshness.svelte` already makes (unknown = grey "we cannot
 * tell", stale = amber "this is old"). `null` now means one thing only: we
 * looked, recently and successfully, and there is nothing unacknowledged.
 */
import { derived, type Readable } from "svelte/store";
import { createPoll } from "$lib/stores/poll";
import { formatAge, freshnessState, toEpochMs } from "$lib/utils/freshness";
import type { AlertInbox, InboxAlert } from "$lib/types/alertInbox";

export const alertInbox = createPoll<AlertInbox>("/api/alerts/inbox", 30_000);

/**
 * Firing alerts with no ack.
 *
 * Only `prom_available` gates this, NOT `configured`: when the ack store is
 * down `reshapeAlerts` joins an empty ack map, so every firing alert comes back
 * `acked:null` and `unacked_count` is the true count of alerts nobody has
 * acknowledged. Zeroing it there (the old behaviour) reported "all quiet"
 * during a live alert storm with no outage at all.
 */
export const unackedCount: Readable<number> = derived(alertInbox, ($i) =>
  $i && $i.prom_available ? $i.unacked_count : 0,
);

export type ChipState = "critical" | "warning" | "overdue" | "unknown" | null;

/**
 * How long an unacked alert may sit before the chip starts showing its own
 * age inline (e.g. "⚠ 1 unacked · 1h12m unacked"), on top of the plain
 * count. Below this, "just fired" and "fired a few minutes ago" render
 * identically on purpose: the bare count is enough context for a fresh
 * alert, and re-labeling the chip within its first minutes would just
 * duplicate the per-row `age_str` already visible in the full inbox.
 */
export const ALERT_AGE_LABEL_MS = 60 * 60 * 1000; // 1h

/**
 * How long an unacked alert may sit before the chip escalates to the
 * dedicated `overdue` tier AND the shell renders a persistent banner
 * (`+layout.svelte`) naming it — one that survives navigation, unlike the
 * chip.
 *
 * Calibration: on 2026-08-14 a treasury blackout alert fired correctly,
 * delivered to Discord correctly, and then sat unacknowledged for **43
 * hours** before anyone looked — the chip's flat "⚠ 1 unacked" (identical at
 * 3 minutes or 3 days) is the UI half of exactly that failure. 6h gives
 * roughly a 7x safety margin against that reference incident — this design
 * would have raised the banner ~37h before the alert was actually found —
 * while staying long enough that a solo operator's normal overnight gap
 * does not greet them with a false alarm the moment they wake up.
 */
export const ALERT_AGE_BANNER_MS = 6 * 60 * 60 * 1000; // 6h

/** What the persistent shell banner (`+layout.svelte`) should say. */
export interface ChipBanner {
  /** e.g. "BotAllVenuesStale unacked for 2d 4h". */
  text: string;
  /** Where the banner should send the operator. */
  href: string;
  /** Severity of the named alert — drives the banner's colour; never invented. */
  severity: "critical" | "warning";
}

/**
 * The oldest currently-unacked alert, by `activeAt`.
 *
 * `activeAt` — never `updatedAt` — is the only honest source of "how long has
 * this actually been firing": a re-fired alert gets a NEW `activeAt`
 * (`src/lib/server/alertAck/logic.test.ts` "RE-FIRE = new activeAt"), so age
 * correctly resets on re-fire without this function needing to know that
 * rule to respect it.
 *
 * A missing or unparseable `activeAt` is EXCLUDED from the search rather than
 * treated as `age = 0` — the latter would silently render the honest-unknown
 * case as the single most reassuring claim available ("just fired"). Excluded
 * alerts simply do not drive escalation; they do not fabricate freshness
 * either.
 */
export function oldestUnackedAlert(
  alerts: InboxAlert[],
  nowMs: number,
): { alert: InboxAlert; ageMs: number } | null {
  let best: { alert: InboxAlert; ageMs: number } | null = null;
  for (const a of alerts) {
    if (a.acked) continue;
    const activeMs = Date.parse(a.activeAt);
    if (!Number.isFinite(activeMs)) continue;
    // Clock-skew floor, same convention as `formatAge`'s own Math.max(0, …).
    const ageMs = Math.max(0, nowMs - activeMs);
    if (best == null || ageMs > best.ageMs) best = { alert: a, ageMs };
  }
  return best;
}

/**
 * How long the inbox poll may go without a SUCCESS before the chip admits it
 * cannot see. Three missed 30s ticks — long enough that one slow response is
 * not an outage, short enough that a dead adapter shows up within ~1.5 min.
 */
export const CHIP_STALE_AFTER_MS = 90_000;

/**
 * Consecutive `prom_available:false` responses before the chip goes grey.
 *
 * `alertInboxGet` gives Prometheus an 8s timeout and reports `false` when it
 * expires, so a single slow scrape trips it. Requiring two in a row means a
 * transient blip never flaps grey chrome onto every page; a real outage still
 * surfaces on the second tick.
 */
export const PROM_DOWN_THRESHOLD = 2;

/** Accumulator for the `prom_available:false` debounce. */
export interface PromDownTracker {
  /** Consecutive polls that reported Prometheus unreachable. */
  streak: number;
  /** `updatedAt` of the last poll folded in — makes the fold idempotent. */
  lastSeenAt: number | null;
}

export const NO_PROM_DOWN: PromDownTracker = { streak: 0, lastSeenAt: null };

/**
 * Fold one inbox observation into the debounce accumulator.
 *
 * Keyed on `updatedAt` (which advances on SUCCESS only) rather than on store
 * emissions: a Svelte `derived` re-runs whenever any of its sources changes and
 * replays its current value to a late subscriber, so counting emissions would
 * double-count a single poll. Folding the same `updatedAt` twice is a no-op.
 */
export function foldPromDown(
  prev: PromDownTracker,
  inbox: AlertInbox | null,
  updatedAt: number | null,
): PromDownTracker {
  if (inbox == null || updatedAt == null) return prev;
  if (updatedAt === prev.lastSeenAt) return prev;
  return {
    lastSeenAt: updatedAt,
    streak: inbox.prom_available ? 0 : prev.streak + 1,
  };
}

const inboxUpdatedAt = alertInbox.updatedAt;

let promTracker: PromDownTracker = NO_PROM_DOWN;

/** Consecutive `prom_available:false` polls — feeds `describeChip`. */
export const promDownStreak: Readable<number> = derived(
  [alertInbox, inboxUpdatedAt],
  ([$inbox, $updatedAt]) => {
    promTracker = foldPromDown(promTracker, $inbox, $updatedAt);
    return promTracker.streak;
  },
);

export interface ChipInputs {
  inbox: AlertInbox | null;
  /** `poll.updatedAt` — epoch-ms of the last SUCCESSFUL inbox fetch. */
  updatedAt: number | null;
  /**
   * Reference point used while `updatedAt` is still null (the consumer's mount
   * time). Without it the chip would flash grey for the few hundred ms before
   * the first fetch lands, and "we have been trying for two minutes with
   * nothing to show" would be indistinguishable from "we started 200ms ago".
   */
  since: number | null;
  promDownStreak: number;
  nowMs: number;
  staleAfterMs?: number;
  promDownThreshold?: number;
}

export interface ChipView {
  state: ChipState;
  /** Chip text; `''` when hidden. */
  label: string;
  /** Tooltip + accessible name; `''` when hidden. */
  title: string;
  /**
   * Non-null only when an unacked alert has aged past `ALERT_AGE_BANNER_MS` —
   * the shell (`+layout.svelte`) renders this as a persistent banner that
   * survives navigation. `null` in every other state, including `unknown`:
   * a poll/Prometheus outage means we cannot even verify the age, so it must
   * not be asserted.
   */
  banner: ChipBanner | null;
}

const HIDDEN: ChipView = { state: null, label: "", title: "", banner: null };

/**
 * The StatusBar chip, as a pure function of what we know and when we last knew
 * it. Kept out of the component so the honesty rules are unit-testable.
 *
 * Precedence is deliberate: a count we can currently VERIFY outranks every
 * unknown. Greying out a live critical-alert count because the ack ledger
 * happens to be unreachable would make a real alarm quieter — the same class of
 * bug in the opposite direction.
 */
export function describeChip(input: ChipInputs): ChipView {
  const {
    inbox,
    updatedAt,
    since,
    promDownStreak: streak,
    nowMs,
    staleAfterMs = CHIP_STALE_AFTER_MS,
    promDownThreshold = PROM_DOWN_THRESHOLD,
  } = input;

  // 1. Prometheus answered and something is unacknowledged. Deliberately NOT
  //    gated on `configured`: with the ack store down every firing alert reads
  //    unacked, which is exactly true.
  if (inbox && inbox.prom_available && inbox.unacked_count > 0) {
    const anyCritical = inbox.alerts.some(
      (a) => !a.acked && (a.labels.severity ?? "").toLowerCase() === "critical",
    );
    const n = inbox.unacked_count;

    // Age dimension (the 2026-08-14 43h-unacked incident, see
    // ALERT_AGE_BANNER_MS): the count alone renders a 3-minute-old alert
    // identically to a 3-day-old one. Deliberately scanning ALL unacked
    // alerts rather than filtering to critical/channel:money — the cockpit's
    // own armed-path filter (`cockpit/+page.svelte` isArmedAlert) is this
    // codebase's scar tissue for why a label-scoped clause silently drops
    // the exact alert it existed to catch, the moment some rule doesn't
    // stamp that label. Any sufficiently old unacked alert escalates here.
    const oldest = oldestUnackedAlert(inbox.alerts, nowMs);
    const overdue = oldest != null && oldest.ageMs >= ALERT_AGE_BANNER_MS;
    const aging = oldest != null && oldest.ageMs >= ALERT_AGE_LABEL_MS;

    return {
      state: overdue ? "overdue" : anyCritical ? "critical" : "warning",
      label: `⚠ ${n} unacked${aging ? ` · ${formatAge(oldest!.ageMs)} unacked` : ""}`,
      title:
        `${n} unacknowledged alert${n === 1 ? "" : "s"} — open the inbox` +
        (inbox.configured
          ? ""
          : " · ack store unavailable, these cannot be acknowledged here") +
        (overdue
          ? ` · oldest (${oldest!.alert.labels.alertname ?? "alert"}) has been unacked for ${formatAge(oldest!.ageMs)}`
          : ""),
      banner: overdue
        ? {
            text: `${oldest!.alert.labels.alertname ?? "alert"} unacked for ${formatAge(oldest!.ageMs)}`,
            href: "/monitoring",
            severity:
              (oldest!.alert.labels.severity ?? "").toLowerCase() === "critical"
                ? "critical"
                : "warning",
          }
        : null,
    };
  }

  // 2. Our own poll has stopped succeeding. `updatedAt` advances on success
  //    only, so this catches a dead adapter, an expired session and a phone
  //    that lost the network — none of which produce a payload to inspect.
  const lastGood = toEpochMs(updatedAt, "ms");
  const ref = lastGood ?? toEpochMs(since, "ms");
  if (freshnessState(ref, nowMs, staleAfterMs) !== "fresh") {
    const age = ref == null ? null : formatAge(nowMs - ref);
    return {
      state: "unknown",
      label: "alerts ?",
      title:
        lastGood == null
          ? `alert feed unavailable — the inbox poll has never succeeded${age ? ` (${age} of trying)` : ""}, so unacknowledged alerts cannot be counted`
          : `alert feed unavailable — no successful inbox poll for ${age}, so unacknowledged alerts cannot be counted`,
      // Our own poll is dead, so we cannot even verify whether the LAST
      // known unacked alert is still unacked, let alone how old it is —
      // asserting a banner here would be the exact "unknown rendered as a
      // claim" bug this branch exists to prevent.
      banner: null,
    };
  }

  // 3. Prometheus unreachable, debounced.
  if (streak >= promDownThreshold) {
    return {
      state: "unknown",
      label: "alerts ?",
      title:
        "alert feed unavailable — Prometheus is unreachable, so firing alerts cannot be counted (Alertmanager paging is likely down with it)",
      banner: null,
    };
  }

  // 4. Prometheus is fine and nothing is firing, but the ack ledger is not
  //    reachable, so "nothing outstanding" is not a claim we can stand behind.
  if (inbox && !inbox.configured) {
    return {
      state: "unknown",
      label: "alerts ?",
      title:
        'alert feed degraded — the acknowledgement store is unavailable, so "no unacknowledged alerts" cannot be verified',
      banner: null,
    };
  }

  // 5. We looked, recently and successfully: genuinely quiet.
  return HIDDEN;
}
