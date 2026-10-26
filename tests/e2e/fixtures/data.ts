import type { Page } from "@playwright/test";

/**
 * Hermetic recorder data for /data: the `btc` recorder's own /status (as the
 * spawner relays it) and its files scan, plus the recorder template for the
 * New-task form. Pathname predicates, like fixtures/home.ts.
 */
export const RECORDER_TEMPLATE = {
  id: "recorder.binance-usdm",
  version: 1,
  kind: "recorder",
  display_name: "Binance USDⓈ-M futures recorder",
  description: "Raw public data from Binance's USDⓈ-M perpetual futures.",
  image: "ghcr.io/nuniesmith/fks-bot-recorder:latest",
  modes: ["record"],
  secrets_allowed: [],
  resources: { cpu: 2, memory_mb: 512 },
  data: { venue: "binance", market: "usdm" },
  params: {
    type: "object",
    required: ["symbols"],
    properties: {
      symbols: {
        type: "array",
        title: "Symbols",
        description: "Perpetual contracts, e.g. BTCUSDT.",
        items: { type: "string", "x-format": "symbol" },
        minItems: 1,
      },
      streams: {
        type: "array",
        title: "Streams",
        items: { enum: ["forceOrder", "bookTicker", "markPrice@1s"] },
        default: ["forceOrder", "bookTicker", "markPrice@1s"],
        "x-labels": { forceOrder: "Liquidations", bookTicker: "Best bid/ask", "markPrice@1s": "Mark price and funding, every second" },
        "x-backfillable": { forceOrder: "no", bookTicker: "partly", "markPrice@1s": "no" },
        "x-est-mb-per-day": { forceOrder: 0.1, bookTicker: 415, "markPrice@1s": 2 },
      },
      rest_seconds: { type: "integer", title: "Seconds between REST snapshots", minimum: 60, maximum: 3600, default: 300 },
      backfill_oi: { type: "boolean", title: "Also backfill open interest from Binance Vision", default: false },
    },
  },
};

export async function installRecorder(page: Page): Promise<void> {
  const now = Date.now();
  const day = (offset: number) => new Date(now - offset * 86_400_000).toISOString().slice(0, 10);
  const streams = ["bookTicker", "forceOrder", "markPrice"];
  const files = [0, 1, 2].flatMap((d) =>
    streams.map((stream) => ({
      symbol: "BTCUSDT",
      stream,
      day: day(d),
      bytes: stream === "bookTicker" ? 415_000_000 : 2_000_000,
      closed: d > 0,
    })),
  );
  const routes: Record<string, unknown> = {
    "/api/spawner/bots/btc/status": {
      ok: true,
      bot_id: "btc",
      status: {
        bot_id: "btc",
        venue: "binance-usdm",
        symbols: ["BTCUSDT"],
        started_at_ms: now - 7_200_000,
        updated_at_ms: now - 500,
        groups: {
          market: { connected: true, last_connect_ts_ms: now - 7_200_000, last_disconnect_ts_ms: null, disconnects: 0, gap_ms_total: 657 },
          public: { connected: true, last_connect_ts_ms: now - 7_200_000, last_disconnect_ts_ms: null, disconnects: 1, gap_ms_total: 3_677 },
        },
        streams: {
          "btcusdt@bookTicker": { symbol: "BTCUSDT", stream: "bookTicker", group: "public", count: 7_200_000, bytes: 1, last_recv_ts_ms: now - 20 },
          "btcusdt@markPrice@1s": { symbol: "BTCUSDT", stream: "markPrice@1s", group: "market", count: 7_200, bytes: 1, last_recv_ts_ms: now - 400 },
          "btcusdt@forceOrder": { symbol: "BTCUSDT", stream: "forceOrder", group: "market", count: 31, bytes: 1, last_recv_ts_ms: now - 600_000 },
        },
      },
    },
    "/api/spawner/instances/btc/files": {
      ok: true,
      name: "btc",
      data_dir: "/srv/fks-lake/raw/binance/usdm/btc",
      coverage: {
        days: [day(0), day(1), day(2)],
        files,
        gaps: [{ day: day(1), group: "public", count: 1, seconds: 3, reasons: { disconnect: 1 } }],
        unreadable_gap_lines: 0,
        first_day: day(2),
        last_day: day(0),
        total_days: 3,
        total_bytes: files.reduce((s, f) => s + f.bytes, 0),
      },
      disk: { free_bytes: 290_000_000_000, total_bytes: 455_000_000_000 },
    },
    "/api/spawner/templates": { templates: [RECORDER_TEMPLATE], errors: [] },
  };
  await page.route(
    (url) => url.pathname in routes,
    (route) => route.fulfill({ json: routes[new URL(route.request().url()).pathname] }),
  );
}
