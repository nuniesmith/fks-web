// Shared types for the alert-ack inbox (webui plan 04 Phase B).
// Consumed by the server handlers (src/lib/server/alertAck/*), the shared
// client store (src/lib/stores/alertInbox.ts), the /monitoring inbox UI, the
// StatusBar chip, and the cockpit armed-alerts panel.

/** A recorded acknowledgement of one incident (append-only audit row). */
export interface InboxAck {
  /** Session username that acked (the operatorName idiom). */
  by: string;
  /** ISO-8601 timestamp the ack was written. */
  at: string;
  /** Optional one-line operator note (may be ''). */
  note: string;
}

/** One firing Prometheus alert, joined to its ack (if any). */
export interface InboxAlert {
  /**
   * Stable incident identity = sha256(canonical-json(labels) + "|" + activeAt).
   * A resolved alert that re-fires gets a new activeAt → a NEW key → re-shows
   * unacked. Acking can never permanently silence an alertname.
   */
  key: string;
  labels: Record<string, string>;
  /** Prometheus activeAt (ISO-8601) — carried through (promAlerts discarded it). */
  activeAt: string;
  /** Compact age string derived from activeAt ("5m" / "2h" / "3d"). */
  age_str: string;
  /** Prometheus alert state ("firing" / "pending"). */
  state: string;
  /** CSS colour var for the severity badge ('' when unknown). */
  severity_color: string;
  /** The ack record when this incident has been acknowledged, else null. */
  acked: InboxAck | null;
}

/**
 * The `/api/alerts/inbox` payload. Three honesty axes, each independent:
 *   - `prom_available:false` → Prometheus unreachable (never an empty-green
 *     inbox); `alerts` is empty because we could not read the live feed.
 *   - `configured:false`     → the ack store is missing/unreachable; `alerts`
 *     still render READ-ONLY (`acked` is null for all) — an ack-store outage
 *     must never hide a live alert.
 *   - both true              → the fully-wired steady state.
 */
export interface AlertInbox {
  configured: boolean;
  prom_available: boolean;
  alerts: InboxAlert[];
  /** Count of firing alerts with no ack (drives the StatusBar chip). */
  unacked_count: number;
}
