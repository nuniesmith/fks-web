/**
 * Public one-time-signup claim page (plan 01 Phase C). `/invite/[token]` is in
 * PUBLIC_PREFIXES (adapter.ts) so it renders without a session. The raw token
 * arrives ONLY in the URL path (`params.token`) and is NEVER echoed back into
 * the page markup — the load returns just {valid, role, expiresAt}; the action
 * reads the token server-side. Already-signed-in visitors are told to log out
 * first (we never auto-bind an invite onto an existing session).
 */
import { fail, redirect } from "@sveltejs/kit";
import {
  authDisabled,
  getAuthService,
  inviteRateLimiter,
  trustForwardedFor,
} from "$lib/server/auth";
import {
  clientIp,
  isSecureRequest,
  setSessionCookie,
} from "$lib/server/auth/http";
import { MIN_PASSWORD_LENGTH } from "$lib/server/auth/policy";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
  // In the explicit dev bypass there is no auth store and invites are
  // meaningless — render the invalid state rather than touch a store.
  if (authDisabled()) {
    return { state: "invalid" as const, minPasswordLength: MIN_PASSWORD_LENGTH };
  }
  // Already authenticated (locals.user set by the hook for a full session):
  // don't auto-bind — ask them to log out first.
  if (locals.user) {
    return { state: "authed" as const, username: locals.user.username };
  }
  let preview;
  try {
    const svc = await getAuthService();
    preview = await svc.previewInvite(params.token);
  } catch {
    // Store unreachable — the open-page outage path renders this degraded shell.
    return { state: "unavailable" as const };
  }
  if (!preview.valid) {
    return { state: "invalid" as const, minPasswordLength: MIN_PASSWORD_LENGTH };
  }
  return {
    state: "valid" as const,
    role: preview.role,
    expiresAt: preview.expiresAt ? preview.expiresAt.toISOString() : null,
    minPasswordLength: MIN_PASSWORD_LENGTH,
  };
};

export const actions: Actions = {
  claim: async ({ request, params, cookies, url, getClientAddress, locals }) => {
    // The action fails closed regardless of what the load rendered.
    if (authDisabled()) {
      return fail(400, { error: "Invites are unavailable." });
    }
    if (locals.user) {
      return fail(400, { error: "You are already signed in — log out first." });
    }

    // Per-IP limiter dedicated to the claim action (separate budget from login),
    // keyed off the unspoofable socket peer (see clientIp).
    const ip = clientIp(request, getClientAddress(), trustForwardedFor());
    if (!inviteRateLimiter.hit(ip)) {
      return fail(429, { error: "Too many attempts. Please wait a few minutes." });
    }

    const data = await request.formData();
    const username = String(data.get("username") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const confirm = String(data.get("confirm") ?? "");

    if (!username || !password) {
      return fail(400, { error: "Username and password are required.", username });
    }
    if (password !== confirm) {
      return fail(400, { error: "Passwords do not match.", username });
    }

    let svc;
    try {
      svc = await getAuthService();
    } catch {
      return fail(503, {
        error: "Authentication store unavailable. Try again shortly.",
        username,
      });
    }

    const result = await svc.claimInvite(params.token, username, password, {
      ip,
      userAgent: request.headers.get("user-agent") ?? "",
    });
    if (!result.ok) return fail(400, { error: result.error, username });

    // Mint the session exactly like login and land the new user in the app.
    setSessionCookie(cookies, result.token, isSecureRequest(request, url));
    redirect(302, "/");
  },
};
