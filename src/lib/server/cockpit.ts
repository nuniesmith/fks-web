/**
 * Armed-futures cockpit — server half (I/O + route handlers).
 *
 * Two data planes, sourced deliberately differently:
 *
 *   1. **Bot state of record** — the funding bot's own Postgres tables
 *      (`funding_kill_switch`, `funding_open_trades`, `funding_paper_records`,
 *      `framework_risk_state`). Read here directly over a scoped connection;
 *      the KILL sentinel write is the cockpit's ONE mutation and uses the
 *      byte-identical SQL convention the bot itself uses (upsert; re-arm
 *      stores JSON `null`, never a DELETE — see fks-state state_store.rs).
 *
 *      Connection: `WEBUI_FR_DATABASE_URL` (the bot's `FR_DATABASE_URL`
 *      pointed at by a webui-scoped role), falling back to
 *      `WEBUI_DATABASE_URL` (the auth-session DB — same `fks_postgres`
 *      `ruby_db` on the deployed compose). Required grants for the connecting
 *      role, documented in docs/COCKPIT.md:
 *        SELECT                  ON funding_open_trades, funding_paper_records,
 *                                   framework_risk_state
 *        SELECT, INSERT, UPDATE  ON funding_kill_switch
 *      If the sentinel table is absent (different DB / bot never ran there)
 *      the cockpit reports `configured:false` — honest-empty, and the kill
 *      routes refuse rather than writing into the wrong database.
 *
 *   2. **Armed-path telemetry** — Prometheus (`fks_prometheus:9090`), the
 *      #18 `:9092` exporter series (`fks_bot_session_halt_active`, …),
 *      scraped ONLY for `mode="live"` funding bots. Zero series while the
 *      bot is paper = the honest "awaiting arm" state.
 *
 * SECURITY: these handlers are dispatched from `proxyBackend` in
 * `hooks.server.ts`, i.e. BEHIND the #47 auth seam — `routeRequest` denies
 * every backend call without a valid session (mutations included; fail-closed
 * on store outage), and the CSRF origin check runs before dispatch. The kill
 * handlers additionally validate the typed confirmation phrase and an explicit
 * instance BEFORE any store access.
 */

import { env } from "$env/dynamic/private";
import postgres from "postgres";
import {
  INSTANCES,
  KILL_CONFIRM_PHRASE,
  REARM_CONFIRM_PHRASE,
  buildKillRecord,
  gateBotName,
  parseGateRows,
  parseSentinel,
  partitionOpenTrades,
  sessionPnl,
  validateKillBody,
  type CockpitInstance,
  type FrameworkRiskRow,
  type OpenTradeRow,
} from "$lib/cockpit/model";
import { buildTelemetry, parseInstantVector, type PromSample } from "$lib/cockpit/promParse";

// ── Store abstraction (injected in tests; Postgres-backed in production) ────

export interface CockpitStore {
  /** Whether the funding bot's sentinel table exists in the connected DB. */
  configured(): Promise<boolean>;
  loadSentinels(): Promise<{ instance: string; record: unknown; updated_at: unknown }[]>;
  loadOpenTrades(): Promise<OpenTradeRow[]>;
  loadRiskRows(): Promise<FrameworkRiskRow[]>;
  /** Ledger rows from the recent window (>= 48h — the pure layer applies the
   *  UTC-day session filter). */
  loadRecentRecords(): Promise<unknown[]>;
  setKill(instance: CockpitInstance, record: unknown): Promise<void>;
  clearKill(instance: CockpitInstance): Promise<void>;
}

type Sql = ReturnType<typeof postgres>;

/** Exported for the sentinel-encoding regression tests (the kill/re-arm SQL
 *  shape is money-critical and must be pinned at the wire-encoding level). */
export class PgCockpitStore implements CockpitStore {
  private sql: Sql;
  /** Positive probe cached forever (tables don't un-exist); negative retried. */
  private known = false;

  constructor(connectionString: string) {
    this.sql = postgres(connectionString, {
      max: 2,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => {},
    });
  }

  async configured(): Promise<boolean> {
    if (this.known) return true;
    const rows = await this.sql<{ present: boolean }[]>`
      SELECT to_regclass('public.funding_kill_switch') IS NOT NULL AS present`;
    this.known = rows[0]?.present === true;
    return this.known;
  }

  async loadSentinels() {
    return await this.sql<{ instance: string; record: unknown; updated_at: unknown }[]>`
      SELECT instance, record, updated_at FROM funding_kill_switch`;
  }

  async loadOpenTrades() {
    return await this.sql<OpenTradeRow[]>`
      SELECT symbol, state, updated_at FROM funding_open_trades`;
  }

  async loadRiskRows() {
    // Both bot names (paper `kucoin-futures`, live `kucoin-futures-live`) —
    // the pure layer partitions EXACTLY on `<bot>/risk/` so the live rows can
    // never bleed into the paper view via this shared fetch.
    return await this.sql<FrameworkRiskRow[]>`
      SELECT key, value, updated_at FROM framework_risk_state
      WHERE key LIKE 'kucoin-futures%'`;
  }

