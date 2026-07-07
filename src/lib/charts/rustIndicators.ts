// ════════════════════════════════════════════════════════════════════════════
// Rust indicators-ta catalog merge (chart Indicators dropdown)
// ════════════════════════════════════════════════════════════════════════════
// Pure helpers that merge janus's Rust `indicators-ta` catalog
// (GET /api/janus/indicators/catalog) into the chart's Indicators menu. The
// goal: indicators newly added to the Rust crate auto-appear in the dropdown
// without a fks-web code change.
//
// Dedupe policy: for indicator concepts already wired via the TS engine
// (EMA/SMA/WMA/MACD/ATR/RSI/Stochastic/Williams %R/Bollinger/Keltner/VWAP) we
// keep the TS implementation — it is already integrated with the on-chart param
// editor + presets + persistence. Only Rust-ONLY indicators are surfaced (with
// a "ta" badge), which is the whole point: new Rust indicators show up.
//
// No I/O here — the fetch lives in the component; this module is unit-tested.

/** Param kinds emitted by the Rust catalog. */
export type RustParamKind = "Integer" | "Float";

/** A tunable param descriptor from the Rust catalog (default/min/max are f64). */
export interface RustParam {
  name: string;
  kind: RustParamKind;
  default: number;
  min: number;
  max: number;
}

/** Rust indicator category → which chart pane it renders in. */
export type RustCategory = "Overlay" | "Oscillator";

/** One indicator descriptor from GET /api/janus/indicators/catalog. */
export interface RustIndicator {
  id: string;
  display_name: string;
  category: RustCategory;
  params: RustParam[];
}

/** Bare shape of the catalog response: { count, indicators }. */
export interface RustCatalogResponse {
  count?: number;
  indicators?: RustIndicator[];
}

// Rust indicator ids whose concept is already wired via the TS indicator engine.
// We prefer the TS implementation for these and only add Rust-ONLY indicators.
// (Keep in sync with the chart's TS INDICATOR_CATALOG + buttoned overlays.)
export const TS_COVERED_RUST_IDS: ReadonlySet<string> = new Set([
  "ema",
  "sma",
  "wma",
  "macd",
  "atr",
  "rsi",
  "stochastic",
  "williamsr",
  "bollingerbands",
  "keltnerchannels",
  "vwap",
]);

/** Narrow an unknown value to a valid RustCategory (defaults to Oscillator). */
function normCategory(c: unknown): RustCategory {
  return c === "Overlay" ? "Overlay" : "Oscillator";
}

/** Narrow an unknown value to a valid RustParamKind (defaults to Float). */
function normKind(k: unknown): RustParamKind {
  return k === "Integer" ? "Integer" : "Float";
}

/**
 * Sanitize the raw catalog response into typed, deduped RustIndicator[].
 * Drops malformed entries (missing/duplicate id). Tolerant of `{}` (janus
 * unreachable → the adapter degrades to an empty list, chart keeps TS set).
 */
export function parseRustCatalog(resp: RustCatalogResponse | null | undefined): RustIndicator[] {
  const raw = Array.isArray(resp?.indicators) ? resp!.indicators! : [];
  const seen = new Set<string>();
  const out: RustIndicator[] = [];
  for (const ind of raw) {
    const id = (ind as { id?: unknown })?.id;
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const params = Array.isArray(ind.params)
      ? ind.params
          .filter((p) => p && typeof (p as RustParam).name === "string")
          .map((p) => ({
            name: p.name,
            kind: normKind(p.kind),
            default: Number(p.default),
            min: Number(p.min),
            max: Number(p.max),
          }))
      : [];
    out.push({
      id,
      display_name: typeof ind.display_name === "string" ? ind.display_name : id,
      category: normCategory(ind.category),
      params,
    });
  }
  return out;
}

/**
 * The Rust-ONLY indicators to add to the dropdown: every catalog entry whose id
 * is NOT already covered by the TS engine. Preserves catalog order
 * (trend→momentum→volatility→volume). Deduped by parseRustCatalog upstream.
 */
export function rustOnlyIndicators(
  indicators: RustIndicator[],
  covered: ReadonlySet<string> = TS_COVERED_RUST_IDS,
): RustIndicator[] {
  return indicators.filter((ind) => !covered.has(ind.id));
}

/** Clamp+round a param value per its descriptor (Integer → rounded). */
export function clampParam(param: RustParam, value: number): number {
  let v = Number(value);
  if (!Number.isFinite(v)) v = param.default;
  if (param.kind === "Integer") v = Math.round(v);
  else v = Math.round(v * 1e6) / 1e6;
  if (Number.isFinite(param.min)) v = Math.max(param.min, v);
  if (Number.isFinite(param.max)) v = Math.min(param.max, v);
  return v;
}

/** Default param map ({ name → default }) for an indicator descriptor. */
export function defaultParams(ind: RustIndicator): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of ind.params) out[p.name] = clampParam(p, p.default);
  return out;
}

/**
 * Build the query string for GET /api/janus/indicators/compute. Params are
 * forwarded verbatim as tunables using the catalog param `name` keys
 * (e.g. &period=21). Values are clamped per descriptor before sending.
 */
export function computeQuery(opts: {
  symbol: string;
  indicator: RustIndicator;
  interval: string;
  params?: Record<string, number>;
  daysBack?: number;
  limit?: number;
}): string {
  const { symbol, indicator, interval, params, daysBack, limit } = opts;
  const q = new URLSearchParams();
  q.set("symbol", symbol);
  q.set("indicator", indicator.id);
  q.set("interval", interval);
  if (daysBack != null) q.set("days_back", String(daysBack));
  if (limit != null) q.set("limit", String(limit));
  for (const p of indicator.params) {
    const raw = params?.[p.name];
    q.set(p.name, String(clampParam(p, raw == null ? p.default : raw)));
  }
  return q.toString();
}

/** A single { time, value } point from a compute series line. */
export interface ComputePoint {
  time: number;
  value: number;
}

/** Shape of GET /api/janus/indicators/compute (200). */
export interface ComputeResponse {
  symbol?: string;
  interval?: string;
  indicator?: string;
  series?: Record<string, ComputePoint[]>;
  count?: number;
}

/**
 * Extract the ordered { key, points } lines from a compute response. Filters
 * out non-array entries; each line's points are passed through as-is (janus
 * already trims warm-up NaNs and emits epoch-SECONDS time to match the chart).
 */
export function computeLines(
  resp: ComputeResponse | null | undefined,
): { key: string; points: ComputePoint[] }[] {
  const series = resp?.series;
  if (!series || typeof series !== "object") return [];
  const out: { key: string; points: ComputePoint[] }[] = [];
  for (const [key, points] of Object.entries(series)) {
    if (Array.isArray(points)) out.push({ key, points: points as ComputePoint[] });
  }
  return out;
}
