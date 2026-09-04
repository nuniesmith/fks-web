import { describe, it, expect } from "vitest";
import {
  candleSymbolCondition,
  pickStoredInstrument,
  pickStoredSymbol,
  type CandleRow,
  humanizeSince,
  intervalToSeconds,
  mapCandleRows,
  reshapeHealth,
  reshapePerformance,
  reshapeRiskConfig,
  resampleCandles,
  resolveCandleTable,
  riskConfigRecognized,
  sanitizeInterval,
  sanitizeSymbol,
  signalStatus,
  toRiskConfigPayload,
  wantsArrayResponse,
} from "./reshape";

describe("reshapeHealth", () => {
  it("builds the StatusBar + System Info superset", () => {
    const out = reshapeHealth({
      status: "ok",
      version: "1.2.3",
      uptime: "3h",
      forward_service: "running",
      components: { redis: { status: "up" }, data: { status: "live" } },
    });
    expect(out.status).toBe("ok");
    expect(out.janus).toBe("ok");
    expect(out.version).toBe("1.2.3");
    expect(out.uptime).toBe("3h");
    expect(out.redis).toBe("up");
    expect(out.feed).toBe("running"); // forward_service wins
  });

  it("does not fabricate 'down' from an empty payload — defaults to unknown", () => {
    // No fetchStatus arg: the caller genuinely doesn't know why the body is
    // empty. A bare timeout must never render identically to a confirmed
    // outage (the bug this default fixes).
    const out = reshapeHealth({});
    expect(out.status).toBe("unknown");
    expect(out.janus).toBe("unknown");
    expect(out.redis).toBe("—");
    expect(out.feed).toBe("—");
    expect(out.components).toEqual({});
  });

  it("threads the fetch layer's 3-way verdict through an empty body", () => {
    // Ambiguous failure (timeout / other network error) → unknown, not down.
    expect(reshapeHealth({}, "unknown").status).toBe("unknown");
    expect(reshapeHealth({}, "unknown").janus).toBe("unknown");
    // Confirmed failure (non-2xx / connection-refused) → down.
    expect(reshapeHealth({}, "down").status).toBe("down");
    expect(reshapeHealth({}, "down").janus).toBe("down");
    // A 2xx reply whose body just happens to omit `status` → still not "down".
    expect(reshapeHealth({}, "up").status).toBe("up");
  });

  it("prefers the body's own status over the fetch-layer fallback", () => {
    // Even if the caller (incorrectly) passed fetchStatus "down", a real
    // status field in the body wins — the body is authoritative when present.
    expect(reshapeHealth({ status: "healthy" }, "down").status).toBe("healthy");
  });

  it("falls back to component statuses for the feed", () => {
    expect(reshapeHealth({ components: { data: { status: "live" } } }).feed).toBe("live");
    expect(reshapeHealth({ components: { questdb: { status: "ok" } } }).feed).toBe("ok");
  });

  it("lights up from janus's components map (live PING + data-module feed)", () => {
    // The exact shape janus /health serves since its components PR:
    // HealthStatus fields + { redis: {status}, feed: {status} }.
    const out = reshapeHealth({
      status: "healthy",
      uptime_seconds: 2863,
      signals_generated: 72,
      signals_persisted: 144,
      modules: [{ name: "data", healthy: true, message: "live: 10 assets" }],
      shutdown_requested: false,
      service_state: "running",
      components: { redis: { status: "connected" }, feed: { status: "connected" } },
    });
    expect(out.janus).toBe("healthy"); // StatusBar classifies "healthy" as ok
    expect(out.redis).toBe("connected");
    expect(out.feed).toBe("connected"); // no forward_service field → components.feed
    // The /settings System Info panel renders the components map verbatim.
    expect(out.components).toEqual({
      redis: { status: "connected" },
      feed: { status: "connected" },
    });
  });

  it("passes janus's idle/disconnected feed states through", () => {
    const idle = reshapeHealth({
      status: "healthy",
      components: { redis: { status: "connected" }, feed: { status: "idle" } },
    });
    expect(idle.feed).toBe("idle");

    const down = reshapeHealth({
      status: "degraded",
      components: { redis: { status: "disconnected" }, feed: { status: "disconnected" } },
    });
    expect(down.redis).toBe("disconnected");
    expect(down.feed).toBe("disconnected");
  });
});

