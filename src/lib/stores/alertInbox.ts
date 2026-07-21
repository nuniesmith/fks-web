/**
 * Shared alert-inbox poll (M3 Phase B). ONE poll on `/api/alerts/inbox` at 30s
 * (matches today's alert cadence) fanned out to every consumer — the
 * /monitoring inbox, the StatusBar chip, and the cockpit armed-alerts panel.
 * `createPoll` already dedupes by (url, interval), so importing this singleton
 * everywhere costs the backend 1× traffic, not N×.
 *
 * The StatusBar (always mounted in the shell) keeps the poll warm app-wide, so
 * the badge reflects unacked state on every page; individual pages also
 * `start()`/`stop()` it and call `alertInbox.refresh()` right after an ack so
 * both surfaces update without waiting for the next tick.
 */
import { derived, type Readable } from "svelte/store";
import { createPoll } from "$lib/stores/poll";
import type { AlertInbox } from "$lib/types/alertInbox";

export const alertInbox = createPoll<AlertInbox>("/api/alerts/inbox", 30_000);

/** Firing alerts with no ack (only meaningful when configured + prom up). */
export const unackedCount: Readable<number> = derived(alertInbox, ($i) =>
  $i && $i.configured && $i.prom_available ? $i.unacked_count : 0,
);

/**
 * StatusBar chip state — 'critical' (red) when any unacked alert is critical,
 * 'warning' (amber) otherwise, and `null` (hidden, no dead chrome) at zero
 * unacked, prom-down, or an unconfigured ack store (where "unacked" is
 * meaningless because nothing can be acked).
 */
export const chipState: Readable<"critical" | "warning" | null> = derived(alertInbox, ($i) => {
  if (!$i || !$i.configured || !$i.prom_available || $i.unacked_count === 0) return null;
  const anyCritical = $i.alerts.some(
    (a) => !a.acked && (a.labels.severity ?? "").toLowerCase() === "critical",
  );
  return anyCritical ? "critical" : "warning";
});
