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

/**
 * Page prefixes that never require an authenticated session. `/invite` is the
 * public one-time-signup claim page (Phase C): both its GET load and its form
 * action are page-path (non-backend) requests, so `isPublic` covers both. It is
 * safe in every mode: in `bootstrap` (empty users table) `isPublic` passes at
 * routeRequest step 2 BEFORE the bootstrap branch, so `/invite/x` renders — but
 * harmlessly, since no users ⇒ no invites ⇒ the load resolves the invalid
 * state. The claim ACTION still fails closed (it calls into the auth store).
 */
export const PUBLIC_PREFIXES = ["/login", "/logout", "/invite"];
/** Exact paths that never require auth (health probes — monitoring must
 *  survive even in bootstrap mode or an auth-store outage). */
export const PUBLIC_EXACT = ["/api/health", "/healthz"];

/**
 * Installable-app static assets that must be reachable pre-login (PWA milestone
 * groundwork). In prod adapter-node serves `build/client/*` via sirv BEFORE the
 * SvelteKit handler runs, so these never reach this hook — but if the serving
 * order ever changes (adapter swap, direct node exposure) or in dev where SSR
 * handles them, the manifest/SW/icons must return the asset (200), never a
 * 302→/login (iOS treats a redirected manifest as broken). This is an EXPLICIT
 * allowlist of known static filenames only — deliberately NOT a wildcard/
 * extension bypass, which could leak an app page or data route pre-auth. The
 * manifest/SW files themselves are added by the PWA milestone (M1); this only
 * guarantees the paths won't fail closed once they exist. GET/HEAD only.
 */
export const PUBLIC_STATIC_EXACT: readonly string[] = [
  "/manifest.webmanifest",
  "/service-worker.js",
  "/favicon.ico",
  "/favicon.svg",
  "/robots.txt",
  "/apple-touch-icon.png",
  "/apple-touch-icon.svg",
  // Manifest icon set (M1) — referenced by /manifest.webmanifest; root-level
  // filenames only (still an explicit allowlist, not an /icons/* wildcard).
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-192.png",
  "/icon-maskable-512.png",
];

/** Whether a path is a pre-login installable-app static asset (GET/HEAD). */
export function isPublicStatic(pathname: string): boolean {
  return PUBLIC_STATIC_EXACT.includes(pathname);
}

/** The forced-credential-change page (and its form action). */
export const SETUP_PREFIX = "/setup";

/**
 * Segment-boundary prefix match: `/invite` opens `/invite` and `/invite/x`
 * but NOT `/invitefoo`. A raw startsWith would silently widen the public
 * surface to any route that merely shares the prefix spelling.
 */
export function matchesPublicPrefix(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/"),
  );
}

/** Whether a (non-backend) path bypasses the session-auth gate. */
export function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT.includes(pathname)) return true;
  return matchesPublicPrefix(pathname);
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
  // content-encoding MUST be stripped, and its absence was a real bug
  // (2026-08-24). `fetch` transparently DECOMPRESSES a gzipped upstream
  // response, so `res.body` is already plaintext — but the proxy copied the
  // upstream's `Content-Encoding: gzip` onto it. The browser then tried to
  // gunzip uncompressed JSON, the fetch rejected, and the page's `.catch()`
  // rendered it as "no data". Every Prometheus panel on /monitoring was blank
  // while Prometheus was healthy and answering `sum(up)`=10.
  //
  // Prometheus was the only upstream honouring accept-encoding, so the three
  // /api/metrics/* routes broke and the other seven `forward()` routes were
  // latent — they would break the moment any of their upstreams enabled gzip.
  //
  // Correct in BOTH directions for the same reason: the runtime has already
  // decoded the payload by the time these headers are copied, so declaring an
  // encoding that is no longer applied is always a lie.
  "content-encoding",
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
  | {
      kind: "unauthorized";
      /**
       * WHY the call was refused, so the client can say something true.
       * `bootstrap` = the users table is empty and no session can exist yet —
       * telling that operator "session expired, sign in again" sends them to
       * /login, where they cannot log in because there is no account. They
       * need /setup. Absent = an ordinary missing/expired session.
       */
      reason?: "bootstrap";
    }
  /** Authenticated but not permitted (mustChange / role) → 403 JSON. An
   *  optional machine-readable `reason` overrides the default
   *  `credential_change_required` in the 403 body. */
  | { kind: "forbidden"; reason?: string };