describe("reshapePerformance", () => {
  it("prefers risk over dashboard on overlap and maps field aliases", () => {
    const out = reshapePerformance(
      { win_rate: 0.7, net_pnl: 100 },
      { win_rate: 0.5, trades: 10 },
    );
    expect(out.win_rate).toBe(0.7); // risk wins over dashboard
    expect(out.total_pnl).toBe(100); // net_pnl alias
    expect(out.total_trades).toBe(10); // dashboard `trades` alias
  });

  it("drops non-numeric values and tolerates null inputs", () => {
    expect(reshapePerformance({ total_trades: "5" }, {}).total_trades).toBeUndefined();
    const empty = reshapePerformance(null, null);
    expect(empty.win_rate).toBeUndefined();
    expect(empty.total_pnl).toBeUndefined();
  });
});

describe("reshapeRiskConfig", () => {
  it("surfaces the daily-loss halt threshold as positive USD", () => {
    expect(reshapeRiskConfig({ max_daily_loss: -5000 }).max_daily_loss_usd).toBe(5000);
    expect(reshapeRiskConfig({ daily_loss: -3000 }).max_daily_loss_usd).toBe(3000);
  });

  it("maps positions + gross exposure and tolerates empty", () => {
    const out = reshapeRiskConfig({
      max_concurrent_positions: 10,
      max_gross_exposure: 2_000_000,
    });
    expect(out.max_positions).toBe(10);
    expect(out.max_gross_exposure_usd).toBe(2_000_000);
    const empty = reshapeRiskConfig({});
    expect(empty.max_daily_loss_usd).toBeUndefined();
    expect(empty.max_positions).toBeUndefined();
  });
});

// R1 — the fabrication guard. `reshapeRiskConfig` cannot tell "janus reports no
// limits" from "nothing recognizable came back"; both are three `undefined`s.
// This predicate is what stops the second case reaching the /settings panel,
// where the panel's own numbers would render in place of the live limits.
describe("riskConfigRecognized", () => {
  it("rejects every shape that carries no limit", () => {
    // the exact value `janusJson` used to hand this route on ANY failure
    expect(riskConfigRecognized(reshapeRiskConfig({}))).toBe(false);
    expect(riskConfigRecognized(reshapeRiskConfig(null))).toBe(false);
    // a janus error envelope parsed as JSON — a 200-shaped lie
    expect(riskConfigRecognized(reshapeRiskConfig({ error: "not found" }))).toBe(false);
    // schema drift: rustrade renames the fields, every mapping falls through
    expect(
      riskConfigRecognized(reshapeRiskConfig({ dailyLossLimit: -5000, positionCap: 10 })),
    ).toBe(false);
    // typed-JSON contract: strings are not numbers, so a stringly-typed body
    // is not a config either
    expect(riskConfigRecognized(reshapeRiskConfig({ max_daily_loss: "-5000" }))).toBe(false);
  });

  it("accepts a real config, including a partial one", () => {
    expect(
      riskConfigRecognized(
        reshapeRiskConfig({
          max_daily_loss: -5000,
          max_concurrent_positions: 10,
          max_gross_exposure: 2_000_000,
        }),
      ),
    ).toBe(true);
    // partial is still real — the client, not this seam, refuses to save it
    expect(riskConfigRecognized(reshapeRiskConfig({ max_concurrent_positions: 10 }))).toBe(true);
    // a genuine zero limit is a limit, not an absence
    expect(riskConfigRecognized(reshapeRiskConfig({ max_daily_loss: 0 }))).toBe(true);
  });
});

