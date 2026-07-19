// Cookie + request helpers shared by the login/logout/setup route actions.
import type { Cookies } from "@sveltejs/kit";
import { SESSION_ABSOLUTE_MS } from "./policy";

export const SESSION_COOKIE = "fks_session";

export function setSessionCookie(
  cookies: Cookies,
  token: string,
  secure: boolean,
): void {
  cookies.set(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000),
  });
}

export function clearSessionCookie(cookies: Cookies): void {
  cookies.delete(SESSION_COOKIE, { path: "/" });
}

/**
 * Client IP used as the rate-limit key and audit source. The trust anchor is
 * `socketAddr` (SvelteKit `getClientAddress()`), which honours a *configured*
 * trusted proxy via adapter-node's ADDRESS_HEADER/XFF_DEPTH — it is NOT
 * client-spoofable. Raw `X-Real-IP`/`X-Forwarded-For` headers are consulted
 * ONLY when `trustForwarded` is explicitly enabled, because on the direct
 * `:3001` tunnel the limiter is built to defend, those headers are attacker-set:
 * trusting them lets a fresh value per request mint a fresh limiter key and
 * pollute the audit IP. Default = socket address, unspoofable.
 */
export function clientIp(
  request: Request,
  socketAddr: string,
  trustForwarded = false,
): string {
  if (trustForwarded) {
    return (
      request.headers.get("x-real-ip") ??
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      socketAddr
    );
  }
  return socketAddr;
}

/** Set the cookie's Secure flag only over HTTPS (nginx sets the proto header). */
export function isSecureRequest(request: Request, url: URL): boolean {
  return (
    request.headers.get("x-forwarded-proto") === "https" ||
    url.protocol === "https:"
  );
}

/** Restrict a `?next=` redirect target to a same-site relative path. */
export function safeNext(raw: string | null): string {
  if (!raw) return "/";
  try {
    const decoded = decodeURIComponent(raw);
    // Must be a rooted path, and NOT protocol-relative. Backslashes are rejected
    // outright: browsers normalise `\` to `/` in the authority position, so
    // `/\evil.com` (single slash + backslash — passes a naive `//` check) would
    // resolve to `//evil.com` → an off-site open redirect. A same-site path has
    // no legitimate reason to contain a backslash.
    if (decoded.includes("\\")) return "/";
    if (decoded.startsWith("/") && !decoded.startsWith("//")) return decoded;
  } catch {
    /* malformed — fall through */
  }
  return "/";
}