/**
 * Live-money mutations the `disabled` dev bypass must NOT expose. The
 * WEBUI_AUTH=disabled opt-out is app-wide, but these paths write a REAL-MONEY
 * bot's credential or notification config, or silence its pager — a deploy
 * accidentally left in disabled mode must not turn tailnet reachability into
 * the only wall between any unauthenticated client and a deleted exchange key,
 * a registered exfil webhook or an acked page (the CSRF origin check passes
 * for requests with no Origin header, so a bare curl reaches these). Refused with 403 even in disabled mode; every
 * other route keeps today's disabled-mode behaviour.
 *
 * Matched by `matchesBlockedMutation` at a SEGMENT boundary (like
 * `matchesPublicPrefix`), so `/api/settings/exchange-keys` also covers the
 * dynamic per-exchange DELETE (`/api/settings/exchange-keys/kraken`) and the
 * notifications channel DELETE/test — but NOT a merely prefix-sharing path.
 */
export const AUTH_DISABLED_BLOCKED_MUTATIONS: readonly string[] = [
  // An ack silences an armed-path page (halt / breaker / stop-divergence). The
  // dev bypass must not turn tailnet reachability into the only wall between an
  // unauthenticated `curl -XPOST .../api/alerts/ack` and the operator's pager
  // going quiet — refused with 403 even in disabled mode (webui plan 04 OD-3).
  "/api/alerts/ack",
  // Money-path config mutations (M1): deleting a live exchange key or
  // registering an exfil notification webhook. `exchange-keys` covers the POST
  // write + the dynamic per-exchange DELETE; the three `*-keys` entries cover
  // the legacy fixed-venue write routes; `notifications` covers the POST write
  // (and its channel DELETE/test).
  "/api/settings/exchange-keys",
  "/api/settings/kraken-keys",
  "/api/settings/kucoin-keys",
  "/api/settings/cryptocom-keys",
  // The same two spawner stores reached through the generic `/api/spawner/*`
  // passthrough, which the settings routes above front (EDGE_FACTORY_PLAN
  // finding 2): `secrets` covers the POST write and the per-exchange DELETE.
  "/api/spawner/secrets",
  "/api/spawner/notifications",
  "/api/settings/notifications",
];

/**
 * Whether a path is (or is a sub-path of) a `disabled`-mode blocked mutation.
 * Segment-boundary match so `/api/settings/exchange-keys` covers
 * `/api/settings/exchange-keys/kraken` but never a prefix-sharing sibling.
 */