describe("toRiskConfigPayload", () => {
  it("flips the daily-loss sign to rustrade's ≤ 0 halt threshold", () => {
    expect(toRiskConfigPayload({ max_daily_loss_usd: 5000 }).max_daily_loss).toBe(-5000);
    // already negative → normalized to a negative magnitude, never positive
    expect(toRiskConfigPayload({ max_daily_loss_usd: -5000 }).max_daily_loss).toBe(-5000);
  });

  it("coerces string form values (number inputs arrive as strings)", () => {
    const out = toRiskConfigPayload({
      max_daily_loss_usd: "5000",
      max_positions: "10",
      max_gross_exposure_usd: "2000000",
    });
    expect(out.max_daily_loss).toBe(-5000);
    expect(out.max_concurrent_positions).toBe(10);
    expect(out.max_gross_exposure).toBe(2_000_000);
  });

  it("leaves missing / non-numeric fields undefined", () => {
    const out = toRiskConfigPayload({});
    expect(out.max_daily_loss).toBeUndefined();
    expect(out.max_concurrent_positions).toBeUndefined();
    expect(out.max_gross_exposure).toBeUndefined();
    expect(toRiskConfigPayload({ max_positions: "abc" }).max_concurrent_positions).toBeUndefined();
  });
});

describe("signalStatus", () => {
  it("maps a gate pass to approved", () => {
    expect(signalStatus({ gate: "pass" })).toBe("approved");
    // gate is the final authority — it already consumed risk_check
    expect(signalStatus({ gate: "pass", risk_check: "ok" })).toBe("approved");
  });

  it("maps gate blocks and risk rejections to rejected", () => {
    expect(signalStatus({ gate: "block_risk:rejected:daily loss" })).toBe("rejected");
    expect(signalStatus({ gate: "block_confidence" })).toBe("rejected");
    expect(signalStatus({ risk_check: "rejected:max positions" })).toBe("rejected");
  });

  it("defaults to staging when no verdict was recorded", () => {
    // holds / closes never reach the gate; risk_check ok alone is advisory
    expect(signalStatus({ risk_check: "ok" })).toBe("staging");
    expect(signalStatus({})).toBe("staging");
    expect(signalStatus(undefined)).toBe("staging");
    expect(signalStatus(null)).toBe("staging");
    expect(signalStatus("not-an-object")).toBe("staging");
    expect(signalStatus({ gate: 42, risk_check: {} })).toBe("staging");
  });
});

describe("humanizeSince", () => {
  it("returns — for missing / invalid input", () => {
    expect(humanizeSince(undefined)).toBe("—");
    expect(humanizeSince("not-a-date")).toBe("—");
  });

  it("formats compact ages", () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    expect(humanizeSince(ago(30_000))).toBe("30s");
    expect(humanizeSince(ago(90_000))).toBe("1m");
    expect(humanizeSince(ago(2 * 3_600_000))).toBe("2h");
    expect(humanizeSince(ago(3 * 86_400_000))).toBe("3d");
  });
});

describe("sanitizeSymbol", () => {
  it("keeps valid symbol characters", () => {
    expect(sanitizeSymbol("BTC/USD")).toBe("BTC/USD");
    expect(sanitizeSymbol("XBTUSDTM")).toBe("XBTUSDTM");
    expect(sanitizeSymbol("ETH-USD.PERP")).toBe("ETH-USD.PERP");
  });

  it("strips SQL-injection metacharacters (the QuestDB query guard)", () => {
    // quotes, spaces, semicolons, parens, equals are all removed
    expect(sanitizeSymbol("a b;c(d)='e'")).toBe("abcde");
    expect(sanitizeSymbol("BTC'); DROP TABLE candles_crypto; --")).toBe(
      "BTCDROPTABLEcandles_crypto--",
    );
  });

  it("caps length and tolerates null / undefined", () => {
    expect(sanitizeSymbol("A".repeat(50))).toHaveLength(32);
    expect(sanitizeSymbol("A".repeat(50), 24)).toHaveLength(24);
    expect(sanitizeSymbol(null)).toBe("");
    expect(sanitizeSymbol(undefined)).toBe("");
  });
});

