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
  CHIP_STALE_AFTER_MS,
  NO_PROM_DOWN,
  PROM_DOWN_THRESHOLD,
  describeChip,
  foldPromDown,
  unackedCount,
  type ChipInputs,
} from "./alertInbox";

vi.mock("$api/client", () => ({ api: { get: vi.fn() } }));

const NOW = 1_800_000_000_000;

function alert(severity: string, acked = false): InboxAlert {
  return {
    key: `k-${severity}-${acked}`,
    labels: { alertname: "X", severity },
    activeAt: new Date(NOW - 60_000).toISOString(),
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
    expect(chip()).toEqual({ state: null, label: "", title: "" });
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
