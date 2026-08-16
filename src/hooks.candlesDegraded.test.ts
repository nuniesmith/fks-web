// R7: a QuestDB outage used to render every chart as an empty market with zero
// error signal — `queryCandles`'s catch returned `[]`, identical to a symbol
// that genuinely has no candles. This drives the real `/bars/:symbol/candles`
// dispatcher (via the exported `proxyBackend`, mirroring hooks.internalToken.
// test.ts / hooks.sessionHeader.test.ts) with a mocked global `fetch` standing
// in for QuestDB, and pins:
//   - a genuinely empty result (QuestDB up, zero rows) stays `degraded: false`
//   - a QuestDB exception/timeout, or a non-2xx answer, flips `degraded: true`
//     while still returning HTTP 200 with an empty `candles: []` (the plan's
//     chosen shape — a 502 would need re-plumbing all three client call sites,
//     none of which check `res.ok` today)
//   - the B3 1m-resample fallback (fires when the native-interval query comes
//     back empty) does NOT spuriously mark a response degraded when it
//     successfully recovers data, but DOES mark it degraded if it fails
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const QUESTDB = "http://questdb.test";
process.env.QUESTDB_INTERNAL_URL = QUESTDB;

let proxyBackend: (event: unknown) => Promise<Response>;

beforeAll(async () => {
  const mod = await import("./hooks.server");
  proxyBackend = (mod as { proxyBackend: typeof proxyBackend }).proxyBackend;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Minimal RequestEvent stand-in: `proxyBackend` reads only `.url` / `.request`. */
function makeEvent(path: string): unknown {
  const url = new URL(`http://webui.test${path}`);
  return { url, request: new Request(url) };
}

type Behavior = "network-error" | "http-error" | { dataset: unknown[] };

/**
 * Stub global `fetch` for the QuestDB `/exec?query=` calls `queryCandles`
 * makes. `behavior(sql)` inspects the decoded SQL literal to tell the primary
 * query apart from the B3 1m-resample fallback (`interval = '1m'`).
 */
function installQuestDb(behavior: (sql: string) => Behavior) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      // `URLSearchParams.get` already percent-decodes — do not decode again
      // (the SQL's `LIKE '...%'` has a lone `%`, which a second decode pass
      // throws on as a malformed escape).
      const sql = new URL(url).searchParams.get("query") ?? "";
      const result = behavior(sql);
      if (result === "network-error") throw new Error("ECONNREFUSED");
      if (result === "http-error") {
        return new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

async function getCandles(qs = "interval=5m&days_back=1&limit=10") {
  const res = await proxyBackend(makeEvent(`/bars/BTC/candles?${qs}`));
  expect(res.status).toBe(200);
  return (await res.json()) as { candles: unknown[]; degraded: boolean };
}

describe("R7 — /bars/:symbol/candles degraded flag", () => {
  it("genuinely zero rows (QuestDB up, empty dataset) → degraded: false", async () => {
    installQuestDb(() => ({ dataset: [] }));
    const body = await getCandles();
    expect(body.candles).toEqual([]);
    expect(body.degraded).toBe(false);
  });

  it("QuestDB unreachable (fetch throws) → candles: [], degraded: true", async () => {
    installQuestDb(() => "network-error");
    const body = await getCandles();
    expect(body.candles).toEqual([]);
    expect(body.degraded).toBe(true);
  });

  it("QuestDB answers non-2xx → candles: [], degraded: true", async () => {
    installQuestDb(() => "http-error");
    const body = await getCandles();
    expect(body.candles).toEqual([]);
    expect(body.degraded).toBe(true);
  });

  it("real rows at the native interval → populated candles, degraded: false", async () => {
    installQuestDb(() => ({
      // QuestDB dataset rows: [t_µs, open, high, low, close, volume], newest-first.
      dataset: [[2_000_000_000, 101, 102, 100, 101.5, 5]],
    }));
    const body = await getCandles();
    expect(body.candles.length).toBe(1);
    expect(body.degraded).toBe(false);
  });

  it("B3 resample recovers real data via the 1m fallback → NOT degraded", async () => {
    installQuestDb((sql) =>
      sql.includes("interval = '1m'")
        ? { dataset: [[60_000_000, 10, 11, 9, 10.5, 1]] }
        : { dataset: [] }, // native 15m interval genuinely has no stored rows
    );
    const body = await getCandles("interval=15m&days_back=1&limit=10");
    expect(body.candles.length).toBeGreaterThan(0);
    expect(body.degraded).toBe(false);
  });

  it("B3 fallback itself fails → degraded: true even though the primary query was a clean empty", async () => {
    installQuestDb((sql) => (sql.includes("interval = '1m'") ? "network-error" : { dataset: [] }));
    const body = await getCandles("interval=15m&days_back=1&limit=10");
    expect(body.candles).toEqual([]);
    expect(body.degraded).toBe(true);
  });
});
