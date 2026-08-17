/**
 * FKS Terminal — Shared Formatter Utilities
 *
 * Centralises all common display-formatting functions so they can be
 * imported from `$lib/utils/format` instead of being copy-pasted into
 * every page/component.
 */

// ─── Price / Number ────────────────────────────────────────────────────────

/**
 * Format a price with adaptive decimal precision.
 *  < 1      → 6 decimals  (crypto sub-dollar)
 *  < 100    → 4 decimals  (mid-range futures)
 *  >= 100   → 2 decimals  (equities / large futures)
 */
export function fmtPrice(n: number | undefined | null): string {
  if (n == null) return '—';
  const abs = Math.abs(n);
  const digits = abs < 1 ? 6 : abs < 100 ? 4 : 2;
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * Format a percentage with sign prefix: "+1.23%" / "-0.45%"
 */
export function fmtPct(n: number | undefined | null): string {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

/**
 * Format a dollar P&L value with sign prefix: "+$12.34" / "-$5.00".
 *
 * ALWAYS SIGNED — this is the P&L formatter. For a balance / net-worth figure
 * use `fmtMoney` below, which is the same grouped notation without the forced
 * sign.
 *
 * Thousands are grouped (M-1). Before that, `/exchanges` rendered a grouped
 * `$12,345.67` net worth in the same `.stat-row` as an ungrouped `+$4567.89`
 * P&L: two notations for the same class of money, adjacent, where a five-figure
 * loss reads as four figures at a phone glance.
 */
export function fmtDollar(n: number | undefined | null): string {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * "$1,234.56" (USD) / "1,234.56 EUR" (other) / "—" for null.
 *
 * UNSIGNED — for balances, net worth, deposits: any figure whose sign is not
 * the information. Null figures come straight from the spawner's honest
 * no-data answer — never render them as 0.
 *
 * Promoted here from `$lib/treasury/cards.ts` (M-1): this module declares
 * itself the anti-copy-paste home for formatters, yet the repo's only correctly
 * grouped money pair lived in a treasury helper, so four pages hand-rolled a
 * local `usd()` beside a comment rediscovering that `fmtDollar` force-signs.
 * `cards.ts` re-exports both for compatibility.
 */
export function fmtMoney(value: number | null | undefined, currency = 'USD'): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const n = value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === 'USD' ? `$${n}` : `${n} ${currency}`;
}

/**
 * Signed money: "+$12.34" / "-$5.00" / "$0.00" (flat) / "—" (no data).
 *
 * Differs from `fmtDollar` on two points that matter: it is currency-aware, and
 * a FLAT figure stays unsigned (`$0.00`, not `+$0.00`) so a zero P&L is not
 * painted as a gain.
 */
export function fmtSignedMoney(value: number | null | undefined, currency = 'USD'): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value === 0) return fmtMoney(0, currency);
  return `${value > 0 ? '+' : '-'}${fmtMoney(Math.abs(value), currency)}`;
}

/**
 * Format a USDT-denominated P&L figure: "+12.34 USDT" / "-5.00 USDT" /
 * "0.00 USDT" (flat).
 *
 * Deliberately NOT `fmtDollar` (M-1) — the cockpit's live/paper funding-bot
 * session PnL is quoted in USDT, not USD, and the suffix notation (vs.
 * `fmtDollar`'s `$` prefix) is how the two are told apart on the one screen
 * that shows both a bot's USDT session PnL and USD figures side by side.
 * Extracted verbatim from `cockpit/+page.svelte`'s local `usdt()` — same
 * sign convention (explicit `+` only on strictly positive; zero and negative
 * rely on `toFixed`'s own minus, so zero is unsigned) — no display change on
 * the live-money page.
 */
