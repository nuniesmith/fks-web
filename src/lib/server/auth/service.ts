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
  validateUsername,
} from "./policy";
import { generateBootstrapPassword, generateSessionToken, hashToken } from "./tokens";
import type { AuthStore, UserRow, UserSummary } from "./store";

/** Roles an admin may assign — the CHECK-constrained set (schema.sql). */
export const ASSIGNABLE_ROLES = ["admin", "operator", "viewer"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

function isAssignableRole(role: string): role is AssignableRole {
  return (ASSIGNABLE_ROLES as readonly string[]).includes(role);
}

/**
 * Roles an INVITE may grant — a DELIBERATE subset of ASSIGNABLE_ROLES that
 * EXCLUDES 'admin' (plan OD-5 / fks 012 CHECK): there is no admin-by-invite,
 * admin creation stays a deliberate /users act or psql. Mirrors the DB CHECK so
 * a bad role is rejected in the service before it can reach the constraint.
 */
export const INVITE_ROLES = ["operator", "viewer"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

function isInviteRole(role: string): role is InviteRole {
  return (INVITE_ROLES as readonly string[]).includes(role);
}

/** Default invite lifetime (plan OD-5: 48 h, single-use). */
export const INVITE_TTL_HOURS = 48;

/** An invite row projected for the admin console, with a derived status. */
export interface InviteView {
  id: number;
  role: string;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  status: "active" | "expired" | "redeemed" | "revoked";
}

/**
 * What the PUBLIC claim page learns about a token at load. Deliberately
 * COARSE: `valid` collapses every not-usable reason (absent / expired /
 * redeemed / revoked) into one state so an unauthenticated prober gains no
 * exists-vs-revoked oracle from the load. The distinct, actionable reasons are
 * surfaced only by `claimInvite` when a form is actually submitted.
 */
export interface InvitePreview {
  valid: boolean;
  role: string | null;
  expiresAt: Date | null;
}

export type ClaimResult =
  | { ok: true; token: string; role: string }
  | { ok: false; error: string };

/** Result of an admin mutation. `status` lets the HTTP seam pick 400/404/409. */
export type AdminResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: string; status: number };

/** A mutation with no success payload (enable/disable/role/revoke). */
export type AdminMutation =
  | { ok: true }
  | { ok: false; error: string; status: number };

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

  // ── Admin user management (plan 01 §3 / Phase B) ──────────────────────────
  // Every mutation writes an audit row (username = TARGET, detail = "by
  // <actor>; <specifics>" — the actor lives in `detail`, not a column, per plan
  // OD-4's zero-migration choice). Guards that protect the operator from
  // locking themselves out (last-admin, self-disable) live here, not in the UI:
  // the page merely mirrors them as disabled affordances.

  /** List all users, secret-free, for the admin console. */
  async adminListUsers(): Promise<UserSummary[]> {
    return this.store.listUsers();
  }

  /**
   * Create a user with a random temp password + mustChange=TRUE (reuses the
   * bootstrap machinery). The temp password is returned ONCE for the admin to
   * hand over — it is never persisted in plaintext, never logged, and the audit
   * row records only that a user was created, never the password.
   */
  async adminCreateUser(
    username: string,
    role: string,
    actor: SessionInfo,
    ctx: RequestCtx,
  ): Promise<AdminResult<{ user: UserSummary; tempPassword: string }>> {
    if (!isAssignableRole(role)) {
      return { ok: false, error: "Invalid role.", status: 400 };
    }
    const uCheck = validateUsername(username);
    if (!uCheck.ok) return { ok: false, error: uCheck.error, status: 400 };
    const clean = username.trim();
    // Case-insensitive pre-check against the lower(username) unique index —
    // mirrors changeCredentials so the user gets a clean 409 rather than a raw
    // constraint 500.
    if (await this.store.getUserByUsername(clean)) {
      return { ok: false, error: "That username is taken.", status: 409 };
    }
    const tempPassword = generateBootstrapPassword();
    const passwordHash = await hashPassword(tempPassword, this.hashParams);
    let row: UserRow;
    try {
      row = await this.store.createUser({
        username: clean,
        passwordHash,
        role,
        mustChange: true,
      });
    } catch {
      // Lost a create race against the unique index.
      return { ok: false, error: "That username is taken.", status: 409 };
    }
    await this.store.audit({
      username: clean,
      action: "user_created",
      ip: ctx.ip,
      detail: `by ${actor.username}; role=${role}`,
    });
    return { ok: true, user: this.toSummary(row), tempPassword };
  }

  /**
   * Enable/disable a user. Disabling revokes the target's sessions immediately
   * (and purges the resolve cache). Guards: an admin cannot disable their own
   * account, nor disable the LAST enabled admin (that would lock everyone out).
   */
  async adminSetDisabled(
    targetId: number,
    disabled: boolean,
    actor: SessionInfo,
    ctx: RequestCtx,
  ): Promise<AdminMutation> {
    const target = await this.store.getUserById(targetId);
    if (!target) return { ok: false, error: "No such user.", status: 404 };

    if (disabled) {
      if (target.id === actor.userId) {
        return {
          ok: false,
          error: "You cannot disable your own account.",
          status: 400,
        };
      }
      if (
        target.role === "admin" &&
        !target.disabled &&
        (await this.store.countEnabledAdmins()) <= 1
      ) {
        return {
          ok: false,
          error: "Cannot disable the last enabled admin.",
          status: 400,
        };
      }
      await this.store.setUserDisabled(targetId, true);
      await this.store.deleteUserSessions(targetId);
      this.purgeUserFromCache(targetId);
      await this.store.audit({
        username: target.username,
        action: "user_disabled",
        ip: ctx.ip,
        detail: `by ${actor.username}`,
      });
    } else {
      await this.store.setUserDisabled(targetId, false);
      await this.store.audit({
        username: target.username,
        action: "user_enabled",
        ip: ctx.ip,
        detail: `by ${actor.username}`,
      });
    }
    return { ok: true };
  }

  /**
   * Change a user's role. Guard: cannot demote the last enabled admin (a
   * self-demotion is allowed ONLY while another enabled admin remains — the
   * `countEnabledAdmins() <= 1` check covers both, since that lone admin is the
   * actor). Sweeps the resolve cache so the new role is authoritative on the
   * target's next in-process request (no 60s stale window).
   */
  async adminSetRole(
    targetId: number,
    role: string,
    actor: SessionInfo,
    ctx: RequestCtx,
  ): Promise<AdminMutation> {
    if (!isAssignableRole(role)) {
      return { ok: false, error: "Invalid role.", status: 400 };
    }
    const target = await this.store.getUserById(targetId);
    if (!target) return { ok: false, error: "No such user.", status: 404 };

    const demotingAdmin =
      target.role === "admin" && role !== "admin" && !target.disabled;
    if (demotingAdmin && (await this.store.countEnabledAdmins()) <= 1) {
      return {
        ok: false,
        error: "Cannot demote the last enabled admin.",
        status: 400,
      };
    }
    const from = target.role;
    await this.store.setUserRole(targetId, role);
    this.purgeUserFromCache(targetId);
    await this.store.audit({
      username: target.username,
      action: "role_changed",
      ip: ctx.ip,
      detail: `by ${actor.username}; ${from} -> ${role}`,
    });
    return { ok: true };
  }

  /**
   * Reset a user's password to a fresh temp value with mustChange=TRUE and
   * revoke ALL their sessions (they re-login through /setup). Returns the temp
   * password once — never persisted/logged, and the audit row omits it.
   */
  async adminResetPassword(
    targetId: number,
    actor: SessionInfo,
    ctx: RequestCtx,
  ): Promise<AdminResult<{ tempPassword: string }>> {
    const target = await this.store.getUserById(targetId);
    if (!target) return { ok: false, error: "No such user.", status: 404 };
    const tempPassword = generateBootstrapPassword();
    const passwordHash = await hashPassword(tempPassword, this.hashParams);
    await this.store.updatePassword(targetId, passwordHash, true);
    await this.store.deleteUserSessions(targetId);
    this.purgeUserFromCache(targetId);
    await this.store.audit({
      username: target.username,
      action: "password_reset",
      ip: ctx.ip,
      detail: `by ${actor.username}`,
    });
    return { ok: true, tempPassword };
  }

  /** Revoke ALL of a user's sessions (a "log them out everywhere" button). */
  async adminRevokeSessions(
    targetId: number,
    actor: SessionInfo,
    ctx: RequestCtx,
  ): Promise<AdminMutation> {
    const target = await this.store.getUserById(targetId);
    if (!target) return { ok: false, error: "No such user.", status: 404 };
    await this.store.deleteUserSessions(targetId);
    this.purgeUserFromCache(targetId);
    await this.store.audit({
      username: target.username,
      action: "sessions_revoked",
      ip: ctx.ip,
      detail: `by ${actor.username}`,
    });
    return { ok: true };
  }

  // ── Invites (plan 01 Phase C) ─────────────────────────────────────────────

  /** Every invite for the admin console, newest first, with a derived status. */
  async adminListInvites(): Promise<InviteView[]> {
    const now = this.now();
    return (await this.store.listInvites()).map((i) => ({
      id: i.id,
      role: i.role,
      createdBy: i.createdByUsername,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      // redeemed wins over revoked (revokeInvite can't touch a redeemed row, so
      // they're mutually exclusive in practice — this order is defensive).
      status: i.redeemedAt
        ? "redeemed"
        : i.revokedAt
          ? "revoked"
          : i.expiresAt.getTime() <= now
            ? "expired"
            : "active",
    }));
  }

  /**
   * Mint a single-use invite for {operator|viewer} ONLY. The raw token is
   * generated here, returned to the caller EXACTLY ONCE, and only hashToken(it)
   * is persisted — the audit row records role + expiry + actor, NEVER the token.
   */
  async adminCreateInvite(
    role: string,
    ttlHours: number,
    actor: SessionInfo,
    ctx: RequestCtx,
  ): Promise<AdminResult<{ token: string; role: string; expiresAt: Date }>> {
    if (!isInviteRole(role)) {
      // No admin-by-invite; anything else is garbage.
      return { ok: false, error: "Invite role must be operator or viewer.", status: 400 };
    }
    if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 24 * 30) {
      return { ok: false, error: "Invalid invite lifetime.", status: 400 };
    }
    const token = generateSessionToken();
    const expiresAt = new Date(this.now() + ttlHours * 60 * 60 * 1000);
    await this.store.createInvite({
      tokenHash: hashToken(token),
      role,
      createdBy: actor.userId,
      expiresAt,
    });
    await this.store.audit({
      username: actor.username,
      action: "invite_created",
      ip: ctx.ip,
      detail: `role=${role}; expires=${expiresAt.toISOString()}; by ${actor.username}`,
    });
    return { ok: true, token, role, expiresAt };
  }

  /** Revoke an outstanding invite (audit invite_revoked; the URL stops working). */
  async adminRevokeInvite(
    id: number,
    actor: SessionInfo,
    ctx: RequestCtx,
  ): Promise<AdminMutation> {
    await this.store.revokeInvite(id);
    await this.store.audit({
      username: actor.username,
      action: "invite_revoked",
      ip: ctx.ip,
      detail: `invite ${id}; by ${actor.username}`,
    });
    return { ok: true };
  }

  /**
   * What the public claim page shows at load — coarse valid/invalid only (see
   * InvitePreview). No audit, no side effects, no oracle beyond "usable or not".
   */
  async previewInvite(token: string): Promise<InvitePreview> {
    const invalid: InvitePreview = { valid: false, role: null, expiresAt: null };
    if (!token) return invalid;
    const invite = await this.store.getInviteByTokenHash(hashToken(token));
    if (!invite) return invalid;
    if (invite.revokedAt || invite.redeemedAt) return invalid;
    if (invite.expiresAt.getTime() <= this.now()) return invalid;
    return { valid: true, role: invite.role, expiresAt: invite.expiresAt };
  }

  /**
   * Redeem an invite: the invitee sets their OWN username+password (mustChange
   * stays FALSE — there is no forced-change hop), and a session is minted just
   * like login. Distinct rejections for invalid / revoked / redeemed / expired /
   * bad-credential / taken-username, so the claim UX can explain the failure.
   *
   * CONCURRENCY — "two concurrent claims yield exactly one user" (the pin):
   * the FK redeemed_by → webui_users(id) requires the user to exist before we
   * can stamp who redeemed it, so we (1) create the invitee, then (2) win-or-lose
   * the ATOMIC redeem. Exactly one concurrent claim wins the conditional UPDATE;
   * the loser rolls back its just-created user (deleteUser) and is rejected. No
   * session is minted until the redeem is won, so a loser is never logged in.
   */
  async claimInvite(
    token: string,
    username: string,
    password: string,
    ctx: RequestCtx,
  ): Promise<ClaimResult> {
    const invite = await this.store.getInviteByTokenHash(hashToken(token));
    if (!invite) return { ok: false, error: "This invite link is not valid." };
    if (invite.revokedAt) {
      return { ok: false, error: "This invite link has been revoked." };
    }
    if (invite.redeemedAt) {
      return { ok: false, error: "This invite link has already been used." };
    }
    if (invite.expiresAt.getTime() <= this.now()) {
      return { ok: false, error: "This invite link has expired." };
    }

    const check = validateNewCredentials(username, password);
    if (!check.ok) return { ok: false, error: check.error };
    const clean = username.trim();
    if (await this.store.getUserByUsername(clean)) {
      return { ok: false, error: "That username is taken." };
    }

    const passwordHash = await hashPassword(password, this.hashParams);
    let user: UserRow;
    try {
      user = await this.store.createUser({
        username: clean,
        passwordHash,
        role: invite.role,
        mustChange: false,
      });
    } catch {
      // Lost a create race against the unique index.
      return { ok: false, error: "That username is taken." };
    }

    const won = await this.store.redeemInvite(invite.id, user.id);
    if (!won) {
      // A concurrent claim consumed the invite first — undo our user so the
      // invariant "one invite ⇒ at most one user" holds, and reject.
      await this.store.deleteUser(user.id);
      return { ok: false, error: "This invite link has already been used." };
    }

    const now = this.now();
    const sessionToken = generateSessionToken();
    await this.store.createSession({
      tokenHash: hashToken(sessionToken),
      userId: user.id,
      idleExpiresAt: new Date(now + SESSION_IDLE_MS),
      expiresAt: new Date(now + SESSION_ABSOLUTE_MS),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    await this.store.audit({
      username: clean,
      action: "invite_redeemed",
      ip: ctx.ip,
      detail: `role=${invite.role}; invite ${invite.id}`,
    });
    return { ok: true, token: sessionToken, role: invite.role };
  }

  /**
   * Purge every cached resolve for a user by userId — called on disable /
   * demote / reset / revoke so a role/disable change is authoritative on THIS
   * process's next request instead of surviving up to the cache TTL.
   *
   * RESIDUAL (multi-replica): each process caches independently, so OTHER
   * replicas still serve a stale role for up to WEBUI_SESSION_CACHE_TTL_MS
   * (default 60s). Set WEBUI_SESSION_CACHE_TTL_MS=0 (auth/index.ts) on clustered
   * deploys to make every resolve DB-authoritative and remove the window.
   */
  private purgeUserFromCache(userId: number): void {
    for (const [hash, entry] of this.cache) {
      if (entry.info.userId === userId) this.cache.delete(hash);
    }
  }

  private toSummary(u: UserRow): UserSummary {
    // Freshly-created rows: createdAt ≈ now (the list refetch carries the exact
    // DB value; this is only the immediate create-response echo).
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      mustChange: u.mustChange,
      disabled: u.disabled,
      lockedUntil: u.lockedUntil,
      createdAt: new Date(this.now()),
    };
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
