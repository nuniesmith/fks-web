/**
 * Typed fixture builders for the cockpit E2E specs.
 *
 * These mirror the EXACT payload shapes the cockpit page consumes — do not
 * invent fields. Sources of truth (origin/main):
 *   - CockpitStateResp / InstanceView   → src/routes/cockpit/+page.svelte:48-65
 *   - SentinelView / OpenPositionView /
 *     GateRowView / SessionPnlView       → src/lib/cockpit/model.ts
 *   - ArmedTelemetry / StopSyncView      → src/lib/cockpit/promParse.ts:51-97
 *   - ExchangesStatus / BotStatus /
 *     PositionStatus                     → src/lib/types/exchanges.ts:36-134
 *
 * They are re-declared locally (not imported from `$lib`) because Playwright's
 * esbuild transform does not resolve SvelteKit's `$lib` alias — the point is a
 * TYPED fixture, and these interfaces are a faithful structural copy the
 * TypeScript compiler checks the builders against.
 */

// ── model.ts view-model shapes ───────────────────────────────────────────────

export type CockpitInstance = "paper" | "live";

export interface SentinelView {
  state: "clear" | "killed";
  reason: string | null;
  trippedAtMs: number | null;
}

export interface OpenPositionView {
  symbol: string;
  side: "LONG" | "SHORT";
  dir: 1 | -1;
  entryPx: number;
  entryTMs: number;
  closing: { reason: string; decidedTMs: number; attempts: number } | null;
}

export interface GateRowView {
  symbol: string;
  haltedPersisted: boolean;
  haltedNow: boolean;
  breakerTrippedAtUnix: number | null;
  breakerActiveNow: boolean;
}

export interface SessionPnlView {
  realizedUsdt: number;
  closes: number;
  entries: number;
  killExits: number;
  closesWithoutUsdt: number;
}

export interface InstanceView {
  sentinel: SentinelView;
  sentinelUpdatedAt: string | null;
  positions: OpenPositionView[];
  gates: GateRowView[];
  gateBotName: string;
  session: SessionPnlView;
}

export interface CockpitStateResp {
  configured: boolean;
  reason?: string;
  generated_at?: number;
  instances?: Record<CockpitInstance, InstanceView>;
  other_instance_keys?: string[];
  other_sentinel_instances?: string[];
}

// ── promParse.ts telemetry shapes ────────────────────────────────────────────

export interface StopSyncView {
  present: number;
  expected: number;
  diverged: boolean;
}

/** `failed` is `(keyof TelemetryParts)[]` at the type site; over the wire it is
 *  a plain string[]. Valid keys: halt | breaker | stopPresent | stopExpected |
 *  orderErrors | openPositions | openNotional | entryUnix. */
export type TelemetryQueryKey =
  | "halt"
  | "breaker"
  | "stopPresent"
  | "stopExpected"
  | "orderErrors"
  | "openPositions"
  | "openNotional"
  | "entryUnix";

export interface ArmedTelemetry {
  available: boolean;
  scraped: boolean;
  failed: TelemetryQueryKey[];
  haltBySymbol: Record<string, number>;
  breakerBySymbol: Record<string, number>;
  stops: Record<string, StopSyncView>;
  orderErrors: { cls: string; total: number }[];
  openPositions: number | null;
  openNotionalUsd: number | null;
  entryUnixBySymbol: Record<string, number>;
}

// ── exchanges.ts /status shapes (only the fields the cockpit reads) ───────────

export interface PositionStatus {
  symbol: string;
  dir: number;
  entry_px: number;
  entry_ts_ms: number;
  mark_px: number;
  ret_pct: number;
  updated: number;
}

export interface BotStatus {
  bot: string;
  market: string;
  mode: string;
  uptime_secs: number;
  net_worth_usd: number;
  pnl_usd: number;
  signals_total: number;
  trades_total: number;
  wins: number;
  losses: number;
  win_rate: number;
  exchanges: unknown[];
  positions: PositionStatus[];
  recent_events: unknown[];
}

export interface ExchangesStatus {
  spot: BotStatus | null;
  funding: BotStatus | null;
}

// ── Builders ─────────────────────────────────────────────────────────────────

/** A clear, empty instance — no sentinel, no positions, no gates, flat ledger. */
export function instanceView(overrides: Partial<InstanceView> = {}): InstanceView {
  return {
    sentinel: { state: "clear", reason: null, trippedAtMs: null },
    sentinelUpdatedAt: null,
    positions: [],
    gates: [],
    gateBotName: "kucoin-futures",
    session: {
      realizedUsdt: 0,
      closes: 0,
      entries: 0,
      killExits: 0,
      closesWithoutUsdt: 0,
    },
    ...overrides,
  };
}

