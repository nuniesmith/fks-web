// Cockpit route handlers — driven with an injected fake store / fetch so the
// money-critical behaviours are pinned without a live Postgres or Prometheus:
//   - a kill/re-arm POST validates the typed confirmation + explicit instance
//     BEFORE any store access (a bad request can never touch the sentinel);
//   - the kill writes EXACTLY the named instance's sentinel in the bot's
//     {killed, reason, t} shape; re-arm stores JSON null (never a delete);
//   - the state endpoint reports configured:false honestly (no fake-empty
//     panels) and a store outage as an error, never an empty success;
//   - telemetry distinguishes outage vs unscraped-live-exporter.

import { describe, expect, it } from "vitest";
import {
  cockpitKillPost,
  cockpitRearmPost,
  cockpitStateGet,
  cockpitTelemetryGet,
  type CockpitStore,
} from "./cockpit";

class FakeStore implements CockpitStore {
  isConfigured = true;
  calls: string[] = [];
  kills: { instance: string; record: unknown }[] = [];
  clears: string[] = [];
  sentinels: { instance: string; record: unknown; updated_at: unknown }[] = [];
  trades: { symbol: string; state: unknown }[] = [];
  riskRows: { key: string; value: unknown }[] = [];
  records: unknown[] = [];

  async configured() {
    this.calls.push("configured");
    return this.isConfigured;
  }
  async loadSentinels() {
    this.calls.push("loadSentinels");
    return this.sentinels;
  }
  async loadOpenTrades() {
    this.calls.push("loadOpenTrades");
    return this.trades;
  }
  async loadRiskRows() {
    this.calls.push("loadRiskRows");
    return this.riskRows;
  }
  async loadRecentRecords() {
    this.calls.push("loadRecentRecords");
    return this.records;
  }
  async setKill(instance: string, record: unknown) {
    this.calls.push("setKill");
    this.kills.push({ instance, record });
  }
  async clearKill(instance: string) {
    this.calls.push("clearKill");
    this.clears.push(instance);
  }
}

const post = (body: unknown) =>
  new Request("http://local/api/cockpit/kill", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/cockpit/kill", () => {
  it("rejects without the typed confirmation — and never touches the store", async () => {
    const store = new FakeStore();
    const r = await cockpitKillPost(post({ instance: "live", confirm: "kill" }), "jordan", store);
    expect(r.status).toBe(400);
    expect(store.calls).toEqual([]); // validation strictly precedes store access
    expect(store.kills).toEqual([]);
  });

  it("rejects a missing/unknown instance — killing must name its target", async () => {
    const store = new FakeStore();
    for (const body of [{ confirm: "KILL" }, { instance: "all", confirm: "KILL" }]) {
      const r = await cockpitKillPost(post(body), "jordan", store);
      expect(r.status).toBe(400);
    }
    expect(store.kills).toEqual([]);
  });

  it("writes the named instance's sentinel in the bot's record shape", async () => {
    const store = new FakeStore();
    const r = await cockpitKillPost(
      post({ instance: "live", confirm: "KILL", note: "drill F4" }),
      "jordan",
      store,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; instance: string; effect: string };
    expect(j.ok).toBe(true);
    expect(j.instance).toBe("live");
    // Honest effect: sentinel semantics, not an instant venue flatten.
    expect(j.effect).toContain("NEXT live bar");
    expect(store.kills).toHaveLength(1);
    expect(store.kills[0].instance).toBe("live");
    const rec = store.kills[0].record as Record<string, unknown>;
    expect(rec.killed).toBe(true);
    expect(rec.reason).toBe("webui kill by jordan: drill F4");
    expect(typeof rec.t).toBe("number");
    expect(Object.keys(rec).sort()).toEqual(["killed", "reason", "t"]);
  });

  it("killing paper targets ONLY the paper sentinel (instance isolation)", async () => {
    const store = new FakeStore();
    await cockpitKillPost(post({ instance: "paper", confirm: "KILL" }), "jordan", store);
    expect(store.kills.map((k) => k.instance)).toEqual(["paper"]);
  });

  it("refuses when the funding tables are absent (wrong DB) — 503, no write", async () => {
    const store = new FakeStore();
    store.isConfigured = false;
    const r = await cockpitKillPost(post({ instance: "live", confirm: "KILL" }), "jordan", store);
    expect(r.status).toBe(503);
    expect(store.kills).toEqual([]);
  });

  it("no store configured at all → 503 (validation still ran first)", async () => {
    const r = await cockpitKillPost(post({ instance: "live", confirm: "KILL" }), "jordan", null);
    expect(r.status).toBe(503);
    const bad = await cockpitKillPost(post({ instance: "live", confirm: "nope" }), "jordan", null);
    expect(bad.status).toBe(400); // bad request reported as such, not as 503
  });

  it("a store write failure is surfaced, never a fake success", async () => {
    const store = new FakeStore();
    store.setKill = async () => {
      throw new Error("connection refused");
    };
    const r = await cockpitKillPost(post({ instance: "live", confirm: "KILL" }), "jordan", store);
    expect(r.status).toBe(502);
    const j = (await r.json()) as { ok: boolean };
    expect(j.ok).toBe(false);
  });
});

describe("POST /api/cockpit/rearm", () => {
  it("requires the REARM phrase (KILL does not clear a sentinel)", async () => {
    const store = new FakeStore();
    const r = await cockpitRearmPost(post({ instance: "live", confirm: "KILL" }), "jordan", store);
    expect(r.status).toBe(400);
    expect(store.clears).toEqual([]);
  });
  it("clears exactly the named instance", async () => {
    const store = new FakeStore();
    const r = await cockpitRearmPost(post({ instance: "paper", confirm: "REARM" }), "jordan", store);
    expect(r.status).toBe(200);
    expect(store.clears).toEqual(["paper"]);
    expect(store.kills).toEqual([]);
  });
});

