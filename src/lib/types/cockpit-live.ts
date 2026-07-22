/**
 * Live-twin `/status` feed (M3 Phase A) — the three-state payload of
 * `GET /api/cockpit/live-status`.
 *
 * Born honest: the live funding twin does not exist yet (Gate-A ~Aug 1 decides
 * arming). When the `CRYPTO_FUNDING_LIVE_INTERNAL_URL` env is unset the route
 * returns `{configured:false}` — never a fabricated empty/green state, never
 * paper PnL masquerading as live. The three states MUST stay distinguishable:
 *
 *   { configured: false }
 *       env unset — the feed is not wired for this deployment.
 *
 *   { configured: true, reachable: false, reason }
 *       the twin URL is set but the fetch failed / timed out / returned a
 *       non-`BotStatus` reply. An armed bot whose status server died is an
 *       OUTAGE, not an unwired feature — the cockpit renders "status feed down".
 *
 *   { configured: true, reachable: true, status, mode_mismatch }
 *       a real `BotStatus` document. `mode_mismatch:true` flags the paper-as-live
 *       trap: the env pointed at a PAPER twin by mistake (its `mode` is not a
 *       live-ish value) — surfaced as a red flag, never rendered as live PnL.
 */
import type { BotStatus } from "$lib/types/exchanges";

export interface LiveStatusResp {
  /** false = env unset (not wired). true = a live-twin URL is configured. */
  configured: boolean;
  /** Present when configured. false = fetch failed / timeout / non-BotStatus. */
  reachable?: boolean;
  /** Human reason for reachable:false (kept distinct from the empty state). */
  reason?: string;
  /** The live bot's own `/status` document (present iff reachable:true). */
  status?: BotStatus;
  /** true when the document's `mode` is not a live-ish value — the env was
   *  pointed at the PAPER twin by mistake (paper PnL would read as live). */
  mode_mismatch?: boolean;
}

/** A BotStatus.mode is "live-ish" when it names the live instance. Paper
 *  strings ("paper", "shadow", "sim") do NOT match → mode_mismatch flagged. */
export function isLiveMode(mode: string | undefined | null): boolean {
  return typeof mode === "string" && /live/i.test(mode);
}
