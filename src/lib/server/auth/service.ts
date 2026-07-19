// AuthService — the Phase-1 security logic (design §4.1), store-agnostic so it
// is exercised in tests against MemoryStore and in production against PgStore.
//
// Guarantees enforced here:
//   - bootstrap creates exactly one admin, once, with a CSPRNG password and
//     mustChange=TRUE (never a static/shipped default);
//   - login verifies scrypt in constant time, applies per-user lockout, and
//     equalises timing for unknown users;
//   - sessions are opaque 32-byte tokens; only sha256(token) is stored;
//   - forced credential change rotates username+password, clears mustChange,
//     and revokes every OTHER session;
//   - a 60 s resolve cache keeps the hot path DB-light; revokes purge it.

import type { SessionInfo } from "../adapter";
import { DEFAULT_SCRYPT, hashPassword, verifyPassword, type ScryptParams } from "./hash";
import {
  computeLockUntil,
  isLocked,
  SESSION_ABSOLUTE_MS,
  SESSION_CACHE_TTL_MS,
  SESSION_IDLE_MS,
  validateNewCredentials,
} from "./policy";
import { generateBootstrapPassword, generateSessionToken, hashToken } from "./tokens";
import type { AuthStore } from "./store";

export interface RequestCtx {
  ip: string;
  userAgent: string;
}

export type LoginResult =
  | { ok: true; token: string; mustChange: boolean }
  | { ok: false; error: string; locked?: boolean };

export type ChangeResult = { ok: true } | { ok: false; error: string };

export interface BootstrapResult {
  created: boolean;
  /** Present only when a random password was generated (must be logged once). */
  password?: string;
  /** True when the password came from WEBUI_BOOTSTRAP_PASSWORD, not random. */
  fromEnv?: boolean;
}

interface ServiceOptions {
  hashParams?: ScryptParams;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Bootstrap password override (else CSPRNG). */
  bootstrapPassword?: string;
  /** Failure delay (ms) that blunts brute-force timing; tests set 0. */
  failureDelayMs?: number;
  /**
   * Read-through session-resolve cache TTL (ms). Defaults to
   * SESSION_CACHE_TTL_MS. Set to 0 to DISABLE the cache entirely — required for
   * multi-replica / clustered deploys where a per-process cache would let a
   * revoked/disabled session survive on other workers for up to the TTL
   * (each replica caches independently). With 0 every resolve hits the DB, so a
   * logout / disable / forced-change is authoritative immediately everywhere.
   */
  cacheTtlMs?: number;
}

interface CacheEntry {
  info: SessionInfo;
  cachedAt: number;
}

export class AuthService {
  private readonly store: AuthStore;
  private readonly hashParams: ScryptParams;
  private readonly now: () => number;
  private readonly bootstrapPassword?: string;
  private readonly failureDelayMs: number;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  /** Latched true once we've confirmed ≥1 user — avoids a per-request count. */
  private usersExist = false;

  constructor(store: AuthStore, opts: ServiceOptions = {}) {
    this.store = store;
    this.hashParams = opts.hashParams ?? DEFAULT_SCRYPT;
    this.now = opts.now ?? Date.now;
    this.bootstrapPassword = opts.bootstrapPassword;
    this.failureDelayMs = opts.failureDelayMs ?? 300;
    this.cacheTtlMs = opts.cacheTtlMs ?? SESSION_CACHE_TTL_MS;
  }

  /** Run the schema migration (idempotent). */
  async init(): Promise<void> {
    await this.store.init();
  }

