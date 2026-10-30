import type { Page } from "@playwright/test";

/**
 * Hermetic Home (and Money) data: every spawner read the account cards,
 * Running, Data capture and Edges panels make, route-mocked. Mirrors oryx on
 * 2026-10-26: one Kraken key, the live crypto-regime bot holding the
 * `kraken:spot:default` lease, and the `btc` recorder.
 *
 * `tall` adds running recorders until the page is far taller than a laptop
 * viewport, so the "page owns the only scroll / no nested scroller" guards
 * have something to bite on (an honest-empty Home fits on one screen and
 * would pass them vacuously).
 *
 * Matchers are pathname predicates, not globs: in dev Vite serves source
 * modules by path, and a `**\/api/**` glob would also catch /src/lib/api/*.
 */
export async function installHome(page: Page, opts: { tall?: boolean } = {}): Promise<void> {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const container = (bot_id: string, mode: string, image: string) => ({
    id: `c-${bot_id}`,
    id_full: `c-${bot_id}-full`,
    name: `fks-bot-${bot_id}`,
    image,
    status: "Up 2 hours (healthy)",
    state: "running",
    bot_id,
    mode,
    created_at: iso(7_200_000),
    started_at: iso(7_200_000),
    finished_at: null,
    labels: {},
    cpu_percent: null,
    memory_bytes: null,
    memory_limit_bytes: null,
  });
  const extra = opts.tall ? 18 : 0;
  const recorderIds = ["btc", ...Array.from({ length: extra }, (_, i) => `rec-${i}`)];
  const containers = [
    container("crypto-regime", "live", "ghcr.io/nuniesmith/fks-bot-crypto:latest"),
    ...recorderIds.map((id) => container(id, "record", "ghcr.io/nuniesmith/fks-bot-recorder:latest")),
  ];
  const instances = recorderIds.map((id) => ({
    name: id,
    kind: "recorder",
    template: "recorder.binance-usdm",
    template_version: 1,
    params: { symbols: ["BTCUSDT"] },
    template_unreadable: false,
    mode: "record",
    image: "ghcr.io/nuniesmith/fks-bot-recorder:latest",
    bot_id: id,
    data_dir: `/srv/fks-lake/raw/binance/usdm/${id}`,
    container: { id: `c-${id}`, state: "running", status: "Up 2 hours", started_at: null },
  }));
  const holdings = ["BTC", "ETH", "SOL", "LINK", "XRP", "INJ"].map((asset, i) => ({
    asset,
    qty: 0.01 * (i + 1),
    price: 1000 * (6 - i),
    value: 60 - i * 5,
    weight: 0.18 - i * 0.02,
    target_weight: 0.17,
  }));
  const routes: Record<string, unknown> = {
    "/api/spawner/secrets/status": {
      db_enabled: true,
      exchanges: [{ exchange: "kraken", updated_at: iso(86_400_000) }],
      total: 1,
    },
    "/api/spawner/configs": {
      db_enabled: true,
      total: 1,
      configs: [
        {
          id: "cfg-1",
          name: "crypto-regime",
          image: "ghcr.io/nuniesmith/fks-bot-crypto:latest",
          mode: "live",
          cpu_limit: 1,
          memory_mb: 512,
          env: { TZ: "UTC", CRYPTO_DISCORD_WEBHOOK_URL: "<redacted>" },
          env_redacted: ["CRYPTO_DISCORD_WEBHOOK_URL"],
          secrets: ["kraken"],
          bot_id: "crypto-regime",
          account: "kraken:spot:default",
          template: null,
          template_unreadable: false,
        },
      ],
    },
    "/api/spawner/leases": {
      db_enabled: true,
      total: 1,
      leases: [
        {
          account: "kraken:spot:default",
          bot_id: "crypto-regime",
          container_id: "c-crypto-regime",
          acquired_at: iso(7_200_000),
          heartbeat_at: iso(30_000),
          expires_at: new Date(now + 60_000).toISOString(),
          live: true,
        },
      ],
    },
    "/api/spawner/containers": { containers, total: containers.length, running: containers.length },
    "/api/spawner/instances": { db_enabled: true, instances },
    "/api/spawner/edges": { db_enabled: true, total: 0, edges: [] },
    "/api/spawner/ladder": { db_enabled: true, edges: [], hypotheses: [], experiments: [], deployments: [], effort: [] },
    "/api/spawner/bots/crypto-regime/status": {
      ok: true,
      bot_id: "crypto-regime",
      status: {
        bot: "crypto-regime",
        market: "spot",
        mode: "live",
        uptime_secs: 7200,
        net_worth_usd: 321.2,
        pnl_usd: 102.85,
        trades_total: 14,
        exchanges: [
          {
            exchange: "kraken",
            mode: "live",
            cash_asset: "USD",
            cash: 16.11,
            total_value: 321.2,
            max_drift: 0.056,
            triggered: false,
            last_rebalance: Math.floor(now / 1000) - 3 * 86_400,
            updated: Math.floor(now / 1000) - 20,
            holdings,
          },
        ],
      },
    },
    "/api/market/coverage": {
      ok: true,
      table: "candles_crypto",
      rows: ["BTCUSDT", "ETHUSDT"].flatMap((symbol) => [
        { symbol, interval: "1m", bars: 49_805, first: "2026-09-22T00:54:00Z", last: iso(60_000) },
        { symbol, interval: "5m", bars: 9_960, first: "2026-09-22T00:55:00Z", last: iso(300_000) },
      ]),
    },
  };
  await page.route(
    (url) => url.pathname in routes,
    (route) => route.fulfill({ json: routes[new URL(route.request().url()).pathname] }),
  );
}
