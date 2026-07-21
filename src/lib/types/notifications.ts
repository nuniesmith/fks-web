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

/** The spawner's lifecycle wire kinds (notifications.rs `ALL_EVENT_KINDS`). */
export const NOTIFY_EVENT_KINDS: readonly NotificationEventKind[] = [
  { id: "bot_spawned", label: "Bot spawned" },
  { id: "bot_stopped", label: "Bot stopped" },
  { id: "bot_removed", label: "Bot removed/pruned" },
  { id: "bot_error", label: "Bot error" },
  { id: "bot_crashed", label: "Bot crashed", alwaysDelivered: true },
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
