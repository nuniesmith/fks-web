/**
 * Armed-futures cockpit — pure view-model + kill-request logic.
 *
 * Everything here is PURE (no fetch, no env, no DB) so the money-critical
 * decisions — which instance a kill targets, whether a confirmation phrase is
 * valid, whether a panel has real data vs an honest empty — are unit-testable
 * in isolation. The server half (`$lib/server/cockpit`) does the I/O.
 *
 * State contract (fks-state `bots/crypto-futures`, origin/main c1eebef):
 *   - `funding_kill_switch(instance PK, record JSONB)` — presence of a
 *     NON-NULL record = KILLED; the operator re-arm stores JSON `null`
 *     (never a row delete). Instances: `paper` (the Gate-A measurement twin)
 *     and `live` (the armed twin). Written by `kill.rs` / `live-flatten`.
 *   - `funding_open_trades(symbol PK, state JSONB)` — key is the bare symbol
 *     for the paper instance and `live:SYM` for the live instance (durable
 *     `FR_INSTANCE` identity, funding_brain::open_trade_key). JSON `null`
 *     state = cleared (postgres owns the key).
 *   - `funding_paper_records(record JSONB)` — the shared ledger; armed rows
 *     are stamped `mode:"live"`, every other row is the paper twin's.
 *     Close actions: `exit` | `stop_exit` | `kill_exit` (is_close_action).
 *   - `framework_risk_state(key PK, value JSONB)` — `"<bot>/risk/<SYM>"`,
 *     bot `kucoin-futures` (paper) / `kucoin-futures-live` (live), value
 *     `{session_pnl:{halted,last_reset_day}, circuit_breaker:{tripped_at_unix_secs}}`.
 */

// ── Instances ───────────────────────────────────────────────────────────────

/** The two deployed bot instances sharing one Postgres (FR_INSTANCE keying). */
export type CockpitInstance = "paper" | "live";

export const INSTANCES: readonly CockpitInstance[] = ["paper", "live"] as const;

/**
 * Parse an instance from an untrusted request body. STRICT whitelist — the
 * kill sentinel is instance-keyed precisely so killing `paper` can never touch
 * `live` and vice versa; an unknown/missing instance must never default to
 * either one.
 */
export function parseInstance(raw: unknown): CockpitInstance | null {
  return raw === "paper" || raw === "live" ? raw : null;
}

// ── Kill / re-arm request validation ────────────────────────────────────────

/** Typed-confirmation phrase for tripping the kill sentinel. */
export const KILL_CONFIRM_PHRASE = "KILL";
/** Typed-confirmation phrase for clearing the sentinel (re-arm). */
export const REARM_CONFIRM_PHRASE = "REARM";

export type KillBodyValidation =
  | { ok: true; instance: CockpitInstance; note: string }
  | { ok: false; status: number; message: string };

/**
 * Validate a kill / re-arm POST body — BEFORE any store access, so a bad
 * request can never touch the sentinel table. Requires:
 *   - `instance` ∈ {paper, live} (explicit; no default target);
 *   - `confirm` EXACTLY equal to the phrase (case-sensitive, untrimmed —
 *     the operator must type it, an autofilled/derived value must not pass).
 * `note` is an optional operator comment folded into the audit reason.
 */
export function validateKillBody(body: unknown, phrase: string): KillBodyValidation {
  const b = (body ?? {}) as Record<string, unknown>;
  const instance = parseInstance(b.instance);
  if (!instance) {
    return {
      ok: false,
      status: 400,
      message: 'instance must be exactly "paper" or "live" — no default target',
    };
  }
  if (b.confirm !== phrase) {
    return {
      ok: false,
      status: 400,
      message: `confirmation phrase mismatch — type ${phrase} to proceed`,
    };
  }
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 200) : "";
  return { ok: true, instance, note };
}

/**
 * The sentinel record the webui writes — the same three-key shape as the
 * bot's `kill::kill_record` (`{killed:true, reason, t}`; reason/t are
 * operator-facing audit only, PRESENCE is what means killed).
 */
export function buildKillRecord(
  operator: string,
  note: string,
  nowMs: number,
): { killed: true; reason: string; t: number } {
  const who = operator.trim() || "unknown-operator";
  const reason = note ? `webui kill by ${who}: ${note}` : `webui kill by ${who}`;
  return { killed: true, reason, t: nowMs };
}

// ── Kill sentinel view ──────────────────────────────────────────────────────

export interface SentinelView {
  /** `killed` = a non-null record is present (the bot halts on its next live
   *  bar); `clear` = absent row or JSON null (normal running). */
  state: "clear" | "killed";
  /** Audit fields from the record, when present (best-effort). */
  reason: string | null;
  trippedAtMs: number | null;
}

