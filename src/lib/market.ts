/**
 * The janus market-data table on the Data page: one row per coin, with each
 * interval's bar count, span and completeness.
 *
 * Completeness is bars recorded over bars expected across the first-to-last
 * span. It cannot see a gap at the very end (that is what the last-bar age is
 * for), only holes in between.
 */
import type { MarketCoverageRow } from '$lib/types/market';

/** Minutes in an interval label: `1m`, `5m`, `1h`, `4h`, `1d`. Null if unknown. */
export function intervalMinutes(interval: string): number | null {
  const m = /^(\d+)\s*([mhdw])$/i.exec(interval.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const per = unit === 'm' ? 1 : unit === 'h' ? 60 : unit === 'd' ? 1440 : 10080;
  return n > 0 ? n * per : null;
}

/** Bars recorded / bars expected between the first and the last bar. */
export function completeness(row: MarketCoverageRow): number | null {
  const minutes = intervalMinutes(row.interval);
  if (!minutes || !row.first || !row.last) return null;
  const span = Date.parse(row.last) - Date.parse(row.first);
  if (!Number.isFinite(span) || span < 0) return null;
  const expected = Math.floor(span / (minutes * 60_000)) + 1;
  return expected > 0 ? Math.min(1, row.bars / expected) : null;
}

export interface CoinRow {
  symbol: string;
  intervals: Record<string, MarketCoverageRow>;
  /** The most recent bar across intervals. */
  last: string | null;
}

/** One row per symbol, intervals side by side, sorted by symbol. */
export function byCoin(rows: MarketCoverageRow[]): CoinRow[] {
  const map = new Map<string, CoinRow>();
  for (const r of rows) {
    const coin = map.get(r.symbol) ?? { symbol: r.symbol, intervals: {}, last: null };
    coin.intervals[r.interval] = r;
    if (r.last && (!coin.last || r.last > coin.last)) coin.last = r.last;
    map.set(r.symbol, coin);
  }
  return [...map.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Every interval present, shortest first. */
export function intervalsOf(rows: MarketCoverageRow[]): string[] {
  return [...new Set(rows.map((r) => r.interval))].sort(
    (a, b) => (intervalMinutes(a) ?? Infinity) - (intervalMinutes(b) ?? Infinity),
  );
}