  async loadRecentRecords(): Promise<unknown[]> {
    const rows = await this.sql<{ record: unknown }[]>`
      SELECT record FROM funding_paper_records
      WHERE ts >= now() - interval '48 hours'
      ORDER BY ts, id`;
    return rows.map((r) => r.record);
  }

  async setKill(instance: CockpitInstance, record: unknown): Promise<void> {
    // Byte-identical convention to the bot's UPSERT_KILL (state_store.rs).
    await this.sql`
      INSERT INTO funding_kill_switch (instance, record, updated_at)
      VALUES (${instance}, ${this.sql.json(record as never)}, now())
      ON CONFLICT (instance) DO UPDATE SET record = EXCLUDED.record, updated_at = now()`;
  }

  async clearKill(instance: CockpitInstance): Promise<void> {
    // Re-arm = store JSON `null` (read back as not-killed), NEVER a row
    // delete — mirrors the bot's ClearKill so "postgres owns this key" holds.
    //
    // ENCODING PITFALL (do not "simplify" this back to a bind): postgres.js
    // `sql.json(null)` puts a JS null in the params array and Bind
    // short-circuits `x === null` to a SQL NULL *before* the jsonb serializer
    // runs — which violates the column's NOT NULL constraint (23502) and makes
    // every re-arm 502. The bot's own ClearKill (tokio-postgres,
    // serde_json::Value::Null) sends the JSONB value `null` — a PRESENT value.
    // The literal `'null'::jsonb` below is the same wire value the bot writes.
    // Pinned by cockpitPgStore.test.ts.
    await this.sql`
      INSERT INTO funding_kill_switch (instance, record, updated_at)
      VALUES (${instance}, 'null'::jsonb, now())
      ON CONFLICT (instance) DO UPDATE SET record = EXCLUDED.record, updated_at = now()`;
  }
}

let storeSingleton: PgCockpitStore | null = null;

/** The cockpit DB URL: explicit override, else the auth-session DB (same
 *  ruby_db on the deployed compose). Empty = not configured (honest-empty). */
function cockpitDbUrl(): string {
  return (env.WEBUI_FR_DATABASE_URL ?? "").trim() || (env.WEBUI_DATABASE_URL ?? "").trim();
}