describe("sanitizeInterval", () => {
  it("keeps valid interval tokens", () => {
    expect(sanitizeInterval("5m")).toBe("5m");
    expect(sanitizeInterval("1h")).toBe("1h");
    expect(sanitizeInterval("1D")).toBe("1D");
  });

  it("defaults to 5m for empty / fully-stripped input", () => {
    expect(sanitizeInterval(null)).toBe("5m");
    expect(sanitizeInterval("")).toBe("5m");
    expect(sanitizeInterval("'; --")).toBe("5m"); // all chars stripped → fallback
    expect(sanitizeInterval("5m'")).toBe("5m"); // trailing quote dropped
  });
});

describe("mapCandleRows", () => {
  it("maps newest-first QuestDB rows to ascending ms OHLCV", () => {
    const dataset = [
      [2_000_000, 11, 12, 10, 11.5, 100], // newer (µs)
      [1_000_000, 10, 11, 9, 10.5, 50], // older
    ];
    expect(mapCandleRows(dataset)).toEqual([
      { tsMs: 1000, open: 10, high: 11, low: 9, close: 10.5, volume: 50 },
      { tsMs: 2000, open: 11, high: 12, low: 10, close: 11.5, volume: 100 },
    ]);
  });

  it("defaults missing volume to 0 and tolerates non-arrays", () => {
    expect(mapCandleRows([[1_000_000, 1, 2, 0.5, 1.5]])).toEqual([
      { tsMs: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 },
    ]);
    expect(mapCandleRows(null)).toEqual([]);
    expect(mapCandleRows(undefined)).toEqual([]);
  });
});

describe("wantsArrayResponse", () => {
  it("returns true for list-ish endpoints", () => {
    for (const p of ["/api/signals", "/api/trades", "/api/x/runs", "/api/alerts", "/api/containers"]) {
      expect(wantsArrayResponse(p)).toBe(true);
    }
  });

  it("returns false for singular / status endpoints", () => {
    for (const p of ["/api/health", "/api/janus/state", "/api/settings/risk"]) {
      expect(wantsArrayResponse(p)).toBe(false);
    }
  });
});

describe("intervalToSeconds", () => {
  it("parses the chart's interval tokens", () => {
    expect(intervalToSeconds("1m")).toBe(60);
    expect(intervalToSeconds("5m")).toBe(300);
    expect(intervalToSeconds("15m")).toBe(900);
    expect(intervalToSeconds("1h")).toBe(3600);
    expect(intervalToSeconds("4h")).toBe(14400);
    expect(intervalToSeconds("1D")).toBe(86400);
    expect(intervalToSeconds("1W")).toBe(604800);
  });

  it("returns null for unknown / invalid tokens", () => {
    expect(intervalToSeconds("")).toBeNull();
    expect(intervalToSeconds("0m")).toBeNull();
    expect(intervalToSeconds("abc")).toBeNull();
    expect(intervalToSeconds("5x")).toBeNull();
  });
});

