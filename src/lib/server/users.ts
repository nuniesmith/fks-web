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

import type { AuthState } from "./adapter";
import type { AuthService, RequestCtx } from "./auth/service";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const forbidden = (reason: string): Response =>
  json({ error: "forbidden", reason }, 403);

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
  // Defense in depth (see file header). Order matters: disabled mode is an
  // explicit refusal distinct from "not an admin".
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
  if (!actor) return forbidden("admin_required");

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
