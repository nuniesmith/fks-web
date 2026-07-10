import { describe, it, expect } from "vitest";
import {
  assetRows,
  latestRun,
  pickHeadline,
  fmtSigned,
  fmtRatePct,
  defaultBacktestParams,
  edgeStatusVariant,
  edgeTypeVariant,
  runStatusVariant,
} from "./edgeResults";
import type {
  BacktestAssetBase,
  BacktestResults,
  EdgeBacktestRun,
} from "$lib/types/spawner";

function base(overrides: Partial<BacktestAssetBase> = {}): BacktestAssetBase {
  return {
    trades: 42,
    win_rate: 0.55,
    avg_net_bps: 3.2,
    price_bps_per_trade: 1.1,
    funding_bps_per_trade: 4.0,
    cost_bps_per_trade: 1.9,
    max_dd_pct: 2.5,
    ...overrides,
  };
}

function run(overrides: Partial<EdgeBacktestRun> = {}): EdgeBacktestRun {
  return {
    id: "r1",
    edge_id: "e1",
    container_id: "c1",
    status: "completed",
    params: null,
    results: null,
    started_at: "2026-07-01T00:00:00Z",
    finished_at: "2026-07-01T01:00:00Z",
    ...overrides,
  };
}

describe("assetRows", () => {
  it("returns [] for missing results / assets", () => {
    expect(assetRows(null)).toEqual([]);
    expect(assetRows(undefined)).toEqual([]);
    expect(assetRows({})).toEqual([]);
  });

  it("maps skipped and stats entries, sorted by symbol", () => {
    const results: BacktestResults = {
      assets: {
        ETHUSDT: { skipped: "no funding data" },
        BTCUSDT: { base: base(), grid_positive_fraction: 0.7 },
      },
    };
    const rows = assetRows(results);
    expect(rows.map((r) => r.symbol)).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(rows[0].skipped).toBeNull();
    expect(rows[0].base?.trades).toBe(42);
    expect(rows[0].gridPositiveFraction).toBe(0.7);
    expect(rows[1].skipped).toBe("no funding data");
    expect(rows[1].base).toBeNull();
    expect(rows[1].gridPositiveFraction).toBeNull();
  });

  it("degrades an entry with neither skipped nor base to a visible skip row", () => {
    const rows = assetRows({ assets: { SOLUSDT: {} } });
    expect(rows).toHaveLength(1);
    expect(rows[0].skipped).toBe("no result recorded");
    expect(rows[0].base).toBeNull();
  });
});

describe("latestRun", () => {
  it("returns null for empty / missing input", () => {
    expect(latestRun(null)).toBeNull();
    expect(latestRun([])).toBeNull();
  });

  it("picks the most recently started run regardless of order", () => {
    const older = run({ id: "old", started_at: "2026-06-01T00:00:00Z" });
    const newer = run({ id: "new", started_at: "2026-07-01T00:00:00Z" });
    expect(latestRun([older, newer])?.id).toBe("new");
    expect(latestRun([newer, older])?.id).toBe("new");
  });

  it("treats unparseable timestamps as oldest, not as winners", () => {
    const bad = run({ id: "bad", started_at: "not-a-date" });
    const good = run({ id: "good", started_at: "2026-07-01T00:00:00Z" });
    expect(latestRun([bad, good])?.id).toBe("good");
  });
});

