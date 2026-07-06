import { describe, it, expect } from "vitest";
import {
  computeIndicators,
  parseIndicatorSpec,
  periodParam,
  factorParam,
  INDICATOR_CATALOG,
  type Candle,
  type Point,
} from "./indicators";

// Build a candle series from a close array. High/low default to the close
// (flat candles) unless overridden; volume defaults to 0. Times are evenly
// spaced epoch seconds so we can assert alignment.
function candles(
  closes: number[],
  opts: { volume?: number[]; high?: number[]; low?: number[] } = {},
): Candle[] {
  return closes.map((c, i) => ({
    time: 1000 + i * 60,
    open: c,
    high: opts.high?.[i] ?? c,
    low: opts.low?.[i] ?? c,
    close: c,
    volume: opts.volume?.[i] ?? 0,
  }));
}

const vals = (pts: Point[]): number[] => pts.map((p) => p.value);

describe("computeIndicators", () => {
  it("returns {} for no names and ignores empty / unknown names", () => {
    expect(computeIndicators(candles([1, 2, 3]), [])).toEqual({});
    expect(computeIndicators(candles([1, 2, 3]), ["", "  ", "nonsense"])).toEqual({});
  });

  it("SMA(3) omits the warm-up and averages a trailing window, aligned to candle time", () => {
    const out = computeIndicators(candles([1, 2, 3, 4, 5]), ["sma3"]);
    expect(vals(out.sma3)).toEqual([2, 3, 4]);
    // first point is the 3rd candle (index 2) — warm-up omitted
    expect(out.sma3[0].time).toBe(1000 + 2 * 60);
  });

  it("RSI is 100 on a strictly rising series (no losses)", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const out = computeIndicators(candles(closes), ["rsi"]);
    expect(out.rsi.length).toBeGreaterThan(0);
    for (const p of out.rsi) expect(p.value).toBe(100);
  });

  it("OBV adds volume on up-closes and subtracts on down-closes", () => {
    const out = computeIndicators(
      candles([10, 11, 10, 12], { volume: [5, 3, 2, 4] }),
      ["obv"],
    );
    expect(vals(out.obv)).toEqual([0, 3, 1, 5]);
  });

  it("Bollinger Bands collapse to the mean on a constant series (zero stdev)", () => {
    const out = computeIndicators(candles(new Array(25).fill(100)), ["bbands"]);
    expect(out.bb_upper.length).toBeGreaterThan(0);
    expect(out.bb_upper.length).toBe(out.bb_middle.length);
    for (let i = 0; i < out.bb_upper.length; i++) {
      expect(out.bb_middle[i].value).toBe(100);
      expect(out.bb_upper[i].value).toBe(100);
      expect(out.bb_lower[i].value).toBe(100);
    }
  });

  it("VWAP equals the price when H=L=C is constant", () => {
    const out = computeIndicators(
      candles(new Array(5).fill(50), { volume: [1, 1, 1, 1, 1] }),
      ["vwap"],
    );
    expect(out.vwap.length).toBe(5);
    for (const p of out.vwap) expect(p.value).toBe(50);
  });

  it("MACD emits line / signal / hist once there is enough data", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const out = computeIndicators(candles(closes), ["macd"]);
    expect(out.macd_line.length).toBeGreaterThan(0);
    expect(out.macd_signal.length).toBeGreaterThan(0);
    expect(out.macd_hist.length).toBeGreaterThan(0);
  });

  it("supports dynamic ema<N> / sma<N> / wma<N> names", () => {
    const out = computeIndicators(candles([1, 2, 3, 4, 5]), ["ema2", "wma2"]);
    expect(out.ema2).toBeDefined();
    expect(out.wma2).toBeDefined();
    // WMA(2) of the first window [1,2] with weights (1,2)/3 = (1·1 + 2·2)/3
    expect(out.wma2[0].value).toBeCloseTo((1 * 1 + 2 * 2) / 3, 4);
  });

  it("tolerates a series too short for the requested indicator", () => {
    // 3 candles < RSI(14) warm-up → no points, not a throw.
    expect(computeIndicators(candles([1, 2, 3]), ["rsi", "atr"])).toEqual({
      rsi: [],
      atr: [],
    });
  });
});

describe("parseIndicatorSpec", () => {
  it("splits name and colon params, lowercasing and trimming", () => {
    expect(parseIndicatorSpec("bb:20:2")).toEqual({ name: "bb", params: [20, 2] });
    expect(parseIndicatorSpec(" RSI:9 ")).toEqual({ name: "rsi", params: [9] });
    expect(parseIndicatorSpec("vwap")).toEqual({ name: "vwap", params: [] });
    expect(parseIndicatorSpec("keltner:20:1.5")).toEqual({ name: "keltner", params: [20, 1.5] });
  });

  it("preserves param positions for malformed slots (NaN, per-slot fallback)", () => {
    const { params } = parseIndicatorSpec("bb:x:3");
    expect(Number.isNaN(params[0])).toBe(true);
    expect(params[1]).toBe(3);
  });

  it("handles empty input", () => {
    expect(parseIndicatorSpec("")).toEqual({ name: "", params: [] });
  });
});

