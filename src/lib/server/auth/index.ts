// Production wiring: pick the store from env, run migration + bootstrap ONCE,
// print the bootstrap password once to the log, and resolve the per-request
// AuthState for the hook (design §4.0-4.1). FAIL CLOSED: if auth is not
// explicitly disabled and the store can't be reached, the caller must deny.

import { env } from "$env/dynamic/private";
import type { AuthState } from "../adapter";
import { AuthService } from "./service";
import { PgStore } from "./pgStore";
import { LoginRateLimiter } from "./rateLimit";

/** Explicit, opt-in dev bypass — the ONLY way to run without auth. */
export function authDisabled(): boolean {
  return (env.WEBUI_AUTH ?? "").trim().toLowerCase() === "disabled";
}

/**
 * Whether to trust client-supplied `X-Real-IP`/`X-Forwarded-For` for the
 * login rate-limit key + audit IP. Default OFF — the socket peer
 * (`getClientAddress()`) is the unspoofable anchor. Enable ONLY when the webui
 * is reachable exclusively through a trusted reverse proxy that overwrites those
 * headers (and prefer configuring adapter-node's ADDRESS_HEADER instead).
 */
export function trustForwardedFor(): boolean {
  return /^(1|true|yes)$/i.test((env.WEBUI_TRUST_FORWARDED_FOR ?? "").trim());
}

/**
 * Session-resolve cache TTL (ms). Default 60s (SESSION_CACHE_TTL_MS via the
 * service). Set WEBUI_SESSION_CACHE_TTL_MS=0 on multi-replica/clustered deploys
 * so revocation (logout / disable / forced-change) is DB-authoritative
 * immediately on every worker instead of surviving up to the TTL per process.
 */
function sessionCacheTtlMs(): number | undefined {
  const raw = (env.WEBUI_SESSION_CACHE_TTL_MS ?? "").trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

let initPromise: Promise<AuthService> | null = null;

async function createAndInit(): Promise<AuthService> {
  const url = env.WEBUI_DATABASE_URL ?? "";
  if (!url) {
    throw new Error(
      "WEBUI_DATABASE_URL is not set — auth store unavailable (failing closed). " +
        "Set it, or set WEBUI_AUTH=disabled to explicitly run without auth.",
    );
  }
  const svc = new AuthService(new PgStore(url), {
    bootstrapPassword: env.WEBUI_BOOTSTRAP_PASSWORD || undefined,
    cacheTtlMs: sessionCacheTtlMs(),
  });
  await svc.init();
  const boot = await svc.bootstrap();
  if (boot.created) {
    if (boot.fromEnv) {
      console.warn(
        "[FKS Auth] Bootstrapped admin using WEBUI_BOOTSTRAP_PASSWORD. " +
          "First login forces a username+password change.",
      );
    } else {
      // Printed ONCE, to the container log only — never to a file, .env, or git.
      console.warn(
        "\n============================================================\n" +
          "[FKS Auth] FIRST-RUN BOOTSTRAP\n" +
          "  A one-time admin account was created.\n" +
          "    username: admin\n" +
          `    password: ${boot.password}\n` +
          "  Log in, then you'll be forced to set your own\n" +
          "  username + password. This is the only time this\n" +
          "  password is shown.\n" +
          "============================================================\n",
      );
    }
  }
  return svc;
}

/**
 * Lazily create the singleton. On failure the promise is discarded so a later
 * request retries (a transient DB blip must not permanently wedge auth).
 */
export function getAuthService(): Promise<AuthService> {
  if (!initPromise) {
    initPromise = createAndInit().catch((e) => {
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}

/** Per-IP login limiter: 10 attempts / 5 min (design §4.1 in-app half). */
export const loginRateLimiter = new LoginRateLimiter({
  max: 10,
  windowMs: 5 * 60 * 1000,
});

/**
 * Per-IP limiter for the PUBLIC invite-claim action (Phase C) — a SEPARATE
 * instance from the login limiter so a burst of bogus-token claims can't consume
 * the login budget (or vice-versa). Same 10 / 5 min shape; keyed by clientIp.
 */
export const inviteRateLimiter = new LoginRateLimiter({
  max: 10,
  windowMs: 5 * 60 * 1000,
});

export class AuthStoreUnavailable extends Error {}

/**
 * Resolve the AuthState for a request from its session cookie. Throws
 * `AuthStoreUnavailable` when the store can't be reached and auth is not
 * disabled — the hook translates that into a fail-closed 503 (pages) / 401
 * (backend), never an open pass.
 */
export async function resolveAuthState(token: string): Promise<AuthState> {
  if (authDisabled()) return { mode: "disabled" };
  let svc: AuthService;
  try {
    svc = await getAuthService();
  } catch (e) {
    throw new AuthStoreUnavailable((e as Error).message);
  }
  try {
    if (!(await svc.hasUsers())) return { mode: "bootstrap" };
    const session = await svc.resolveSession(token);
    return { mode: "enabled", session };
  } catch (e) {
    throw new AuthStoreUnavailable((e as Error).message);
  }
}
