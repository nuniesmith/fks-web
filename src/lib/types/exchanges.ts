/**
 * Exchanges / net-worth types — mirror of the crypto bots' `/status` document
 * (crypto repo `src/status.rs`: `StatusState::status_json`, `VenueStatus`,
 * `HoldingStatus`, `PositionStatus`). Field names must match that serde
 * output exactly.
 */

export interface HoldingStatus {
  asset: string;
  qty: number;
  price: number;
  value: number;
  /** Current portfolio weight 0–1. */
  weight: number;
  /** Configured target weight 0–1. */
  target_weight: number;
}

export interface VenueStatus {
  exchange: string;
  /** "paper" | "dry-run" | "live" — paper venues must be excluded from real totals. */
  mode: string;
  cash_asset: string;
  cash: number;
  total_value: number;
  /** Max |weight - target| across holdings, 0–1. */
  max_drift: number;
  triggered: boolean;
  /** Epoch seconds of the last rebalance, if any. */
  last_rebalance: number | null;
  /** Epoch seconds of the last snapshot update. */
  updated: number;
  holdings: HoldingStatus[];
}

export interface PositionStatus {
  symbol: string;
  /** +1 long, -1 short. */
  dir: number;
  entry_px: number;
  entry_ts_ms: number;
  mark_px: number;
  /** Signed return % on the position (already leveraged). */
  ret_pct: number;
  updated: number;
}

export interface BotStatus {
  bot: string;
  market: 'spot' | 'futures' | string;
  mode: string;
  uptime_secs: number;
  net_worth_usd: number;
  pnl_usd: number;
  signals_total: number;
  trades_total: number;
  wins: number;
  losses: number;
  win_rate: number;
  exchanges: VenueStatus[];
  positions: PositionStatus[];
  recent_events: unknown[];
}

/**
 * One entry of `recent_events` (loose: spot and futures bots push different
 * shapes). Spot rebalance fills: `{ event: "rebalance_trade", venue, live,
 * asset, side, volume, usd, price, ts }`. Futures live fills
 * (`futures/brain.rs` `observe_fill`): `{ kind: "futures-fill", symbol,
 * side: "Buy"|"Sell", price, size, fee, ts }`. Futures funding-reversion
 * paper records (`futures/funding_brain.rs` `record`): `{ t (epoch ms), sym,
 * action: "entry"|"exit"|"stop_exit", dir: ±1, entry_px, ts }` plus
 * `funding`/`pct` on entries and `exit_px`/`ret_pct` on exits. `ts` (epoch
 * secs) is stamped by the bot's push_event.
 */
export interface TradeEvent {
  event?: string;
  action?: string;
  venue?: string;
  asset?: string;
  sym?: string;
  side?: string;
  volume?: number;
  usd?: number;
  price?: number;
  live?: boolean;
  ts?: number;
  // ── Futures-fill fields (live fills via observe_fill) ──
  kind?: string;
  symbol?: string;
  size?: number;
  fee?: number;
  // ── Funding-reversion paper-record fields ──
  /** Event wall-clock, epoch **milliseconds** (paper records only). */
  t?: number;
  /** +1 long / -1 short. */
  dir?: number;
  entry_px?: number;
  exit_px?: number;
  /** Direction-signed round-trip return, in percent (exits only). */
  ret_pct?: number;
  /** Latest funding rate at entry. */
  funding?: number;
  /** Funding-rate trailing percentile at entry, 0–1. */
  pct?: number;
  [key: string]: unknown;
}

/**
 * A futures `recent_events` entry normalized for tabular display — the
 * output of `$lib/utils/tradeEvents.normalizeFuturesEvent`. `null` means the
 * source event genuinely does not carry the field (rendered as an em dash).
 */
export interface FuturesEventRow {
  /** Epoch seconds (bot-stamped `ts`, else derived from the ms `t`). */
  ts: number | null;
  /** "fill" | "entry" | "exit" | "stop exit" (underscores prettified). */
  event: string;
  /** Order side ("Buy"/"Sell") for fills; position side ("long"/"short") for paper records. */
  side: string | null;
  symbol: string | null;
  /** Fill size in contracts (fills only — paper records carry no size). */
  size: number | null;
  /** Fill price / entry price / exit price, per event kind. */
  price: number | null;
  /** Direction-signed round-trip return % (exits only). */
  ret_pct: number | null;
}

/** Response of the adapter's GET /api/exchanges/status. */
export interface ExchangesStatus {
  spot: BotStatus | null;
  funding: BotStatus | null;
}
