/**
 * Profit-window → `since` timestamp math for /treasury.
 *
 * The operator thinks in Eastern-Time calendar days (paychecks land and DCA
 * buys happen on ET days), so the "7d" / "30d" profit windows anchor at ET
 * MIDNIGHT N days back — not a rolling now-minus-168h window whose meaning
 * drifts with the time of day the page happens to load.
 *
 * Pure — no Svelte, no fetch — vitest-covered in windows.test.ts.
 */

export type ProfitWindow = '7d' | '30d' | 'all';

/** Card display order. */
export const PROFIT_WINDOWS: readonly ProfitWindow[] = ['7d', '30d', 'all'];

export const WINDOW_LABELS: Record<ProfitWindow, string> = {
  '7d': '7d',
  '30d': '30d',
  all: 'All',
};

const ET_TZ = 'America/New_York';

// en-CA date order (YYYY-MM-DD) is irrelevant here — we read formatToParts —
// but h23 matters: it avoids the hour-'24' quirk of h24 at midnight.
const ET_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: ET_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

interface EtWallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** Read a UTC instant as an ET wall-clock date/time (tz database via Intl). */
export function etWallClock(instant: Date): EtWallClock {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const p of ET_FMT.formatToParts(instant)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/**
 * The UTC instant of ET midnight on the given ET calendar date. ET is UTC−5
 * (EST) or UTC−4 (EDT); both candidate instants are checked against the tz
 * database (via Intl) rather than hard-coding DST rules. DST transitions
 * happen at 02:00 ET, so midnight itself always exists and is unambiguous.
 */
export function etMidnightUtc(year: number, month: number, day: number): Date {
  for (const offsetHours of [5, 4]) {
    const candidate = new Date(Date.UTC(year, month - 1, day, offsetHours));
    const w = etWallClock(candidate);
    if (w.year === year && w.month === month && w.day === day && w.hour === 0 && w.minute === 0) {
      return candidate;
    }
  }
  // Unreachable for America/New_York; fail safe on EST rather than throw.
  return new Date(Date.UTC(year, month - 1, day, 5));
}

/**
 * The `since` value for `GET /profit`: ET midnight N days before now's ET
 * calendar date, as an ISO-8601 UTC string. 'all' → null (= full history).
 * "7d" therefore covers 7 complete ET days plus today-so-far.
 */
export function windowToSince(window: ProfitWindow, now: Date = new Date()): string | null {
  if (window === 'all') return null;
  const days = window === '7d' ? 7 : 30;
  const today = etWallClock(now);
  // Date.UTC normalises day underflow → the ET calendar date N days back.
  const back = new Date(Date.UTC(today.year, today.month - 1, today.day - days));
  return etMidnightUtc(back.getUTCFullYear(), back.getUTCMonth() + 1, back.getUTCDate()).toISOString();
}
