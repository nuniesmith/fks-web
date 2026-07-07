import { describe, expect, it } from "vitest";
import {
  promSamplesToLine,
  promRangeToLine,
  promRangeByLabel,
  promRangeHasData,
  type PromRangeResponse,
  type PromRangeSeries,
} from "./prometheus";

/** A minimal matrix range response wrapping the given series. */
function rangeResp(result: PromRangeSeries[]): PromRangeResponse {
  return { status: "success", data: { resultType: "matrix", result } };
}

describe("promSamplesToLine", () => {
  it("maps [ts, str] samples to finite {time, value} points", () => {
    expect(
      promSamplesToLine([
        [1000, "10.5"],
        [1060, "11"],
      ]),
    ).toEqual([
      { time: 1000, value: 10.5 },
      { time: 1060, value: 11 },
    ]);
  });

  it("floors fractional timestamps to whole seconds", () => {
    expect(promSamplesToLine([[1000.832, "5"]])).toEqual([{ time: 1000, value: 5 }]);
  });

  it("drops non-finite values (NaN / Inf strings)", () => {
    expect(
      promSamplesToLine([
        [1000, "NaN"],
        [1060, "+Inf"],
        [1120, "7"],
      ]),
    ).toEqual([{ time: 1120, value: 7 }]);
  });

  it("sorts ascending and collapses duplicate timestamps (last wins)", () => {
    expect(
      promSamplesToLine([
        [1060, "2"],
        [1000, "1"],
        [1060, "3"],
      ]),
    ).toEqual([
      { time: 1000, value: 1 },
      { time: 1060, value: 3 },
    ]);
  });

  it("returns [] for missing / malformed input", () => {
    expect(promSamplesToLine(undefined)).toEqual([]);
    expect(promSamplesToLine(null)).toEqual([]);
    expect(promSamplesToLine([[1000] as unknown as [number, string]])).toEqual([]);
  });
});

describe("promRangeToLine", () => {
  it("reshapes the single spot net-worth series", () => {
    const resp = rangeResp([
      {
        metric: { __name__: "fks_bot_net_worth_usd", market: "spot" },
        values: [
          [1783443425, "202.96162766435634"],
          [1783443485, "202.56136254371188"],
        ],
      },
    ]);
    expect(promRangeToLine(resp)).toEqual([
      { time: 1783443425, value: 202.96162766435634 },
      { time: 1783443485, value: 202.56136254371188 },
    ]);
  });

  it("sums across series per-timestamp when more than one matches", () => {
    const resp = rangeResp([
      { metric: { exchange: "Kraken" }, values: [[1000, "10"], [1060, "12"]] },
      { metric: { exchange: "KuCoin" }, values: [[1000, "5"], [1060, "6"]] },
    ]);
    expect(promRangeToLine(resp)).toEqual([
      { time: 1000, value: 15 },
      { time: 1060, value: 18 },
    ]);
  });

  it("returns [] when the range query has no series", () => {
    expect(promRangeToLine(rangeResp([]))).toEqual([]);
    expect(promRangeToLine(undefined)).toEqual([]);
    expect(promRangeToLine({ status: "success", data: {} })).toEqual([]);
  });
});

describe("promRangeByLabel", () => {
  it("splits into one sorted named series per label value", () => {
    const resp = rangeResp([
      { metric: { exchange: "KuCoin-spot" }, values: [[1000, "72.5"]] },
      { metric: { exchange: "Kraken" }, values: [[1000, "75.1"]] },
      { metric: { exchange: "Crypto.com" }, values: [[1000, "55.4"]] },
    ]);
    expect(promRangeByLabel(resp, "exchange")).toEqual([
      { key: "Crypto.com", points: [{ time: 1000, value: 55.4 }] },
      { key: "Kraken", points: [{ time: 1000, value: 75.1 }] },
      { key: "KuCoin-spot", points: [{ time: 1000, value: 72.5 }] },
    ]);
  });

  it("uses the fallback when the label is absent and drops empty series", () => {
    const resp = rangeResp([
      { metric: {}, values: [[1000, "1"]] },
      { metric: { exchange: "Kraken" }, values: [] },
    ]);
    expect(promRangeByLabel(resp, "exchange", "all")).toEqual([
      { key: "all", points: [{ time: 1000, value: 1 }] },
    ]);
  });
});

describe("promRangeHasData", () => {
  it("is true only when at least one finite point exists", () => {
    expect(promRangeHasData(rangeResp([{ metric: {}, values: [[1000, "1"]] }]))).toBe(true);
    expect(promRangeHasData(rangeResp([]))).toBe(false);
    expect(promRangeHasData(rangeResp([{ metric: {}, values: [] }]))).toBe(false);
    expect(promRangeHasData(rangeResp([{ metric: {}, values: [[1000, "NaN"]] }]))).toBe(false);
    expect(promRangeHasData(undefined)).toBe(false);
  });
});
