/**
 * FKS WebUI — Notification channel types + the notifier WIRE CONTRACT.
 *
 * The event ids below are the EXACT strings the spawner matches a stored
 * channel's `events[]` filter against — the wire contract shared between this
 * UI, the adapter, and the spawner. Ground truth:
 * `fks-spawner/crates/spawner/src/notifications.rs` (`ALL_EVENT_KINDS`,
 * `ALWAYS_DELIVERED_KINDS`). A channel scoped to an id NOT in this list matches
 * nothing and silently receives only the always-delivered kinds — which is the
 * exact scoping bug this const fixes (the old UI stored `spawn`/`stop`/`error`/
 * `live_flip`/`pnl_digest`, none of which the spawner emits).
 *
 * SINGLE SOURCE OF TRUTH: this file is the only place the known kinds are
 * enumerated. The `/settings` checkboxes (which kinds are selectable) and the
 * adapter's POST validation (which kinds it accepts) both read it, so shipping a
 * new spawner kind (Phase C: `bot_restarted`, `live_flip`, `key_rotation`,
 * `net_worth_milestone`, …) is a ONE-LINE edit here — nothing else changes.
 */

/** A Discord webhook notification channel stored (encrypted) in the spawner.
 *  The webhook URL is submit-only and never returned; the list carries only
 *  name/kind/events (+ updated_at). */
export interface NotificationChannel {
  name: string;
  kind: string;
  events: string[];
  updated_at?: string;
}

export interface NotificationEventKind {
  /** Wire id — matched verbatim against the spawner's emitted event. */
  id: string;
  label: string;
  /** Bypasses the `events[]` filter in the spawner (`ALWAYS_DELIVERED_KINDS`):
   *  delivered to EVERY channel regardless of scope, so the UI renders it
   *  checked + disabled (an uncheckable box is honest — it can't be filtered
   *  out) and the save path always includes it in a scoped channel. */
  alwaysDelivered?: boolean;
}

/**
 * The spawner's wire kinds — EXACTLY `notifications.rs` `ALL_EVENT_KINDS`, in
 * emission-priority order. The `alwaysDelivered` flag mirrors the Rust
 * `ALWAYS_DELIVERED_KINDS` (`bot_crashed`, `bot_restarted`, `live_flip`,
 * `risk_halt`) — those bypass every channel filter, so the settings checkbox
 * renders them checked + disabled and the save path force-includes them.
 * `edge_decay`/`net_worth_milestone`/`key_rotation` are ordinary filterable
 * kinds. Copy any change here verbatim from the Rust source — this is a frozen
 * wire contract, not a place to paraphrase.
 */
export const NOTIFY_EVENT_KINDS: readonly NotificationEventKind[] = [
  { id: "bot_spawned", label: "Bot spawned" },
  { id: "bot_stopped", label: "Bot stopped" },
  { id: "bot_removed", label: "Bot removed/pruned" },
  { id: "bot_error", label: "Bot error" },
  { id: "bot_crashed", label: "Bot crashed", alwaysDelivered: true },
  { id: "bot_restarted", label: "Bot restarted (always sent)", alwaysDelivered: true },
  { id: "live_flip", label: "Live mode armed (always sent)", alwaysDelivered: true },
  { id: "key_rotation", label: "Exchange keys rotated" },
  { id: "net_worth_milestone", label: "Net-worth milestone" },
  { id: "risk_halt", label: "Risk guard tripped (always sent)", alwaysDelivered: true },
  { id: "edge_decay", label: "Edge decay detected" },
];

/** Fast membership test set of every known wire id. */
export const KNOWN_EVENT_IDS: ReadonlySet<string> = new Set(
  NOTIFY_EVENT_KINDS.map((e) => e.id),
);

/** Ids that bypass the filter and are delivered to every channel. */
export const ALWAYS_DELIVERED_EVENT_IDS: readonly string[] = NOTIFY_EVENT_KINDS
  .filter((e) => e.alwaysDelivered)
  .map((e) => e.id);

/** Whether `id` is a real spawner wire kind (vs a legacy/typo id). */
export function isKnownEventKind(id: string): boolean {
  return KNOWN_EVENT_IDS.has(id);
}

/**
 * Validate a submitted `events[]` against the wire contract. Trims + de-dups +
 * drops empties; returns the first UNKNOWN id so the caller can 400 with an
 * actionable, typo-proof message. A non-array input is treated as "no scope"
 * (catch-all) to match the store's `events: [] = send everything` semantics.
 *
 * Forward-compatible: the only edit needed to accept a new kind is adding it to
 * `NOTIFY_EVENT_KINDS` above — this validator reads that list.
 */
