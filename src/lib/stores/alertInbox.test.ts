/**
 * R3 — "a dead pager reads as a quiet one" regression suite.
 *
 * Every case below encodes ONE thing an operator would otherwise be told
 * falsely: that there is nothing to acknowledge. The chip is the only alert
 * surface on 18 of the 20 routes, so `null` (hidden) is a positive claim of
 * all-quiet and has to be earned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get as readStore } from "svelte/store";
import { api } from "$api/client";
import type { AlertInbox, InboxAlert } from "$lib/types/alertInbox";
import {
  ALERT_AGE_BANNER_MS,
  ALERT_AGE_LABEL_MS,
  CHIP_STALE_AFTER_MS,
  NO_PROM_DOWN,
  PROM_DOWN_THRESHOLD,
  describeChip,
  foldPromDown,
  oldestUnackedAlert,
  unackedCount,
  type ChipInputs,
} from "./alertInbox";

vi.mock("$api/client", () => ({ api: { get: vi.fn() } }));

const NOW = 1_800_000_000_000;

function alert(
  severity: string,
  acked = false,
  ageMs = 60_000,
  alertname = "X",
): InboxAlert {
  return {
    key: `k-${severity}-${acked}-${ageMs}`,
    labels: { alertname, severity },
    activeAt: new Date(NOW - ageMs).toISOString(),
    age_str: "1m",
    state: "firing",
    severity_color: "",
    acked: acked ? { by: "op", at: "now", note: "" } : null,
  };
}

function inbox(over: Partial<AlertInbox> = {}): AlertInbox {
  return {
    configured: true,
    prom_available: true,
    alerts: [],
    unacked_count: 0,
    ...over,
  };
}

/** Steady state: fetched a moment ago, Prometheus healthy. */
function chip(over: Partial<ChipInputs> = {}) {
  return describeChip({
    inbox: inbox(),
    updatedAt: NOW - 1_000,
    since: NOW - 1_000,
    promDownStreak: 0,
    nowMs: NOW,
    ...over,
  });
}

describe("describeChip — the honest-quiet baseline", () => {
  it("hides only when a recent, successful poll said there is nothing unacked", () => {
    expect(chip()).toEqual({ state: null, label: "", title: "", banner: null });
  });

  it("counts unacked alerts, red when any is critical", () => {
    const v = chip({
      inbox: inbox({ unacked_count: 2, alerts: [alert("warning"), alert("critical")] }),
    });
    expect(v.state).toBe("critical");
    expect(v.label).toBe("⚠ 2 unacked");
  });

  it("is amber when nothing unacked is critical", () => {
    const v = chip({
      inbox: inbox({ unacked_count: 1, alerts: [alert("warning")] }),
    });
    expect(v.state).toBe("warning");
  });

  it("ignores the severity of an ALREADY-ACKED critical", () => {
    const v = chip({
      inbox: inbox({ unacked_count: 1, alerts: [alert("critical", true), alert("warning")] }),
    });
    expect(v.state).toBe("warning");
  });
});

/**
 * §2.3 — age escalation. Calibration reference: the 2026-08-14 treasury
 * blackout alert fired correctly, delivered to Discord correctly, and sat
 * unacknowledged for 43 hours because the chip rendered a 3-minute-old alert
 * identically to a 3-day-old one. These pin the fix: the chip must read
 * differently as an unacked alert ages, and a persistent shell banner must
 * appear well before 43h — not exactly at it.
 */
