/**
 * History recorders (fks-spawner bots/history): Binance's public archive,
 * downloaded into the lake and kept current. Their `/status` is a table of
 * series (dataset × symbol × candle interval) with file counts by state, not
 * live streams, so they get their own card on the Data page.
 *
 * The files are research input only: janus stays the source of bars and
 * signals for charts and the live bots (EDGE_FACTORY_PLAN §12).
 */
import { fmtDuration } from '$lib/coverage';
import type { HistorySeries, HistoryStatus, Instance } from '$lib/types/spawner';

/** History templates are `history.*` (fks templates/history.*.json). */
export function isHistory(i: Pick<Instance, 'template'>): boolean {
  return i.template?.startsWith('history.') ?? false;
}

export const DATASET_LABELS: Record<string, string> = {
  klines: 'Candles',
  fundingRate: 'Funding',
  metrics: 'Open interest',
};

const DATASET_ORDER = ['klines', 'fundingRate', 'metrics'];
const INTERVAL_ORDER = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d'];

export type RowState = 'failing' | 'waiting' | 'complete' | 'empty';

export interface HistoryRow extends HistorySeries {
  key: string;
  /** Files the archive has or will have: expected minus the never-published. */
  available: number;
  state: RowState;
}

function rank(order: string[], v: string | null): number {
  const i = order.indexOf(v ?? '');
  return i < 0 ? order.length : i;
}

/**
 * One row per series, by symbol, then dataset, then interval. A row is
 * failing when its last check had errors, waiting when only recent files
 * are missing (the archive publishes a day about a day late), complete when
 * every file the archive has is on disk.
 */
export function historyRows(doc: Pick<HistoryStatus, 'series'>): HistoryRow[] {
  return Object.entries(doc.series ?? {})
    .map(([key, s]) => {
      const available = s.expected - s.not_published;
      const state: RowState =
        s.errors > 0 ? 'failing' : available <= 0 ? 'empty' : s.present >= available ? 'complete' : 'waiting';
      return { ...s, key, available, state };
    })
    .sort(
      (a, b) =>
        a.symbol.localeCompare(b.symbol) ||
        rank(DATASET_ORDER, a.dataset) - rank(DATASET_ORDER, b.dataset) ||
        rank(INTERVAL_ORDER, a.interval) - rank(INTERVAL_ORDER, b.interval),
    );
}

function ago(ms: number, now: number): string {
  const s = Math.max(0, (now - ms) / 1000);
  return s < 1 ? 'just now' : `${fmtDuration(s)} ago`;
}

/** What the recorder is doing, in one line. */
export function cycleLine(doc: HistoryStatus, now: number): string {
  const c = doc.cycle;
  const n = (x: number) => x.toLocaleString('en-US');
  if (c.running) {
    const first = Object.keys(doc.series ?? {}).length === 0 ? 'First check' : 'Checking';
    return `${first}: ${n(c.checked)} of ${n(c.planned)} files, ${n(c.downloaded)} new so far`;
  }
  if (c.finished_at_ms == null) return 'No check has run yet';
  const parts = [`Last check ${ago(c.finished_at_ms, now)}: ${n(c.downloaded)} new`];
  if (c.errors) parts.push(`${n(c.errors)} failed`);
  let line = parts.join(', ');
  if (c.next_at_ms != null) {
    line += c.next_at_ms > now ? ` · next in ${fmtDuration((c.next_at_ms - now) / 1000)}` : ' · next due now';
  }
  return line;
}

/** Totals across series, for the card's summary line. */
export function historyTotals(rows: HistoryRow[]): { files: number; bytes: number; failing: number } {
  return {
    files: rows.reduce((sum, r) => sum + r.present, 0),
    bytes: rows.reduce((sum, r) => sum + r.bytes, 0),
    failing: rows.filter((r) => r.state === 'failing').length,
  };
}
