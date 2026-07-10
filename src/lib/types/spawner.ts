/**
 * FKS Bot Spawner — Shared Types
 *
 * Mirror of the Rust types in `src/spawner/src/models.rs` and
 * `src/spawner/src/db.rs`. Keep these in sync with the Rust definitions
 * — the spawner exposes JSON over HTTP at `/api/bots/*` (via nginx) or
 * `/api/spawner/*` (passthrough), so any field rename on either side
 * needs to be reflected here.
 */

// ─── Container info ──────────────────────────────────────────────────────

/** Bot mode label — informational, stored as a container label. */
export type BotMode = "paper" | "live" | "backtest" | "optimise" | "train";

/** A bot container as returned by `GET /containers` and `GET /container/:id`. */
export interface ContainerInfo {
  /** Short Docker container ID (12 chars). */
  id: string;
  /** Full 64-char container ID. */
  id_full: string;
  /** Container name — typically `fks-bot-<bot_id>`. */
  name: string;
  /** Image, e.g. `fks-bot-arbitrage:latest`. */
  image: string;
  /** Human-readable status string from Docker (e.g. "Up 5 minutes"). */
  status: string;
  /** Lifecycle state (e.g. "running", "exited", "dead"). */
  state: string;
  /** Bot identifier from the `fks.bot_id` label. */
  bot_id: string;
  /** Mode from the `fks.mode` label. */
  mode: string;
  /** ISO-8601 timestamp; null if unknown. */
  created_at: string | null;
  /** ISO-8601 timestamp; null if not yet started. */
  started_at: string | null;
  /** ISO-8601 timestamp; null if still running. */
  finished_at: string | null;
  /** All container labels (includes the `fks.*` ones plus user-supplied). */
  labels: Record<string, string>;
  /** Last sampled CPU % (per-core, optional — not always populated). */
  cpu_percent: number | null;
  /** Last sampled memory in bytes. */
  memory_bytes: number | null;
  /** Memory limit in bytes, if the container has one. */
  memory_limit_bytes: number | null;
}

/** Wrapper returned by `GET /containers`. */
export interface ContainersResponse {
  containers: ContainerInfo[];
  total: number;
  running: number;
}

// ─── Spawn ────────────────────────────────────────────────────────────────

/** Request body for `POST /spawn`. */
export interface SpawnRequest {
  /** Docker image — must start with the spawner's `ALLOWED_IMAGE_PREFIX`. */
  image: string;
  /** Optional bot id; auto-generated UUID when omitted. */
  bot_id?: string;
  /** Defaults to `"paper"`. */
  mode?: BotMode | string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  /** Fractional cores. */
  cpu_limit?: number;
  /** Megabytes. */
  memory_limit_mb?: number;
  cmd?: string[];
  entrypoint?: string[];
  /**
   * Exchanges whose stored credentials (submitted via /settings) the spawner
   * injects into the container env as `{EXCHANGE}_API_KEY/_API_SECRET`
   * (+ `_API_PASSPHRASE` when stored). The spawn fails with 400 if an
   * exchange has no stored credentials.
   */
  secrets?: string[];
}

/** Response body for `POST /spawn` (HTTP 201). */
export interface SpawnResponse {
  container_id: string;
  container_name: string;
  bot_id: string;
  image: string;
  mode: string;
  /** ISO-8601 timestamp. */
  started_at: string;
}

// ─── Action / health ──────────────────────────────────────────────────────

/** Generic ack body for stop/restart/remove. */
export interface ActionResponse {
  ok: boolean;
  container_id: string;
  action: string;
  message: string;
}

/** `GET /health` response. */
export interface HealthResponse {
  status: "ok";
  service: "fks-bot-spawner";
  version: string;
  running_bots: number;
  max_bots: number;
}

// ─── Run history (db feature) ────────────────────────────────────────────

/** A single row from the `bot_runs` table. */
export interface BotRun {
  id: string;
  container_id: string;
  container_name: string | null;
  image: string;
  mode: string;
  /** spawning | running | stopping | stopped | error | pruned */
  status: string;
  started_at: string;
  stopped_at: string | null;
  runtime_secs: number | null;
  error_message: string | null;
}

/** `GET /runs?limit=N` wrapper. When `db_enabled=false` the array is empty. */
export interface RunsResponse {
  runs: BotRun[];
  total: number;
  db_enabled: boolean;
}

// ─── Net-worth history (db feature) ──────────────────────────────────────

/**
 * One row from the spawner's `GET /net-worth` (durable `net_worth_snapshots`
 * table in ruby_db, appended by the spawner sampler). Rows come back ordered
 * by `ts`, oldest → newest. `venue` is null for a bot-level total (spans
 * venues). The endpoint returns a flat array — an empty array means either
 * no database is configured or nothing has been sampled yet.
 */
export interface NetWorthSnapshot {
  bot_id: string;
  /** ISO-8601 timestamp the reading was taken (DB clock). */
  ts: string;
  /** Total account value at `ts`, denominated in `currency`. */
  net_worth: number;
  currency: string;
  venue: string | null;
}

// ─── Saved spawn configs (db feature) ────────────────────────────────────

/** Request body for `POST /configs` — a named, reusable spawn template. */
export interface SaveConfigRequest {
  name: string;
  image: string;
  mode?: BotMode | string;
  cpu_limit?: number;
  memory_mb?: number;
  env?: Record<string, string>;
  /** Exchanges whose stored credentials the template injects at spawn time. */
  secrets?: string[];
}

