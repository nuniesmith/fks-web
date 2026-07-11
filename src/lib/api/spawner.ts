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
 *
 * The vite dev server proxies `/api/spawner` → `http://fks_bot_spawner:8090/`
 * with the same rewrite as the production nginx config.
 */
import { api } from "./client";
import type {
  AccountsResponse,
  ActionResponse,
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
