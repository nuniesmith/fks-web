import { describe, it, expect } from "vitest";
import {
  fmtPrice,
  fmtPct,
  fmtDollar,
  fmtMoney,
  fmtSignedMoney,
  fmtConfidence,
  fmtFixed,
  fmtInt,
  scoreColor,
  signalVariant,
  riskVariant,
  regimeVariant,
  directionVariant,
  fmtTime,
  fmtDateTime,
  fmtRelative,
} from "./format";

describe("fmtPrice", () => {
  it("adapts decimal precision to magnitude", () => {
    expect(fmtPrice(0.5)).toBe("0.500000"); // < 1 → 6 dp
    expect(fmtPrice(0.123456789)).toBe("0.123457"); // rounded to 6 dp
    expect(fmtPrice(1)).toBe("1.0000"); // < 100 → 4 dp
    expect(fmtPrice(99.99)).toBe("99.9900");
    expect(fmtPrice(100)).toBe("100.00"); // >= 100 → 2 dp
    expect(fmtPrice(1234.5)).toBe("1,234.50"); // thousands separator
    expect(fmtPrice(-0.5)).toBe("-0.500000"); // magnitude drives precision
  });
  it("returns — for null/undefined", () => {
    expect(fmtPrice(null)).toBe("—");
    expect(fmtPrice(undefined)).toBe("—");
  });
});

describe("fmtPct", () => {
  it("prefixes a sign and fixes 2 decimals", () => {
    expect(fmtPct(1.23)).toBe("+1.23%");
    expect(fmtPct(-0.45)).toBe("-0.45%");
    expect(fmtPct(0)).toBe("+0.00%");
    expect(fmtPct(null)).toBe("—");
  });
});

describe("fmtDollar", () => {
  it("formats signed P&L with a $ and 2 decimals", () => {
    expect(fmtDollar(12.34)).toBe("+$12.34");
    expect(fmtDollar(-5)).toBe("-$5.00");
    expect(fmtDollar(0)).toBe("+$0.00");
    expect(fmtDollar(null)).toBe("—");
  });

  // M-1: /exchanges renders a grouped `$12,345.67` net-worth stat in the SAME
  // `.stat-row` as `fmtDollar(spot.pnl_usd)`. Ungrouped, a five-figure PnL
  // ("+$4567.89") reads as four figures at a phone glance, and it disagrees
  // with the grouped notation sitting beside it for the same class of money.
  it("groups thousands so a five-figure PnL cannot read as four", () => {
    expect(fmtDollar(4567.89)).toBe("+$4,567.89");
    expect(fmtDollar(12345.67)).toBe("+$12,345.67");
    expect(fmtDollar(-1234567.8)).toBe("-$1,234,567.80");
    // Grouping must not disturb the sub-1000 rendering the 39 existing call
    // sites already show.
    expect(fmtDollar(999.5)).toBe("+$999.50");
  });
});

// M-1: promoted verbatim out of `$lib/treasury/cards.ts` — `format.ts` calls
// itself the anti-copy-paste module, and the only correctly-grouped money pair
// in the repo was buried in a treasury helper. `cards.ts` re-exports these, so
// `cards.test.ts` pins the SAME functions through the compat path.
describe("fmtMoney / fmtSignedMoney (promoted from treasury/cards)", () => {
  it("groups thousands and switches notation for non-USD", () => {
    expect(fmtMoney(1234.5)).toBe("$1,234.50");
    expect(fmtMoney(0)).toBe("$0.00");
    expect(fmtMoney(99.9, "CAD")).toBe("99.90 CAD");
  });

  it("never renders a missing figure as zero", () => {
    expect(fmtMoney(null)).toBe("—");
    expect(fmtMoney(undefined)).toBe("—");
    expect(fmtMoney(Number.NaN)).toBe("—");
    expect(fmtSignedMoney(null)).toBe("—");
  });

  it("signs a non-zero figure and leaves flat unsigned", () => {
    expect(fmtSignedMoney(12.34)).toBe("+$12.34");
    expect(fmtSignedMoney(-5)).toBe("-$5.00");
    expect(fmtSignedMoney(4567.89)).toBe("+$4,567.89");
    expect(fmtSignedMoney(0)).toBe("$0.00");
  });
});

describe("fmtConfidence", () => {
  it("accepts a fraction (0–1) or a percentage (1–100)", () => {
    expect(fmtConfidence(0.73)).toBe("73%");
    expect(fmtConfidence(0.5)).toBe("50%");
    expect(fmtConfidence(1)).toBe("100%"); // boundary: treated as a fraction
    expect(fmtConfidence(73)).toBe("73%");
    expect(fmtConfidence(null)).toBe("—");
  });
});

describe("fmtFixed", () => {
  it("fixes the requested decimals (default 2)", () => {
    expect(fmtFixed(3.14159)).toBe("3.14");
    expect(fmtFixed(3.14159, 4)).toBe("3.1416");
    expect(fmtFixed(10, 0)).toBe("10");
    expect(fmtFixed(null)).toBe("—");
  });
});