describe("describeChip — age escalation (the 43h-unacked incident)", () => {
  it("stays plain (no age suffix, no banner) below the label threshold", () => {
    const v = chip({
      inbox: inbox({
        unacked_count: 1,
        alerts: [alert("warning", false, ALERT_AGE_LABEL_MS - 1_000)],
      }),
    });
    expect(v.label).toBe("⚠ 1 unacked");
    expect(v.state).toBe("warning");
    expect(v.banner).toBeNull();
  });

  it("shows the age inline once past the label threshold, still no banner", () => {
    const v = chip({
      inbox: inbox({
        unacked_count: 1,
        alerts: [alert("critical", false, ALERT_AGE_LABEL_MS + 60_000)],
      }),
    });
    expect(v.label).toMatch(/⚠ 1 unacked · .+ unacked/);
    // Still 'critical', not 'overdue' — the banner threshold is separate and
    // higher, by design (a fourth, more urgent tier, not the same one).
    expect(v.state).toBe("critical");
    expect(v.banner).toBeNull();
  });

  it("escalates to 'overdue' and raises the banner past the banner threshold", () => {
    const v = chip({
      inbox: inbox({
        unacked_count: 1,
        alerts: [alert("critical", false, ALERT_AGE_BANNER_MS + 3_600_000, "BotAllVenuesStale")],
      }),
    });
    expect(v.state).toBe("overdue");
    expect(v.banner).not.toBeNull();
    expect(v.banner?.text).toMatch(/^BotAllVenuesStale unacked for /);
    expect(v.banner?.href).toBe("/monitoring");
    expect(v.banner?.severity).toBe("critical");
  });

  it("names the OLDEST unacked alert in the banner, not just any overdue one", () => {
    const v = chip({
      inbox: inbox({
        unacked_count: 2,
        alerts: [
          alert("warning", false, ALERT_AGE_BANNER_MS + 60_000, "Newer"),
          alert("critical", false, ALERT_AGE_BANNER_MS + 7_200_000, "Oldest"),
        ],
      }),
    });
    expect(v.banner?.text).toMatch(/^Oldest unacked for /);
  });

  it("banner severity follows the OLDEST alert's own severity, even if it is only 'warning'", () => {
    const v = chip({
      inbox: inbox({
        unacked_count: 1,
        alerts: [alert("warning", false, ALERT_AGE_BANNER_MS + 1_000, "SlowLeak")],
      }),
    });
    expect(v.state).toBe("overdue");
    expect(v.banner?.severity).toBe("warning");
  });

  it("excludes ACKED alerts from the age computation entirely", () => {
    // An old critical alert that has already been acked must not drive the
    // banner — acking is the mechanism that is supposed to silence this.
    const v = chip({
      inbox: inbox({
        unacked_count: 1,
        alerts: [
          alert("critical", true, ALERT_AGE_BANNER_MS + 1_000_000, "OldButAcked"),
          alert("warning", false, 30_000, "FreshOne"),
        ],
      }),
    });
    expect(v.state).toBe("warning");
    expect(v.banner).toBeNull();
  });

  it("a re-fired alert (new activeAt) is young again, even under the same alertname as an old acked one", () => {
    // Mirrors alertAck/logic.test.ts's "RE-FIRE = new activeAt": a resolved
    // alert that fires again gets a NEW activeAt/key, so the OLD (acked)
    // instance and the NEW (unacked) instance coexist here exactly as the
    // real inbox payload would shape them. This function must not need to
    // know that re-fire rule to respect it — it only ever reads each row's
    // own `activeAt`, never a cached "have I seen this alertname" notion.
    const v = chip({
      inbox: inbox({
        unacked_count: 1,
        alerts: [
          alert("critical", true, ALERT_AGE_BANNER_MS + 1_000_000, "BotAllVenuesStale"), // old, acked, resolved
          alert("critical", false, 5_000, "BotAllVenuesStale"), // re-fired moments ago
        ],
      }),
    });
    expect(v.state).toBe("critical"); // not 'overdue' — the re-fired instance is seconds old
    expect(v.banner).toBeNull();
  });

  it("unparseable activeAt is excluded, never treated as age-zero/fresh", () => {
    const bad: InboxAlert = {
      ...alert("critical"),
      activeAt: "not-a-real-timestamp",
    };
    // A second, genuinely fresh alert keeps unacked_count > 0 so branch 1 is
    // reached; the malformed one must simply not participate in the max.
    const v = chip({
      inbox: inbox({ unacked_count: 2, alerts: [bad, alert("warning", false, 10_000)] }),
    });
    expect(v.label).toBe("⚠ 2 unacked"); // no age suffix — nothing verifiable
    expect(v.banner).toBeNull();
  });

  it("unparseable activeAt on the ONLY unacked alert never fabricates a banner", () => {
    const bad: InboxAlert = {
      ...alert("critical"),
      activeAt: "",
    };
    const v = chip({ inbox: inbox({ unacked_count: 1, alerts: [bad] }) });
    expect(v.state).toBe("critical"); // severity still counted — just no age claim
    expect(v.label).toBe("⚠ 1 unacked");
    expect(v.banner).toBeNull();
  });
});