export function openPosition(overrides: Partial<OpenPositionView> = {}): OpenPositionView {
  return {
    symbol: "XBTUSDTM",
    side: "LONG",
    dir: 1,
    entryPx: 61234.5,
    entryTMs: Date.now() - 3_600_000,
    closing: null,
    ...overrides,
  };
}

/** The honest not-configured payload (page shows the "database not available"
 *  panel + UNKNOWN sentinel). */
export function cockpitConfiguredFalse(
  reason = "funding bot tables not found in the configured database (funding_kill_switch absent)",
): CockpitStateResp {
  return { configured: false, reason };
}

/**
 * A configured cockpit with both instances present. Pass per-instance overrides
 * to shape a scenario (killed sentinel, open positions, …). `live` defaults to
 * the live gate-bot name so the fixture never silently mislabels the family.
 */
export function cockpitState(
  opts: {
    paper?: Partial<InstanceView>;
    live?: Partial<InstanceView>;
    other_instance_keys?: string[];
    other_sentinel_instances?: string[];
  } = {},
): CockpitStateResp {
  return {
    configured: true,
    generated_at: Date.now(),
    instances: {
      paper: instanceView(opts.paper),
      live: instanceView({ gateBotName: "kucoin-futures-live", ...opts.live }),
    },
    ...(opts.other_instance_keys ? { other_instance_keys: opts.other_instance_keys } : {}),
    ...(opts.other_sentinel_instances
      ? { other_sentinel_instances: opts.other_sentinel_instances }
      : {}),
  };
}

const EMPTY_TELE: ArmedTelemetry = {
  available: false,
  scraped: false,
  failed: [],
  haltBySymbol: {},
  breakerBySymbol: {},
  stops: {},
  orderErrors: [],
  openPositions: null,
  openNotionalUsd: null,
  entryUnixBySymbol: {},
};

/** Prometheus itself is unreachable — the telemetry outage state (never zeros). */
export function telemetryUnavailable(): ArmedTelemetry {
  return { ...EMPTY_TELE, available: false, scraped: false };
}

/** Prometheus answered but no live armed-path series exist (paper / awaiting
 *  arm) — the honest "no live bot" empty, distinct from an outage. */
export function telemetryDormant(): ArmedTelemetry {
  return { ...EMPTY_TELE, available: true, scraped: false };
}

/**
 * Prometheus answered AND a live exporter is scraped. `failed` lists any query
 * keys that produced no usable answer — those columns must render "unobserved",
 * never the benign green. Defaults to one halted-clear series so `scraped` is
 * honestly true.
 */
export function telemetryScraped(overrides: Partial<ArmedTelemetry> = {}): ArmedTelemetry {
  return {
    available: true,
    scraped: true,
    failed: [],
    haltBySymbol: { XBTUSDTM: 0 },
    breakerBySymbol: { XBTUSDTM: 0 },
    stops: { XBTUSDTM: { present: 1, expected: 1, diverged: false } },
    orderErrors: [],
    openPositions: 1,
    openNotionalUsd: 4200,
    entryUnixBySymbol: { XBTUSDTM: Math.floor(Date.now() / 1000) - 3600 },
    ...overrides,
  };
}

/** An /api/exchanges/status document carrying paper funding positions (drives
 *  the paper Unrealized ret% column). */
export function exchangesStatus(
  fundingPositions: PositionStatus[] | null = null,
): ExchangesStatus {
  if (fundingPositions === null) return { spot: null, funding: null };
  return {
    spot: null,
    funding: {
      bot: "crypto-funding",
      market: "futures",
      mode: "paper",
      uptime_secs: 3600,
      net_worth_usd: 10_000,
      pnl_usd: 0,
      signals_total: 0,
      trades_total: 0,
      wins: 0,
      losses: 0,
      win_rate: 0,
      exchanges: [],
      positions: fundingPositions,
      recent_events: [],
    },
  };
}

export function positionStatus(overrides: Partial<PositionStatus> = {}): PositionStatus {
  return {
    symbol: "XBTUSDTM",
    dir: 1,
    entry_px: 61234.5,
    entry_ts_ms: Date.now() - 3_600_000,
    mark_px: 61500,
    ret_pct: 0.43,
    updated: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}
