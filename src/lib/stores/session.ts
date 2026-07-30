/**
 * Session-expiry signal — "the ADAPTER refused YOU", never "something 401'd".
 *
 * Sessions are 7d idle / 30d absolute (`$lib/server/auth/policy.ts`), and
 * `WEBUI_AUTH` is unset in the real deploy, so auth is ENABLED. The absolute cap
 * therefore fires on an installed PWA roughly monthly: every poll starts
 * failing, and before this module the operator's only clue was a raw
 * `request failed — 401: {"error":"unauthorized"}` string on /cockpit with no
 * sign-in affordance.
 *
 * ## Why this is NOT keyed off `res.status === 401`
 *
 * The adapter is a PROXY. It streams upstream statuses straight back
 * (`hooks.server.ts` `forward`), so a spawner `X-Internal-Token` mismatch — a
 * deploy/config fault that signing in again cannot fix — also arrives at the
 * browser as a 401. Keying the banner off a bare 401 would raise "sign in
 * again" for a backend credential fault, which trains the operator to ignore
 * the one banner that means their session really is gone. So the ADAPTER stamps
 * its OWN denials with a header, and the client keys off that pair
 * (`status 401` AND the header). Everything else stays an ordinary `ApiError`.
 *
 * These two constants are imported by BOTH halves — `hooks.server.ts` (stamp)
 * and `$api/client` (detect) — deliberately: a rename that only touched one
 * side would silently disable the banner, and nothing would fail loudly. This
 * module imports only `svelte/store`, which is isomorphic, so it is safe on the
 * server. The store itself is never written server-side (only `$api/client`
 * writes it, and every `api.*` call in this app runs from the browser — no
 * universal `load` uses it), so the module-level singleton cannot leak state
 * across SSR requests.
 */
import { writable } from 'svelte/store';

/** Response header the adapter stamps on ITS OWN session denials. */
export const SESSION_HEADER = 'x-fks-auth';

/** The only header value that means "your webui session is gone". */
export const SESSION_REQUIRED = 'session-required';

/**
 * True once the adapter has told us our session is gone. Deliberately STICKY:
 * it is NOT cleared by a later successful request, because `/api/health` is on
 * the adapter's `PUBLIC_EXACT` allowlist and StatusBar polls it every cycle —
 * an "any success clears it" rule would wipe the banner seconds after it
 * appeared while the session was still dead. A real sign-in navigates (full
 * document load), which resets the module.
 */
export const sessionExpired = writable(false);

/**
 * The bit of `Response` we read. Structural so unit tests (and the existing
 * client tests' header-less stand-in) can pass a plain object.
 */
export interface AuthProbe {
  status?: number;
  headers?: { get(name: string): string | null } | null;
}

/**
 * True only for the adapter's own session denial: a 401 that also carries
 * `x-fks-auth: session-required`. A proxied upstream 401 (no header) and a
 * stray header on any other status both return false.
 */
export function isSessionRequired(res: AuthProbe | null | undefined): boolean {
  if (!res || res.status !== 401) return false;
  return res.headers?.get(SESSION_HEADER) === SESSION_REQUIRED;
}