describe("periodParam / factorParam", () => {
  it("periodParam falls back to the default and clamps to 2..500", () => {
    expect(periodParam([], 0, 14)).toBe(14);
    expect(periodParam([NaN], 0, 14)).toBe(14);
    expect(periodParam([9], 0, 14)).toBe(9);
    expect(periodParam([9.6], 0, 14)).toBe(10); // rounded to an integer
    expect(periodParam([0], 0, 14)).toBe(2);
    expect(periodParam([99999], 0, 14)).toBe(500);
  });

  it("factorParam falls back to the default and clamps to 0.1..10", () => {
    expect(factorParam([], 1, 2)).toBe(2);
    expect(factorParam([20, 1.5], 1, 2)).toBe(1.5);
    expect(factorParam([20, 0], 1, 2)).toBe(0.1);
    expect(factorParam([20, 100], 1, 2)).toBe(10);
  });
});

describe("computeIndicators with colon params", () => {
  it("rsi:<p> matches the bare-name default when p = 14 and differs when p ≠ 14", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 6);
    const c = candles(closes);
    expect(computeIndicators(c, ["rsi:14"]).rsi).toEqual(computeIndicators(c, ["rsi"]).rsi);
    const rsi5 = computeIndicators(c, ["rsi:5"]).rsi;
    // A shorter warm-up → more points than the default.
    expect(rsi5.length).toBeGreaterThan(computeIndicators(c, ["rsi"]).rsi.length);
  });

  it("bb:<p>:<std> parameterizes period and band width under stable keys", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + (i % 5));
    const c = candles(closes);
    const def = computeIndicators(c, ["bb"]);
    const wide = computeIndicators(c, ["bb:20:3"]);
    expect(Object.keys(wide).sort()).toEqual(["bb_lower", "bb_middle", "bb_upper"]);
    // Same middle band, wider upper band at 3σ vs 2σ.
    expect(wide.bb_middle).toEqual(def.bb_middle);
    const last = wide.bb_upper.length - 1;
    expect(wide.bb_upper[last].value).toBeGreaterThan(def.bb_upper[last].value);
  });

  it("stoch:<k>:<d> changes the warm-up length", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 4);
    const c = candles(closes, {
      high: closes.map((v) => v + 1),
      low: closes.map((v) => v - 1),
    });
    const short = computeIndicators(c, ["stoch:5:3"]);
    const long = computeIndicators(c, ["stoch:14:3"]);
    expect(short.stoch_k.length).toBeGreaterThan(long.stoch_k.length);
  });

  it("falls back to defaults for malformed params (bb:x:3 keeps period 20)", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + (i % 7));
    const c = candles(closes);
    const out = computeIndicators(c, ["bb:x:2"]);
    expect(out.bb_middle).toEqual(computeIndicators(c, ["bb"]).bb_middle);
  });

  it("macd:<f>:<s>:<g> is accepted and emits the standard keys", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 5);
    const out = computeIndicators(candles(closes), ["macd:5:15:4"]);
    expect(out.macd_line.length).toBeGreaterThan(0);
    expect(out.macd_signal.length).toBeGreaterThan(0);
    expect(out.macd_hist.length).toBeGreaterThan(0);
    // Faster EMAs → the line series starts earlier than the default 12/26.
    expect(out.macd_line.length).toBeGreaterThan(
      computeIndicators(candles(closes), ["macd"]).macd_line.length,
    );
  });
});

describe("INDICATOR_CATALOG", () => {
  it("exposes the expected indicator set", () => {
    const ids = INDICATOR_CATALOG.map((m) => m.id);
    expect(INDICATOR_CATALOG.length).toBe(16);
    for (const id of ["ema9", "sma20", "bbands", "rsi", "macd", "atr", "adx"]) {
      expect(ids).toContain(id);
    }
  });

  it("tags panes and lists the emit keys each indicator produces", () => {
    const rsi = INDICATOR_CATALOG.find((m) => m.id === "rsi");
    expect(rsi?.pane).toBe("separate");
    expect(rsi?.keys).toEqual(["rsi"]);

    const bb = INDICATOR_CATALOG.find((m) => m.id === "bbands");
    expect(bb?.pane).toBe("overlay");
    expect(bb?.keys).toEqual(["bb_upper", "bb_middle", "bb_lower"]);
  });
});