function getStore(): CockpitStore | null {
  const url = cockpitDbUrl();
  if (!url) return null;
  if (!storeSingleton) storeSingleton = new PgCockpitStore(url);
  return storeSingleton;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** The honest not-configured payload (never fake-empty panels). */
function notConfigured(reason: string): Response {
  return json({ configured: false, reason });
}

// ── GET /api/cockpit/state ──────────────────────────────────────────────────

export async function cockpitStateGet(store: CockpitStore | null = getStore()): Promise<Response> {
  if (!store) {
    return notConfigured(
      "no cockpit database configured (set WEBUI_FR_DATABASE_URL or WEBUI_DATABASE_URL)",
    );
  }
  try {
    if (!(await store.configured())) {
      return notConfigured(
        "funding bot tables not found in the configured database (funding_kill_switch absent)",
      );
    }
    const [sentinels, trades, riskRows, records] = await Promise.all([
      store.loadSentinels(),
      store.loadOpenTrades(),
      store.loadRiskRows(),
      store.loadRecentRecords(),
    ]);
    const now = Date.now();
    const nowUnix = Math.floor(now / 1000);
    const partition = partitionOpenTrades(trades);
    const byInstance = Object.fromEntries(
      INSTANCES.map((inst) => {
        const sentinelRow = sentinels.find((s) => s.instance === inst);
        return [
          inst,
          {
            sentinel: parseSentinel(sentinelRow?.record ?? null),
            sentinelUpdatedAt: sentinelRow?.updated_at ?? null,
            positions: partition[inst],
            gates: parseGateRows(riskRows, inst, nowUnix),
            gateBotName: gateBotName(inst),
            session: sessionPnl(records, inst, now),
          },
        ];
      }),
    );
    // FR_INSTANCE coupling guard: the cockpit only ever targets the literal
    // instances "paper"/"live", but the bot keys its sentinel on the RAW
    // FR_INSTANCE env value. A sentinel row under any other instance key means
    // a bot ran with a non-standard FR_INSTANCE — a cockpit KILL "live" would
    // NOT reach it. Surface those keys instead of silently dropping them.
    const otherSentinelInstances = sentinels
      .map((s) => s.instance)
      .filter((i) => !(INSTANCES as readonly string[]).includes(i))
      .sort();
    return json({
      configured: true,
      generated_at: now,
      instances: byInstance,
      other_instance_keys: partition.otherKeys,
      other_sentinel_instances: otherSentinelInstances,
    });
  } catch (e) {
    // DB unreachable ≠ "everything is fine and empty" — surface the outage.
    return json({ configured: false, reason: `cockpit store error: ${(e as Error).message}` }, 502);
  }
}

// ── GET /api/cockpit/telemetry ──────────────────────────────────────────────

/** The #18 armed-path instant queries — `mode="live"` matches the scrape
 *  job's injected label; the paper twin has no series here by design. */
const TELEMETRY_QUERIES = {
  halt: 'fks_bot_session_halt_active{mode="live"}',
  breaker: 'fks_bot_circuit_breaker_tripped{mode="live"}',
  stopPresent: 'fks_bot_resting_stop_present{mode="live"}',
  stopExpected: 'fks_bot_resting_stop_expected{mode="live"}',
  orderErrors: 'fks_bot_order_errors_total{mode="live"}',
  openPositions: 'fks_bot_open_positions{mode="live"}',
  openNotional: 'fks_bot_open_notional_usd{mode="live"}',
  entryUnix: 'fks_bot_open_position_entry_unix{mode="live"}',
} as const;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function promInstant(
  promUrl: string,
  query: string,
  fetchFn: FetchLike,
): Promise<PromSample[] | null> {
  try {
    const r = await fetchFn(`${promUrl}/api/v1/query?query=${encodeURIComponent(query)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return null;
    return parseInstantVector(await r.json());
  } catch {
    return null;
  }
}

export async function cockpitTelemetryGet(
  promUrl: string,
  fetchFn: FetchLike = fetch,
): Promise<Response> {
  const q = (query: string) => promInstant(promUrl, query, fetchFn);
  const [halt, breaker, stopPresent, stopExpected, orderErrors, openPositions, openNotional, entryUnix] =
    await Promise.all([
      q(TELEMETRY_QUERIES.halt),
      q(TELEMETRY_QUERIES.breaker),
      q(TELEMETRY_QUERIES.stopPresent),
      q(TELEMETRY_QUERIES.stopExpected),
      q(TELEMETRY_QUERIES.orderErrors),
      q(TELEMETRY_QUERIES.openPositions),
      q(TELEMETRY_QUERIES.openNotional),
      q(TELEMETRY_QUERIES.entryUnix),
    ]);
  return json(
    buildTelemetry({
      halt,
      breaker,
      stopPresent,
      stopExpected,
      orderErrors,
      openPositions,
      openNotional,
      entryUnix,
    }),
  );
}

// ── POST /api/cockpit/kill  +  POST /api/cockpit/rearm ──────────────────────

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/**
 * Trip the durable kill sentinel for ONE explicitly named instance.
 * Validation runs strictly BEFORE any store access. The response is honest
 * about what a sentinel write does and does not do: the bot halts + flattens
 * reduce-only on its NEXT live bar (60m cadence) — it is not an instant venue
 * flatten (that is `live-flatten`'s venue-direct half, per the drill runbook).
 */
export async function cockpitKillPost(
  request: Request,
  operator: string,
  store: CockpitStore | null = getStore(),
): Promise<Response> {
  const v = validateKillBody(await readBody(request), KILL_CONFIRM_PHRASE);
  if (!v.ok) return json({ ok: false, message: v.message }, v.status);
  if (!store) return json({ ok: false, message: "cockpit database not configured" }, 503);
  try {
    if (!(await store.configured())) {
      return json(
        { ok: false, message: "funding bot tables absent — refusing to write a sentinel here" },
        503,
      );
    }
    const record = buildKillRecord(operator, v.note, Date.now());
    await store.setKill(v.instance, record);
    return json({
      ok: true,
      instance: v.instance,
      record,
      effect:
        `kill sentinel SET for instance "${v.instance}" — the bot refuses new entries and ` +
        `flattens any open trade reduce-only on its NEXT live bar (60m cadence), and a ` +
        `respawn comes back HALTED until re-armed. This does NOT instantly flatten the ` +
        `venue: for an immediate venue-direct flatten run live-flatten per the drill runbook.`,
    });
  } catch (e) {
    return json({ ok: false, message: `sentinel write failed: ${(e as Error).message}` }, 502);
  }
}

/** Clear the sentinel (re-arm) — equally gated, equally typed-confirmed. */
export async function cockpitRearmPost(
  request: Request,
  operator: string,
  store: CockpitStore | null = getStore(),
): Promise<Response> {
  const v = validateKillBody(await readBody(request), REARM_CONFIRM_PHRASE);
  if (!v.ok) return json({ ok: false, message: v.message }, v.status);
  if (!store) return json({ ok: false, message: "cockpit database not configured" }, 503);
  try {
    if (!(await store.configured())) {
      return json(
        { ok: false, message: "funding bot tables absent — nothing to re-arm here" },
        503,
      );
    }
    await store.clearKill(v.instance);
    return json({
      ok: true,
      instance: v.instance,
      effect:
        `kill sentinel CLEARED for instance "${v.instance}" — the bot may trade again on its ` +
        `next live bar. Never re-arm with an unreconciled venue (runbook §0 step 4).`,
    });
  } catch (e) {
    return json({ ok: false, message: `sentinel clear failed: ${(e as Error).message}` }, 502);
  }
}