describe("resampleCandles", () => {
  // Five ascending 1m bars in one 5m bucket, then one bar in the next bucket.
  const m = (i: number, o: number, h: number, l: number, c: number, v: number): CandleRow => ({
    tsMs: i * 60_000,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
  });

  it("aggregates 1m bars into a 5m OHLCV bucket", () => {
    const bars = [
      m(0, 10, 12, 9, 11, 5),
      m(1, 11, 13, 10, 12, 6),
      m(2, 12, 12.5, 11, 11.5, 7),
      m(3, 11.5, 14, 11, 13, 8),
      m(4, 13, 13.5, 12, 12.5, 9),
    ];
    expect(resampleCandles(bars, 300)).toEqual([
      { tsMs: 0, open: 10, high: 14, low: 9, close: 12.5, volume: 35 },
    ]);
  });

  it("splits across bucket boundaries", () => {
    const bars = [m(0, 1, 2, 1, 2, 1), m(4, 2, 3, 2, 3, 1), m(5, 3, 4, 3, 4, 1)];
    const out = resampleCandles(bars, 300); // 5-minute buckets
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ tsMs: 0, open: 1, high: 3, low: 1, close: 3, volume: 2 });
    expect(out[1]).toEqual({ tsMs: 300_000, open: 3, high: 4, low: 3, close: 4, volume: 1 });
  });

  it("returns [] for empty input or a non-positive bucket", () => {
    expect(resampleCandles([], 300)).toEqual([]);
    expect(resampleCandles([m(0, 1, 1, 1, 1, 1)], 0)).toEqual([]);
  });
});

describe("resolveCandleTable", () => {
  it("routes bare symbols to candles_crypto (non-exact match)", () => {
    const r = resolveCandleTable("BTCUSDT");
    expect(r.table).toBe("candles_crypto");
    expect(r.sym).toBe("BTCUSDT");
    expect(r.exact).toBe(false);
  });
  it("routes venue-tagged symbols to candles_futures (exact match)", () => {
    const r = resolveCandleTable("rithmic:MESU6");
    expect(r.table).toBe("candles_futures");
    expect(r.sym).toBe("rithmic:MESU6");
    expect(r.exact).toBe(true);
  });
  it("sanitizes both halves of a tagged symbol (injection guard)", () => {
    const r = resolveCandleTable("rith'mic:MES';DROP");
    expect(r.table).toBe("candles_futures");
    expect(r.sym).not.toContain("'");
    expect(r.sym).not.toContain(";");
  });
  it("falls back to crypto when the tag is malformed", () => {
    expect(resolveCandleTable(":MES").table).toBe("candles_crypto");
  });
});

describe("candleSymbolCondition", () => {
  /** The regression: storage holds the exchange's concatenated pair, and the
   *  charts page sends the bare base ticker. Matching only the
   *  separator-bearing forms matched none of the 25,422 stored BTC 5m rows, so
   *  every crypto chart showed only ticks accumulated since page load. */
  it("matches the concatenated pair form the exchanges actually write", () => {
    const c = candleSymbolCondition("BTC", false);
    expect(c).toContain("'BTCUSDT'");
    expect(c).toContain("'BTCUSD'");
  });

  it("still matches the separator-bearing and bare forms", () => {
    const c = candleSymbolCondition("BTC", false);
    expect(c).toContain("symbol = 'BTC'");
    expect(c).toContain("symbol LIKE 'BTC/%'");
    expect(c).toContain("symbol LIKE 'BTC-%'");
  });

  /** Deliberately NOT `LIKE 'BTC%'`. A prefix wildcard would also match a
   *  different asset starting with the same letters, and charting the wrong
   *  instrument is worse than charting nothing. */
  it("does not use a bare prefix wildcard", () => {
    expect(candleSymbolCondition("BTC", false)).not.toContain("LIKE 'BTC%'");
  });

  it("matches futures symbols exactly, with no pair expansion", () => {
    const c = candleSymbolCondition("rithmic:GC", true);
    expect(c).toBe("symbol = 'rithmic:GC'");
    expect(c).not.toContain("USDT");
  });
});

