// Armed-path telemetry parsing: an unscraped live exporter must read as the
// honest "awaiting arm" state — never as fabricated zeros (the fake-success
// anti-pattern), and a Prometheus outage must read as an outage.

import { describe, expect, it } from "vitest";
import { buildTelemetry, parseInstantVector, type TelemetryParts } from "./promParse";

const vector = (result: unknown[]) => ({
  status: "success",
  data: { resultType: "vector", result },
});
const sample = (labels: Record<string, string>, v: number | string) => ({
  metric: labels,
  value: [1_770_000_000, String(v)],
});

const EMPTY_PARTS: TelemetryParts = {
  halt: [],
  breaker: [],
  stopPresent: [],
  stopExpected: [],
  orderErrors: [],
  openPositions: [],
  openNotional: [],
  entryUnix: [],
};

describe("parseInstantVector", () => {
  it("parses a well-formed instant vector", () => {
    const out = parseInstantVector(
      vector([sample({ symbol: "ETHUSDTM", mode: "live" }, "1")]),
    );
    expect(out).toEqual([{ labels: { symbol: "ETHUSDTM", mode: "live" }, value: 1 }]);
  });
  it("returns null for malformed / failed responses (not an empty vector)", () => {
    expect(parseInstantVector(null)).toBeNull();
    expect(parseInstantVector({ status: "error" })).toBeNull();
    expect(parseInstantVector({ status: "success", data: { resultType: "matrix", result: [] } })).toBeNull();
    expect(parseInstantVector("nope")).toBeNull();
  });
  it("skips non-finite samples rather than fabricating numbers", () => {
    const out = parseInstantVector(vector([sample({ symbol: "A" }, "NaN")]));
    expect(out).toEqual([]);
  });
});

describe("buildTelemetry — honest-empty discipline", () => {
  it("all queries failed → available:false (Prometheus outage, not 'all clear')", () => {
    const t = buildTelemetry({
      halt: null,
      breaker: null,
      stopPresent: null,
      stopExpected: null,
      orderErrors: null,
      openPositions: null,
      openNotional: null,
      entryUnix: null,
    });
    expect(t.available).toBe(false);
    expect(t.scraped).toBe(false);
  });
  it("reachable but zero series → scraped:false (paper mode / awaiting arm)", () => {
    const t = buildTelemetry(EMPTY_PARTS);
    expect(t.available).toBe(true);
    expect(t.scraped).toBe(false);
    expect(t.openPositions).toBeNull(); // null, not a fabricated 0
    expect(t.openNotionalUsd).toBeNull();
  });
  it("live series present → scraped:true with per-symbol views", () => {
    const t = buildTelemetry({
      ...EMPTY_PARTS,
      halt: [{ labels: { symbol: "ETHUSDTM" }, value: 1 }],
      breaker: [{ labels: { symbol: "ETHUSDTM" }, value: 0 }],
      openPositions: [{ labels: {}, value: 1 }],
      openNotional: [{ labels: {}, value: 3000 }],
    });
    expect(t.scraped).toBe(true);
    expect(t.haltBySymbol).toEqual({ ETHUSDTM: 1 });
    expect(t.breakerBySymbol).toEqual({ ETHUSDTM: 0 });
    expect(t.openPositions).toBe(1);
    expect(t.openNotionalUsd).toBe(3000);
  });
  it("stop divergence = expected>0 && present==0 (the #18 unprotected signal)", () => {
    const t = buildTelemetry({
      ...EMPTY_PARTS,
      stopPresent: [
        { labels: { symbol: "ETHUSDTM" }, value: 0 },
        { labels: { symbol: "AVAXUSDTM" }, value: 1 },
      ],
      stopExpected: [
        { labels: { symbol: "ETHUSDTM" }, value: 1 },
        { labels: { symbol: "AVAXUSDTM" }, value: 1 },
      ],
    });
    expect(t.stops.ETHUSDTM).toEqual({ present: 0, expected: 1, diverged: true });
    expect(t.stops.AVAXUSDTM).toEqual({ present: 1, expected: 1, diverged: false });
  });
  it("order errors are surfaced by class, largest first", () => {
    const t = buildTelemetry({
      ...EMPTY_PARTS,
      orderErrors: [
        { labels: { class: "stop_place" }, value: 2 },
        { labels: { class: "stop_cancel" }, value: 5 },
      ],
    });
    expect(t.orderErrors).toEqual([
      { cls: "stop_cancel", total: 5 },
      { cls: "stop_place", total: 2 },
    ]);
    expect(t.scraped).toBe(true);
  });
});