  /**
   * Create the sole admin if the users table is empty. Idempotent: a second
   * call (or a concurrent process) with users present is a no-op. The random
   * password is returned exactly once for the caller to log — never persisted
   * in plaintext, never written to a file.
   */
  async bootstrap(): Promise<BootstrapResult> {
    if ((await this.store.countUsers()) > 0) {
      this.usersExist = true;
      return { created: false };
    }
    const fromEnv = this.bootstrapPassword !== undefined;
    const password = this.bootstrapPassword ?? generateBootstrapPassword();
    const passwordHash = await hashPassword(password, this.hashParams);
    try {
      await this.store.createUser({
        username: "admin",
        passwordHash,
        role: "admin",
        mustChange: true,
      });
    } catch {
      // Lost a create race with another worker — someone else bootstrapped.
      this.usersExist = true;
      return { created: false };
    }
    this.usersExist = true;
    await this.store.audit({
      username: "admin",
      action: "bootstrap",
      ip: "",
      detail: fromEnv ? "password from env" : "random password",
    });
    return { created: true, password: fromEnv ? undefined : password, fromEnv };
  }

  /** Whether any user exists (drives bootstrap vs enabled AuthState). */
  async hasUsers(): Promise<boolean> {
    if (this.usersExist) return true;
    const n = await this.store.countUsers();
    if (n > 0) this.usersExist = true;
    return n > 0;
  }