describe("GET /api/cockpit/state", () => {
  it("no DB url → configured:false with a reason (honest, not empty panels)", async () => {
    const r = await cockpitStateGet(null);
    const j = (await r.json()) as { configured: boolean; reason: string };
    expect(j.configured).toBe(false);
    expect(j.reason).toContain("WEBUI_FR_DATABASE_URL");
  });

  it("funding tables absent → configured:false (never reads other tables)", async () => {
    const store = new FakeStore();
    store.isConfigured = false;
    const r = await cockpitStateGet(store);
    const j = (await r.json()) as { configured: boolean };
    expect(j.configured).toBe(false);
    expect(store.calls).toEqual(["configured"]);
  });

  it("store outage → 502 error, NOT an empty 200 (no fake success)", async () => {
    const store = new FakeStore();
    store.loadSentinels = async () => {
      throw new Error("db down");
    };
    const r = await cockpitStateGet(store);
    expect(r.status).toBe(502);
    const j = (await r.json()) as { configured: boolean; reason: string };
    expect(j.configured).toBe(false);
    expect(j.reason).toContain("db down");
  });

  it("partitions state per instance: sentinel, positions, gates, session PnL", async () => {
    const store = new FakeStore();
    const now = Date.now();
    store.sentinels = [
      { instance: "live", record: { killed: true, reason: "drill", t: 5 }, updated_at: "x" },
    ];
    store.trades = [
      { symbol: "ETHUSDTM", state: { entry_t: now - 60_000, dir: 1, entry_px: 2500 } },
      { symbol: "live:AVAXUSDTM", state: { entry_t: now - 120_000, dir: -1, entry_px: 30 } },
    ];
    store.riskRows = [
      {
        key: "kucoin-futures/risk/ETHUSDTM",
        value: { session_pnl: { halted: true, last_reset_day: Math.floor(now / 86_400_000) } },
      },
    ];
    store.records = [
      { t: now - 1000, action: "exit", net_pnl_usdt: 7 },
      { t: now - 2000, action: "kill_exit", net_pnl_usdt: -3, mode: "live" },
    ];
    const r = await cockpitStateGet(store);
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      configured: boolean;
      instances: Record<string, any>;
    };
    expect(j.configured).toBe(true);
    // paper: its own position, halt row, unstamped ledger row
    expect(j.instances.paper.sentinel.state).toBe("clear");
    expect(j.instances.paper.positions).toHaveLength(1);
    expect(j.instances.paper.positions[0].symbol).toBe("ETHUSDTM");
    expect(j.instances.paper.gates[0]).toMatchObject({ symbol: "ETHUSDTM", haltedNow: true });
    expect(j.instances.paper.session.realizedUsdt).toBe(7);
    // live: killed sentinel, live-keyed position, mode:"live" kill_exit row
    expect(j.instances.live.sentinel).toMatchObject({ state: "killed", reason: "drill" });
    expect(j.instances.live.positions[0]).toMatchObject({ symbol: "AVAXUSDTM", side: "SHORT" });
    expect(j.instances.live.gates).toEqual([]);
    expect(j.instances.live.session).toMatchObject({ realizedUsdt: -3, killExits: 1 });
  });

  it("surfaces sentinel rows under unexpected FR_INSTANCE keys (a bot deployed as e.g. 'kucoin-live' is NOT reachable by the cockpit's KILL)", async () => {
    const store = new FakeStore();
    store.sentinels = [
      { instance: "live", record: null, updated_at: "x" },
      { instance: "kucoin-live", record: { killed: true, reason: "r", t: 1 }, updated_at: "y" },
      { instance: "live-1", record: null, updated_at: "z" },
    ];
    const r = await cockpitStateGet(store);
    const j = (await r.json()) as {
      instances: Record<string, { sentinel: { state: string } }>;
      other_sentinel_instances: string[];
    };
    // Flagged, never silently dropped — the operator must learn the cockpit's
    // literal paper/live targeting does not match that deployment.
    expect(j.other_sentinel_instances).toEqual(["kucoin-live", "live-1"]);
    // And the unexpected keys never bleed into the paper/live views.
    expect(j.instances.live.sentinel.state).toBe("clear");
    expect(j.instances.paper.sentinel.state).toBe("clear");
  });
});

describe("GET /api/cockpit/telemetry", () => {
  const promOk = (result: unknown[]) =>
    new Response(
      JSON.stringify({ status: "success", data: { resultType: "vector", result } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("prometheus down → available:false (outage, not all-clear)", async () => {
    const r = await cockpitTelemetryGet("http://prom", async () => {
      throw new Error("unreachable");
    });
    const j = (await r.json()) as { available: boolean; scraped: boolean };
    expect(j).toMatchObject({ available: false, scraped: false });
  });

  it("reachable, zero live series → scraped:false (awaiting arm)", async () => {
    const r = await cockpitTelemetryGet("http://prom", async () => promOk([]));
    const j = (await r.json()) as { available: boolean; scraped: boolean };
    expect(j).toMatchObject({ available: true, scraped: false });
  });

  it("live series → scraped:true and mode=live selectors are used", async () => {
    const queries: string[] = [];
    const r = await cockpitTelemetryGet("http://prom", async (url: string) => {
      queries.push(decodeURIComponent(url));
      return promOk([{ metric: { symbol: "ETHUSDTM" }, value: [1, "1"] }]);
    });
    const j = (await r.json()) as { scraped: boolean; haltBySymbol: Record<string, number> };
    expect(j.scraped).toBe(true);
    expect(j.haltBySymbol.ETHUSDTM).toBe(1);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) expect(q).toContain('mode="live"');
  });
});
