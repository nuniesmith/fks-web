// Pure cockpit view-model + kill-validation logic. These are the
// money-critical decisions: which instance a kill targets, whether a typed
// confirmation passes, and whether a panel renders data vs an HONEST empty.

import { describe, expect, it } from "vitest";
import {
  BREAKER_COOLDOWN_SECS,
  CLOSE_ACTIONS,
  KILL_CONFIRM_PHRASE,
  REARM_CONFIRM_PHRASE,
  buildKillRecord,
  gateBotName,
  parseGateRows,
  parseInstance,
  parseSentinel,
  partitionOpenTrades,
  sessionPnl,
  utcDayStartMs,
  validateKillBody,
} from "./model";

describe("parseInstance — strict whitelist", () => {
  it("accepts exactly paper and live", () => {
    expect(parseInstance("paper")).toBe("paper");
    expect(parseInstance("live")).toBe("live");
  });
  it("rejects everything else — no default target", () => {
    for (const bad of [undefined, null, "", "LIVE", "Live", " live", "live ", "paper-drill", 1, {}]) {
      expect(parseInstance(bad)).toBeNull();
    }
  });
});

describe("validateKillBody — typed confirmation, instance-explicit", () => {
  it("passes with exact instance + exact phrase", () => {
    const v = validateKillBody({ instance: "live", confirm: "KILL" }, KILL_CONFIRM_PHRASE);
    expect(v).toMatchObject({ ok: true, instance: "live" });
  });
  it("rejects a missing instance (must never default to either twin)", () => {
    const v = validateKillBody({ confirm: "KILL" }, KILL_CONFIRM_PHRASE);
    expect(v).toMatchObject({ ok: false, status: 400 });
  });
  it("rejects a wrong/absent/case-different/padded confirmation phrase", () => {
    for (const confirm of [undefined, "", "kill", "Kill", " KILL", "KILL ", "REARM"]) {
      const v = validateKillBody({ instance: "live", confirm }, KILL_CONFIRM_PHRASE);
      expect(v).toMatchObject({ ok: false, status: 400 });
    }
  });
  it("the re-arm phrase does not satisfy the kill phrase and vice versa", () => {
    expect(
      validateKillBody({ instance: "paper", confirm: KILL_CONFIRM_PHRASE }, REARM_CONFIRM_PHRASE),
    ).toMatchObject({ ok: false });
    expect(
      validateKillBody({ instance: "paper", confirm: REARM_CONFIRM_PHRASE }, KILL_CONFIRM_PHRASE),
    ).toMatchObject({ ok: false });
  });
  it("carries a bounded operator note", () => {
    const v = validateKillBody(
      { instance: "paper", confirm: "KILL", note: "  drill F6  " },
      KILL_CONFIRM_PHRASE,
    );
    expect(v).toMatchObject({ ok: true, note: "drill F6" });
    const long = validateKillBody(
      { instance: "paper", confirm: "KILL", note: "x".repeat(500) },
      KILL_CONFIRM_PHRASE,
    );
    expect(long.ok && long.note.length).toBe(200);
  });
});

describe("buildKillRecord — the bot's three-key sentinel shape", () => {
  it("matches kill::kill_record ({killed:true, reason, t})", () => {
    const r = buildKillRecord("jordan", "drill", 1234);
    expect(r).toEqual({ killed: true, reason: "webui kill by jordan: drill", t: 1234 });
    expect(Object.keys(r).sort()).toEqual(["killed", "reason", "t"]);
  });
  it("never emits a blank operator", () => {
    expect(buildKillRecord("  ", "", 1).reason).toBe("webui kill by unknown-operator");
  });
});

describe("parseSentinel — presence semantics", () => {
  it("absent row / JSON null = clear (bot's not-killed convention)", () => {
    expect(parseSentinel(null).state).toBe("clear");
    expect(parseSentinel(undefined).state).toBe("clear");
  });
  it("any non-null record = killed, audit fields best-effort", () => {
    expect(parseSentinel({ killed: true, reason: "r", t: 9 })).toEqual({
      state: "killed",
      reason: "r",
      trippedAtMs: 9,
    });
    // Presence means killed even with unknown content — mirror the bot.
    expect(parseSentinel({}).state).toBe("killed");
    expect(parseSentinel({ killed: false }).state).toBe("killed");
  });
});

describe("partitionOpenTrades — durable-instance keying", () => {
  const open = { entry_t: 1_700_000_000_000, dir: 1, entry_px: 2500.5 };
  it("bare symbol → paper, live:SYM → live", () => {
    const p = partitionOpenTrades([
      { symbol: "ETHUSDTM", state: open },
      { symbol: "live:ETHUSDTM", state: { ...open, dir: -1 } },
    ]);
    expect(p.paper).toHaveLength(1);
    expect(p.paper[0]).toMatchObject({ symbol: "ETHUSDTM", side: "LONG" });
    expect(p.live).toHaveLength(1);
    expect(p.live[0]).toMatchObject({ symbol: "ETHUSDTM", side: "SHORT" });
    expect(p.otherKeys).toEqual([]);
  });
  it("cleared (JSON null) rows are skipped — 'postgres owns this key'", () => {
    const p = partitionOpenTrades([{ symbol: "ETHUSDTM", state: null }]);
    expect(p.paper).toEqual([]);
    expect(p.live).toEqual([]);
  });
  it("unknown instance prefixes are surfaced, never silently dropped", () => {
    const p = partitionOpenTrades([{ symbol: "paper-drill:ETHUSDTM", state: open }]);
    expect(p.paper).toEqual([]);
    expect(p.live).toEqual([]);
    expect(p.otherKeys).toEqual(["paper-drill:ETHUSDTM"]);
  });
  it("a pending Closing is exposed (the close-confirm state machine)", () => {
    const p = partitionOpenTrades([
      {
        symbol: "live:AVAXUSDTM",
        state: { ...open, closing: { reason: "kill", decided_t: 5, attempts: 3, last_attempt_t: 6 } },
      },
    ]);
    expect(p.live[0].closing).toEqual({ reason: "kill", decidedTMs: 5, attempts: 3 });
  });
  it("malformed state blobs render nothing rather than garbage", () => {
    const p = partitionOpenTrades([
      { symbol: "ETHUSDTM", state: { dir: 2, entry_px: "x", entry_t: null } },
      { symbol: "AVAXUSDTM", state: "not-an-object" },
    ]);
    expect(p.paper).toEqual([]);
  });
});