describe("pickHeadline", () => {
  it("returns null when there are no runnable assets", () => {
    expect(pickHeadline(null)).toBeNull();
    expect(pickHeadline({ assets: {} })).toBeNull();
    expect(
      pickHeadline({ assets: { BTCUSDT: { skipped: "nope" } } }),
    ).toBeNull();
  });

  it("ranks assets by avg_net_bps", () => {
    const results: BacktestResults = {
      assets: {
        BTCUSDT: { base: base({ avg_net_bps: 1.0, ann_return_pct: 99 }) },
        ETHUSDT: { base: base({ avg_net_bps: 5.0, ann_return_pct: 12.34 }) },
      },
    };
    const h = pickHeadline(results);
    expect(h?.symbol).toBe("ETHUSDT");
    expect(h?.text).toBe("+12.3% ann");
  });

  it("prefers ann return, then total return, then bps/trade for the label", () => {
    const ann = pickHeadline({
      assets: {
        A: { base: base({ ann_return_pct: 38.21, total_return_pct: 6.0 }) },
      },
    });
    expect(ann?.text).toBe("+38.2% ann");

    const total = pickHeadline({
      assets: { A: { base: base({ total_return_pct: -4.06 }) } },
    });
    expect(total?.text).toBe("-4.1% total");

    const bps = pickHeadline({
      assets: { A: { base: base({ avg_net_bps: 3.44 }) } },
    });
    expect(bps?.text).toBe("+3.4 bps/trade");
  });

  it("ignores skipped assets when ranking", () => {
    const h = pickHeadline({
      assets: {
        SKIP: { skipped: "insufficient bars" },
        RUN: { base: base({ avg_net_bps: -0.5 }) },
      },
    });
    expect(h?.symbol).toBe("RUN");
    expect(h?.text).toBe("-0.5 bps/trade");
  });
});

describe("fmtSigned", () => {
  it("prefixes + for non-negative values and fixes decimals", () => {
    expect(fmtSigned(3.44)).toBe("+3.4");
    expect(fmtSigned(-1.26)).toBe("-1.3");
    expect(fmtSigned(0)).toBe("+0.0");
    expect(fmtSigned(1.234, 2)).toBe("+1.23");
  });
  it("returns — for missing / non-finite", () => {
    expect(fmtSigned(null)).toBe("—");
    expect(fmtSigned(undefined)).toBe("—");
    expect(fmtSigned(Number.NaN)).toBe("—");
  });
});

describe("fmtRatePct", () => {
  it("renders 0–1 fractions as whole percents", () => {
    expect(fmtRatePct(0.62)).toBe("62%");
    expect(fmtRatePct(0)).toBe("0%");
    expect(fmtRatePct(1)).toBe("100%");
  });
  it("passes already-percent values through", () => {
    expect(fmtRatePct(62)).toBe("62%");
  });
  it("returns — for missing", () => {
    expect(fmtRatePct(null)).toBe("—");
    expect(fmtRatePct(undefined)).toBe("—");
  });
});

describe("defaultBacktestParams", () => {
  it("prefills days + the edge's asset scope", () => {
    expect(JSON.parse(defaultBacktestParams(["BTCUSDT", "ETHUSDT"]))).toEqual({
      days: 60,
      symbols: ["BTCUSDT", "ETHUSDT"],
    });
  });
  it("uses an empty symbols list for empty / missing scope", () => {
    expect(JSON.parse(defaultBacktestParams([]))).toEqual({
      days: 60,
      symbols: [],
    });
    expect(JSON.parse(defaultBacktestParams(null))).toEqual({
      days: 60,
      symbols: [],
    });
  });
});

describe("badge variants", () => {
  it("gives each edge status a distinct colour", () => {
    const variants = ["research", "paper", "live", "retired"].map(
      edgeStatusVariant,
    );
    expect(variants).toEqual(["cyan", "amber", "green", "default"]);
    expect(new Set(variants).size).toBe(4);
    expect(edgeStatusVariant("unknown")).toBe("default");
  });

  it("distinguishes adaptive from rule edges", () => {
    expect(edgeTypeVariant("adaptive")).toBe("purple");
    expect(edgeTypeVariant("rule")).toBe("cyan");
    expect(edgeTypeVariant("other")).toBe("default");
  });

  it("maps run statuses", () => {
    expect(runStatusVariant("running")).toBe("amber");
    expect(runStatusVariant("completed")).toBe("green");
    expect(runStatusVariant("failed")).toBe("red");
    expect(runStatusVariant("weird")).toBe("default");
  });
});