/** Interpret a `funding_kill_switch.record` value exactly as the bot does:
 *  presence of a non-null record = KILLED, regardless of its content. */
export function parseSentinel(record: unknown): SentinelView {
  if (record === null || record === undefined) {
    return { state: "clear", reason: null, trippedAtMs: null };
  }
  const r = record as Record<string, unknown>;
  return {
    state: "killed",
    reason: typeof r.reason === "string" ? r.reason : null,
    trippedAtMs: typeof r.t === "number" && Number.isFinite(r.t) ? r.t : null,
  };
}

// ── Open trades (funding_open_trades) ───────────────────────────────────────

export interface OpenTradeRow {
  symbol: string; // the storage key: bare `SYM` (paper) or `live:SYM`
  state: unknown; // JSONB: {entry_t, dir, entry_px, closing?} or null (cleared)
  updated_at?: string | Date | null;
}

export interface OpenPositionView {
  symbol: string;
  side: "LONG" | "SHORT";
  dir: 1 | -1;
  entryPx: number;
  entryTMs: number;
  /** Non-null while an ARMED exit awaits venue close-fill confirmation. */
  closing: { reason: string; decidedTMs: number; attempts: number } | null;
}

export interface OpenTradesPartition {
  paper: OpenPositionView[];
  live: OpenPositionView[];
  /** Storage keys under an instance prefix other than `live:` (e.g. a
   *  `paper-drill:` throwaway) — surfaced, never silently dropped. */
  otherKeys: string[];
}

/**
 * Partition `funding_open_trades` rows by the durable instance keying:
 * `live:SYM` → live, bare symbol → paper, any other `prefix:SYM` → other.
 * JSON-null state (cleared trade — "postgres owns this key") and malformed
 * state blobs are skipped (a malformed OPEN blob would fail the bot loudly at
 * startup; the cockpit just must not render garbage).
 */
export function partitionOpenTrades(rows: OpenTradeRow[]): OpenTradesPartition {
  const out: OpenTradesPartition = { paper: [], live: [], otherKeys: [] };
  for (const row of rows) {
    const key = row.symbol ?? "";
    const idx = key.indexOf(":");
    const prefix = idx >= 0 ? key.slice(0, idx) : null;
    const sym = idx >= 0 ? key.slice(idx + 1) : key;
    if (row.state === null || row.state === undefined) continue; // cleared
    const pos = parseOpenState(sym, row.state);
    if (!pos) continue;
    if (prefix === null) out.paper.push(pos);
    else if (prefix === "live") out.live.push(pos);
    else out.otherKeys.push(key);
  }
  return out;
}

function parseOpenState(symbol: string, state: unknown): OpenPositionView | null {
  if (typeof state !== "object" || state === null) return null;
  const s = state as Record<string, unknown>;
  const dirRaw = s.dir;
  const entryPx = s.entry_px;
  const entryT = s.entry_t;
  if (dirRaw !== 1 && dirRaw !== -1) return null;
  if (typeof entryPx !== "number" || !Number.isFinite(entryPx)) return null;
  if (typeof entryT !== "number" || !Number.isFinite(entryT)) return null;
  let closing: OpenPositionView["closing"] = null;
  const c = s.closing;
  if (typeof c === "object" && c !== null) {
    const cc = c as Record<string, unknown>;
    closing = {
      reason: typeof cc.reason === "string" ? cc.reason : "unknown",
      decidedTMs: typeof cc.decided_t === "number" ? cc.decided_t : 0,
      attempts: typeof cc.attempts === "number" ? cc.attempts : 0,
    };
  }
  return {
    symbol,
    dir: dirRaw,
    side: dirRaw === 1 ? "LONG" : "SHORT",
    entryPx,
    entryTMs: entryT,
    closing,
  };
}

// ── Session PnL from the shared ledger ──────────────────────────────────────

/** Trade-closing ledger actions — must mirror the bot's `is_close_action`
 *  (`ExitReason::ALL`): a kill close counts like any other close. */
export const CLOSE_ACTIONS: readonly string[] = ["exit", "stop_exit", "kill_exit"];

export interface SessionPnlView {
  /** Sum of `net_pnl_usdt` over today's (UTC) closes for the instance. */
  realizedUsdt: number;
  closes: number;
  entries: number;
  killExits: number;
  /** Closes in the window that carry NO `net_pnl_usdt` — counted, never
   *  imputed (the sum above simply excludes them; flag, don't fake). */
  closesWithoutUsdt: number;
}

/** UTC day start (ms) for `nowMs` — the bot's session boundary (00:00 UTC). */
export function utcDayStartMs(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000) * 86_400_000;
}

