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
 * table in fks_db, appended by the spawner sampler). Rows come back ordered
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

/**
 * Request body for `POST /net-worth` — ONE hand-entered net-worth snapshot
 * (persisted with `source='manual'`). This is how balances without a watcher
 * node of their own (prop payout accounts, a bank balance, a hardware-wallet
 * total) get into the series. Records a reading only — can never move funds.
 */
export interface ManualNetWorthRequest {
  /** Logical account id (lands in the `bot_id` column so it joins /profit). */
  account_id: string;
  /** Value in `currency`. Must be finite. */
  net_worth: number;
  /** Defaults to USD server-side. */
  currency?: string;
  /** Optional venue/source tag (e.g. "apex", "chase-bank", "ledger"). */
  venue?: string | null;
}

/** `POST /net-worth` ack (201). 400 = validation, 503 = no database. */
export interface ManualNetWorthResponse {
  ok: boolean;
  account_id?: string;
  net_worth?: number;
  currency?: string;
  source?: string;
  db_enabled?: boolean;
  error?: string;
}

// ─── Treasury: transfers ledger + accounts registry + /profit (db feature) ─

/** Allowlisted `transfers.kind` values (mirrors the SQL CHECK constraint). */
export type TransferKind = "deposit" | "withdrawal" | "payout" | "sweep";

/** Who wrote the ledger row: operator entry vs a bot-detected balance jump. */
export type TransferSource = "manual" | "bot_detected";

/**
 * One row from `GET /transfers` (flat array, ordered oldest → newest like
 * /net-worth). SIGN CONVENTION: `amount` is signed from the account's point
 * of view — positive = money INTO the account (deposit), negative = money
 * OUT (withdrawal). Empty array = no database configured or no rows yet.
 */
export interface TransferRow {
  id: number;
  account_id: string;
  /** ISO-8601 timestamp of the flow. */
  ts: string;
  /** Signed flow: positive = in, negative = out. */
  amount: number;
  currency: string;
  kind: TransferKind | string;
  source: TransferSource | string;
  note: string | null;
}

/**
 * Request body for `POST /transfers` — append one signed cash-flow row so
 * net-worth drift decomposes into deposits vs trading profit (GET /profit).
 * `ts` (RFC3339) backdates an entry the operator records after the fact;
 * omitted = the DB stamps NOW(). `source` defaults to "manual" server-side.
 */
export interface RecordTransferRequest {
  account_id: string;
  /** Signed: positive = deposit in, negative = withdrawal out. Non-zero. */
  amount: number;
  kind: TransferKind | string;
  /** Defaults to USD server-side. */
  currency?: string;
  ts?: string;
  note?: string;
  source?: TransferSource | string;
}

/** `POST /transfers` ack (201). 400 = validation, 503 = no database. */
export interface RecordTransferResponse {
  ok: boolean;
  id?: number;
  account_id?: string;
  kind?: string;
  amount?: number;
  db_enabled?: boolean;
  error?: string;
}

/**
 * `GET /profit?account_id=&since=` — one account's net-worth drift
 * decomposed into external cash flows vs what it actually EARNED:
 *
 *     delta       = end_net_worth − start_net_worth
 *     net_inflows = deposits_in − withdrawals_out
 *     profit      = delta − net_inflows
 *
 * The window is bounded by the FIRST and LAST net_worth_snapshots rows in
 * range. With no database, or no snapshots in the window, every figure is
 * null — never an invented zero baseline.
 */
export interface ProfitResponse {
  account_id: string;
  /** Echo of the requested window start (null = full history). */
  since: string | null;
  db_enabled: boolean;
  start_ts: string | null;
  end_ts: string | null;
  start_net_worth: number | null;
  end_net_worth: number | null;
  delta: number | null;
  deposits_in: number | null;
  withdrawals_out: number | null;
  net_inflows: number | null;
  profit: number | null;
  /** Number of ledger rows inside the window. */
  transfers: number;
}

