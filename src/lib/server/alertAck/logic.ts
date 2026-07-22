/**
 * Alert-ack inbox — PURE logic (no I/O, no $env, no fetch).
 *
 * The core design point is INCIDENT IDENTITY. Prometheus `/api/v1/alerts`
 * gives `labels` + `activeAt`; the identity is
 *
 *     alert_key = sha256(canonical-json(labels) + "|" + activeAt)
 *
 * where canonical-json sorts object keys RECURSIVELY, so the label order
 * Prometheus happens to emit can never change the key. A resolved alert that
 * re-fires gets a new `activeAt` → a new key → a NEW incident that re-shows
 * unacked (acking can never permanently silence an alertname).
 *
 * Kept pure + injectable so key stability, canonicalization, and the degrade
 * shapes are unit-testable without a DB or a Prometheus.
 */

import { createHash } from "node:crypto";
import type { InboxAck, InboxAlert } from "$lib/types/alertInbox";

/** Recursively key-sorted JSON — the canonical form hashed into the key. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortDeep(src[k]);
    return out;
  }
  return v;
}

/**
 * Stable incident identity. `sha256(canonical-json(labels) + "|" + activeAt)`,
 * hex-encoded. Label order in `labels` is irrelevant (canonicalized); a
 * different `activeAt` (a re-fire) yields a different key.
 */
export function alertKey(labels: Record<string, string>, activeAt: string): string {
  return createHash("sha256")
    .update(canonicalJson(labels) + "|" + activeAt)
    .digest("hex");
}

/** Severity → CSS colour var for the badge ('' when unknown). */
export function severityColor(severity: string | undefined): string {
  switch ((severity ?? "").toLowerCase()) {
    case "critical":
      return "var(--red)";
    case "warning":
      return "var(--amber)";
    case "info":
      return "var(--cyan)";
    default:
      return "";
  }
}

/** Compact age ("5m" / "2h" / "3d") from an ISO timestamp — `now` injected. */
export function ageStr(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The subset of a Prometheus `/api/v1/alerts` entry we consume. */
export interface PromAlertRaw {
  labels?: Record<string, string>;
  activeAt?: string;
  state?: string;
}

/** Pull the firing-alert list out of a Prometheus alerts response, defensively. */
export function extractPromAlerts(body: unknown): PromAlertRaw[] {
  const list = (body as { data?: { alerts?: unknown } } | null)?.data?.alerts;
  return Array.isArray(list) ? (list as PromAlertRaw[]) : [];
}

/**
 * Join the firing Prometheus alerts to the ack map by computed key. Pure —
 * `acks` is looked up (never mutated), `now` is injected for deterministic age.
 */
export function reshapeAlerts(
  raw: PromAlertRaw[],
  acks: Map<string, InboxAck>,
  now: number = Date.now(),
): { alerts: InboxAlert[]; unacked_count: number } {
  const alerts: InboxAlert[] = raw.map((a) => {
    const labels = a.labels ?? {};
    const activeAt = a.activeAt ?? "";
    const key = alertKey(labels, activeAt);
    return {
      key,
      labels,
      activeAt,
      age_str: ageStr(a.activeAt, now),
      state: a.state ?? "firing",
      severity_color: severityColor(labels.severity),
      acked: acks.get(key) ?? null,
    };
  });
  const unacked_count = alerts.reduce((n, a) => n + (a.acked ? 0 : 1), 0);
  return { alerts, unacked_count };
}