describe("pickStoredSymbol", () => {
  /** The defect this closes: the matcher accepts every spelling, so querying on
   *  it directly would merge two different books into one series. */
  it("picks ONE symbol when several spellings exist", () => {
    const picked = pickStoredSymbol("BTC", ["BTCUSD", "BTCUSDT"]);
    expect(picked).toBe("BTCUSDT");
    // Deterministic: order of candidates must not change the answer.
    expect(pickStoredSymbol("BTC", ["BTCUSDT", "BTCUSD"])).toBe("BTCUSDT");
  });

  it("prefers the bare base when it is stored that way", () => {
    expect(pickStoredSymbol("BTC", ["BTC", "BTCUSDT"])).toBe("BTC");
  });

  it("follows the stated quote preference", () => {
    expect(pickStoredSymbol("ETH", ["ETHUSDC", "ETHUSD"])).toBe("ETHUSD");
    expect(pickStoredSymbol("ETH", ["ETHPERP", "ETHUSDC"])).toBe("ETHUSDC");
  });

  it("reports nothing rather than inventing a symbol", () => {
    expect(pickStoredSymbol("BTC", [])).toBeNull();
  });

  it("falls back stably for an unrecognised spelling", () => {
    // No preferred form present: alphabetical, so the answer is at least stable
    // across calls rather than dependent on storage order.
    expect(pickStoredSymbol("BTC", ["BTC-PERP", "BTC/USD"])).toBe("BTC-PERP");
  });
});

describe("mapCandleRows symbol disambiguation", () => {
  /** Two spellings of the same base are two different ORDER BOOKS. Rendering
   *  both interleaves two price series into one chart that looks normal. */
  it("keeps one spelling and drops the other", () => {
    const rows = [
      [3_000_000, 3, 3, 3, 3, 30, "BTCUSD"],
      [2_000_000, 2, 2, 2, 2, 20, "BTCUSDT"],
      [1_000_000, 1, 1, 1, 1, 10, "BTCUSDT"],
    ];
    const out = mapCandleRows(rows, "BTC");
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.close)).toEqual([1, 2]); // ascending, USDT only
  });

  /** No `base` = the caller already queried an exact symbol (the futures path).
   *  It must be passed through untouched. */
  it("does not filter when no base is supplied", () => {
    const rows = [
      [2_000_000, 2, 2, 2, 2, 20, "rithmic:GC"],
      [1_000_000, 1, 1, 1, 1, 10, "rithmic:GC"],
    ];
    expect(mapCandleRows(rows)).toHaveLength(2);
  });

  /** Rows with no symbol column (older shape) must still map. */
  it("tolerates rows without a symbol column", () => {
    expect(mapCandleRows([[1_000_000, 1, 2, 0.5, 1.5, 7]])).toHaveLength(1);
  });
});

describe("pickStoredInstrument", () => {
  /** Symbol alone is not an instrument: the table dedups on
   *  (timestamp, symbol, exchange, interval), so two venues storing the same
   *  symbol are two different order books sharing a name. */
  it("picks one venue when a symbol trades on several", () => {
    const picked = pickStoredInstrument("BTC", [
      ["BTCUSDT", "kraken"],
      ["BTCUSDT", "binance"],
    ]);
    expect(picked).toEqual({ symbol: "BTCUSDT", exchange: "binance" });
  });

  it("is deterministic — candidate order cannot change the answer", () => {
    const a = pickStoredInstrument("BTC", [
      ["BTCUSDT", "binance"],
      ["BTCUSDT", "kraken"],
    ]);
    const b = pickStoredInstrument("BTC", [
      ["BTCUSDT", "kraken"],
      ["BTCUSDT", "binance"],
    ]);
    expect(a).toEqual(b);
  });

  it("resolves the symbol preference first, then the venue", () => {
    // USDT wins over USD by QUOTE_SUFFIXES order, and only that symbol's
    // venues are then considered — a venue on the losing symbol is irrelevant.
    const picked = pickStoredInstrument("BTC", [
      ["BTCUSD", "aaa_exchange"],
      ["BTCUSDT", "zzz_exchange"],
    ]);
    expect(picked).toEqual({ symbol: "BTCUSDT", exchange: "zzz_exchange" });
  });

  it("reports nothing rather than inventing an instrument", () => {
    expect(pickStoredInstrument("BTC", [])).toBeNull();
  });
});
