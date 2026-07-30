import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Trade, TradesResponse } from "./trade";

/**
 * Q-4's deliverable is not the rendering fix — that is pinned by
 * `tests/e2e/performance-trades.spec.ts`. It is that the UNIT of `pnl_percent`
 * is written down where the person who eventually implements
 * `GET /api/trades` will read it. `hooks.server.ts` hardwires that route to
 * `{trades: []}`, so nothing else in the repo can contradict a wrong guess,
 * and the page had been dividing by 100 against a convention nobody had
 * recorded.
 *
 * These are source-contract assertions on purpose: a type has no runtime, so
 * the only thing a test can hold in place is that the interface still lives
 * here (not re-inlined into the component, where it was invisible) and still
 * carries its unit note. Both are exactly what a future refactor would drop.
 */

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("Trade wire type", () => {
  it("type-checks a minimal trade (every field but symbol is optional)", () => {
    const minimal: Trade = { symbol: "BTC-USDT" };
    const envelope: TradesResponse = {};
    expect(minimal.symbol).toBe("BTC-USDT");
    expect(envelope.trades).toBeUndefined();
  });

  it("records the pnl_percent unit at the interface", () => {
    const src = read("./trade.ts");
    expect(src).toMatch(/pnl_percent\?: number/);
    // The convention itself, not just the field: 2.5 means 2.5%.
    expect(src).toMatch(/ALREADY A PERCENT, NOT A FRACTION/);
  });

  it("keeps the interface out of the component that renders it", () => {
    const page = read("../../routes/performance/+page.svelte");
    expect(page).toMatch(/from ['"]\$lib\/types\/trade['"]/);
    expect(page).not.toMatch(/interface\s+Trade\b/);
    // The 100× bug must not come back by copy-paste.
    expect(page).not.toMatch(/pnlPct\s*\/\s*100/);
  });
});
