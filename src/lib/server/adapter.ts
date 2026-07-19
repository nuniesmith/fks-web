// Pure routing + auth-decision helpers for the SvelteKit server adapter
// (`hooks.server.ts`). Deliberately free of `$env` / `fetch` / SvelteKit
// runtime imports so the access-control core is unit-testable in isolation —
// the hook reads the env + cookies + auth store and performs the side effects,
// this module just decides.

/** Same-origin prefixes the dashboard proxies to internal backends. */
export const BACKEND_PREFIXES = [
  "/api/",
  "/sse/",
  "/bars/",
  "/factory/",
  "/kraken/",
  "/fapi/",
];

/** Whether a path is a backend call (proxied) rather than a page. */
export function isBackend(pathname: string): boolean {
  return BACKEND_PREFIXES.some((x) => pathname.startsWith(x));
}

/** Page prefixes that never require an authenticated session. */
export const PUBLIC_PREFIXES = ["/login", "/logout"];
/** Exact paths that never require auth (health probes — monitoring must
 *  survive even in bootstrap mode or an auth-store outage). */
export const PUBLIC_EXACT = ["/api/health", "/healthz"];

/** The forced-credential-change page (and its form action). */
export const SETUP_PREFIX = "/setup";

/** Whether a (non-backend) path bypasses the session-auth gate. */
export function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT.includes(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// Headers not forwarded to (or streamed back from) an upstream:
//   - hop-by-hop / connection-specific ones (forwarding them can corrupt
//     message framing or smuggle requests);
//   - the browser's `cookie` — the internal upstreams (spawner / janus /
//     Prometheus / QuestDB) authenticate via `X-Internal-Token`, never the
//     SvelteKit `fks_session` cookie, so forwarding it only leaks a browser
//     credential across the trust boundary;
//   - `x-internal-token` and `authorization` — these are BOUNDARY credentials
//     the adapter mints itself (service identity to the spawner / janus). A
//     client-supplied copy must die at the seam and never be forwarded as-is
//     (design §4.1a F1: the token must mean "passed the session-checked
//     adapter", not "reached a socket").
// (`cookie`/`authorization` are request-only; the response's `set-cookie` /
// `www-authenticate` are different headers and are unaffected.)
const HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "cookie",
  "x-internal-token",
  "authorization",
]);

/**
 * Copy `src` minus the non-forwarded headers above — used for both the upstream
 * request and the response streamed back. Boundary credentials
 * (`x-internal-token`, `authorization`) are stripped here and re-injected by the
 * hook on the outbound request only, so a client cannot smuggle them through.
 */
export function upstreamHeaders(src: Headers): Headers {
  const h = new Headers();
  for (const [k, v] of src) if (!HOP.has(k.toLowerCase())) h.set(k, v);
  return h;
}

/** Identity carried by a validated session (never includes a hash/secret). */
export interface SessionInfo {
  userId: number;
  username: string;
  role: string;
  /** Bootstrap credential not yet rotated — user is confined to `/setup`. */
  mustChange: boolean;
}

/**
 * The auth posture for a single request, resolved by the hook from env + store:
 *   - `disabled`  → explicit `WEBUI_AUTH=disabled` escape hatch (loud, opt-in);
 *   - `bootstrap` → the users table is empty (fail-closed holding state);
 *   - `enabled`   → normal operation; `session` is null when unauthenticated.
 */
export type AuthState =
  | { mode: "disabled" }
  | { mode: "bootstrap" }
  | { mode: "enabled"; session: SessionInfo | null };

/** Outcome of routing a request through the adapter's auth/proxy gate. */
export type AdapterRoute =
  | { kind: "backend" }
  | { kind: "pass" }
  | { kind: "redirect"; location: string }
  /** API/backend request without a valid session → 401 JSON (never a 302: a
   *  redirect would corrupt a JSON/SSE consumer). */
  | { kind: "unauthorized" }
  /** Authenticated but not permitted (mustChange / role) → 403 JSON. */
  | { kind: "forbidden" };

