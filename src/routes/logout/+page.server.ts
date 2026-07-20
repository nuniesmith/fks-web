import { redirect } from "@sveltejs/kit";
import { getAuthService, trustForwardedFor } from "$lib/server/auth";
import {
  clearSessionCookie,
  clientIp,
  SESSION_COOKIE,
} from "$lib/server/auth/http";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  // GET /logout just redirects to login — the action does the real revoke.
  redirect(302, "/login");
};

export const actions: Actions = {
  default: async ({ cookies, request, getClientAddress }) => {
    const token = cookies.get(SESSION_COOKIE) ?? "";
    // Revoke the session row server-side (real revocation, not a client wipe).
    try {
      const svc = await getAuthService();
      await svc.logout(token, {
        ip: clientIp(request, getClientAddress(), trustForwardedFor()),
        userAgent: request.headers.get("user-agent") ?? "",
      });
    } catch {
      /* store down — still clear the cookie so the browser stops presenting it */
    }
    clearSessionCookie(cookies);
    redirect(302, "/login");
  },
};
