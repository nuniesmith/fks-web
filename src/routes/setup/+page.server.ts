import { fail, redirect } from "@sveltejs/kit";
import { authDisabled, getAuthService, trustForwardedFor } from "$lib/server/auth";
import type { AuthService } from "$lib/server/auth/service";
import type { SessionInfo } from "$lib/server/adapter";
import {
  clientIp,
  isSecureRequest,
  SESSION_COOKIE,
  setSessionCookie,
} from "$lib/server/auth/http";
import type { Actions, PageServerLoad } from "./$types";

// Resolve the caller's session, or bounce. Redirects are thrown OUTSIDE the
// try so SvelteKit's redirect signal isn't swallowed.
async function requireMustChangeSession(
  token: string,
): Promise<{ svc: AuthService; session: SessionInfo } | { redirectTo: string }> {
  if (authDisabled()) return { redirectTo: "/" };
  let svc: AuthService;
  let session: SessionInfo | null;
  try {
    svc = await getAuthService();
    session = await svc.resolveSession(token);
  } catch {
    return { redirectTo: "/login" };
  }
  if (!session) return { redirectTo: "/login" };
  if (!session.mustChange) return { redirectTo: "/" };
  return { svc, session };
}

export const load: PageServerLoad = async ({ cookies }) => {
  const r = await requireMustChangeSession(cookies.get(SESSION_COOKIE) ?? "");
  if ("redirectTo" in r) redirect(302, r.redirectTo);
  return { currentUsername: r.session.username };
};

export const actions: Actions = {
  change: async ({ request, cookies, url, getClientAddress }) => {
    const token = cookies.get(SESSION_COOKIE) ?? "";
    const r = await requireMustChangeSession(token);
    if ("redirectTo" in r) redirect(302, r.redirectTo);
    const { svc, session } = r;

    const data = await request.formData();
    const username = String(data.get("username") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const confirm = String(data.get("confirm") ?? "");

    if (password !== confirm) {
      return fail(400, { error: "Passwords do not match.", username });
    }

    const result = await svc.changeCredentials(
      session.userId,
      token,
      username,
      password,
      {
        ip: clientIp(request, getClientAddress(), trustForwardedFor()),
        userAgent: request.headers.get("user-agent") ?? "",
      },
    );
    if (!result.ok) return fail(400, { error: result.error, username });

    // The kept session is now non-mustChange; refresh the cookie's lifetime and
    // land the operator in the app.
    setSessionCookie(cookies, token, isSecureRequest(request, url));
    redirect(302, "/");
  },
};
