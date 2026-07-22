/**
 * User-management route handlers (the `/api/users` seam) — dispatched from
 * `proxyBackend` in hooks.server.ts, following the cockpit/alertAck module
 * pattern (JSON in/out, injectable service so the logic is tested DB-free).
 *
 *   GET  /api/users                        → { users: UserSummary[] }
 *   POST /api/users {username, role}       → { ok, user, tempPassword }
 *   POST /api/users/:id/disable            → { ok }
 *   POST /api/users/:id/enable             → { ok }
 *   POST /api/users/:id/role {role}        → { ok }
 *   POST /api/users/:id/reset-password     → { ok, tempPassword }
 *   POST /api/users/:id/revoke-sessions    → { ok }
 *
 * There is deliberately NO hard DELETE — disable is the removal story (keeps the
 * audit trail + FK integrity intact, and a disabled user can be re-enabled).
 *
 * DEFENSE IN DEPTH — the dispatch re-checks the caller is an admin even though
 * `routeRequest` (R1) already gates `/api/users` for ANY method: `proxyBackend`
 * is ALSO reached on the auth-store outage path WITHOUT an `auth` arg
 * (handle → outageRoute open-backend), and under WEBUI_AUTH=disabled user
 * management against the real store is meaningless. Both must 403 here rather
 * than trust the upstream gate — belt-and-braces, mirroring the alertAck ack
 * handler and the AUTH_DISABLED_BLOCKED_MUTATIONS philosophy. CSRF is already
 * covered upstream (the origin check runs for every backend non-GET).
 */

import type { AuthState, SessionInfo } from "./adapter";
import { INVITE_TTL_HOURS, type AuthService, type RequestCtx } from "./auth/service";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const forbidden = (reason: string): Response =>
  json({ error: "forbidden", reason }, 403);

/**
 * The shared admin guard for BOTH the /api/users and /api/invites seams (see
 * file header — defense in depth over routeRequest R1). Returns the acting admin
 * SessionInfo, or a ready-to-send 403 Response. `disabled` mode is an explicit
 * refusal distinct from "not an admin".
 */
function requireAdmin(auth: AuthState | undefined): SessionInfo | Response {
  if (auth?.mode === "disabled") {
    return forbidden("user_management_requires_auth");
  }
  const actor =
    auth?.mode === "enabled" &&
    auth.session &&
    !auth.session.mustChange &&
    auth.session.role === "admin"
      ? auth.session
      : null;
  return actor ?? forbidden("admin_required");
}

/** The one route regex — base list/create + the five per-user sub-actions. */
const ROUTE =
  /^\/api\/users(?:\/(\d+)\/(disable|enable|role|reset-password|revoke-sessions))?$/;

type SubAction =
  | "disable"
  | "enable"
  | "role"
  | "reset-password"
  | "revoke-sessions";

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await request.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Map an AdminResult failure to a JSON error response with its status. */
function fail(r: { error: string; status: number }): Response {
  return json({ ok: false, error: r.error }, r.status);
}

/**
 * Handle a request whose pathname is already known to be under `/api/users`.
 * `auth` is the resolved posture (undefined on the outage path); `getService`
 * is called ONLY after the admin guard passes, so an unauthenticated outage
 * request never forces a store connect. Injected so the handler is unit-tested
 * against a MemoryStore-backed service.
 */