describe("oldestUnackedAlert", () => {
  it("returns null when every alert is acked or absent", () => {
    expect(oldestUnackedAlert([], NOW)).toBeNull();
    expect(oldestUnackedAlert([alert("critical", true)], NOW)).toBeNull();
  });

  it("picks the largest age among unacked alerts with a valid activeAt", () => {
    const best = oldestUnackedAlert(
      [alert("warning", false, 10_000), alert("critical", false, 500_000)],
      NOW,
    );
    expect(best?.ageMs).toBe(500_000);
    expect(best?.alert.labels.severity).toBe("critical");
  });

  it("clamps a future activeAt (clock skew) to age 0, never negative", () => {
    const skewed: InboxAlert = { ...alert("warning"), activeAt: new Date(NOW + 60_000).toISOString() };
    const best = oldestUnackedAlert([skewed], NOW);
    expect(best?.ageMs).toBe(0);
  });
});

describe("describeChip — Prometheus unreachable is NOT all-quiet", () => {
  it("goes grey-unknown, not hidden, once prom_available:false has persisted", () => {
    const v = chip({
      inbox: inbox({ prom_available: false }),
      promDownStreak: PROM_DOWN_THRESHOLD,
    });
    expect(v.state).toBe("unknown");
    expect(v.label).toBe("alerts ?");
    expect(v.title).toMatch(/Prometheus is unreachable/);
  });

  it("says out-of-band paging is probably down too — the operator cannot fall back on it", () => {
    const v = chip({
      inbox: inbox({ prom_available: false }),
      promDownStreak: PROM_DOWN_THRESHOLD,
    });
    expect(v.title).toMatch(/Alertmanager/);
  });

  it("does NOT flap grey on a single blip (the 8s upstream timeout)", () => {
    const v = chip({ inbox: inbox({ prom_available: false }), promDownStreak: 1 });
    expect(v.state).toBeNull();
  });
});

describe("describeChip — an unreachable ack store must not fake a quiet pager", () => {
  it("shows the real count when Prometheus is up and the ack ledger is down", () => {
    // The old store zeroed this branch: alerts firing, no outage at all, and
    // the chip claimed all-quiet on every page.
    const v = chip({
      inbox: inbox({
        configured: false,
        unacked_count: 3,
        alerts: [alert("critical"), alert("warning"), alert("warning")],
      }),
    });
    expect(v.state).toBe("critical");
    expect(v.label).toBe("⚠ 3 unacked");
    expect(v.title).toMatch(/cannot be acknowledged here/);
  });

  it("goes grey-unknown when nothing is firing but acks cannot be verified", () => {
    const v = chip({ inbox: inbox({ configured: false }) });
    expect(v.state).toBe("unknown");
    expect(v.title).toMatch(/acknowledgement store is unavailable/);
  });
});

describe("describeChip — our own poll dying is the same lie", () => {
  it("goes grey once no fetch has SUCCEEDED past the threshold", () => {
    // Last payload was a healthy all-quiet; it is now 3 missed ticks old, so
    // the adapter/network is gone and that payload proves nothing.
    const v = chip({ updatedAt: NOW - CHIP_STALE_AFTER_MS - 1_000, nowMs: NOW });
    expect(v.state).toBe("unknown");
    expect(v.title).toMatch(/no successful inbox poll for/);
  });

  it("keeps the last known count visible while the gap is still within tolerance", () => {
    const v = chip({
      inbox: inbox({ unacked_count: 1, alerts: [alert("warning")] }),
      updatedAt: NOW - (CHIP_STALE_AFTER_MS - 1_000),
    });
    expect(v.state).toBe("warning");
  });

  it("does not flash grey during the first moments after mount", () => {
    const v = chip({ inbox: null, updatedAt: null, since: NOW - 200 });
    expect(v.state).toBeNull();
  });

  it("admits it never got an answer once mount + threshold has elapsed", () => {
    const v = chip({
      inbox: null,
      updatedAt: null,
      since: NOW - CHIP_STALE_AFTER_MS - 1,
    });
    expect(v.state).toBe("unknown");
    expect(v.title).toMatch(/never succeeded/);
  });

  it("is unknown, not hidden, when there is no reference point at all", () => {
    const v = chip({ inbox: null, updatedAt: null, since: null });
    expect(v.state).toBe("unknown");
  });
});