/**
 * One row from `GET /accounts` — the multi-account treasury topology's
 * source of truth. Topology + policy metadata only: the registry holds NO
 * credentials by design (keys live in the encrypted exchange_secrets store).
 */
export interface TreasuryAccount {
  /** Logical account identity (fks.bot_id for bot-traded accounts). */
  account_id: string;
  display_name: string | null;
  /** 0 = cold-BTC backbone, 1 = personal-crypto, 2 = rithmic-main, 3 = prop-copy-target. */
  tier: number;
  /** Coarse class: personal-crypto | paper | prop | cold-storage | … */
  account_class: string;
  venue: string | null;
  /** watch | bot-trade | human-trade-source | copy-target. */
  role: string;
  /** Prop firm the account belongs to (null for non-prop accounts). */
  firm: string | null;
  /** manual-mirror (human confirms every mirrored fill) | auto-fill. */
  compliance_flag: string;
  risk_caps: Record<string, unknown>;
  sizing: Record<string, unknown>;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** `GET /accounts` wrapper (active accounts first). */
export interface AccountsResponse {
  accounts: TreasuryAccount[];
  total: number;
  db_enabled: boolean;
}

/** Request body for `POST /accounts` (UPSERT keyed by `account_id`). */
export interface UpsertAccountRequest {
  account_id: string;
  display_name?: string | null;
  tier: number;
  account_class: string;
  venue?: string | null;
  role: string;
  firm?: string | null;
  compliance_flag?: string;
  risk_caps?: Record<string, unknown>;
  sizing?: Record<string, unknown>;
  active?: boolean;
}

/** `POST /accounts` ack. 400 = validation, 503 = no database. */
export interface UpsertAccountResponse {
  ok?: boolean;
  account_id?: string;
  created?: boolean;
  db_enabled?: boolean;
  error?: string;
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
  /**
   * Bot identity this template respawns as (`fks-bot-{bot_id}`) — makes the
   * saved config self-contained for `POST /configs/{name}/respawn`. Omitted
   * ⇒ the config has no respawn target (`resolve_respawn_bot_id` 400s unless
   * the caller passes an override in the respawn body).
   */
  bot_id?: string;
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
  /**
   * Bot identity the template respawns as. `null`/absent for configs saved
   * before the field existed or saved with no Bot ID — those configs are NOT
   * respawn-ready (`POST .../respawn` needs a body override instead).
   */
  bot_id?: string | null;
  /** The exchange account the bot trades, e.g. `kraken:spot:default` (leases). */
  account?: string | null;
  /** Set when the config is an instance made from a template. */
  template?: { id: string; version: number; params: Record<string, unknown> } | null;
  template_unreadable?: boolean;
  /**
   * Env names whose values the spawner replaced with `<redacted>` in this read
   * (fks-spawner #64). Saving the config back restores them server-side.
   */
  env_redacted?: string[];
}

/** `GET /configs` wrapper. When `db_enabled=false` the array is empty. */
export interface ConfigsResponse {
  configs: BotConfig[];
  total: number;
  db_enabled: boolean;
}

// ─── Respawn (db feature) ─────────────────────────────────────────────────

/**
 * Optional body for `POST /configs/{name}/respawn`. An explicit `bot_id`
 * overrides the config's stored one; omitted/empty uses the config's own
 * (400 `bot_id required (config has none)` if neither resolves).
 */
export interface RespawnRequest {
  bot_id?: string;
}

/**
 * `POST /configs/{name}/respawn` ack (200) — the atomic stop → force-remove
 * → re-spawn-from-config that re-injects CURRENT stored secrets, i.e. the
 * rotate-then-respawn path. Idempotent: `old_container_id` is `null` when the
 * bot wasn't running (nothing to remove). 400 = no bot_id resolvable, 404 =
 * config not found, 503 = spawner has no database configured.
 */
export interface RespawnResponse {
  bot_id: string;
  old_container_id: string | null;
  new_container_id: string;
  status: string;
  image: string;
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

// ─── Templates and instances (fks-spawner #61) ───────────────────────────────

/** What a template makes: a raw-data recorder, a bot, or a one-shot job. */
export type TemplateKind = "recorder" | "bot" | "job";

/**
 * One form field: the JSON-Schema subset the spawner validates
 * (crates/spawner/src/templates.rs), plus the `x-*` presentation hints the
 * form renders (labels per enum value, backfill badges, MB/day estimates).
 */
export interface TemplateField {
  type?: "string" | "integer" | "number" | "boolean" | "array";
  title?: string;
  description?: string;
  enum?: (string | number)[];
  items?: { type?: string; enum?: (string | number)[]; "x-format"?: string };
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  "x-format"?: string;
  "x-labels"?: Record<string, string>;
  "x-backfillable"?: Record<string, string>;
  "x-est-mb-per-day"?: Record<string, number>;
  "x-note"?: string;
  /** Display position in the form (the spawner's JSON loses the file's order). */
  "x-order"?: number;
}

export interface TemplateParams {
  type: "object";
  required?: string[];
  properties: Record<string, TemplateField>;
}

export interface Template {
  id: string;
  version: number;
  kind: TemplateKind;
  display_name: string;
  description?: string;
  image: string;
  modes: string[];
  resources?: { cpu?: number; memory_mb?: number };
  /** Recorders: where their files go, `LAKE_ROOT/raw/<venue>/<market>/<name>`. */
  data?: { venue: string; market: string } | null;
  params: TemplateParams;
}

export interface TemplatesResponse {
  templates: Template[];
  /** Template files that did not validate, with why. */
  errors: { file?: string; error?: string }[];
}

export interface InstanceRequest {
  template: string;
  name: string;
  params: Record<string, unknown>;
  mode?: string;
}

/** What an instance resolves to before anything is created. */
export interface InstancePlan {
  name: string;
  template_id: string;
  template_version: number;
  kind: TemplateKind;
  image: string;
  mode: string;
  env: Record<string, string>;
  params: Record<string, unknown>;
  cpu_limit: number | null;
  memory_mb: number | null;
  data_dir: string | null;
}

/** `POST /instances/validate` (and the 4xx bodies of `POST /instances`). */
export interface InstanceValidateResponse {
  ok: boolean;
  plan?: InstancePlan;
  /** One line per problem, form field first. */
  errors?: string[];
}

export interface InstanceCreateResponse {
  ok: boolean;
  name?: string;
  container_id?: string;
  data_dir?: string | null;
  errors?: string[];
}

export interface Instance {
  name: string;
  /** The template's kind (fks-spawner #64; absent from older spawners). */
  kind?: TemplateKind | null;
  template: string | null;
  template_version: number | null;
  params: Record<string, unknown> | null;
  template_unreadable: boolean;
  mode: string;
  image: string;
  bot_id: string;
  data_dir: string | null;
  container: { id: string; state: string; status: string; started_at: string | null } | null;
}

export interface InstancesResponse {
  db_enabled: boolean;
  instances: Instance[];
}

// ─── What a recorder has written (fks-spawner #64) ───────────────────────────

export interface CoverageFileDay {
  symbol: string;
  stream: string;
  day: string;
  bytes: number;
  /** Gzipped, and the open file is gone. */
  closed: boolean;
}

export interface CoverageGapDay {
  day: string;
  group: string;
  count: number;
  seconds: number;
  reasons: Record<string, number>;
}

export interface Coverage {
  /** Newest first. */
  days: string[];
  files: CoverageFileDay[];
  gaps: CoverageGapDay[];
  unreadable_gap_lines: number;
  first_day: string | null;
  last_day: string | null;
  total_days: number;
  total_bytes: number;
}

export interface InstanceFilesResponse {
  ok: boolean;
  name: string;
  data_dir: string;
  coverage: Coverage;
  disk: { free_bytes: number; total_bytes: number } | null;
}

// ─── Accounts as configured: leases and bot status (fks-spawner #62, #64) ────

/** One `account_leases` row: which bot holds which exchange account. */
export interface AccountLease {
  account: string;
  bot_id: string;
  container_id: string | null;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  /** Not expired, by Postgres's clock. */
  live: boolean;
}

export interface LeasesResponse {
  leases: AccountLease[];
  total: number;
  db_enabled: boolean;
}

/** A holding in a trading bot's `/status` (crypto-bot-core contract). */
export interface VenueHolding {
  asset: string;
  qty: number;
  price: number;
  value: number;
  weight: number;
  target_weight?: number;
}

export interface BotVenueStatus {
  exchange: string;
  mode?: string;
  cash_asset?: string;
  cash?: number;
  total_value?: number;
  max_drift?: number;
  triggered?: boolean;
  /** Unix seconds. */
  last_rebalance?: number;
  /** Unix seconds: when the bot last refreshed this venue's snapshot. */
  updated?: number;
  holdings?: VenueHolding[];
}

/** A trading bot's `/status` on :9091. */
export interface TradingBotStatus {
  bot: string;
  market?: string;
  mode: string;
  uptime_secs?: number;
  net_worth_usd?: number;
  pnl_usd?: number;
  signals_total?: number;
  trades_total?: number;
  wins?: number;
  losses?: number;
  win_rate?: number;
  exchanges?: BotVenueStatus[];
  expected_venues?: number;
}

/** A recorder's `/status` on :9091 (fks-spawner bots/recorder). */
export interface RecorderStatus {
  bot_id: string;
  venue: string;
  symbols: string[];
  started_at_ms: number;
  updated_at_ms: number;
  groups: Record<
    string,
    {
      connected: boolean;
      last_connect_ts_ms: number | null;
      last_disconnect_ts_ms: number | null;
      disconnects: number;
      gap_ms_total: number;
    }
  >;
  streams: Record<
    string,
    { symbol: string; stream: string; group: string; count: number; bytes: number; last_recv_ts_ms: number | null }
  >;
  rest_snapshots?: Record<
    string,
    { count: number; errors: number; last_poll_ts_ms: number | null; last_error: string | null }
  >;
}

/** One series a history recorder keeps: a dataset for a symbol (and a candle interval). */
export interface HistorySeries {
  dataset: string;
  symbol: string;
  /** Candle interval; null for funding and metrics. */
  interval: string | null;
  /** Files the plan asks for. */
  expected: number;
  /** On disk, verified against the archive's sha256. */
  present: number;
  /** Recent files the archive has not published yet ("not yet"). */
  pending: number;
  /** Old 404s, e.g. before the symbol listed ("never"); asked again weekly. */
  not_published: number;
  /** Failed in the last check; retried at the next. */
  errors: number;
  bytes: number;
  /** Oldest and newest period on disk: `YYYY-MM` (monthly) or `YYYY-MM-DD` (daily). */
  first: string | null;
  last: string | null;
}

/** A history recorder's `/status` on :9091 (fks-spawner bots/history). */
export interface HistoryStatus {
  bot_id: string;
  kind: 'history';
  market: string;
  symbols: string[];
  datasets: string[];
  intervals: string[];
  /** `YYYY-MM`. */
  start: string;
  started_at_ms: number;
  updated_at_ms: number;
  cycle: {
    running: boolean;
    started_at_ms: number | null;
    finished_at_ms: number | null;
    next_at_ms: number | null;
    /** Files in the running (or last) check, and how many it has been through. */
    planned: number;
    checked: number;
    downloaded: number;
    errors: number;
  };
  /** When the last check finished with no errors. */
  last_success_ms: number | null;
  downloads_total: number;
  errors_total: number;
  /** The last FINISHED check's counts, by `dataset/symbol/interval`. */
  series: Record<string, HistorySeries>;
  recent_errors: { file: string; error: string; at_ms: number }[];
}

/** `GET /bots/{bot_id}/status`: the running bot's own document. */
export interface BotStatusResponse<T = unknown> {
  ok: boolean;
  bot_id?: string;
  status?: T;
  error?: string;
}
