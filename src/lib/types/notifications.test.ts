import { describe, expect, it } from "vitest";
import {
  ALWAYS_DELIVERED_EVENT_IDS,
  KNOWN_EVENT_IDS,
  NOTIFY_EVENT_KINDS,
  isKnownEventKind,
  validateNotificationEvents,
} from "./notifications";

describe("notification wire contract", () => {
  it("enumerates EXACTLY the spawner's ALL_EVENT_KINDS (notifications.rs)", () => {
    expect(NOTIFY_EVENT_KINDS.map((e) => e.id)).toEqual([
      "bot_spawned",
      "bot_stopped",
      "bot_removed",
      "bot_error",
      "bot_crashed",
    ]);
  });

  it("marks only bot_crashed as always-delivered (ALWAYS_DELIVERED_KINDS)", () => {
    expect(ALWAYS_DELIVERED_EVENT_IDS).toEqual(["bot_crashed"]);
  });

  it("rejects the legacy ids the old UI stored (the scoping bug)", () => {
    for (const legacy of ["spawn", "stop", "live_flip", "pnl_digest", "error"]) {
      expect(isKnownEventKind(legacy)).toBe(false);
      expect(KNOWN_EVENT_IDS.has(legacy)).toBe(false);
    }
  });
});

describe("validateNotificationEvents", () => {
  it("accepts known kinds, trimming + de-duping + dropping empties", () => {
    expect(validateNotificationEvents([" bot_spawned ", "bot_spawned", "", "bot_crashed"])).toEqual(
      { ok: true, events: ["bot_spawned", "bot_crashed"] },
    );
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
