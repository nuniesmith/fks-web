/**
 * Normalizers for the crypto bots' `recent_events` entries (see
 * `$lib/types/exchanges.ts` `TradeEvent` for the source shapes).
 *
 * The funding (futures) bot pushes two shapes that share almost no field
 * names with the spot bot's rebalance trades:
 *
 * - live fills:          `{ kind: "futures-fill", symbol, side, price, size, fee, ts }`
 * - paper trade records: `{ t (ms), sym, action, dir, entry_px[, exit_px, ret_pct], ts }`
 *
 * `normalizeFuturesEvent` maps both onto one row shape for the venue-detail
 * table. Fields a shape genuinely lacks come back `null` so the UI renders a
 * deliberate em dash (paper records have no size; only exits have a return).
 */

import type { FuturesEventRow, TradeEvent } from '$lib/types/exchanges';

/** True when the event is a futures live fill (from `observe_fill`). */
export function isFuturesFill(e: TradeEvent): boolean {
  return e.kind === 'futures-fill';
}

/**
 * Map one futures `recent_events` entry (live fill or funding-reversion
 * paper record) onto the display row shape.
 */
export function normalizeFuturesEvent(e: TradeEvent): FuturesEventRow {
  // Prefer the bot-stamped epoch-seconds `ts`; paper records also carry the
  // event wall-clock as `t` in milliseconds.
  const ts = e.ts ?? (typeof e.t === 'number' ? Math.floor(e.t / 1000) : null);

  if (isFuturesFill(e)) {
    return {
      ts,
      event: 'fill',
      side: e.side ?? null,
      symbol: e.symbol ?? null,
      size: e.size ?? null,
      price: e.price ?? null,
      ret_pct: null, // fills carry fee, not a round-trip return
    };
  }

  // Funding-reversion paper record ("entry" | "exit" | "stop_exit") — with a
  // defensive fallback for any unknown shape so a new bot event still renders
  // a labelled row instead of a blank one.
  const action = e.action ?? e.kind ?? e.event ?? null;
  const dir = typeof e.dir === 'number' ? e.dir : null;
  return {
    ts,
    event: action != null ? action.replaceAll('_', ' ') : '—',
    side: dir == null || dir === 0 ? null : dir > 0 ? 'long' : 'short',
    symbol: e.sym ?? e.symbol ?? null,
    size: null, // paper records carry no order size
    // Exits report the acted price as exit_px; entries only have entry_px.
    price: e.exit_px ?? e.entry_px ?? e.price ?? null,
    ret_pct: e.ret_pct ?? null,
  };
}