/** A saved spawn config row from `GET /configs`. */
export interface BotConfig {
  id: string;
  name: string;
  image: string;
  mode: string;
  cpu_limit: number | null;
  memory_mb: number | null;
  env: Record<string, string>;
  /** Exchanges the template injects at spawn time (may be absent on old rows). */
  secrets?: string[];
}

/** `GET /configs` wrapper. When `db_enabled=false` the array is empty. */
export interface ConfigsResponse {
  configs: BotConfig[];
  total: number;
  db_enabled: boolean;
}

// ─── Stored exchange credentials (secret store) ──────────────────────────

/**
 * One stored credential id from the spawner's `GET /secrets/status`, surfaced
 * to the browser via the adapter's `GET /api/settings/exchange-keys/status`.
 * Only the id + last-upsert time — the secret itself is never returned.
 */
export interface StoredExchangeCredential {
  exchange: string;
  /** ISO-8601 timestamp of the last upsert, when known. */
  updated_at?: string;
}

/** `GET /api/settings/exchange-keys/status` wrapper. When `db_enabled=false`
 *  (no secret-store database, or the spawner is unreachable) the array is empty. */
export interface ExchangeKeysStatusResponse {
  db_enabled: boolean;
  exchanges: StoredExchangeCredential[];
}

// ─── Edge registry (db feature) ──────────────────────────────────────────

/** How the edge decides — adaptive (janus-driven) vs a fixed rule. */
export type EdgeType = "adaptive" | "rule";

/** Lifecycle stage of an edge in the portfolio. */
export type EdgeStatus = "research" | "paper" | "live" | "retired";

/** One edge from `GET /edges` — a registered, backtestable trading edge. */
export interface Edge {
  edge_id: string;
  display_name: string;
  edge_type: EdgeType;
  /** Symbols the edge trades. Empty ⇒ applies to all assets. */
  asset_scope: string[];
  status: EdgeStatus;
  /**
   * Docker image `POST /edges/:id/backtest` spawns. `null` ⇒ the edge has no
   * runnable backtest yet (the endpoint 400s) — disable the Run button.
   */
  backtest_image: string | null;
  /** Free-form provenance of how/when the edge was validated. */
  validation_record: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** `GET /edges` wrapper. When `db_enabled=false` the array is empty. */
export interface EdgesResponse {
  edges: Edge[];
  db_enabled: boolean;
  total: number;
}

/** Lifecycle of one backtest run. */
export type BacktestRunStatus = "running" | "completed" | "failed";

/**
 * Per-asset headline stats block (`results.assets.{SYMBOL}.base`).
 * bps figures are per-trade averages; the decomposition is
 * `avg_net_bps = price + funding − cost`.
 */
export interface BacktestAssetBase {
  trades: number;
  /** Fraction 0–1. */
  win_rate: number;
  avg_net_bps: number;
  price_bps_per_trade: number;
  funding_bps_per_trade: number;
  cost_bps_per_trade: number;
  total_return_pct?: number;
  ann_return_pct?: number;
  max_dd_pct: number;
}

/**
 * One entry of `results.assets` — either `{skipped: reason}` or a
 * `{base: {...}, grid_positive_fraction, ...}` stats object.
 */
export interface BacktestAssetResult {
  skipped?: string;
  base?: BacktestAssetBase;
  /** Fraction 0–1 of the parameter grid with positive expectancy. */
  grid_positive_fraction?: number;
  [key: string]: unknown;
}

/** The `results` JSON persisted on a finished backtest run. */
export interface BacktestResults {
  assets?: Record<string, BacktestAssetResult>;
  /** Provenance: which harness produced the numbers (honesty label). */
  harness?: string;
  /** Provenance: the effective parameter set, as a string (honesty label). */
  params_effective?: string;
  /** Populated on failed runs. */
  error?: string;
  [key: string]: unknown;
}

/** One row from `GET /edges/:id/backtests`. */
export interface EdgeBacktestRun {
  id: string;
  edge_id: string;
  container_id: string | null;
  status: BacktestRunStatus;
  params: Record<string, unknown> | null;
  /** Null while the run is still in flight. */
  results: BacktestResults | null;
  started_at: string;
  finished_at: string | null;
}

/** `GET /edges/:id/backtests?limit=N` wrapper. */
export interface EdgeBacktestsResponse {
  runs: EdgeBacktestRun[];
  total?: number;
  db_enabled?: boolean;
}

/** `POST /edges/:id/backtest` 202 body — the launched run. */
export interface StartBacktestResponse {
  run_id: string;
  container_id?: string | null;
  [key: string]: unknown;
}

/** Request body for `POST /edges` (UPSERT keyed by `edge_id`). */
export interface UpsertEdgeRequest {
  edge_id: string;
  display_name: string;
  edge_type: EdgeType | string;
  asset_scope?: string[];
  status?: EdgeStatus | string;
  backtest_image?: string | null;
  validation_record?: string | null;
  notes?: string | null;
  active?: boolean;
}

/** `POST /edges` ack. */
export interface UpsertEdgeResponse {
  ok?: boolean;
  edge_id?: string;
  [key: string]: unknown;
}

// ─── Errors ──────────────────────────────────────────────────────────────

/** Error envelope used by all 4xx/5xx responses. */
export interface SpawnerErrorBody {
  error: string;
  detail?: string;
}
