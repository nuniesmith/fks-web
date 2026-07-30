/**
 * Closed-trade wire shape for `GET /api/trades` (the /performance Trade History
 * table).
 *
 * WHY THIS FILE EXISTS AND NOT AN `interface Trade` INSIDE THE PAGE:
 * there is no backend behind `/api/trades` yet — `hooks.server.ts` hardwires it
 * to `{trades: []}`, deliberately, so the route reports empty rather than
 * fake-succeeding. That means every field below is an ASSUMPTION about a
 * producer that has not been written. Buried in a component's `<script>`, an
 * assumption is invisible to the person who will eventually write the producer;
 * in `$lib/types` it is the first thing they read. The unit note on
 * `pnl_percent` is the whole point of the move.
 *
 * The page rendered `fmtPct(pnl_percent / 100)` for months. That is wrong under
 * BOTH candidate conventions — 11.28-means-11.28% renders as `+0.11%`, and
 * 0.1128-as-a-fraction needs ×100 and still renders `+0.00%` — which is what an
 * undocumented unit costs on a money table.
 */

export interface Trade {
  /** Instrument, as the venue names it (e.g. "BTC-USDT", "rithmic:MESU6"). */
  symbol: string;
  /** "buy" | "sell" by convention; matched case-insensitively when rendered. */
  side?: string;
  /**
   * Entry/exit are PRICES in the quote currency, not P&L. Render with
   * `fmtPrice` — `fmtDollar` force-signs, which is for P&L only.
   */
  entry_price?: number;
  exit_price?: number;
  /** Position size in base units (contracts / coins), not notional. */
  size?: number;
  /** Realised P&L in the account's quote currency. Signed. */
  pnl?: number;
  /**
   * ALREADY A PERCENT, NOT A FRACTION: 2.5 means 2.5%.
   *
   * This is the repo's committed convention — `fmtPct` (`$lib/utils/format`)
   * appends `%` and does NOT multiply, so this field goes to it untouched. A
   * producer that emits the fraction 0.025 for the same trade is a BUG in the
   * producer, not something the page compensates for: silently scaling here
   * would make the two conventions indistinguishable on screen.
   */
  pnl_percent?: number;
  /** ISO-8601 instants. Rendered as a LOCAL, zone-labelled wall clock. */
  open_time?: string;
  close_time?: string;
}

/** `GET /api/trades` envelope. `trades` may be absent on a degraded answer. */
export interface TradesResponse {
  trades?: Trade[];
}
