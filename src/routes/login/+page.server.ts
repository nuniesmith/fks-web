import { fail, redirect } from "@sveltejs/kit";
import {
  authDisabled,
  getAuthService,
  loginRateLimiter,
  trustForwardedFor,
} from "$lib/server/auth";
import {
  clientIp,
  isSecureRequest,
  safeNext,
  SESSION_COOKIE,
  setSessionCookie,
} from "$lib/server/auth/http";
import type { Actions, PageServerLoad } from "./$types";

// Already-authenticated visitors skip the login form. A mustChange session is
// funnelled to /setup; the store being down just shows the form (the action
// surfaces the real error).
export const load: PageServerLoad = async ({ cookies, url }) => {
  if (authDisabled()) return {};
  let mustChange = false;
  let authed = false;
  try {
    const svc = await getAuthService();
    const session = await svc.resolveSession(cookies.get(SESSION_COOKIE) ?? "");
    if (session) {
      authed = true;
      mustChange = session.mustChange;
    }
  } catch {
    return {};
  }
  if (authed) {
    redirect(302, mustChange ? "/setup" : safeNext(url.searchParams.get("next")));
  }
  return {};
};

export const actions: Actions = {
  login: async ({ request, cookies, url, getClientAddress }) => {
    if (authDisabled()) redirect(302, safeNext(url.searchParams.get("next")));

    const data = await request.formData();
    const username = String(data.get("username") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const next = safeNext(url.searchParams.get("next"));

    if (!username || !password) {
      return fail(400, { error: "Username and password are required.", username });
    }

    // Key off the unspoofable socket peer (getClientAddress) — NOT raw
    // X-Real-IP/X-Forwarded-For, which an attacker on the direct :3001 tunnel
    // this limiter defends can rotate per request to mint fresh keys.
    const ip = clientIp(request, getClientAddress(), trustForwardedFor());
    // Per-IP limiter (design §4.1 in-app half — nginx is bypassable via :3001).
    if (!loginRateLimiter.hit(ip)) {
      return fail(429, {
        error: "Too many attempts. Please wait a few minutes.",
        username,
      });
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

    const result = await svc.login(username, password, {
      ip,
      userAgent: request.headers.get("user-agent") ?? "",
    });
    if (!result.ok) {
      return fail(result.locked ? 429 : 401, { error: result.error, username });
    }

    setSessionCookie(cookies, result.token, isSecureRequest(request, url));
    redirect(302, result.mustChange ? "/setup" : next);
  },
};