function isGetLike(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/**
 * Decide how the server hook should handle a request — the access-control core,
 * extracted pure so it's testable without a SvelteKit runtime.
 *
 * FAIL-CLOSED contract: the only ways a backend request reaches an upstream are
 * (a) an explicit health probe, (b) `disabled` mode, or (c) a valid session.
 * Every other path — missing session, empty users table, mustChange — denies
 * mutations (and, once auth exists, reads too). Absence of configuration is
 * bootstrap-then-enforce, never an open door.
 *
 * Decision order (design §4.1):
 *  1. health probes            → always open (monitoring survives outages);
 *  2. login/logout pages       → public;
 *  3. `disabled`               → today's behaviour (explicit opt-out only);
 *  4. `bootstrap` (no users)   → GET reads pass, mutations 401, pages → /setup;
 *  5. `enabled`, no session    → backend 401, pages → /login?next=…;
 *  6. `enabled`, mustChange    → backend GET passes / mutations 403, pages → /setup;
 *  7. `enabled`, full session  → backend + pages pass (/setup bounces home).
 */
export function routeRequest(
  pathname: string,
  search: string,
  method: string,
  auth: AuthState,
): AdapterRoute {
  const backend = isBackend(pathname);
  const get = isGetLike(method);

  // 1. Health probes are always open — unauthenticated — so external
  //    monitoring keeps working during bootstrap or an auth-store outage.
  if (PUBLIC_EXACT.includes(pathname)) {
    return backend ? { kind: "backend" } : { kind: "pass" };
  }

  // 2. Login/logout pages are public.
  if (!backend && isPublic(pathname)) return { kind: "pass" };

  // 3. Explicit, opt-in dev bypass. Missing config does NOT land here.
  if (auth.mode === "disabled") {
    return backend ? { kind: "backend" } : { kind: "pass" };
  }

  // 4. Bootstrap (users table empty): fail closed on mutations, let harmless
  //    GET reads through on the loopback while the operator sets up, funnel
  //    every page to /setup.
  if (auth.mode === "bootstrap") {
    if (backend) return get ? { kind: "backend" } : { kind: "unauthorized" };
    if (pathname.startsWith(SETUP_PREFIX)) return { kind: "pass" };
    return { kind: "redirect", location: SETUP_PREFIX };
  }

  // 5-7. Enabled.
  const session = auth.session;
  // NOTE (RBAC — forward-looking): `session.role` is carried but intentionally
  // NOT enforced here in Phase 1, which provides no path to create a non-admin
  // user (only the bootstrap admin + self credential-change exist), so every
  // session is admin. When operator/viewer accounts are added, this is the
  // enforcement point — gate mutating backend calls on role BEFORE returning
  // `backend`, or a viewer would silently gain live-money mutation rights.

  if (!session) {
    if (backend) return { kind: "unauthorized" };
    const next = encodeURIComponent(pathname + search);
    return { kind: "redirect", location: `/login?next=${next}` };
  }

  if (session.mustChange) {
    // Confined to /setup until the bootstrap credential is rotated.
    if (backend) return get ? { kind: "backend" } : { kind: "forbidden" };
    if (pathname.startsWith(SETUP_PREFIX)) return { kind: "pass" };
    return { kind: "redirect", location: SETUP_PREFIX };
  }

  // Fully authenticated. /setup is done — bounce it home to avoid a dead page.
  if (!backend && pathname.startsWith(SETUP_PREFIX)) {
    return { kind: "redirect", location: "/" };
  }
  return backend ? { kind: "backend" } : { kind: "pass" };
}

/**
 * How the hook should treat a request when the auth store is UNREACHABLE
 * (design §7 DB-coupling). Fail closed for everything that needs auth, but keep
 * the box observable and recoverable WITHOUT SSH:
 *   - `open-backend` / `open-page` → health probes (monitoring must survive);
 *   - `open-page` → login/logout pages, so a persistent store outage or a
 *     least-privilege deploy that can't self-migrate still renders the login UI
 *     (a retry surface) instead of a bare 503 that bricks the whole browser
 *     path. These pages carry no data and cannot authenticate while the store is
 *     down (the login *action* still fails closed), so serving the shell leaks
 *     nothing;
 *   - `deny-backend` (503 JSON) / `deny-page` (503 shell) → everything else.
 * Pure so the fail-closed disposition is unit-tested without a SvelteKit runtime.
 */
export type OutageDisposition =
  | "open-backend"
  | "open-page"
  | "deny-backend"
  | "deny-page";

export function outageRoute(pathname: string): OutageDisposition {
  const backend = isBackend(pathname);
  if (PUBLIC_EXACT.includes(pathname)) {
    return backend ? "open-backend" : "open-page";
  }
  // Public *pages* (login/logout) render degraded so the operator has a UI +
  // retry path; public backend paths are only the health probes above.
  if (!backend && PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return "open-page";
  }
  return backend ? "deny-backend" : "deny-page";
}

/**
 * CSRF guard for state-changing backend calls (design §4.1). With `sameSite=lax`
 * cookies the main residual vector is a cross-origin form/fetch; we additionally
 * require that a non-GET backend request either presents no `Origin` (native
 * app / server-to-server) or an `Origin` whose host matches the request `Host`.
 * A cross-site `Origin` is rejected. Pure so it is unit-testable.
 */
export function originAllowed(
  method: string,
  origin: string | null,
  host: string | null,
): boolean {
  if (isGetLike(method)) return true;
  if (!origin) return true; // non-browser client; no ambient cookie to abuse
  try {
    const o = new URL(origin);
    return !!host && o.host === host;
  } catch {
    return false;
  }
}
