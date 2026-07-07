/**
 * Rithmic connector types — mirror of the read-only `/positions` surface
 * exposed by `crates/rithmic-connector` (fks #183) and adapted by
 * `/api/rithmic/positions` in hooks.server.ts.
 *
 * READ-ONLY by construction: the connector never opens the order plant. These
 * types describe *observed* positions/PnL, never an order.
 */

/** One open futures position as last reported by Rithmic. */
export interface RithmicPosition {
  symbol: string;
  exchange: string;
  product_code: string;
  /** Signed net quantity (>0 long, <0 short). */
  net_quantity: number;
  /** `long` / `short` / `flat`. */
  direction: string;
  avg_open_price: number;
  open_pnl: number;
  day_pnl: number;
  buy_qty: number;
  sell_qty: number;
  open_quantity: number;
  account_id: string;
}

/** Account-level P&L summary, when the connector has received one. */
export interface RithmicAccountSummary {
  account_id: string;
  net_quantity: number;
  open_pnl: number;
  day_pnl: number;
  account_balance: number;
}

/** The `/api/rithmic/positions` adapter response. */
export interface RithmicPositionsView {
  /** Whether the connector's `/positions` surface responded. */
  connected: boolean;
  account: string;
  count: number;
  positions: RithmicPosition[];
  account_summary: RithmicAccountSummary | null;
}
