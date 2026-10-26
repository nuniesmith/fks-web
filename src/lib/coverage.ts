/**
 * Day-by-day verdicts for a recorder's coverage calendar.
 *
 * Input is the spawner's `GET /instances/{name}/files` scan (fks-spawner #64):
 * which (symbol, stream) files exist per UTC day, whether each day is closed
 * (gzipped), and the gap ledger summed per day. Output is one cell per day for
 * a fixed window ending today, so a day with NO files still gets a cell — a
 * hole in the calendar is the thing this view exists to show.
 *
 * The expected streams are the (symbol, stream) pairs seen anywhere in the
 * window: a day missing one of them is partial. A few seconds of gap is normal
 * (every reconnect and every start logs one), so gaps only mark a day once
 * they pass `gapToleranceSeconds`.
 */
import type { Coverage } from '$lib/types/spawner';

export type DayState =
  /** Before the recorder's first file: not a hole, just not started. */
  | 'before'
  /** Today: still being written. */
  | 'open'
  /** Every expected stream closed, gaps within tolerance. */
  | 'complete'
  /** All streams present but more than the tolerated gap time. */
  | 'gaps'
  /** A stream is missing or a past day was never closed. */
  | 'partial'
  /** Nothing at all for a day after recording started. */
  | 'missing';

export interface DayCell {
  day: string;
  state: DayState;
  bytes: number;
  gapSeconds: number;
  gapCount: number;
  /** Why the day is not complete, for the cell's tooltip. */
  reasons: string[];
}

/** `YYYY-MM-DD` for a UTC instant. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The `count` UTC days ending at `today`, oldest first. */
export function dayWindow(today: string, count: number): string[] {
  const end = Date.parse(`${today}T00:00:00Z`);
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) days.push(utcDay(end - i * 86_400_000));
  return days;
}

export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function calendar(
  cov: Coverage,
  today: string,
  count = 30,
  gapToleranceSeconds = 60,
): DayCell[] {
  const expected = new Set(cov.files.map((f) => `${f.symbol}/${f.stream}`));
  const firstDay = cov.first_day;
  return dayWindow(today, count).map((day) => {
    const files = cov.files.filter((f) => f.day === day);
    const gaps = cov.gaps.filter((g) => g.day === day);
    const gapSeconds = gaps.reduce((sum, g) => sum + g.seconds, 0);
    const gapCount = gaps.reduce((sum, g) => sum + g.count, 0);
    const bytes = files.reduce((sum, f) => sum + f.bytes, 0);
    const cell = { day, bytes, gapSeconds, gapCount, reasons: [] as string[] };

    if (!firstDay || day < firstDay) return { ...cell, state: 'before' };
    if (day === today) {
      if (gapSeconds > gapToleranceSeconds) cell.reasons.push(`gaps ${fmtDuration(gapSeconds)} so far`);
      return { ...cell, state: 'open' };
    }
    if (files.length === 0) {
      return { ...cell, state: 'missing', reasons: ['no files'] };
    }
    const present = new Set(files.map((f) => `${f.symbol}/${f.stream}`));
    const absent = [...expected].filter((k) => !present.has(k));
    if (absent.length) cell.reasons.push(`no ${absent.join(', ')}`);
    const unclosed = files.filter((f) => !f.closed);
    if (unclosed.length) cell.reasons.push('not closed (the recorder was down at 00:00 UTC?)');
    if (cell.reasons.length) return { ...cell, state: 'partial' };
    if (gapSeconds > gapToleranceSeconds) {
      cell.reasons.push(`gaps ${fmtDuration(gapSeconds)}`);
      return { ...cell, state: 'gaps' };
    }
    return { ...cell, state: 'complete' };
  });
}

/** Share of the window's recorded days (from the first file) that are complete. */
export function completeShare(cells: DayCell[]): number | null {
  const judged = cells.filter((c) => c.state !== 'before' && c.state !== 'open');
  if (judged.length === 0) return null;
  return judged.filter((c) => c.state === 'complete').length / judged.length;
}
