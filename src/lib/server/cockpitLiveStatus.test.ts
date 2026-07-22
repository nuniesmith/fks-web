// Live-twin /status feed (M3 Phase A) — driven with an injected fetchFn (the
// `cockpitTelemetryGet(promUrl, fetchFn)` idiom) so the three honest states are
// pinned without a real live bot:
//   - env unset (empty url) → {configured:false}          (not wired)
//   - fetch throws / HTTP not-ok / non-JSON / non-BotStatus
//        → {configured:true, reachable:false, reason}      (outage, distinct)
//   - a real BotStatus document → reachable:true, positions passed through
//        untouched, mode_mismatch:false
//   - a PAPER document under the live URL → mode_mismatch:true  (paper-as-live
//     trap flagged, never rendered as live)
//   - an error is NEVER a bare empty-200 `{}` (honest-empty rule) — the
//     configured/reachable flags always survive.

import { describe, expect, it } from "vitest";
import { cockpitLiveStatusGet } from "./cockpit";
import { isLiveMode, type LiveStatusResp } from "$lib/types/cockpit-live";
import type { BotStatus } from "$lib/types/exchanges";

describe("isLiveMode (the mode-mismatch gate)", () => {
  it("matches live-ish modes, rejects paper/sim/empty (paper-as-live guard)", () => {
    for (const m of ["live", "LIVE", "live-armed", "kucoin-futures-live"]) {
      expect(isLiveMode(m)).toBe(true);
    }
    for (const m of ["paper", "shadow", "sim", "", undefined, null]) {
      expect(isLiveMode(m as string | undefined)).toBe(false);
    }
  });
});

const liveDoc: BotStatus = {
  bot: "crypto-funding-live",
  market: "futures",
  mode: "live",
  uptime_secs: 3600,
  net_worth_usd: 10_000,
  pnl_usd: 12.5,
  signals_total: 4,
  trades_total: 2,
  wins: 1,
  losses: 1,
  win_rate: 0.5,
  exchanges: [],
  positions: [
    { symbol: "ETHUSDTM", dir: 1, entry_px: 3000, entry_ts_ms: 1, mark_px: 3060, ret_pct: 2.0, updated: 1 },
    { symbol: "XBTUSDTM", dir: -1, entry_px: 60000, entry_ts_ms: 1, mark_px: 60600, ret_pct: -1.0, updated: 1 },
  ],
  recent_events: [],
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("GET /api/cockpit/live-status", () => {
  it("env unset (empty url) → configured:false, no fetch attempted", async () => {
    let called = false;
    const r = await cockpitLiveStatusGet("", async () => {
      called = true;
      return jsonResponse(liveDoc);
    });
    const j = (await r.json()) as LiveStatusResp;
    expect(j).toEqual({ configured: false });
    expect(j.reachable).toBeUndefined();
    expect(j.status).toBeUndefined();
    expect(called).toBe(false);
  });

  it("fetch throws (timeout/DNS) → configured:true, reachable:false + reason", async () => {
    const r = await cockpitLiveStatusGet("http://live-twin:9091", async () => {
      throw new Error("The operation timed out");
    });
    const j = (await r.json()) as LiveStatusResp;
    expect(j.configured).toBe(true);
    expect(j.reachable).toBe(false);
    expect(j.reason).toContain("unreachable");
    expect(j.status).toBeUndefined();
  });

  it("HTTP non-ok → reachable:false with the status code in the reason", async () => {
    const r = await cockpitLiveStatusGet("http://live-twin:9091", async () =>
      jsonResponse({ error: "boom" }, 503),
    );
    const j = (await r.json()) as LiveStatusResp;
    expect(j).toMatchObject({ configured: true, reachable: false });
    expect(j.reason).toContain("503");
  });

  it("non-JSON body → reachable:false (not a benign empty)", async () => {
    const r = await cockpitLiveStatusGet("http://live-twin:9091", async () => {
      return new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    const j = (await r.json()) as LiveStatusResp;
    expect(j).toMatchObject({ configured: true, reachable: false });
    expect(j.reason).toBeTruthy();
  });

  it("JSON but not a BotStatus (no `bot` key) → reachable:false + reason", async () => {
    const r = await cockpitLiveStatusGet("http://live-twin:9091", async () =>
      jsonResponse({ status: "ok", positions: [] }),
    );
    const j = (await r.json()) as LiveStatusResp;
    expect(j).toMatchObject({ configured: true, reachable: false });
    expect(j.reason).toContain("BotStatus");
    expect(j.status).toBeUndefined();
  });

  it("valid live BotStatus → reachable:true, positions passed through untouched", async () => {
    const r = await cockpitLiveStatusGet("http://live-twin:9091", async () => jsonResponse(liveDoc));
    const j = (await r.json()) as LiveStatusResp;
    expect(j.configured).toBe(true);
    expect(j.reachable).toBe(true);
    expect(j.mode_mismatch).toBe(false);
    // positions survive byte-for-byte (the enrichment source of ret%/mark_px)
    expect(j.status?.positions).toEqual(liveDoc.positions);
    expect(j.status?.mode).toBe("live");
  });

  it("mode mismatch: a PAPER document under the live URL → mode_mismatch:true", async () => {
    const paperDoc: BotStatus = { ...liveDoc, bot: "crypto-funding", mode: "paper" };
    const r = await cockpitLiveStatusGet("http://live-twin:9091", async () => jsonResponse(paperDoc));
    const j = (await r.json()) as LiveStatusResp;
    expect(j.configured).toBe(true);
    expect(j.reachable).toBe(true);
    // paper-as-live trap: still reachable, but flagged so the UI suppresses PnL
    expect(j.mode_mismatch).toBe(true);
  });

  it("an error NEVER returns a bare empty-200 {} — the states stay distinguishable", async () => {
    // fetch failure and non-status reply must both carry the configured/reachable
    // flags, never collapse to `{}` (honest-empty rule).
    const fail = (await (
      await cockpitLiveStatusGet("http://x", async () => {
        throw new Error("down");
      })
    ).json()) as LiveStatusResp;
    const nonStatus = (await (
      await cockpitLiveStatusGet("http://x", async () => jsonResponse({ nope: true }))
    ).json()) as LiveStatusResp;
    for (const j of [fail, nonStatus]) {
      expect(Object.keys(j).length).toBeGreaterThan(0);
      expect(j.configured).toBe(true);
      expect(j.reachable).toBe(false);
      expect(j.reason).toBeTruthy();
    }
    // the three states are mutually exclusive in the `reachable` discriminant
    expect(fail.reachable).toBe(false);
  });
});