export function validateNotificationEvents(
  raw: unknown,
): { ok: true; events: string[] } | { ok: false; bad: string } {
  if (!Array.isArray(raw)) return { ok: true, events: [] };
  const seen = new Set<string>();
  for (const e of raw) {
    const s = typeof e === "string" ? e.trim() : "";
    if (!s) continue;
    if (!KNOWN_EVENT_IDS.has(s)) return { ok: false, bad: s };
    seen.add(s);
  }
  return { ok: true, events: [...seen] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery ledger (Phase E) — the read side of the notification history surface.
//
// Mirrors the spawner's `GET /notifications/history` response
// (`api.rs::notification_history_handler` → `db.rs::NotificationLogRow`, one row
// per webhook send ATTEMPT). Serialised shape:
//   { db_enabled, entries: [{ ts, event, bot_id, channel_name, kind, outcome,
//                             status_code, detail }] }
// The response NEVER carries a webhook URL — the ledger table doesn't hold one.
// ─────────────────────────────────────────────────────────────────────────────

/** One delivery-ledger row (`notification_log`). `event` is a wire kind OR the
 *  literal `test` for a probe; `status_code` is null unless the webhook
 *  responded; `detail` is a truncated event snippet, never a URL. */
export interface NotificationLogEntry {
  ts: string;
  event: string;
  bot_id: string;
  channel_name: string;
  /** Transport (discord_webhook). */
  kind: string;
  /** sent / http_error / send_failed / decrypt_failed / test_sent / test_failed. */
  outcome: string;
  status_code: number | null;
  detail: string;
}

/** The full history response the adapter hands the page. */
export interface NotificationHistory {
  db_enabled: boolean;
  entries: NotificationLogEntry[];
}

/** The safe, always-valid shape returned on any upstream failure. */
function emptyHistory(): NotificationHistory {
  return { db_enabled: false, entries: [] };
}

function coerceStr(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** Coerce one raw ledger row into a `NotificationLogEntry`, or `null` if it is
 *  too malformed to render (no timestamp AND no event — nothing to show). */
function coerceEntry(raw: unknown): NotificationLogEntry | null {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ts = coerceStr(r.ts);
  const event = coerceStr(r.event);
  if (!ts && !event) return null;
  const sc = r.status_code;
  const status_code = typeof sc === "number" && Number.isFinite(sc) ? sc : null;
  return {
    ts,
    event,
    bot_id: coerceStr(r.bot_id),
    channel_name: coerceStr(r.channel_name),
    kind: coerceStr(r.kind),
    outcome: coerceStr(r.outcome),
    status_code,
    detail: coerceStr(r.detail),
  };
}

/**
 * Defensive reshape of the spawner's `/notifications/history` JSON into a
 * guaranteed-valid {@link NotificationHistory}. Total over any input: a
 * non-object, missing/`false` `db_enabled`, a non-array `entries`, or malformed
 * rows all degrade gracefully (malformed rows are dropped, never rendered).
 * Same defensive-coercion contract the sibling adapter mappers follow, so the
 * page never has to guard against a bad upstream payload. Pure — unit-tested.
 */
export function coerceNotificationHistory(raw: unknown): NotificationHistory {
  if (raw == null || typeof raw !== "object") return emptyHistory();
  const r = raw as Record<string, unknown>;
  const entriesRaw = Array.isArray(r.entries) ? r.entries : [];
  const entries: NotificationLogEntry[] = [];
  for (const e of entriesRaw) {
    const coerced = coerceEntry(e);
    if (coerced) entries.push(coerced);
  }
  return { db_enabled: r.db_enabled === true, entries };
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation helpers (pure — unit-tested, no Svelte/DOM deps).
// ─────────────────────────────────────────────────────────────────────────────

/** Badge variants the history panel uses (a subset of `Badge.svelte`'s). */
export type NotifyBadgeVariant = "green" | "amber" | "red" | "cyan" | "default";

/**
 * Map a ledger `event` kind to a Badge variant:
 *   green  — a healthy lifecycle transition (spawned / restarted)
 *   amber  — a benign/attention transition (stopped / net-worth milestone)
 *   red    — a page-worthy / failure kind (error / crashed / risk_halt / live_flip)
 *   cyan   — an out-of-band probe/admin action (test probe / key rotation)
 *   default — everything else (removed, edge_decay, unknown)  [the "muted" case]
 */
export function kindBadgeVariant(kind: string): NotifyBadgeVariant {
  switch (kind) {
    case "bot_spawned":
    case "bot_restarted":
      return "green";
    case "bot_stopped":
    case "net_worth_milestone":
      return "amber";
    case "bot_error":
    case "bot_crashed":
    case "risk_halt":
    case "live_flip":
      return "red";
    case "test":
    case "key_rotation":
      return "cyan";
    default:
      return "default";
  }
}

/** Whether a ledger `outcome` represents a successful delivery — drives the
 *  green (ok) vs red (fail) outcome dot. Only `sent` and `test_sent` are ok;
 *  every other outcome (http_error / send_failed / decrypt_failed / test_failed
 *  / anything unknown) is a failure. */
export function outcomeIsOk(outcome: string): boolean {
  return outcome === "sent" || outcome === "test_sent";
}
