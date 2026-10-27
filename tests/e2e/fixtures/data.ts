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

/**
 * A history recorder beside the `btc` recorder: the `history.binance-usdm`
 * template, an instance of it and its /status, shaped like the real one from
 * the smoke run on oryx (2026-10-27). One ETHUSDT series failed its last
 * check. Install after installHome: it replaces the instances list.
 */
export const HISTORY_TEMPLATE = {
  id: "history.binance-usdm",
  version: 1,
  kind: "recorder",
  display_name: "Binance USDⓈ-M futures history",
  description: "Binance's public archive for USDⓈ-M perpetual futures.",
  image: "ghcr.io/nuniesmith/fks-bot-history:latest",
  modes: ["record"],
  secrets_allowed: [],
  resources: { cpu: 0.5, memory_mb: 256 },
  data: { venue: "binance", market: "usdm" },
  params: {
    type: "object",
    required: ["symbols", "datasets"],
    properties: {
      symbols: {
        "x-order": 1,
        type: "array",
        title: "Symbols",
        items: { type: "string", "x-format": "symbol" },
        minItems: 1,
      },
      datasets: {
        "x-order": 2,
        type: "array",
        title: "Datasets",
        items: { enum: ["klines", "fundingRate", "metrics"] },
        default: ["klines", "fundingRate", "metrics"],
      },
      intervals: {
        "x-order": 3,
        type: "array",
        title: "Candle intervals",
        items: { enum: ["1m", "1h", "1d"] },
        default: ["1m", "1h", "1d"],
      },
      start_year: { "x-order": 4, type: "integer", title: "From the start of", minimum: 2019, maximum: 2026, default: 2020 },
    },
  },
};

export async function installHistory(page: Page): Promise<void> {
  const now = Date.now();
  const recorder = (name: string, template: string, image: string, params: Record<string, unknown>) => ({
    name,
    kind: "recorder",
    template,
    template_version: 1,
    params,
    template_unreadable: false,
    mode: "record",
    image,
    bot_id: name,
    data_dir: `/srv/fks-lake/raw/binance/usdm/${name}`,
    container: { id: `c-${name}`, state: "running", status: "Up 1 hour", started_at: null },
  });
  const series = (dataset: string, symbol: string, interval: string | null, over: Record<string, unknown> = {}) => ({
    dataset,
    symbol,
    interval,
    expected: 37,
    present: 36,
    pending: 1,
    not_published: 0,
    errors: 0,
    bytes: 16_220,
    first: "2026-08",
    last: "2026-10-25",
    ...over,
  });
  const routes: Record<string, unknown> = {
    "/api/spawner/instances": {
      db_enabled: true,
      instances: [
        recorder("btc", "recorder.binance-usdm", "ghcr.io/nuniesmith/fks-bot-recorder:latest", { symbols: ["BTCUSDT"] }),
        recorder("majors-history", "history.binance-usdm", "ghcr.io/nuniesmith/fks-bot-history:latest", {
          symbols: ["BTCUSDT", "ETHUSDT"],
          datasets: ["klines", "fundingRate", "metrics"],
          intervals: ["1d"],
          start_year: 2026,
        }),
      ],
    },
    "/api/spawner/bots/majors-history/status": {
      ok: true,
      bot_id: "majors-history",
      status: {
        bot_id: "majors-history",
        kind: "history",
        market: "usdm",
        symbols: ["BTCUSDT", "ETHUSDT"],
        datasets: ["klines", "fundingRate", "metrics"],
        intervals: ["1d"],
        start: "2026-08",
        started_at_ms: now - 3_600_000,
        updated_at_ms: now - 4_000,
        cycle: {
          running: false,
          started_at_ms: now - 3_540_000,
          finished_at_ms: now - 3_488_000,
          next_at_ms: now + 18_000_000,
          planned: 252,
          checked: 252,
          downloaded: 247,
          errors: 1,
        },
        last_success_ms: null,
        downloads_total: 247,
        errors_total: 1,
        series: {
          "klines/BTCUSDT/1d": series("klines", "BTCUSDT", "1d"),
          "fundingRate/BTCUSDT/-": series("fundingRate", "BTCUSDT", null, { expected: 2, present: 2, pending: 0, bytes: 1_820, last: "2026-09" }),
          "metrics/BTCUSDT/-": series("metrics", "BTCUSDT", null, { expected: 87, present: 86, bytes: 1_009_409, first: "2026-08-01" }),
          "klines/ETHUSDT/1d": series("klines", "ETHUSDT", "1d", { present: 35, errors: 1 }),
        },
        recent_errors: [
          { file: "ETHUSDT-1d-2026-10-20.zip", error: "sha256 3f1a… != published 9c2e…", at_ms: now - 3_500_000 },
        ],
      },
    },
    "/api/spawner/templates": { templates: [RECORDER_TEMPLATE, HISTORY_TEMPLATE], errors: [] },
  };
  await page.route(
    (url) => url.pathname in routes,
    (route) => route.fulfill({ json: routes[new URL(route.request().url()).pathname] }),
  );
}