/**
 * Fold ledger records into the instance's UTC-day session view. Instance
 * discrimination mirrors the store's `mode` column: `mode:"live"` rows belong
 * to the live instance, everything else (absent/`paper`) to the paper twin.
 */
export function sessionPnl(
  records: unknown[],
  instance: CockpitInstance,
  nowMs: number,
): SessionPnlView {
  const dayStart = utcDayStartMs(nowMs);
  const view: SessionPnlView = {
    realizedUsdt: 0,
    closes: 0,
    entries: 0,
    killExits: 0,
    closesWithoutUsdt: 0,
  };
  for (const raw of records) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const mode = r.mode === "live" ? "live" : "paper";
    if (mode !== instance) continue;
    const t = typeof r.t === "number" ? r.t : NaN;
    if (!(t >= dayStart && t <= nowMs + 60_000)) continue;
    const action = typeof r.action === "string" ? r.action : "";
    if (action === "entry") {
      view.entries += 1;
    } else if (CLOSE_ACTIONS.includes(action)) {
      view.closes += 1;
      if (action === "kill_exit") view.killExits += 1;
      const net = r.net_pnl_usdt;
      if (typeof net === "number" && Number.isFinite(net)) view.realizedUsdt += net;
      else view.closesWithoutUsdt += 1;
    }
  }
  return view;
}

// ── Persisted risk-gate state (framework_risk_state) ────────────────────────

/**
 * The circuit-breaker cooldown used to render "tripped" freshness. The
 * persisted snapshot carries only the ABSOLUTE trip time; the framework
 * auto-resets on a sweep tick that never re-persists. MUST track
 * `rustrade_risk::CircuitBreakerConfig::default().cooldown_secs` (3600s on
 * 0.5.2) — same constant, same caveat, as the bot's own exporter
 * (`risk_metrics.rs BREAKER_COOLDOWN_SECS`).
 */
export const BREAKER_COOLDOWN_SECS = 3_600;

export interface GateRowView {
  symbol: string;
  /** Raw persisted halt flag. */
  haltedPersisted: boolean;
  /** Halt rendered LIVE: a persisted halt whose `last_reset_day` predates the
   *  current UTC day has rolled over (00:00 UTC) and reads CLEARED — mirrors
   *  the bot exporter's rollover logic, never pages off a stale flag. */
  haltedNow: boolean;
  breakerTrippedAtUnix: number | null;
  /** Breaker rendered LIVE against the cooldown. */
  breakerActiveNow: boolean;
}

export interface FrameworkRiskRow {
  key: string; // "<bot>/risk/<SYM>"
  value: unknown;
  updated_at?: string | Date | null;
}

/** The `framework_risk_state` key prefix (bot name) for an instance —
 *  mirrors `kill::gate_bot_name`: paper keeps the historic bare name. */
export function gateBotName(instance: CockpitInstance): string {
  return instance === "paper" ? "kucoin-futures" : "kucoin-futures-live";
}

/**
 * Parse the instance's persisted gate rows. `rows` may contain BOTH bot
 * names (the server fetches one prefix family); filtering is exact on
 * `<botName>/risk/` so `kucoin-futures-live/...` can never leak into the
 * paper view via a prefix match.
 */
export function parseGateRows(
  rows: FrameworkRiskRow[],
  instance: CockpitInstance,
  nowUnix: number,
): GateRowView[] {
  const wanted = `${gateBotName(instance)}/risk/`;
  const out: GateRowView[] = [];
  for (const row of rows) {
    if (!row.key.startsWith(wanted)) continue;
    const symbol = row.key.slice(wanted.length);
    if (!symbol) continue;
    const v = (row.value ?? {}) as Record<string, unknown>;
    const session = (v.session_pnl ?? {}) as Record<string, unknown>;
    const halted = session.halted === true;
    const lastResetDay =
      typeof session.last_reset_day === "number" ? session.last_reset_day : null;
    const today = Math.floor(nowUnix / 86_400);
    // Rollover-aware: with a known snapshot day, the halt only reads active
    // for the SAME UTC day; without one, trust the raw flag (no inference).
    const haltedNow = halted && (lastResetDay === null || lastResetDay >= today);
    const breaker = (v.circuit_breaker ?? {}) as Record<string, unknown>;
    const trippedAt =
      typeof breaker.tripped_at_unix_secs === "number"
        ? breaker.tripped_at_unix_secs
        : null;
    const breakerActiveNow =
      trippedAt !== null && nowUnix < trippedAt + BREAKER_COOLDOWN_SECS;
    out.push({
      symbol,
      haltedPersisted: halted,
      haltedNow,
      breakerTrippedAtUnix: trippedAt,
      breakerActiveNow,
    });
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}
