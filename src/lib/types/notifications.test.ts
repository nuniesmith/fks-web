import { describe, expect, it } from "vitest";
import {
  ALWAYS_DELIVERED_EVENT_IDS,
  KNOWN_EVENT_IDS,
  NOTIFY_EVENT_KINDS,
  coerceNotificationHistory,
  isKnownEventKind,
  kindBadgeVariant,
  outcomeIsOk,
  validateNotificationEvents,
} from "./notifications";

describe("notification wire contract", () => {
  it("enumerates EXACTLY the spawner's ALL_EVENT_KINDS (notifications.rs), in order", () => {
    expect(NOTIFY_EVENT_KINDS.map((e) => e.id)).toEqual([
      "bot_spawned",
      "bot_stopped",
      "bot_removed",
      "bot_error",
      "bot_crashed",
      "bot_restarted",
      "live_flip",
      "key_rotation",
      "net_worth_milestone",
      "risk_halt",
      "edge_decay",
    ]);
  });

  it("marks the spawner's ALWAYS_DELIVERED_KINDS (crash/restart/live_flip/risk_halt)", () => {
    // Order follows NOTIFY_EVENT_KINDS (emission-priority), which is how the
    // filtered derive produces the list.
    expect(ALWAYS_DELIVERED_EVENT_IDS).toEqual([
      "bot_crashed",
      "bot_restarted",
      "live_flip",
      "risk_halt",
    ]);
  });

  it("still rejects the legacy ids the old UI stored (the scoping bug)", () => {
    // `live_flip` is NO LONGER legacy — it is now a real wire kind — so it is
    // deliberately absent from this list.
    for (const legacy of ["spawn", "stop", "pnl_digest", "error"]) {
      expect(isKnownEventKind(legacy)).toBe(false);
      expect(KNOWN_EVENT_IDS.has(legacy)).toBe(false);
    }
  });

  it("accepts every new Phase-C/D kind as known", () => {
    for (const id of [
      "bot_restarted",
      "live_flip",
      "key_rotation",
      "net_worth_milestone",
      "risk_halt",
      "edge_decay",
    ]) {
      expect(isKnownEventKind(id)).toBe(true);
    }
  });
});

describe("validateNotificationEvents", () => {
  it("accepts known kinds, trimming + de-duping + dropping empties", () => {
    expect(validateNotificationEvents([" bot_spawned ", "bot_spawned", "", "bot_crashed"])).toEqual(
      { ok: true, events: ["bot_spawned", "bot_crashed"] },
    );
  });

  it("passes a channel scoped to a new kind (risk_halt) through validation", () => {
    // A4's adapter validation keys off NOTIFY_EVENT_KINDS, so scoping the new
    // kinds Just Works: a risk_halt-only channel is accepted verbatim.
    expect(validateNotificationEvents(["risk_halt"])).toEqual({
      ok: true,
      events: ["risk_halt"],
    });
    expect(validateNotificationEvents(["net_worth_milestone", "edge_decay"])).toEqual({
      ok: true,
      events: ["net_worth_milestone", "edge_decay"],
    });
  });

  it("treats a non-array (or absent) events field as catch-all", () => {
    expect(validateNotificationEvents(undefined)).toEqual({ ok: true, events: [] });
    expect(validateNotificationEvents(null)).toEqual({ ok: true, events: [] });
    expect(validateNotificationEvents([])).toEqual({ ok: true, events: [] });
  });

  it("400-signals the FIRST unknown id by name (typo-proof)", () => {
    expect(validateNotificationEvents(["bot_spawned", "spawn"])).toEqual({
      ok: false,
      bad: "spawn",
    });
    expect(validateNotificationEvents(["pnl_digest"])).toEqual({ ok: false, bad: "pnl_digest" });
  });
});

