/**
 * Pure reshapers for the Prometheus HTTP API `/api/v1/query_range` response
 * (proxied by the webui as `/api/metrics/query_range` — see hooks.server.ts).
 *
 * Range response shape (resultType "matrix"):
 *   { status, data: { resultType, result: [ { metric: {…labels}, values: [[ts, "value"], …] } ] } }
 * Each sample is `[<unix seconds>, "<float as string>"]`. We reshape those into
 * `{ time, value }` points suitable for a lightweight-charts line series
 * (time = unix seconds, ascending + unique).
 *
 * Kept framework-agnostic and side-effect-free so it can be unit-tested and
 * reused by any panel that reads a Prometheus range query.
 */

export interface PromRangeSample {
  0: number; // unix seconds (may be fractional)
  1: string; // float value, as a string
}

export interface PromRangeSeries {
  metric: Record<string, string>;
  values: [number, string][];
}

export interface PromRangeResponse {
  status?: string;
  data?: {
    resultType?: string;
    result?: PromRangeSeries[];
  };
}

/** A single line-chart point: `time` is unix seconds, `value` a finite number. */
export interface LinePoint {
  time: number;
  value: number;
}

/** One named series (keyed by a chosen label, e.g. `exchange`) + its points. */
export interface NamedSeries {
  key: string;
  points: LinePoint[];
}

/**
 * Reshape a single series' `values` array into ascending, unique-timestamp
 * line points. Drops samples that don't parse to a finite number, floors
 * fractional timestamps to whole seconds, sorts ascending, and collapses
 * duplicate timestamps (keeping the last) — lightweight-charts requires a
 * strictly-ascending, unique time axis.
 */
export function promSamplesToLine(values: [number, string][] | undefined | null): LinePoint[] {
  if (!Array.isArray(values)) return [];
  const byTime = new Map<number, number>();
  for (const sample of values) {
    if (!Array.isArray(sample) || sample.length < 2) continue;
    const time = Math.floor(Number(sample[0]));
    const value = Number(sample[1]);
    if (!Number.isFinite(time) || !Number.isFinite(value)) continue;
    byTime.set(time, value); // last write wins on duplicate ts
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }));
}

/**
 * Total line from a range response. When the query matches multiple series
 * (should not happen for the pre-filtered spot net-worth query, but be safe),
 * the values are summed per-timestamp. Returns `[]` when there is no data.
 */
export function promRangeToLine(resp: PromRangeResponse | undefined | null): LinePoint[] {
  const result = resp?.data?.result;
  if (!Array.isArray(result) || result.length === 0) return [];
  if (result.length === 1) return promSamplesToLine(result[0].values);

  const byTime = new Map<number, number>();
  for (const series of result) {
    for (const p of promSamplesToLine(series.values)) {
      byTime.set(p.time, (byTime.get(p.time) ?? 0) + p.value);
    }
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }));
}

/**
 * Split a multi-series range response into per-label named series (e.g. one
 * line per `exchange`). Series missing the label fall back to `fallback`.
 * Empty series (no finite points) are dropped; the rest are sorted by key so
 * render order is stable across polls.
 */
export function promRangeByLabel(
  resp: PromRangeResponse | undefined | null,
  label: string,
  fallback = 'unknown',
): NamedSeries[] {
  const result = resp?.data?.result;
  if (!Array.isArray(result)) return [];
  return result
    .map((series) => ({
      key: series.metric?.[label] ?? fallback,
      points: promSamplesToLine(series.values),
    }))
    .filter((s) => s.points.length > 0)
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** True when the response carries at least one finite data point. */
export function promRangeHasData(resp: PromRangeResponse | undefined | null): boolean {
  const result = resp?.data?.result;
  if (!Array.isArray(result)) return false;
  return result.some((series) => promSamplesToLine(series.values).length > 0);
}