export function matchesBlockedMutation(pathname: string): boolean {
  return AUTH_DISABLED_BLOCKED_MUTATIONS.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

/**
 * Pages that moved or were removed in the 2026-10-26 rework (six sections:
 * Home, Data, Edges, Tasks, Money, System), and where an old bookmark or an
 * installed PWA's history lands instead. Pages only: a removed API path keeps
 * its honest 404/501, since a caller must not mistake a redirect for data.
 */
const MOVED_PAGES: ReadonlyArray<readonly [string, string]> = [
  ["/bots", "/tasks"],
  ["/treasury", "/money"],
  ["/exchanges", "/money"],
  ["/db", "/data"],
  ["/cockpit", "/"],
  ["/futures", "/"],
  ["/trading", "/"],
  ["/signals", "/"],
  ["/janus-ai", "/"],
  ["/journal", "/"],
  ["/workspace", "/"],
  ["/performance", "/"],
];

/** Where a moved page now lives, or null. Segment-boundary match. */
export function movedPage(pathname: string): string | null {
  for (const [from, to] of MOVED_PAGES) {
    if (pathname === from || pathname.startsWith(from + "/")) return to;
  }
  return null;
}

/** GET/HEAD — i.e. a read. Exported so the hook can refuse to degrade a
 *  MUTATION into an empty-200 (a fake success). */
export function isGetLike(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

// ── Role-based access control (RBAC — design §4.3 / plan 01 §1.1) ─────────────
// Pure role rules, enforced by `routeRequest` ONLY for `mode:"enabled"` with a
// full (post-`mustChange`) session. Ordering: viewer < operator < admin. The
// bootstrap / disabled / mustChange dispositions above ALWAYS win first — role
// rules never loosen them, only add a layer once a real session exists. With
// zero non-admin users (the solo-admin default) nothing here changes: every
// session is admin. Kept `$env`/fetch-free so the access-control core stays
// unit-testable in isolation.

export type Role = "admin" | "operator" | "viewer";

/**
 * Numeric privilege of a role string. Unknown/garbage → viewer rank (0) — a
 * session whose role we cannot rank gets the LEAST privilege, never more
 * (fail closed). Uses a switch (not an object lookup) so prototype keys like
 * `"toString"` can never resolve to a rank.
 */
export function roleRank(role: string): number {
  switch (role) {
    case "admin":
      return 2;
    case "operator":
      return 1;
    default:
      return 0; // viewer AND any unknown/garbage string → least privilege
  }
}

/**
 * R1 — admin-only backend surfaces, matched as prefixes so `/api/users`,
 * `/api/users/<id>/…`, `/api/invites` and `/api/invites/<id>/…` are all covered
 * for ANY method (even a GET leaks the user/invite list). These routes do not
 * exist yet (Phase B/C) — future-proofing the seam is intentional and harmless.
 */
export const ADMIN_ONLY_BACKEND_PREFIXES: readonly string[] = [
  "/api/users",
  "/api/invites",
];

/**
 * R2 — admin-only MUTATIONS (non-GET only): config / credential surfaces.
 * Matched as prefixes, so subpaths ride along: `/api/settings/exchange-keys/*`,
 * the legacy per-exchange `-keys` routes,
 * `/api/settings/notifications/<name>/test`, etc. Starting anything that can
 * trade real money is R2b (`spawnerWriteNeedsAdmin`), decided by the body.
 */
export const ADMIN_ONLY_MUTATION_RULES: readonly string[] = [
  "/api/settings/exchange-keys",
  "/api/settings/kraken-keys",
  "/api/settings/kucoin-keys",
  "/api/settings/cryptocom-keys",
  "/api/settings/notifications",
  // The spawner's own credential and webhook stores, which the `/settings`
  // routes above front. Through the generic `/api/spawner/*` passthrough they
  // fell to R3, so an operator could store or delete an exchange key or a
  // webhook that the settings routes refuse them (EDGE_FACTORY_PLAN finding 2).
  // Reads (`/api/spawner/secrets/status`) stay open under R4: no secrets in it.
  "/api/spawner/secrets",
  "/api/spawner/notifications",
];

/** R5 — admin-only PAGE prefixes. Non-admins get a redirect to `/` (pages
 *  redirect, they never 403 — matches existing page semantics). `/users` is
 *  Phase B; the gate is live now so the tab/page can't be reached early. */
export const ADMIN_ONLY_PAGE_PREFIXES: readonly string[] = ["/users"];

/**
 * Whether a fully-authenticated BACKEND request is denied by the caller's role
 * — implements R1–R4 of the §1.1 rule table, evaluated top-down. Returns `true`
 * to DENY. Page gating (R5) is handled separately in `routeRequest` because
 * pages redirect rather than 403. Callers gate on `isBackend(pathname)` first;
 * role ranking is fail-closed (an unrankable role is treated as viewer).
 */
export function roleDenies(
  pathname: string,
  method: string,
  role: string,
): boolean {
  const rank = roleRank(role);
  // R1: admin-only surfaces — ANY method, incl. GET (the list itself leaks).
  if (ADMIN_ONLY_BACKEND_PREFIXES.some((p) => pathname.startsWith(p))) {
    return rank < roleRank("admin");
  }
  // R4: reads (GET/HEAD, incl. SSE) are open to every role.
  if (isGetLike(method)) return false;
  // R2: admin-only mutations — config/credential/live-arming surfaces.
  if (ADMIN_ONLY_MUTATION_RULES.some((p) => pathname.startsWith(p))) {
    return rank < roleRank("admin");
  }
  // R3: every OTHER backend mutation is operator+ (viewer denied): spawner
  // writes (stop/restart/delete, instances, edges, transfers), alert acks and
  // db queries.
  return rank < roleRank("operator");
}

/**
 * R2b — starting something that can trade real money needs an admin, decided
 * by what would run rather than by the path. The spawner's `/spawn` and
 * `/configs` take a spawn spec, and `/configs/{name}/respawn` runs a stored
 * one; through the `/api/spawner/*` passthrough all three are otherwise R3
 * (EDGE_FACTORY_PLAN finding 2). A spec needs admin when its `mode` is `live`
 * or it asks for stored exchange keys (`secrets`): the keys are what let an
 * image trade, and an image can trade live whatever its mode label says (the
 * disabled `crypto-regime` bot did). Anything that isn't a spec object needs
 * admin too, so a malformed body or a missing config fails closed. So does a
 * spec that takes webhooks from Settings (`webhooks`, fks-spawner #71): their
 * URLs are bearer capabilities set into the container, like the keys.
 */
export function spawnSpecNeedsAdmin(spec: unknown): boolean {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return true;
  const { mode, secrets, webhooks } = spec as { mode?: unknown; secrets?: unknown; webhooks?: unknown };
  if (typeof mode === "string" && mode.trim().toLowerCase() === "live") return true;
  if (webhooks !== undefined && webhooks !== null) {
    if (typeof webhooks !== "object" || Array.isArray(webhooks)) return true;
    if (Object.keys(webhooks).length > 0) return true;
  }
  if (secrets === undefined || secrets === null) return false;
  return !Array.isArray(secrets) || secrets.length > 0;
}

/** A spawner path as the R2b check reads it: decoded, with doubled and
 *  trailing slashes gone, so no spelling of a guarded path slips past (the
 *  spawner would not route most of them anyway). Case is kept for the config
 *  name; the guarded paths compare case-insensitively. */
function normalizedSpawnerPath(pathname: string): string {
  let p = pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep the raw path; a guarded path still matches below if it's spelled plainly
  }
  p = p.replace(/\/{2,}/g, "/");
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** The passthrough paths whose POST body is a spawn spec. */
const SPAWN_SPEC_PATHS: readonly string[] = ["/api/spawner/spawn", "/api/spawner/configs"];
const RESPAWN_PATH = /^\/api\/spawner\/configs\/([^/]+)\/respawn$/i;
const INSTANCE_CREATE_PATH = "/api/spawner/instances";
const INSTANCE_START_PATH = /^\/api\/spawner\/instances\/([^/]+)\/start$/i;

/**
 * Whether making an instance from a template needs an admin. The request
 * names the template and maybe a mode; the template says which modes exist
 * (the first is the default) and which exchange keys it may be given. Live
 * mode, or any template that may receive keys, needs an admin. A template
 * that can't be read fails closed.
 */
export function instanceNeedsAdmin(request: unknown, template: unknown): boolean {
  if (request === null || typeof request !== "object" || Array.isArray(request)) return true;
  if (template === null || typeof template !== "object" || Array.isArray(template)) return true;
  const { mode } = request as { mode?: unknown };
  const { modes, secrets_allowed } = template as { modes?: unknown; secrets_allowed?: unknown };
  const effective =
    typeof mode === "string" && mode.trim()
      ? mode
      : Array.isArray(modes) && typeof modes[0] === "string"
        ? modes[0]
        : null;
  if (effective === null || effective.trim().toLowerCase() === "live") return true;
  if (secrets_allowed === undefined || secrets_allowed === null) return false;
  return !Array.isArray(secrets_allowed) || secrets_allowed.length > 0;
}

/**
 * Whether a passthrough write must come from an admin under R2b. The body and
 * the stored config are read only when the path needs them: `readBody` returns
 * the request's text, `lookupConfig` the stored config for a respawn or an
 * instance start, and `lookupTemplate` the template an instance is made from
 * (each null when the spawner can't show it, which fails closed).
 */
export async function spawnerWriteNeedsAdmin(
  pathname: string,
  method: string,
  readBody: () => Promise<string>,
  lookupConfig: (name: string) => Promise<unknown>,
  lookupTemplate: (id: string) => Promise<unknown> = () => Promise.resolve(null),
): Promise<boolean> {
  if (method.toUpperCase() !== "POST") return false;
  const path = normalizedSpawnerPath(pathname);
  if (SPAWN_SPEC_PATHS.includes(path.toLowerCase())) {
    let spec: unknown = null;
    try {
      spec = JSON.parse(await readBody());
    } catch {
      spec = null;
    }
    return spawnSpecNeedsAdmin(spec);
  }
  if (path.toLowerCase() === INSTANCE_CREATE_PATH) {
    let request: unknown = null;
    try {
      request = JSON.parse(await readBody());
    } catch {
      return true;
    }
    const id = (request as { template?: unknown } | null)?.template;
    let template: unknown = null;
    try {
      template = typeof id === "string" ? await lookupTemplate(id) : null;
    } catch {
      template = null;
    }
    return instanceNeedsAdmin(request, template);
  }
  // A respawn and an instance start both run a stored config as it is saved.
  const stored_name = RESPAWN_PATH.exec(path)?.[1] ?? INSTANCE_START_PATH.exec(path)?.[1];
  if (!stored_name) return false;
  let stored: unknown = null;
  try {
    stored = await lookupConfig(stored_name);
  } catch {
    stored = null;
  }
  return spawnSpecNeedsAdmin(stored);
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
 *  7. `enabled`, full session  → RBAC (§1.1): backend allowed unless `roleDenies`
 *                                (→ 403 `role_denied`), admin-only pages redirect
 *                                home for non-admins, else backend + pages pass
 *                                (/setup bounces home). mustChange/bootstrap/
 *                                disabled always win BEFORE any role rule.
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

  // 1b. Installable-app static assets (manifest/SW/icons/robots) are public on
  //     GET/HEAD so they never 302→/login (a redirected manifest reads as broken
  //     on iOS). Explicit filename allowlist — not a wildcard. A non-GET to one
  //     of these falls through to the normal page gate (harmless: no backend).
  if (get && isPublicStatic(pathname)) return { kind: "pass" };

  // 2. Login/logout pages are public.
  if (!backend && isPublic(pathname)) return { kind: "pass" };

  // 3. Explicit, opt-in dev bypass. Missing config does NOT land here.
  //    Even here, the money-path mutations stay refused — the dev bypass must
  //    never let an unauthenticated request change a key, a webhook or an ack.
  if (auth.mode === "disabled") {
    if (!get && matchesBlockedMutation(pathname)) {
      return { kind: "forbidden", reason: "live_mutation_requires_auth" };
    }
    return backend ? { kind: "backend" } : { kind: "pass" };
  }

  // 4. Bootstrap (users table empty): fail closed on mutations, let harmless
  //    GET reads through on the loopback while the operator sets up, funnel
  //    every page to /setup.
  if (auth.mode === "bootstrap") {
    if (backend)
      return get ? { kind: "backend" } : { kind: "unauthorized", reason: "bootstrap" };
    if (pathname.startsWith(SETUP_PREFIX)) return { kind: "pass" };
    return { kind: "redirect", location: SETUP_PREFIX };
  }

  // 5-7. Enabled.
  const session = auth.session;

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

  // Fully authenticated (RBAC enforcement point — plan 01 §1.1, R1-R5).
  if (backend) {
    // Backend-shaped denial is a 403 JSON with a machine reason, NEVER a 302 —
    // a redirect would corrupt a JSON/SSE consumer. The hook already renders
    // `forbidden.reason` as a 403 body.
    if (roleDenies(pathname, method, session.role)) {
      return { kind: "forbidden", reason: "role_denied" };
    }
    return { kind: "backend" };
  }
  // Page request. /setup is done — bounce it home to avoid a dead page.
  if (pathname.startsWith(SETUP_PREFIX)) {
    return { kind: "redirect", location: "/" };
  }
  // R5: admin-only pages redirect non-admins home (pages redirect, don't 403).
  if (
    roleRank(session.role) < roleRank("admin") &&
    ADMIN_ONLY_PAGE_PREFIXES.some((p) => pathname.startsWith(p))
  ) {
    return { kind: "redirect", location: "/" };
  }
  return { kind: "pass" };
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
  // Public *pages* (login/logout/invite) render degraded so the operator has a
  // UI + retry path; public backend paths are only the health probes above.
  // `/invite` rides this same render-degraded path: the page shell renders while
  // the store is down (its load surfaces the "unavailable" state), and the claim
  // ACTION still fails closed — claimInvite needs the store, which is down.
  if (!backend && matchesPublicPrefix(pathname)) {
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
