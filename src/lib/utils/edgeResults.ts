/**
 * Edge backtest results — pure display logic for /edges.
 *
 * Everything here is DOM-free so it can be unit-tested (vitest, node env):
 * reshaping `results.assets` into table rows, picking the latest run and its
 * single headline number for the portfolio table, and the small formatting /
 * badge-variant helpers shared by the edge components.
 */
import type {
  BacktestAssetBase,
  BacktestResults,
  EdgeBacktestRun,
} from "$lib/types/spawner";

// ─── Per-asset table rows ──────────────────────────────────────────────────

/** One row of the per-asset results table (skipped OR stats, never both). */
export interface AssetRow {
  symbol: string;
  /** Skip reason, or null when the asset was actually run. */
  skipped: string | null;
  base: BacktestAssetBase | null;
  /** Fraction 0–1 of the parameter grid with positive expectancy. */
  gridPositiveFraction: number | null;
}

/**
 * Flatten `results.assets` into sorted table rows. Skipped assets are kept
 * (shown honestly with their reason); assets with neither `skipped` nor
 * `base` degrade to a skipped-style row so malformed entries stay visible.
 */
export function assetRows(
  results: BacktestResults | null | undefined,
): AssetRow[] {
  const assets = results?.assets;
  if (!assets || typeof assets !== "object") return [];
  return Object.entries(assets)
    .map(([symbol, r]) => ({
      symbol,
      skipped:
        typeof r?.skipped === "string"
          ? r.skipped
          : r?.base
            ? null
            : "no result recorded",
      base: r?.base ?? null,
      gridPositiveFraction:
        typeof r?.grid_positive_fraction === "number" &&
        Number.isFinite(r.grid_positive_fraction)
          ? r.grid_positive_fraction
          : null,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

// ─── Latest run + headline picker ─────────────────────────────────────────

/** Most recently started run (defensive against unsorted input). */
export function latestRun(
  runs: EdgeBacktestRun[] | null | undefined,
): EdgeBacktestRun | null {
  if (!runs || runs.length === 0) return null;
  const ts = (r: EdgeBacktestRun) => {
    const t = Date.parse(r.started_at);
    return Number.isFinite(t) ? t : 0;
  };
  return runs.reduce((best, r) => (ts(r) > ts(best) ? r : best));
}

/** The portfolio table's one-line summary of a completed run. */
export interface RunHeadline {
  symbol: string;
  /** e.g. "+38.2% ann", "+4.1% total", "+3.4 bps/trade". */
  text: string;
}

/**
 * Pick the single best headline number from a completed run's results.
 *
 * Assets are ranked by `avg_net_bps` — the one metric every non-skipped
 * asset carries, so the comparison is always like-for-like. The label then
 * prefers the winner's annualised return, falling back to total return and
 * finally to net bps/trade. Returns null when every asset was skipped.
 */
export function pickHeadline(
  results: BacktestResults | null | undefined,
): RunHeadline | null {
  const rows = assetRows(results).filter(
    (r) => r.base != null && Number.isFinite(r.base.avg_net_bps),
  );
  if (rows.length === 0) return null;
  const best = rows.reduce((a, b) =>
    b.base!.avg_net_bps > a.base!.avg_net_bps ? b : a,
  );
  const base = best.base!;
  let text: string;
  if (base.ann_return_pct != null && Number.isFinite(base.ann_return_pct)) {
    text = `${fmtSigned(base.ann_return_pct)}% ann`;
  } else if (
    base.total_return_pct != null &&
    Number.isFinite(base.total_return_pct)
  ) {
    text = `${fmtSigned(base.total_return_pct)}% total`;
  } else {
    text = `${fmtSigned(base.avg_net_bps)} bps/trade`;
  }
  return { symbol: best.symbol, text };
}

// ─── Formatting helpers ────────────────────────────────────────────────────

/** Signed fixed-decimal number: "+3.4" / "-1.2" / "—" for missing. */
export function fmtSigned(
  n: number | null | undefined,
  decimals = 1,
): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(decimals)}`;
}

/**
 * A 0–1 fraction as a whole percent: 0.62 → "62%". Values > 1 are treated
 * as already-percent (defensive against harnesses that emit 62 not 0.62).
 */
export function fmtRatePct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const pct = n <= 1 ? n * 100 : n;
  return `${pct.toFixed(0)}%`;
}

/** Prefill for the run-backtest params editor: {"days":60,"symbols":[...]}. */
export function defaultBacktestParams(
  assetScope: string[] | null | undefined,
): string {
  return JSON.stringify({ days: 60, symbols: assetScope ?? [] }, null, 2);
}

// ─── Badge variants ────────────────────────────────────────────────────────

export type BadgeVariant =
  | "default"
  | "green"
  | "red"
  | "amber"
  | "cyan"
  | "purple";

/** Edge lifecycle status → distinct badge colour. */
export function edgeStatusVariant(status: string): BadgeVariant {
  switch (status) {
    case "live":
      return "green";
    case "paper":
      return "amber";
    case "research":
      return "cyan";
    case "retired":
      return "default";
    default:
      return "default";
  }
}

/** Edge type (adaptive | rule) → badge colour. */
export function edgeTypeVariant(edgeType: string): BadgeVariant {
  if (edgeType === "adaptive") return "purple";
  if (edgeType === "rule") return "cyan";
  return "default";
}

/** Backtest-run status → badge colour. */
export function runStatusVariant(status: string): BadgeVariant {
  switch (status) {
    case "running":
      return "amber";
    case "completed":
      return "green";
    case "failed":
      return "red";
    default:
      return "default";
  }
}