export function fmtUsdt(n: number | undefined | null): string {
  if (n == null) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)} USDT`;
}

/**
 * Format a confidence value.
 * Accepts either a fraction (0–1) or a percentage (1–100).
 * Returns "73%" style string.
 */
export function fmtConfidence(n: number | undefined | null): string {
  if (n == null) return '—';
  if (n <= 1) return (n * 100).toFixed(0) + '%';
  return n.toFixed(0) + '%';
}

/**
 * Format a number with a fixed number of decimal places.
 */
export function fmtFixed(n: number | undefined | null, decimals = 2): string {
  if (n == null) return '—';
  return n.toFixed(decimals);
}

/**
 * Format a large integer with locale thousands separators: "1,234,567"
 */
export function fmtInt(n: number | undefined | null): string {
  if (n == null) return '—';
  return Math.round(n).toLocaleString('en-US');
}

// ─── Colour Helpers ────────────────────────────────────────────────────────

export type ScoreColor = 'green' | 'amber' | 'cyan' | 'red';
export type SignalVariant = 'green' | 'red' | 'amber' | 'default';
export type RiskVariant = 'green' | 'amber' | 'red' | 'default';
export type RegimeVariant = 'green' | 'red' | 'amber' | 'cyan' | 'purple' | 'default';
export type DirectionVariant = 'green' | 'red' | 'default';

/**
 * Map a 0–100 score to a colour bucket for badges / progress bars.
 *  >= 70 → green
 *  >= 40 → cyan
 *  >= 20 → amber
 *  <  20 → red
 */
export function scoreColor(score: number): ScoreColor {
  if (score >= 70) return 'green';
  if (score >= 40) return 'cyan';
  if (score >= 20) return 'amber';
  return 'red';
}

/**
 * Map a signal string (buy/sell/hold/…) to a Badge variant.
 */
export function signalVariant(signal: string | undefined | null): SignalVariant {
  if (!signal) return 'default';
  const s = signal.toLowerCase();
  if (s.includes('buy') || s.includes('long') || s.includes('bull')) return 'green';
  if (s.includes('sell') || s.includes('short') || s.includes('bear')) return 'red';
  if (s.includes('hold') || s.includes('neutral')) return 'amber';
  return 'default';
}

/**
 * Map a drawdown percentage to a risk colour variant.
 *  > 5% → red
 *  > 2% → amber
 *  else → green
 */
export function riskVariant(dd: number | undefined | null): RiskVariant {
  if (dd == null) return 'default';
  if (dd > 5) return 'red';
  if (dd > 2) return 'amber';
  return 'green';
}

/**
 * Map a regime label string to a Badge variant.
 */
export function regimeVariant(
  label: string | undefined | null,
): RegimeVariant {
  if (!label) return 'default';
  const l = label.toLowerCase();
  if (l.includes('bull') || l.includes('trend up') || l.includes('risk on')) return 'green';
  if (l.includes('bear') || l.includes('trend down') || l.includes('risk off')) return 'red';
  if (l.includes('chop') || l.includes('range') || l.includes('neutral')) return 'amber';
  if (l.includes('volat')) return 'purple';
  return 'cyan';
}

/**
 * Map a trade direction string (long/short/buy/sell) to a Badge variant.
 */
export function directionVariant(dir: string | undefined | null): DirectionVariant {
  if (!dir) return 'default';
  const d = dir.toLowerCase();
  if (d === 'long' || d === 'buy') return 'green';
  if (d === 'short' || d === 'sell') return 'red';
  return 'default';
}

// ─── Time ──────────────────────────────────────────────────────────────────

/**
 * Format a UTC timestamp (ISO string or ms epoch) as a short local time.
 * e.g. "14:32:07"
 */
export function fmtTime(ts: string | number | undefined | null): string {
  if (ts == null) return '—';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-US', { hour12: false });
}

/**
 * Format a UTC timestamp as a short LOCAL date+time, zone named.
 * e.g. "2025-07-18 14:32 EDT"
 *
 * The zone marker is load-bearing (Q-5). `cockpit/+page.svelte`'s `tsLabel`
 * stamps the kill-sentinel trip time in UTC with a trailing `Z`; this renders
 * the operator's wall clock. Unlabelled, the two produce near-identical
 * "YYYY-MM-DD HH:MM" strings on adjacent tabs, so an incident timeline built
 * from both is silently off by the local UTC offset. Naming the zone here is
 * cheaper than converting every ledger/trade/run stamp to UTC.
 */
export function fmtDateTime(ts: string | number | undefined | null): string {
  if (ts == null) return '—';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return '—';
  const date = d.toLocaleDateString('en-CA'); // YYYY-MM-DD
  const time = d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  return `${date} ${time}`;
}

/**
 * Format a timestamp as a compact relative age, e.g. "just now", "30s ago",
 * "5m ago", "2h ago", "3d ago". Client-safe (mirrors the server's
 * `humanizeSince` but lives in `$lib/utils` so components can import it, and
 * appends "ago"). Pair with `fmtDateTime` in a `title=` for the exact instant.
 */
export function fmtRelative(ts: string | number | undefined | null): string {
  if (ts == null) return "—";
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Return the current wall-clock time as a "HH:MM:SS TZ" string,
 * suitable for the terminal strip clock.
 */
export function nowClock(): string {
  return new Date().toLocaleTimeString('en-US', {
    hour12: false,
    timeZoneName: 'short',
  });
}