export async function usersDispatch(
  request: Request,
  pathname: string,
  auth: AuthState | undefined,
  ctx: RequestCtx,
  getService: () => Promise<AuthService>,
): Promise<Response> {
  // Defense in depth (see file header).
  const actor = requireAdmin(auth);
  if (actor instanceof Response) return actor;

  const svc = await getService();
  const m = ROUTE.exec(pathname);
  if (!m) return json({ error: "not_found" }, 404);
  const method = request.method;
  const id = m[1] ? Number(m[1]) : null;
  const action = (m[2] as SubAction | undefined) ?? null;

  // Base collection: GET list / POST create.
  if (id === null) {
    if (method === "GET") {
      return json({ users: await svc.adminListUsers() });
    }
    if (method === "POST") {
      const body = await readBody(request);
      const username = typeof body.username === "string" ? body.username : "";
      const role = typeof body.role === "string" ? body.role : "";
      const r = await svc.adminCreateUser(username, role, actor, ctx);
      if (!r.ok) return fail(r);
      return json({ ok: true, user: r.user, tempPassword: r.tempPassword });
    }
    return json({ error: "method_not_allowed" }, 405);
  }

  // Per-user sub-actions are POST-only.
  if (method !== "POST") return json({ error: "method_not_allowed" }, 405);

  switch (action) {
    case "disable": {
      const r = await svc.adminSetDisabled(id, true, actor, ctx);
      return r.ok ? json({ ok: true }) : fail(r);
    }
    case "enable": {
      const r = await svc.adminSetDisabled(id, false, actor, ctx);
      return r.ok ? json({ ok: true }) : fail(r);
    }
    case "role": {
      const body = await readBody(request);
      const role = typeof body.role === "string" ? body.role : "";
      const r = await svc.adminSetRole(id, role, actor, ctx);
      return r.ok ? json({ ok: true }) : fail(r);
    }
    case "reset-password": {
      const r = await svc.adminResetPassword(id, actor, ctx);
      return r.ok ? json({ ok: true, tempPassword: r.tempPassword }) : fail(r);
    }
    case "revoke-sessions": {
      const r = await svc.adminRevokeSessions(id, actor, ctx);
      return r.ok ? json({ ok: true }) : fail(r);
    }
    default:
      return json({ error: "not_found" }, 404);
  }
}

/** The invite route regex — base list/create + the per-invite revoke action. */
const INVITE_ROUTE = /^\/api\/invites(?:\/(\d+)\/(revoke))?$/;

/**
 * Handle a request under `/api/invites` (Phase C). Same admin defense-in-depth
 * as usersDispatch (R1 already gates it upstream; this re-checks because the
 * outage path calls proxyBackend WITHOUT auth and WEBUI_AUTH=disabled must
 * refuse here). The mint endpoint returns a RELATIVE `/invite/<raw token>` URL —
 * the raw token is surfaced exactly once, and the admin's own browser origin
 * completes it (the server never guesses its public host).
 *
 *   GET  /api/invites               → { invites: InviteView[] }
 *   POST /api/invites {role,ttlHours?} → { ok, url }
 *   POST /api/invites/:id/revoke    → { ok }
 */
export async function invitesDispatch(
  request: Request,
  pathname: string,
  auth: AuthState | undefined,
  ctx: RequestCtx,
  getService: () => Promise<AuthService>,
): Promise<Response> {
  const actor = requireAdmin(auth);
  if (actor instanceof Response) return actor;

  const svc = await getService();
  const m = INVITE_ROUTE.exec(pathname);
  if (!m) return json({ error: "not_found" }, 404);
  const method = request.method;
  const id = m[1] ? Number(m[1]) : null;
  const action = m[2] ?? null;

  // Base collection: GET list / POST mint.
  if (id === null) {
    if (method === "GET") {
      return json({ invites: await svc.adminListInvites() });
    }
    if (method === "POST") {
      const body = await readBody(request);
      const role = typeof body.role === "string" ? body.role : "";
      const ttlHours =
        typeof body.ttlHours === "number" ? body.ttlHours : INVITE_TTL_HOURS;
      const r = await svc.adminCreateInvite(role, ttlHours, actor, ctx);
      if (!r.ok) return fail(r);
      // RELATIVE URL — the admin browser origin completes it (see header).
      return json({ ok: true, url: `/invite/${r.token}` });
    }
    return json({ error: "method_not_allowed" }, 405);
  }

  // Per-invite action is POST-only.
  if (method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (action === "revoke") {
    const r = await svc.adminRevokeInvite(id, actor, ctx);
    return r.ok ? json({ ok: true }) : fail(r);
  }
  return json({ error: "not_found" }, 404);
}