describe("coerceNotificationHistory (defensive reshaper)", () => {
  const goodEntry = {
    ts: "2026-07-22T03:00:00Z",
    event: "bot_crashed",
    bot_id: "crypto-demo",
    channel_name: "ops-all",
    kind: "discord_webhook",
    outcome: "sent",
    status_code: 204,
    detail: "container exited",
  };

  it("passes a well-formed payload through (happy path)", () => {
    const out = coerceNotificationHistory({ db_enabled: true, entries: [goodEntry] });
    expect(out.db_enabled).toBe(true);
    expect(out.entries).toEqual([goodEntry]);
  });

  it("returns the safe empty shape for bad JSON / non-object input", () => {
    // A JSON.parse failure hands us `null`; a garbage upstream hands a string.
    for (const bad of [null, undefined, "not json", 42, true]) {
      expect(coerceNotificationHistory(bad)).toEqual({ db_enabled: false, entries: [] });
    }
  });

  it("returns the safe empty shape when the fetch was non-2xx (adapter passes null)", () => {
    // The adapter's non-2xx branch feeds the coercer nothing; it must degrade,
    // never throw.
    expect(coerceNotificationHistory(null)).toEqual({ db_enabled: false, entries: [] });
  });

  it("coerces db_enabled to a strict boolean (only literal true is true)", () => {
    expect(coerceNotificationHistory({ db_enabled: false, entries: [] }).db_enabled).toBe(false);
    expect(coerceNotificationHistory({ entries: [] }).db_enabled).toBe(false);
    expect(coerceNotificationHistory({ db_enabled: "true", entries: [] }).db_enabled).toBe(false);
    expect(coerceNotificationHistory({ db_enabled: true, entries: [] }).db_enabled).toBe(true);
  });

  it("drops malformed rows and coerces field primitives on the survivors", () => {
    const out = coerceNotificationHistory({
      db_enabled: true,
      entries: [
        goodEntry,
        null, // dropped: not an object
        "junk", // dropped: not an object
        {}, // dropped: no ts AND no event
        { ts: "", event: "" }, // dropped: both blank
        { event: "bot_stopped", status_code: "502", bot_id: 7 }, // kept, coerced
      ],
    });
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toEqual(goodEntry);
    // Non-number status_code → null; numeric bot_id → string; missing → "".
    expect(out.entries[1]).toEqual({
      ts: "",
      event: "bot_stopped",
      bot_id: "7",
      channel_name: "",
      kind: "",
      outcome: "",
      status_code: null,
      detail: "",
    });
  });

  it("treats a non-array entries field as empty", () => {
    expect(coerceNotificationHistory({ db_enabled: true, entries: "nope" })).toEqual({
      db_enabled: true,
      entries: [],
    });
  });
});

describe("kindBadgeVariant", () => {
  it("greens a healthy lifecycle transition", () => {
    expect(kindBadgeVariant("bot_spawned")).toBe("green");
    expect(kindBadgeVariant("bot_restarted")).toBe("green");
  });

  it("ambers a benign/attention transition", () => {
    expect(kindBadgeVariant("bot_stopped")).toBe("amber");
    expect(kindBadgeVariant("net_worth_milestone")).toBe("amber");
  });

  it("reds every page-worthy / failure kind", () => {
    for (const k of ["bot_error", "bot_crashed", "risk_halt", "live_flip"]) {
      expect(kindBadgeVariant(k)).toBe("red");
    }
  });

  it("cyans a probe or admin action", () => {
    expect(kindBadgeVariant("test")).toBe("cyan");
    expect(kindBadgeVariant("key_rotation")).toBe("cyan");
  });

  it("falls back to the muted default for removed / edge_decay / unknown", () => {
    expect(kindBadgeVariant("bot_removed")).toBe("default");
    expect(kindBadgeVariant("edge_decay")).toBe("default");
    expect(kindBadgeVariant("something_new")).toBe("default");
    expect(kindBadgeVariant("")).toBe("default");
  });
});

describe("outcomeIsOk", () => {
  it("is ok ONLY for sent and test_sent", () => {
    expect(outcomeIsOk("sent")).toBe(true);
    expect(outcomeIsOk("test_sent")).toBe(true);
  });

  it("is a failure for every other outcome (and unknowns)", () => {
    for (const o of ["http_error", "send_failed", "decrypt_failed", "test_failed", "", "weird"]) {
      expect(outcomeIsOk(o)).toBe(false);
    }
  });
});
