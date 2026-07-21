/**
 * Alert-ack inbox — route handlers (the I/O seam). Dispatched from
 * `proxyBackend` in hooks.server.ts, BEHIND the #47 auth seam.
 *
 *   GET  /api/alerts/inbox → live Prometheus alerts LEFT-JOINed to acks.
 *   POST /api/alerts/ack   → record an ack (server RECOMPUTES the key from
 *                            labels+activeAt; idempotent on conflict).
 *
 * Honest-empty everywhere: Prometheus unreachable → `prom_available:false`
 * (never an empty-green inbox); ack store missing/unreachable →
 * `configured:false` but the live alerts STILL render read-only (an ack-store
 * outage must never hide a live alert).
 */

import type { AlertInbox, InboxAck } from "$lib/types/alertInbox";
import { alertKey, extractPromAlerts, reshapeAlerts } from "./logic";
import type { AlertAckStore } from "./store";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Whether the ack store is present + reachable + has the table (safe probe). */
async function safeConfigured(store: AlertAckStore | null): Promise<boolean> {
  if (!store) return false;
  try {
    return await store.configured();
  } catch {
    return false;
  }
}

// ── GET /api/alerts/inbox ────────────────────────────────────────────────────

export async function alertInboxGet(
  promUrl: string,
  store: AlertAckStore | null,
  fetchFn: FetchLike = fetch,
): Promise<Response> {
  // 1. Read the live firing alerts. Prometheus down ≠ "no alerts" — say so.
  let raw;
  try {
    const r = await fetchFn(`${promUrl}/api/v1/alerts`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    raw = extractPromAlerts(await r.json());
  } catch {
    const payload: AlertInbox = {
      configured: await safeConfigured(store),
      prom_available: false,
      alerts: [],
      unacked_count: 0,
    };
    return json(payload);
  }

  // 2. LEFT-JOIN acks. Store missing/unreachable → configured:false, but the
  //    alerts STILL render (acked:null for all) — never hide a live alert.
  const keys = raw.map((a) => alertKey(a.labels ?? {}, a.activeAt ?? ""));
  let configured = false;
  let acks = new Map<string, InboxAck>();
  if (store) {
    try {
      if (await store.configured()) {
        configured = true;
        acks = await store.acksFor(keys);
      }
    } catch {
      configured = false;
      acks = new Map();
    }
  }

  const { alerts, unacked_count } = reshapeAlerts(raw, acks);
  const payload: AlertInbox = { configured, prom_available: true, alerts, unacked_count };
  return json(payload);
}

// ── POST /api/alerts/ack ─────────────────────────────────────────────────────

export async function alertAckPost(
  request: Request,
  store: AlertAckStore | null,
  operator: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }

  const b = body as {
    key?: unknown;
    labels?: unknown;
    activeAt?: unknown;
    note?: unknown;
  } | null;
  const key = b?.key;
  const labels = b?.labels;
  const activeAt = b?.activeAt;
  if (
    typeof key !== "string" ||
    typeof activeAt !== "string" ||
    !labels ||
    typeof labels !== "object" ||
    Array.isArray(labels)
  ) {
    return json({ ok: false, error: "invalid_body" }, 400);
  }

  // RECOMPUTE the key server-side — no acking an unseen blob. A mismatch means
  // the client's labels/activeAt don't hash to the key it presented.
  const labelsRec = labels as Record<string, string>;
  const recomputed = alertKey(labelsRec, activeAt);
  if (recomputed !== key) {
    return json(
      { ok: false, error: "key_mismatch", reason: "recomputed alert_key does not match labels+activeAt" },
      400,
    );
  }

  if (!store) {
    return json({ ok: false, error: "not_configured", reason: "ack store not configured" }, 503);
  }
  try {
    if (!(await store.configured())) {
      return json(
        { ok: false, error: "not_configured", reason: "webui_alert_acks table not found" },
        503,
      );
    }
    const alertname = typeof labelsRec.alertname === "string" ? labelsRec.alertname : "";
    const note = typeof b?.note === "string" ? b.note.slice(0, 500) : "";
    const acked = await store.insertAck({
      alert_key: key,
      alertname,
      labels: labelsRec,
      active_at: activeAt,
      acked_by: operator,
      note,
    });
    // 200 whether freshly inserted or already present (idempotent double-ack).
    return json({ ok: true, key, acked }, 200);
  } catch (e) {
    return json({ ok: false, error: "store_error", reason: (e as Error).message }, 502);
  }
}