  async login(
    username: string,
    password: string,
    ctx: RequestCtx,
  ): Promise<LoginResult> {
    const now = this.now();
    const user = await this.store.getUserByUsername(username);

    if (!user) {
      // Equalise timing so a probe can't distinguish unknown vs wrong password:
      // burn a hash comparison AND apply the same failure delay as wrong-password.
      await verifyPassword(password, DUMMY_HASH);
      await this.store.audit({
        username,
        action: "login_fail",
        ip: ctx.ip,
        detail: "unknown user",
      });
      await sleep(this.failureDelayMs);
      return { ok: false, error: "Invalid credentials." };
    }

    if (user.disabled) {
      await verifyPassword(password, user.passwordHash);
      await this.store.audit({
        username,
        action: "login_fail",
        ip: ctx.ip,
        detail: "disabled",
      });
      await sleep(this.failureDelayMs);
      return { ok: false, error: "Invalid credentials." };
    }

    if (isLocked(user.lockedUntil, now)) {
      // Burn the same scrypt + failure delay as the wrong-password path so a
      // locked account is not a fast-path timing oracle (result unused).
      await verifyPassword(password, user.passwordHash);
      await this.store.audit({
        username,
        action: "lockout",
        ip: ctx.ip,
        detail: "login while locked",
      });
      await sleep(this.failureDelayMs);
      return { ok: false, error: "Account temporarily locked. Try later.", locked: true };
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      const failed = user.failedLogins + 1;
      const lockUntil = computeLockUntil(failed, now);
      await this.store.setFailedLogins(user.id, failed, lockUntil);
      await this.store.audit({
        username,
        action: lockUntil ? "lockout" : "login_fail",
        ip: ctx.ip,
        detail: `fail ${failed}`,
      });
      // Blunt brute-force timing (design keeps the 300 ms delay).
      await sleep(this.failureDelayMs);
      return {
        ok: false,
        error: "Invalid credentials.",
        locked: !!lockUntil,
      };
    }

    // Success — reset counters, mint a session.
    if (user.failedLogins !== 0 || user.lockedUntil) {
      await this.store.setFailedLogins(user.id, 0, null);
    }
    const token = generateSessionToken();
    await this.store.createSession({
      tokenHash: hashToken(token),
      userId: user.id,
      idleExpiresAt: new Date(now + SESSION_IDLE_MS),
      expiresAt: new Date(now + SESSION_ABSOLUTE_MS),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    await this.store.audit({
      username: user.username,
      action: "login_ok",
      ip: ctx.ip,
      detail: user.mustChange ? "mustChange" : "",
    });
    return { ok: true, token, mustChange: user.mustChange };
  }

  /**
   * Resolve a cookie token to a SessionInfo, or null. Enforces absolute + idle
   * expiry (expired rows are deleted), slides the idle window, and caches the
   * result for 60 s to keep the hot path DB-light.
   */
  async resolveSession(token: string): Promise<SessionInfo | null> {
    if (!token) return null;
    const tokenHash = hashToken(token);
    const now = this.now();
    const caching = this.cacheTtlMs > 0;

    if (caching) {
      const cached = this.cache.get(tokenHash);
      if (cached && now - cached.cachedAt < this.cacheTtlMs) {
        return cached.info;
      }
    }

    const s = await this.store.getSession(tokenHash);
    if (!s) {
      this.cache.delete(tokenHash);
      return null;
    }
    if (s.expiresAt.getTime() <= now || s.idleExpiresAt.getTime() <= now) {
      await this.store.deleteSession(tokenHash);
      this.cache.delete(tokenHash);
      return null;
    }

    // Slide the idle window, capped at the absolute expiry.
    const nextIdle = Math.min(now + SESSION_IDLE_MS, s.expiresAt.getTime());
    await this.store.touchSession(tokenHash, new Date(nextIdle));

    const info: SessionInfo = {
      userId: s.userId,
      username: s.username,
      role: s.role,
      mustChange: s.mustChange,
    };
    if (caching) this.cache.set(tokenHash, { info, cachedAt: now });
    return info;
  }

  /**
   * Forced first-login change (and, later, any voluntary change). Requires the
   * caller's own session token so it can keep that session alive while revoking
   * all others. Rejects a new password equal to the current one.
   */
  async changeCredentials(
    userId: number,
    currentToken: string,
    newUsername: string,
    newPassword: string,
    ctx: RequestCtx,
  ): Promise<ChangeResult> {
    const user = await this.store.getUserById(userId);
    if (!user) return { ok: false, error: "Session invalid." };

    const check = validateNewCredentials(newUsername, newPassword);
    if (!check.ok) return check;

    // New password must differ from the current/bootstrap one.
    if (await verifyPassword(newPassword, user.passwordHash)) {
      return {
        ok: false,
        error: "New password must differ from the current password.",
      };
    }

    const clash = await this.store.getUserByUsername(newUsername);
    if (clash && clash.id !== userId) {
      return { ok: false, error: "That username is taken." };
    }

    const passwordHash = await hashPassword(newPassword, this.hashParams);
    try {
      await this.store.updateCredentials(userId, newUsername.trim(), passwordHash);
    } catch {
      return { ok: false, error: "That username is taken." };
    }

    // Revoke every other session; keep the caller's.
    const currentHash = hashToken(currentToken);
    await this.store.deleteUserSessions(userId, currentHash);
    // The kept session's cached mustChange is now stale — purge it so the very
    // next request sees mustChange=false and the app unlocks immediately.
    this.cache.delete(currentHash);

    await this.store.audit({
      username: newUsername.trim(),
      action: "credential_change",
      ip: ctx.ip,
      detail: `user ${userId}`,
    });
    return { ok: true };
  }

  /** Revoke a single session (logout). */
  async logout(token: string, ctx: RequestCtx): Promise<void> {
    if (!token) return;
    const tokenHash = hashToken(token);
    const s = await this.store.getSession(tokenHash);
    await this.store.deleteSession(tokenHash);
    this.cache.delete(tokenHash);
    if (s) {
      await this.store.audit({
        username: s.username,
        action: "logout",
        ip: ctx.ip,
        detail: "",
      });
    }
  }
}

// A well-formed scrypt PHC used only to burn ~equal work on the unknown-user
// path so it can't be distinguished from a known-user wrong password by timing.
// The params MUST match DEFAULT_SCRYPT (the cost a real stored hash re-derives
// at); a cheaper dummy would leave a measurable username-enumeration oracle. The
// salt/key bytes are irrelevant to timing (we discard the result) — only the
// ln/r/p cost matters — so we build the string straight from DEFAULT_SCRYPT to
// keep it in lock-step if the production params ever change.
export const DUMMY_HASH = buildDummyHash(DEFAULT_SCRYPT);

function buildDummyHash(p: ScryptParams): string {
  const zero = Buffer.alloc(p.keyLen).toString("base64");
  return `$scrypt$ln=${Math.log2(p.N)},r=${p.r},p=${p.p}$${zero}$${zero}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