describe("fmtInt", () => {
  it("rounds and groups thousands", () => {
    expect(fmtInt(1234567)).toBe("1,234,567");
    expect(fmtInt(1234.6)).toBe("1,235");
    expect(fmtInt(0)).toBe("0");
    expect(fmtInt(null)).toBe("—");
  });
});

describe("scoreColor", () => {
  it("buckets a 0–100 score into a colour", () => {
    expect(scoreColor(85)).toBe("green");
    expect(scoreColor(70)).toBe("green"); // boundary
    expect(scoreColor(50)).toBe("cyan");
    expect(scoreColor(40)).toBe("cyan"); // boundary
    expect(scoreColor(30)).toBe("amber");
    expect(scoreColor(20)).toBe("amber"); // boundary
    expect(scoreColor(10)).toBe("red");
  });
});

describe("signalVariant", () => {
  it("maps buy/sell/hold keywords to variants", () => {
    expect(signalVariant("buy")).toBe("green");
    expect(signalVariant("STRONG SELL")).toBe("red");
    expect(signalVariant("long")).toBe("green");
    expect(signalVariant("bear")).toBe("red");
    expect(signalVariant("hold")).toBe("amber");
    expect(signalVariant("whatever")).toBe("default");
    expect(signalVariant(null)).toBe("default");
  });
});

describe("riskVariant", () => {
  it("maps drawdown % to a risk colour", () => {
    expect(riskVariant(6)).toBe("red");
    expect(riskVariant(5)).toBe("amber"); // > 5 is strict
    expect(riskVariant(3)).toBe("amber");
    expect(riskVariant(2)).toBe("green"); // > 2 is strict
    expect(riskVariant(0)).toBe("green");
    expect(riskVariant(null)).toBe("default");
  });
});

describe("regimeVariant", () => {
  it("maps regime labels to variants (default cyan)", () => {
    expect(regimeVariant("Bull market")).toBe("green");
    expect(regimeVariant("risk off")).toBe("red");
    expect(regimeVariant("choppy range")).toBe("amber");
    expect(regimeVariant("high volatility")).toBe("purple");
    expect(regimeVariant("trending")).toBe("cyan");
    expect(regimeVariant(null)).toBe("default");
  });
});

describe("directionVariant", () => {
  it("maps exact long/short/buy/sell to a variant", () => {
    expect(directionVariant("long")).toBe("green");
    expect(directionVariant("BUY")).toBe("green");
    expect(directionVariant("short")).toBe("red");
    expect(directionVariant("sell")).toBe("red");
    expect(directionVariant("flat")).toBe("default");
    expect(directionVariant(null)).toBe("default");
  });
});

// The time formatters depend on the runner's timezone, so assert the guard
// cases exactly and only shape-check valid output (TZ-independent).
describe("fmtTime / fmtDateTime", () => {
  it("return — for null / invalid input", () => {
    expect(fmtTime(null)).toBe("—");
    expect(fmtTime("not-a-date")).toBe("—");
    expect(fmtDateTime(null)).toBe("—");
    expect(fmtDateTime("not-a-date")).toBe("—");
  });

  it("format valid timestamps in the expected shape", () => {
    expect(fmtTime(Date.UTC(2025, 6, 18, 14, 32, 7))).toMatch(/^\d{1,2}:\d{2}:\d{2}$/);
    expect(fmtDateTime(Date.UTC(2025, 6, 18, 14, 32))).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+$/,
    );
  });

  // Q-5: `fmtDateTime` is a LOCAL wall clock (treasury's ledger, /performance,
  // /bots, /edges, /signals). `cockpit`'s `tsLabel` stamps the kill-sentinel
  // trip time in UTC with a trailing `Z`. Two near-identical
  // "YYYY-MM-DD HH:MM" strings in different zones on adjacent tabs is how an
  // operator mis-orders an incident timeline by their UTC offset, so the local
  // one must name its zone.
  it("names the zone, so it can never be mistaken for cockpit's UTC Z stamp", () => {
    const out = fmtDateTime(Date.UTC(2025, 6, 18, 14, 32));
    expect(out).not.toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    // A zone token follows the time: "EDT", "UTC", "GMT+5:30", …
    expect(out.split(" ")[2] ?? "").toMatch(/^[A-Z][A-Za-z0-9+:−-]*$/);
  });
});

describe("fmtRelative", () => {
  it("returns — for null / invalid input", () => {
    expect(fmtRelative(null)).toBe("—");
    expect(fmtRelative(undefined)).toBe("—");
    expect(fmtRelative("not-a-date")).toBe("—");
  });

  it("buckets an age into just-now / s / m / h / d ago", () => {
    const now = Date.now();
    expect(fmtRelative(now - 1_000)).toBe("just now");
    expect(fmtRelative(now - 30_000)).toBe("30s ago");
    expect(fmtRelative(now - 5 * 60_000)).toBe("5m ago");
    expect(fmtRelative(now - 2 * 3_600_000)).toBe("2h ago");
    expect(fmtRelative(now - 3 * 86_400_000)).toBe("3d ago");
  });

  it("clamps a future timestamp to just now (never negative)", () => {
    expect(fmtRelative(Date.now() + 60_000)).toBe("just now");
  });
});