describe("foldPromDown", () => {
  it("counts consecutive prom-down polls", () => {
    let t = NO_PROM_DOWN;
    t = foldPromDown(t, inbox({ prom_available: false }), 1);
    expect(t.streak).toBe(1);
    t = foldPromDown(t, inbox({ prom_available: false }), 2);
    expect(t.streak).toBe(2);
  });

  it("resets the moment Prometheus answers again", () => {
    let t = foldPromDown(NO_PROM_DOWN, inbox({ prom_available: false }), 1);
    t = foldPromDown(t, inbox({ prom_available: true }), 2);
    expect(t.streak).toBe(0);
  });

  it("is idempotent for one poll — a derived replay must not double-count", () => {
    let t = foldPromDown(NO_PROM_DOWN, inbox({ prom_available: false }), 7);
    t = foldPromDown(t, inbox({ prom_available: false }), 7);
    t = foldPromDown(t, inbox({ prom_available: false }), 7);
    expect(t.streak).toBe(1);
  });

  it("ignores emissions with no successful fetch behind them", () => {
    const t = foldPromDown(NO_PROM_DOWN, null, null);
    expect(t).toBe(NO_PROM_DOWN);
    expect(foldPromDown(NO_PROM_DOWN, inbox(), null)).toBe(NO_PROM_DOWN);
  });
});

describe("unackedCount", () => {
  it("is zero before the first fetch (nothing has been counted yet)", () => {
    expect(readStore(unackedCount)).toBe(0);
  });
});

// ── End-to-end store wiring ────────────────────────────────────────────────
// The pure rules above are worthless if the streak never reaches the chip, so
// these drive the real poll → store → describeChip path.
describe("promDownStreak wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("reports real firing alerts even when the ack ledger is unreachable", async () => {
    vi.resetModules();
    const mod = await import("./alertInbox");
    const apiGet = vi.mocked(api.get);
    apiGet.mockReset();
    apiGet.mockResolvedValue(
      inbox({ configured: false, unacked_count: 4, alerts: [alert("critical")] }),
    );

    mod.alertInbox.start();
    await vi.advanceTimersByTimeAsync(0);
    // Prometheus is UP and four alerts are firing; the ack table merely being
    // absent must not zero the count on the app-wide chip.
    expect(readStore(mod.unackedCount)).toBe(4);
    mod.alertInbox.stop();
  });

  it("turns two real prom-down poll responses into a grey chip", async () => {
    vi.resetModules();
    const mod = await import("./alertInbox");
    const apiGet = vi.mocked(api.get);
    apiGet.mockReset();
    apiGet.mockResolvedValue(inbox({ prom_available: false }));

    const seen: number[] = [];
    const unsub = mod.promDownStreak.subscribe((n) => seen.push(n));

    mod.alertInbox.start();
    await vi.advanceTimersByTimeAsync(0); // immediate fetch
    expect(readStore(mod.promDownStreak)).toBe(1);
    expect(
      mod.describeChip({
        inbox: readStore(mod.alertInbox),
        updatedAt: readStore(mod.alertInbox.updatedAt),
        since: null,
        promDownStreak: readStore(mod.promDownStreak),
        nowMs: Date.now(),
      }).state,
    ).toBeNull(); // debounced

    await vi.advanceTimersByTimeAsync(30_000); // second tick
    expect(readStore(mod.promDownStreak)).toBe(2);
    expect(
      mod.describeChip({
        inbox: readStore(mod.alertInbox),
        updatedAt: readStore(mod.alertInbox.updatedAt),
        since: null,
        promDownStreak: readStore(mod.promDownStreak),
        nowMs: Date.now(),
      }).state,
    ).toBe("unknown");

    mod.alertInbox.stop();
    unsub();
  });
});
