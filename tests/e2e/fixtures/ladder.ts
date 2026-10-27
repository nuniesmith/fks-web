import type { Page } from "@playwright/test";

/**
 * A populated edge ladder for /edges (fks-spawner GET /ladder): one
 * hypothesis waiting for a search, one withdrawn, a USABLE search with a
 * deployment on paper (4 of 20 sessions) and one at backtest, a DO NOT
 * PASTE search with its reasons, a retired deployment, and the search
 * effort. Plus the registry and the accounts the Deploy form lists.
 * Pathname predicates, like fixtures/home.ts. Install after installHome.
 */
export const LADDER_EDGE = {
  edge_id: "liq-fade",
  display_name: "Liquidation fade",
  edge_type: "rule",
  asset_scope: ["BTCUSDT"],
  status: "research",
  backtest_image: null,
  validation_record: null,
  notes: null,
  active: true,
  created_at: "2026-10-27T03:00:00Z",
  updated_at: "2026-10-27T03:00:00Z",
};

const hypothesis = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  edge_id: "liq-fade",
  idea: "Liquidation clusters on BTCUSDT overshoot; fading the 5-minute move earns the snap-back.",
  symbols: ["BTCUSDT"],
  dataset: "raw/binance/usdm/btc 2026-10-27..2027-01-27",
  holdout_share: 0.25,
  params: [
    { name: "threshold_usd", min: 1000000, max: 20000000, step: 1000000 },
    { name: "side", choices: ["long", "short"] },
  ],
  baseline: "buy-and-hold",
  metric: "net return after fees",
  costs: { maker_bps: 40, taker_bps: 80, slippage_bps: 5 },
  registered_at: "2026-10-27T05:00:00Z",
  registered_by: "jordan",
  status: "registered",
  withdrawn_reason: null,
  withdrawn_at: null,
  ...over,
});

const experiment = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  study_name: `liq-fade-${id}`,
  config_fingerprint: "fp-liq",
  symbol: "BTCUSDT",
  bar_minutes: 5,
  hypothesis: null,
  hypothesis_id: 2,
  registered_at: null,
  tuned_params: ["threshold_usd"],
  n_trials: 40,
  train_days: 69,
  test_days: 23,
  folds: 4,
  holdout_folds: 1,
  selection_score: 1.42,
  holdout_score: 0.81,
  baseline_holdout_score: 0.12,
  overfit_gap: 0.61,
  selection_trades: 120,
  holdout_trades: 34,
  verdict: "USABLE",
  verdict_reasons: [],
  outcome: "pending",
  finished_at: "2026-10-28T00:00:00Z",
  created_at: "2026-10-28T00:00:00Z",
  ...over,
});

const deployment = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  experiment_id: 1,
  account_id: "kraken-main",
  symbol: "BTCUSDT",
  stage: "backtest",
  execution: "manual",
  params_snapshot: { threshold_usd: 5000000 },
  forward_sessions_required: null,
  forward_sessions_observed: 0,
  live_trades: 0,
  live_r_sum: 0,
  divergence_vs_backtest: null,
  since: "2026-10-29T00:00:00Z",
  retired_reason: null,
  created_at: "2026-10-29T00:00:00Z",
  updated_at: "2026-10-29T00:00:00Z",
  ...over,
});

export const LADDER = {
  db_enabled: true,
  edges: [LADDER_EDGE],
  hypotheses: [
    hypothesis(3),
    hypothesis(2),
    hypothesis(1, { status: "withdrawn", withdrawn_reason: "superseded by #2", withdrawn_at: "2026-10-27T04:59:00Z" }),
  ],
  experiments: [
    experiment(1),
    experiment(2, {
      verdict: "DO NOT PASTE",
      holdout_score: -0.2,
      holdout_trades: 9,
      verdict_reasons: ["U4: 9 holdout trades, under 30", "U3: holdout below the baseline"],
    }),
  ],
  deployments: [
    deployment(11, { stage: "forward", forward_sessions_required: 20, forward_sessions_observed: 4 }),
    deployment(12),
    deployment(10, { stage: "retired", retired_reason: "drift on 2 consecutive days" }),
  ],
  effort: [
    {
      symbol: "BTCUSDT",
      config_fingerprint: "fp-liq",
      experiments: 2,
      trials_total: 80,
      best_holdout: 0.81,
      usable: 1,
      adopted: 0,
      first_run: "2026-10-28T00:00:00Z",
      last_run: "2026-10-28T00:00:00Z",
    },
  ],
};

export async function installLadder(page: Page, ladder: unknown = LADDER): Promise<void> {
  const routes: Record<string, unknown> = {
    "/api/spawner/ladder": ladder,
    "/api/spawner/edges": { db_enabled: true, total: 1, edges: [LADDER_EDGE] },
    "/api/spawner/edges/liq-fade/backtests": { runs: [], total: 0, db_enabled: true },
    "/api/spawner/accounts": {
      db_enabled: true,
      total: 1,
      accounts: [
        {
          account_id: "kraken-main",
          display_name: "Kraken",
          tier: 1,
          account_class: "personal-crypto",
          venue: "kraken",
          role: "bot-trade",
          firm: null,
          compliance_flag: "manual-mirror",
          risk_caps: {},
          sizing: {},
          active: true,
        },
      ],
    },
  };
  await page.route(
    (url) => url.pathname in routes,
    (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: routes[new URL(route.request().url()).pathname] })
        : route.fallback(),
  );
}
