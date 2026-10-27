/**
 * FKS Bot Spawner API Client
 *
 * Wraps the spawner's HTTP surface so route components don't have to
 * know the URL structure. We use the `/api/spawner/*` passthrough
 * route exclusively (not the `/api/bots/*` rewrite route) because:
 *
 *   - The `/api/bots/` rewrites collapse paths into `/container/<id>/<...>`
 *     which would mis-route `/api/bots/runs` → `/container/runs` (404).
 *   - The passthrough is a single `^/api/spawner/(.*)$ → /$1` rule, so
 *     every spawner route maps trivially.
 *
 *   browser                            → fks_bot_spawner:8090
 *   ─────────────────────────────────────────────────────────
 *   GET    /api/spawner/health            → /health
 *   GET    /api/spawner/containers        → /containers
 *   GET    /api/spawner/container/<id>    → /container/<id>
 *   POST   /api/spawner/spawn             → /spawn
 *   POST   /api/spawner/container/<id>/stop / restart  → ...
 *   DELETE /api/spawner/container/<id>    → /container/<id>
 *   GET    /api/spawner/container/<id>/logs            → SSE
 *   GET    /api/spawner/runs?limit=N      → /runs (db feature only)
 *   GET    /api/spawner/net-worth        → /net-worth (db feature only)
 *   POST   /api/spawner/net-worth        → /net-worth (manual snapshot)
 *   GET    /api/spawner/transfers        → /transfers (db feature only)
 *   POST   /api/spawner/transfers        → /transfers (record a cash flow)
 *   GET    /api/spawner/profit           → /profit?account_id=&since=
 *   GET    /api/spawner/accounts         → /accounts (db feature only)
 *   POST   /api/spawner/accounts         → /accounts (UPSERT by account_id)
 *   GET    /api/spawner/edges            → /edges (db feature only)
 *   GET    /api/spawner/edges/<id>/backtests?limit=N → /edges/<id>/backtests
 *   POST   /api/spawner/edges/<id>/backtest          → 202 (launch run)
 *   POST   /api/spawner/edges            → /edges (UPSERT by edge_id)
 *   GET    /api/spawner/ladder           → /ladder (the edge ladder in one read)
 *   POST   /api/spawner/edges/<id>/hypotheses → register a hypothesis (frozen)
 *   POST   /api/spawner/hypotheses/<id>/withdraw · /deployments ·
 *          /deployments/<id>/promote (live = admin, R2b) · /deployments/<id>/retire
 *   POST   /api/spawner/configs/<name>/respawn → /configs/<name>/respawn
 *          (db feature only — stop+recreate from the saved config, current
 *          stored secrets re-injected; the rotate-then-respawn step)
 *   GET    /api/spawner/templates        → /templates (forms for recorders, bots, jobs)
 *   POST   /api/spawner/instances/validate → what an instance WOULD be, no side effects
 *   GET    /api/spawner/instances        → instances made from templates
 *   POST   /api/spawner/instances        → make one (config + data folder + container)
 *   POST   /api/spawner/instances/<name>/start | stop, DELETE /instances/<name>
 *   GET    /api/spawner/instances/<name>/files?days=N → what it has written (coverage)
 *   GET    /api/spawner/secrets/status   → which exchanges have keys (names only)
 *   GET    /api/spawner/leases           → which bot holds which exchange account
 *   GET    /api/spawner/bots/<id>/status → a running bot's own /status
 *
 * The vite dev server proxies `/api/spawner` → `http://fks_bot_spawner:8090/`
 * with the same rewrite as the production nginx config.
 */
