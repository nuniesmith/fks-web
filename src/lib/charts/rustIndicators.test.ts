import { describe, it, expect } from "vitest";
import {
  parseRustCatalog,
  rustOnlyIndicators,
  clampParam,
  defaultParams,
  computeQuery,
  computeLines,
  TS_COVERED_RUST_IDS,
  type RustIndicator,
  type RustParam,
} from "./rustIndicators";

// A slimmed sample mirroring the janus contract (order = trend→…→volume).
const SAMPLE = {
  count: 4,
  indicators: [
    {
      id: "ema",
      display_name: "EMA",
      category: "Overlay",
      params: [{ name: "period", kind: "Integer", default: 20, min: 2, max: 500 }],
    },
    {
      id: "macd",
      display_name: "MACD",
      category: "Oscillator",
      params: [
        { name: "fast_period", kind: "Integer", default: 12, min: 1, max: 500 },
        { name: "slow_period", kind: "Integer", default: 26, min: 1, max: 500 },
        { name: "signal_period", kind: "Integer", default: 9, min: 1, max: 500 },
      ],
    },
    {
      id: "parabolicsar",
      display_name: "Parabolic SAR",
      category: "Overlay",
      params: [{ name: "step", kind: "Float", default: 0.02, min: 0.001, max: 1 }],
    },
    {
      id: "adl",
      display_name: "ADL",
      category: "Oscillator",
      params: [],
    },
  ],
};

describe("parseRustCatalog", () => {
  it("returns [] for empty/unreachable (graceful degradation)", () => {
    expect(parseRustCatalog(null)).toEqual([]);
    expect(parseRustCatalog(undefined)).toEqual([]);
    expect(parseRustCatalog({})).toEqual([]);
    expect(parseRustCatalog({ count: 0, indicators: [] })).toEqual([]);
  });

  it("parses valid entries preserving order", () => {
    const out = parseRustCatalog(SAMPLE as any);
    expect(out.map((i) => i.id)).toEqual(["ema", "macd", "parabolicsar", "adl"]);
    expect(out[0].category).toBe("Overlay");
    expect(out[1].category).toBe("Oscillator");
    expect(out[3].params).toEqual([]);
  });

  it("drops malformed entries and duplicate ids", () => {
    const out = parseRustCatalog({
      indicators: [
        { id: "rsi", display_name: "RSI", category: "Oscillator", params: [] },
        { id: "rsi", display_name: "dupe", category: "Oscillator", params: [] },
        { display_name: "no id", category: "Overlay", params: [] } as any,
        { id: "", category: "Overlay", params: [] } as any,
      ],
    } as any);
    expect(out.map((i) => i.id)).toEqual(["rsi"]);
  });

  it("defaults unknown category/kind and coerces numeric fields", () => {
    const out = parseRustCatalog({
      indicators: [
        {
          id: "x",
          display_name: "X",
          category: "Bogus",
          params: [{ name: "p", kind: "Weird", default: "5", min: "1", max: "9" }],
        },
      ],
    } as any);
    expect(out[0].category).toBe("Oscillator");
    expect(out[0].params[0].kind).toBe("Float");
    expect(out[0].params[0].default).toBe(5);
    expect(out[0].params[0].min).toBe(1);
  });
});

describe("rustOnlyIndicators (dedupe vs TS)", () => {
  it("drops ids already covered by the TS engine, keeps Rust-only", () => {
    const parsed = parseRustCatalog(SAMPLE as any);
    const only = rustOnlyIndicators(parsed);
    // ema + macd are TS-covered → dropped; parabolicsar + adl are Rust-only.
    expect(only.map((i) => i.id)).toEqual(["parabolicsar", "adl"]);
  });

  it("all overlapping ids are in the covered set", () => {
    for (const id of ["ema", "sma", "wma", "macd", "atr", "rsi", "vwap"]) {
      expect(TS_COVERED_RUST_IDS.has(id)).toBe(true);
    }
    expect(TS_COVERED_RUST_IDS.has("parabolicsar")).toBe(false);
  });

  it("honors an override covered-set", () => {
    const parsed = parseRustCatalog(SAMPLE as any);
    const only = rustOnlyIndicators(parsed, new Set(["adl"]));
    expect(only.map((i) => i.id)).toEqual(["ema", "macd", "parabolicsar"]);
  });
});

describe("clampParam", () => {
  const intP: RustParam = { name: "period", kind: "Integer", default: 14, min: 2, max: 500 };
  const floatP: RustParam = { name: "std_dev", kind: "Float", default: 2, min: 0.1, max: 10 };

  it("rounds integers and clamps to range", () => {
    expect(clampParam(intP, 20.7)).toBe(21);
    expect(clampParam(intP, 1)).toBe(2);
    expect(clampParam(intP, 9999)).toBe(500);
  });

  it("keeps float precision (6dp) and clamps", () => {
    expect(clampParam(floatP, 2.5)).toBe(2.5);
    expect(clampParam(floatP, 0)).toBe(0.1);
    expect(clampParam(floatP, 99)).toBe(10);
  });

  it("falls back to default for non-finite", () => {
    expect(clampParam(intP, NaN)).toBe(14);
  });
});

describe("defaultParams", () => {
  it("maps each param name to its clamped default", () => {
    const macd = parseRustCatalog(SAMPLE as any)[1];
    expect(defaultParams(macd)).toEqual({ fast_period: 12, slow_period: 26, signal_period: 9 });
  });
  it("empty for param-less indicators", () => {
    const adl = parseRustCatalog(SAMPLE as any)[3];
    expect(defaultParams(adl)).toEqual({});
  });
});

describe("computeQuery", () => {
  const macd = parseRustCatalog(SAMPLE as any)[1];

  it("builds symbol/indicator/interval + forwarded tunables", () => {
    const qs = computeQuery({
      symbol: "BTCUSDT",
      indicator: macd,
      interval: "5m",
      params: { fast_period: 8, slow_period: 21, signal_period: 5 },
    });
    const p = new URLSearchParams(qs);
    expect(p.get("symbol")).toBe("BTCUSDT");
    expect(p.get("indicator")).toBe("macd");
    expect(p.get("interval")).toBe("5m");
    expect(p.get("fast_period")).toBe("8");
    expect(p.get("slow_period")).toBe("21");
    expect(p.get("signal_period")).toBe("5");
  });

  it("falls back to descriptor defaults (clamped) when params omitted", () => {
    const ema = parseRustCatalog(SAMPLE as any)[0];
    const p = new URLSearchParams(computeQuery({ symbol: "X", indicator: ema, interval: "1m" }));
    expect(p.get("period")).toBe("20");
  });

  it("clamps out-of-range param values before sending", () => {
    const ema = parseRustCatalog(SAMPLE as any)[0];
    const p = new URLSearchParams(
      computeQuery({ symbol: "X", indicator: ema, interval: "1m", params: { period: 9999 } }),
    );
    expect(p.get("period")).toBe("500");
  });
});

describe("computeLines", () => {
  it("extracts ordered lines from the series map", () => {
    const lines = computeLines({
      series: {
        macd_line: [{ time: 1, value: 1.2 }],
        macd_signal: [{ time: 1, value: 1.1 }],
        macd_histogram: [{ time: 1, value: 0.1 }],
      },
    });
    expect(lines.map((l) => l.key)).toEqual(["macd_line", "macd_signal", "macd_histogram"]);
    expect(lines[0].points).toEqual([{ time: 1, value: 1.2 }]);
  });

  it("returns [] when series missing", () => {
    expect(computeLines({})).toEqual([]);
    expect(computeLines(null)).toEqual([]);
  });
});
