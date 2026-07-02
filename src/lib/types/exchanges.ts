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
 * asset, side, volume, usd, price, ts }`. Futures paper records use
 * `{ action: "entry"|"exit"|…, sym, … }`. `ts` (epoch secs) is stamped by
 * the bot's push_event.
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
  [key: string]: unknown;
}

/** Response of the adapter's GET /api/exchanges/status. */
export interface ExchangesStatus {
  spot: BotStatus | null;
  funding: BotStatus | null;
}