import { api } from "./client";
import type {
  AccountsResponse,
  ActionResponse,
  BotStatusResponse,
  ExchangeKeysStatusResponse,
  InstanceCreateResponse,
  InstanceFilesResponse,
  InstanceRequest,
  InstanceValidateResponse,
  InstancesResponse,
  LeasesResponse,
  TemplatesResponse,
  ConfigsResponse,
  ContainerInfo,
  ContainersResponse,
  EdgeBacktestsResponse,
  EdgesResponse,
  HealthResponse,
  ManualNetWorthRequest,
  ManualNetWorthResponse,
  NetWorthSnapshot,
  ProfitResponse,
  RecordTransferRequest,
  RecordTransferResponse,
  RespawnResponse,
  RunsResponse,
  SaveConfigRequest,
  SpawnRequest,
  SpawnResponse,
  StartBacktestResponse,
  TransferRow,
  UpsertAccountRequest,
  UpsertAccountResponse,
  UpsertEdgeRequest,
  UpsertEdgeResponse,
  LadderResponse,
  Hypothesis,
  RegisterHypothesisRequest,
  Deployment,
  CreateDeploymentRequest,
  PromoteRequest,
} from "$lib/types/spawner";

/** Base path — matches the nginx + vite proxy passthrough rewrites. */
const BASE = "/api/spawner";