describe("sessionPnl — UTC-day ledger fold with mode discrimination", () => {
  const now = Date.UTC(2026, 6, 20, 14, 0, 0);
  const today = (h: number) => Date.UTC(2026, 6, 20, h, 0, 0);
  const yesterday = Date.UTC(2026, 6, 19, 23, 0, 0);

  it("counts all three close actions incl. kill_exit (is_close_action parity)", () => {
    expect(CLOSE_ACTIONS).toEqual(["exit", "stop_exit", "kill_exit"]);
    const v = sessionPnl(
      [
        { t: today(1), action: "exit", net_pnl_usdt: 5 },
        { t: today(2), action: "stop_exit", net_pnl_usdt: -2 },
        { t: today(3), action: "kill_exit", net_pnl_usdt: -1 },
      ],
      "paper",
      now,
    );
    expect(v.closes).toBe(3);
    expect(v.killExits).toBe(1);
    expect(v.realizedUsdt).toBeCloseTo(2);
  });
  it("mode:'live' rows belong ONLY to the live instance; unstamped rows to paper", () => {
    const records = [
      { t: today(1), action: "exit", net_pnl_usdt: 10, mode: "live" },
      { t: today(2), action: "exit", net_pnl_usdt: 3 },
      { t: today(3), action: "entry", mode: "live" },
      { t: today(4), action: "entry" },
    ];
    const live = sessionPnl(records, "live", now);
    expect(live).toMatchObject({ realizedUsdt: 10, closes: 1, entries: 1 });
    const paper = sessionPnl(records, "paper", now);
    expect(paper).toMatchObject({ realizedUsdt: 3, closes: 1, entries: 1 });
  });
  it("yesterday's closes are outside the session window", () => {
    const v = sessionPnl([{ t: yesterday, action: "exit", net_pnl_usdt: 99 }], "paper", now);
    expect(v.closes).toBe(0);
    expect(v.realizedUsdt).toBe(0);
  });
  it("closes without net_pnl_usdt are FLAGGED, never imputed into the sum", () => {
    const v = sessionPnl(
      [
        { t: today(1), action: "exit" },
        { t: today(2), action: "exit", net_pnl_usdt: 4 },
      ],
      "paper",
      now,
    );
    expect(v.realizedUsdt).toBe(4);
    expect(v.closesWithoutUsdt).toBe(1);
  });
  it("utcDayStartMs anchors 00:00 UTC (the bot's session boundary)", () => {
    expect(utcDayStartMs(now)).toBe(Date.UTC(2026, 6, 20));
  });
});

describe("parseGateRows — persisted halt/breaker, rendered live", () => {
  const nowUnix = 1_770_000_000; // some UTC instant
  const today = Math.floor(nowUnix / 86_400);
  const row = (key: string, value: unknown) => ({ key, value });

  it("selects exactly the instance's bot name (live never bleeds into paper)", () => {
    const rows = [
      row("kucoin-futures/risk/ETHUSDTM", { session_pnl: { halted: true, last_reset_day: today } }),
      row("kucoin-futures-live/risk/ETHUSDTM", { session_pnl: { halted: false } }),
    ];
    expect(gateBotName("paper")).toBe("kucoin-futures");
    expect(gateBotName("live")).toBe("kucoin-futures-live");
    const paper = parseGateRows(rows, "paper", nowUnix);
    expect(paper).toHaveLength(1);
    expect(paper[0]).toMatchObject({ symbol: "ETHUSDTM", haltedNow: true });
    const live = parseGateRows(rows, "live", nowUnix);
    expect(live).toHaveLength(1);
    expect(live[0].haltedNow).toBe(false);
  });
  it("a halt from a PREVIOUS UTC day reads cleared-by-rollover (never a stale page)", () => {
    const rows = [
      row("kucoin-futures/risk/ETHUSDTM", {
        session_pnl: { halted: true, last_reset_day: today - 1 },
      }),
    ];
    const [g] = parseGateRows(rows, "paper", nowUnix);
    expect(g.haltedPersisted).toBe(true);
    expect(g.haltedNow).toBe(false);
  });
  it("breaker freshness renders against the cooldown", () => {
    const rows = [
      row("kucoin-futures/risk/A", {
        circuit_breaker: { tripped_at_unix_secs: nowUnix - BREAKER_COOLDOWN_SECS + 10 },
      }),
      row("kucoin-futures/risk/B", {
        circuit_breaker: { tripped_at_unix_secs: nowUnix - BREAKER_COOLDOWN_SECS - 10 },
      }),
    ];
    const gates = parseGateRows(rows, "paper", nowUnix);
    expect(gates.find((g) => g.symbol === "A")?.breakerActiveNow).toBe(true);
    expect(gates.find((g) => g.symbol === "B")?.breakerActiveNow).toBe(false);
  });
  it("no rows → empty list (the panel's honest-empty input)", () => {
    expect(parseGateRows([], "paper", nowUnix)).toEqual([]);
  });
});
