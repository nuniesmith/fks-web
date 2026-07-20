/**
 * Armed-path telemetry — pure parsing of Prometheus instant-query results
 * into the cockpit's telemetry view model.
 *
 * Source: the funding bot's money-path exporter (fks-state #18,
 * `risk_metrics.rs`, `:9092`), scraped by the dedicated `fks-bots-risk`
 * Prometheus job which is SCOPED to `mode="live"` funding bots — the paper
 * measurement twin is structurally unscrapable. So:
 *   - Prometheus unreachable        → `available: false` (telemetry outage);
 *   - reachable but zero series     → `scraped: false` — the honest
 *     "no live bot / exporter dormant / awaiting arm" state, NOT zeros.
 * Fabricating 0s here would be exactly the fake-success anti-pattern the
 * fks-web discipline forbids: an unscraped exporter must never read as
 * "0 halts, 0 errors, all clear".
 */

export interface PromSample {
  labels: Record<string, string>;
  value: number;
}

/**
 * Parse one Prometheus `/api/v1/query` (instant vector) response body.
 * Returns `null` for anything other than a well-formed success vector —
 * the caller treats null as "this query produced no usable answer".
 */
export function parseInstantVector(body: unknown): PromSample[] | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.status !== "success") return null;
  const data = b.data as Record<string, unknown> | undefined;
  if (!data || data.resultType !== "vector" || !Array.isArray(data.result)) return null;
  const out: PromSample[] = [];
  for (const item of data.result) {
    if (typeof item !== "object" || item === null) continue;
    const it = item as Record<string, unknown>;
    const metric = (it.metric ?? {}) as Record<string, unknown>;
    const value = it.value;
    if (!Array.isArray(value) || value.length < 2) continue;
    const num = Number(value[1]);
    if (!Number.isFinite(num)) continue;
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(metric)) {
      if (typeof v === "string") labels[k] = v;
    }
    out.push({ labels, value: num });
  }
  return out;
}

/** One symbol's resting-stop reconcile view (present vs expected). */
export interface StopSyncView {
  present: number;
  expected: number;
  /** The #18 divergence predicate: a stop is EXPECTED but none MATCHING rests
   *  on the venue — an unprotected (or mis-protected) live position. */
  diverged: boolean;
}

export interface ArmedTelemetry {
  /** Prometheus answered at all (any query returned a well-formed result). */
  available: boolean;
  /** At least one live armed-path series exists — the live exporter is
   *  scraped. False = no live bot / dormant exporter → panels must show the
   *  awaiting-arm empty state, never zeros. */
  scraped: boolean;
  /** Query keys whose instant query FAILED (fetch error / timeout / Prometheus
   *  status:"error") — as opposed to succeeding with zero series. A failed
   *  query must render as "unobserved", NEVER collapse into the benign empty:
   *  a failed order-errors query is not "zero errors", and a failed
   *  stop-expected query must not read as "no stop expected" on a live
   *  position. */
  failed: (keyof TelemetryParts)[];
  /** symbol → `fks_bot_session_halt_active` (1 halted). */
  haltBySymbol: Record<string, number>;
  /** symbol → `fks_bot_circuit_breaker_tripped` (1 tripped). */
  breakerBySymbol: Record<string, number>;
  /** symbol → resting-stop present/expected/divergence. */
  stops: Record<string, StopSyncView>;
  /** `fks_bot_order_errors_total` by class (stop_place / stop_cancel …). */
  orderErrors: { cls: string; total: number }[];
  openPositions: number | null;
  openNotionalUsd: number | null;
  /** symbol → open-position entry time (unix seconds). */
  entryUnixBySymbol: Record<string, number>;
}

export interface TelemetryParts {
  halt: PromSample[] | null;
  breaker: PromSample[] | null;
  stopPresent: PromSample[] | null;
  stopExpected: PromSample[] | null;
  orderErrors: PromSample[] | null;
  openPositions: PromSample[] | null;
  openNotional: PromSample[] | null;
  entryUnix: PromSample[] | null;
}

function bySymbol(samples: PromSample[] | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of samples ?? []) {
    const sym = s.labels.symbol;
    if (sym) out[sym] = s.value;
  }
  return out;
}

/** Assemble the telemetry view from the eight instant queries. */
export function buildTelemetry(parts: TelemetryParts): ArmedTelemetry {
  const available = Object.values(parts).some((p) => p !== null);
  // Per-query failure is DISTINCT from per-query empty: null = the query
  // produced no usable answer (must render unobserved), [] = it answered with
  // zero series (the honest empty).
  const failed = (Object.keys(parts) as (keyof TelemetryParts)[])
    .filter((k) => parts[k] === null)
    .sort();
  const haltBySymbol = bySymbol(parts.halt);
  const breakerBySymbol = bySymbol(parts.breaker);
  const present = bySymbol(parts.stopPresent);
  const expected = bySymbol(parts.stopExpected);
  const entryUnixBySymbol = bySymbol(parts.entryUnix);

  const stops: Record<string, StopSyncView> = {};
  for (const sym of new Set([...Object.keys(present), ...Object.keys(expected)])) {
    const p = present[sym] ?? 0;
    const e = expected[sym] ?? 0;
    stops[sym] = { present: p, expected: e, diverged: e > 0 && p === 0 };
  }

  const orderErrors = (parts.orderErrors ?? [])
    .map((s) => ({ cls: s.labels.class ?? "unknown", total: s.value }))
    .sort((a, b) => b.total - a.total);

  const openPositions = parts.openPositions?.[0]?.value ?? null;
  const openNotionalUsd = parts.openNotional?.[0]?.value ?? null;

  const scraped =
    Object.keys(haltBySymbol).length > 0 ||
    Object.keys(breakerBySymbol).length > 0 ||
    Object.keys(stops).length > 0 ||
    orderErrors.length > 0 ||
    openPositions !== null ||
    Object.keys(entryUnixBySymbol).length > 0;

  return {
    available,
    scraped,
    failed,
    haltBySymbol,
    breakerBySymbol,
    stops,
    orderErrors,
    openPositions,
    openNotionalUsd,
    entryUnixBySymbol,
  };
}