export const spawner = {
  // ── Health & inventory ────────────────────────────────────────────────

  health: () => api.get<HealthResponse>(`${BASE}/health`),

  list: () => api.get<ContainersResponse>(`${BASE}/containers`),

  inspect: (id: string) => api.get<ContainerInfo>(`${BASE}/container/${id}`),

  // ── Lifecycle actions ──────────────────────────────────────────────────

  spawn: (req: SpawnRequest) => api.post<SpawnResponse>(`${BASE}/spawn`, req),

  stop: (id: string) =>
    api.post<ActionResponse>(`${BASE}/container/${id}/stop`),

  restart: (id: string) =>
    api.post<ActionResponse>(`${BASE}/container/${id}/restart`),

  remove: (id: string) => api.delete<ActionResponse>(`${BASE}/container/${id}`),

  // ── History ────────────────────────────────────────────────────────────

  /**
   * Recent run history. The spawner returns `db_enabled: false` (and an
   * empty array) when Postgres isn't configured — callers should check
   * the flag before showing a "no data" message instead of an error.
   */
  runs: (limit = 50) => api.get<RunsResponse>(`${BASE}/runs?limit=${limit}`),

  /**
   * Durable net-worth history from the `net_worth_snapshots` table (db
   * feature). Returns a flat array ordered by ts (oldest → newest); an empty
   * array when Postgres isn't configured or nothing has been sampled yet.
   * `botId` filters to one bot; `limit` caps the most-recent rows returned
   * (spawner default 500, hard cap 5000).
   */
  netWorth: (opts: { botId?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.botId) q.set("bot_id", opts.botId);
    if (opts.limit != null) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return api.get<NetWorthSnapshot[]>(`${BASE}/net-worth${qs ? `?${qs}` : ""}`);
  },

  /**
   * Record ONE hand-entered net-worth snapshot (`source='manual'`) for an
   * account without a watcher node of its own (prop payouts, bank balance,
   * hardware wallet). 400 = validation, 503 = no spawner database.
   */
  recordNetWorth: (req: ManualNetWorthRequest) =>
    api.post<ManualNetWorthResponse>(`${BASE}/net-worth`, req),

  // ── Treasury: transfers ledger + accounts registry + /profit (db) ──────

  /**
   * A window of the transfers ledger, flat array ordered oldest → newest
   * (like netWorth). `accountId` filters to one account; `limit` caps the
   * most-recent rows (spawner default 500, hard cap 5000). Empty array when
   * Postgres isn't configured — show an honest empty state, not an error.
   */
  transfers: (opts: { accountId?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.accountId) q.set("account_id", opts.accountId);
    if (opts.limit != null) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return api.get<TransferRow[]>(`${BASE}/transfers${qs ? `?${qs}` : ""}`);
  },

  /**
   * Append one signed cash-flow row (positive = deposit in, negative =
   * withdrawal out) so /profit can decompose net-worth drift into deposits
   * vs trading profit. The write is awaited server-side — a 201 means the
   * ledger row persisted. 400 = validation, 503 = no spawner database.
   */
  recordTransfer: (req: RecordTransferRequest) =>
    api.post<RecordTransferResponse>(`${BASE}/transfers`, req),

  /**
   * Decompose one account's net-worth drift into deposits vs trading profit
   * over `since`..now (`since` omitted/null = the account's full history).
   * Figures come back null — never an invented zero — when no snapshots
   * fall inside the window or no database is configured (`db_enabled`).
   */
  profit: (accountId: string, since?: string | null) => {
    const q = new URLSearchParams({ account_id: accountId });
    if (since) q.set("since", since);
    return api.get<ProfitResponse>(`${BASE}/profit?${q.toString()}`);
  },

  /**
   * The accounts registry (multi-account treasury topology), active accounts
   * first. Carries NO credentials by design. `db_enabled: false` (empty
   * array) when the spawner has no Postgres configured.
   */
  accounts: () => api.get<AccountsResponse>(`${BASE}/accounts`),

  /** UPSERT a registry account (keyed by `account_id`). */
  upsertAccount: (req: UpsertAccountRequest) =>
    api.post<UpsertAccountResponse>(`${BASE}/accounts`, req),

  // ── Saved spawn configs (db feature) ───────────────────────────────────

  /** List active saved spawn configs. `db_enabled:false` ⇒ empty array. */
  listConfigs: () => api.get<ConfigsResponse>(`${BASE}/configs`),

  /** Save (UPSERT by name) a reusable spawn config. */
  saveConfig: (req: SaveConfigRequest) =>
    api.post<{ ok: boolean; id?: string; name?: string }>(`${BASE}/configs`, req),

  /** Soft-delete a saved config by name. */
  deleteConfig: (name: string) =>
    api.delete<{ ok: boolean; name?: string }>(
      `${BASE}/configs/${encodeURIComponent(name)}`,
    ),

  /**
   * Atomically redeploy a saved config's bot: stop + force-remove the
   * existing `fks-bot-{bot_id}` container (idempotent — skips cleanly if it
   * isn't running), then spawn a fresh one from the config through the SAME
   * `/spawn` path — so CURRENT stored secrets are re-injected. This is the
   * rotate-then-respawn step: rotating a key in `/settings` only updates the
   * secret store, a running bot keeps using the OLD key until this runs.
   * `botId` overrides the config's stored `bot_id` when passed; otherwise
   * the spawner resolves it from the saved config (400 if neither exists).
   */
  respawn: (name: string, botId?: string) =>
    api.post<RespawnResponse>(
      `${BASE}/configs/${encodeURIComponent(name)}/respawn`,
      botId ? { bot_id: botId } : {},
    ),

  // ── Edge registry (db feature) ─────────────────────────────────────────

  /**
   * The edge portfolio. `db_enabled: false` (empty array) when the spawner
   * has no Postgres configured — show an honest empty state, not an error.
   */
  edges: () => api.get<EdgesResponse>(`${BASE}/edges`),

  /** Backtest-run history for one edge, newest first. */
  edgeBacktests: (id: string, limit = 20) =>
    api.get<EdgeBacktestsResponse>(
      `${BASE}/edges/${encodeURIComponent(id)}/backtests?limit=${limit}`,
    ),

  /**
   * Launch a backtest container for an edge (HTTP 202). The spawner rejects
   * with 400 when the edge has no `backtest_image`. `params` (optional) is
   * passed through to the harness, e.g. `{days: 60, symbols: [...]}`.
   */
  runBacktest: (id: string, params?: Record<string, unknown>) =>
    api.post<StartBacktestResponse>(
      `${BASE}/edges/${encodeURIComponent(id)}/backtest`,
      params ? { params } : {},
    ),

  /** UPSERT an edge definition (keyed by `edge_id`). */
  upsertEdge: (req: UpsertEdgeRequest) =>
    api.post<UpsertEdgeResponse>(`${BASE}/edges`, req),

  // ── The edge ladder (db feature; Postgres guards every rung) ──────────

  /** Edges, hypotheses, experiments, deployments and search effort. */
  ladder: () => api.get<LadderResponse>(`${BASE}/ladder`),

  /** Register a hypothesis (stage 2). Frozen from then on. */
  registerHypothesis: (edgeId: string, req: RegisterHypothesisRequest) =>
    api.post<{ ok: boolean; hypothesis: Hypothesis }>(
      `${BASE}/edges/${encodeURIComponent(edgeId)}/hypotheses`,
      req,
    ),

  withdrawHypothesis: (id: number, reason: string) =>
    api.post<{ ok: boolean; hypothesis: Hypothesis }>(`${BASE}/hypotheses/${id}/withdraw`, { reason }),

  /** A deployment row at `backtest` for an experiment. */
  createDeployment: (req: CreateDeploymentRequest) =>
    api.post<{ ok: boolean; deployment: Deployment }>(`${BASE}/deployments`, req),

  /** One rung up; the database's refusal comes back as a 409 in its own words. */
  promoteDeployment: (id: number, req: PromoteRequest) =>
    api.post<{ ok: boolean; deployment: Deployment }>(`${BASE}/deployments/${id}/promote`, req),

  retireDeployment: (id: number, reason: string) =>
    api.post<{ ok: boolean; deployment: Deployment }>(`${BASE}/deployments/${id}/retire`, { reason }),

  // ── Templates and instances ───────────────────────────────────────────

  /** Every valid template (its form is `params`), plus files that did not validate. */
  templates: () => api.get<TemplatesResponse>(`${BASE}/templates`),

  /** What an instance would be: image, env, resources and data folder. No side effects. */
  validateInstance: (req: InstanceRequest) =>
    api.post<InstanceValidateResponse>(`${BASE}/instances/validate`, req),

  /** Instances made from templates, with their container's state. */
  instances: () => api.get<InstancesResponse>(`${BASE}/instances`),

  /** Make an instance: save its config, create its data folder, start it. */
  createInstance: (req: InstanceRequest) =>
    api.post<InstanceCreateResponse>(`${BASE}/instances`, req),

  /** (Re)create the instance's container from its template as it is now. */
  startInstance: (name: string) =>
    api.post<{ ok: boolean; name?: string; container_id?: string }>(
      `${BASE}/instances/${encodeURIComponent(name)}/start`,
      {},
    ),

  stopInstance: (name: string) =>
    api.post<{ ok: boolean; name?: string }>(
      `${BASE}/instances/${encodeURIComponent(name)}/stop`,
      {},
    ),

  /** Stop and remove the container, soft-delete the config. Its data is kept. */
  deleteInstance: (name: string) =>
    api.delete<{ ok: boolean; name?: string }>(`${BASE}/instances/${encodeURIComponent(name)}`),

  /** Days, per-stream file sizes and gaps a recorder instance has written. */
  instanceFiles: (name: string, days = 31) =>
    api.get<InstanceFilesResponse>(
      `${BASE}/instances/${encodeURIComponent(name)}/files?days=${days}`,
    ),

  // ── Accounts as configured ────────────────────────────────────────────

  /** Which exchanges have keys stored (names and dates, never a secret). */
  secretsStatus: () => api.get<ExchangeKeysStatusResponse>(`${BASE}/secrets/status`),

  /** Account leases: which bot holds which exchange account. */
  leases: () => api.get<LeasesResponse>(`${BASE}/leases`),

  /** A running bot's own `/status` document, through the spawner. */
  botStatus: <T = unknown>(botId: string) =>
    api.get<BotStatusResponse<T>>(`${BASE}/bots/${encodeURIComponent(botId)}/status`),

  // ── SSE log stream ─────────────────────────────────────────────────────

  /**
   * Open a Server-Sent Events stream of container logs. Caller is
   * responsible for closing the returned EventSource. Each event has
   * type `"log"` with `data` set to the log line (already trimmed).
   *
   * @param id   Short or full container ID.
   * @param tail Number of historical lines to send before tailing live
   *             output. Default 100 (matches the spawner default).
   */
  openLogStream: (id: string, tail = 100): EventSource => {
    const url = `${BASE}/container/${id}/logs?tail=${tail}`;
    return new EventSource(url);
  },
};
