// AuthStore — the persistence contract for Phase 1 user management. Two
// implementations: `PgStore` (production, fks_db) and `MemoryStore` (tests).
// The service depends only on this interface, so the security logic is tested
// with zero database.

export interface UserRow {
  id: number;
  username: string;
  passwordHash: string;
  role: string;
  mustChange: boolean;
  disabled: boolean;
  failedLogins: number;
  lockedUntil: Date | null;
}

export interface NewUser {
  username: string;
  passwordHash: string;
  role: string;
  mustChange: boolean;
}

/**
 * A user projected for the admin `/users` list — deliberately WITHOUT
 * `passwordHash` (a list endpoint must never carry a secret, even a hashed one,
 * across the wire). Separate type from `UserRow` so the omission is enforced by
 * the compiler, not by remembering to strip a field.
 */
export interface UserSummary {
  id: number;
  username: string;
  role: string;
  mustChange: boolean;
  disabled: boolean;
  lockedUntil: Date | null;
  createdAt: Date;
}

export interface NewSession {
  tokenHash: string;
  userId: number;
  idleExpiresAt: Date;
  expiresAt: Date;
  ip: string;
  userAgent: string;
}

/** A session joined with its owner's live identity fields. */
export interface SessionWithUser {
  userId: number;
  username: string;
  role: string;
  mustChange: boolean;
  idleExpiresAt: Date;
  expiresAt: Date;
}

export interface AuditEntry {
  username: string;
  action: string;
  ip: string;
  detail: string;
}

/**
 * An audit row projected for the admin viewer (`GET /api/users/audit`). Same
 * fields as the write-shape `AuditEntry` PLUS the DB-assigned `at` timestamp
 * (which `AuditEntry` omits — the column defaults it, so the writer never
 * supplies it). Ordering (newest first) is the store's responsibility.
 */
export interface AuditView {
  at: Date;
  username: string;
  action: string;
  ip: string;
  detail: string;
}

/** An invite to mint — the raw token never crosses this boundary, only its
 *  sha256 (same discipline as NewSession.tokenHash). */
export interface NewInvite {
  tokenHash: string;
  role: string;
  createdBy: number;
  expiresAt: Date;
}

/** A full invite row (claim/preview logic reads redeemed/revoked/expiry). */
export interface InviteRow {
  id: number;
  tokenHash: string;
  role: string;
  createdBy: number;
  createdAt: Date;
  expiresAt: Date;
  redeemedBy: number | null;
  redeemedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * An invite projected for the admin list — deliberately WITHOUT `tokenHash`
 * (a list endpoint must never carry the secret material, even hashed), and with
 * the creator's username resolved. Separate type from `InviteRow` so the
 * omission is compiler-enforced, mirroring UserSummary vs UserRow.
 */
export interface InviteSummary {
  id: number;
  role: string;
  createdByUsername: string;
  createdAt: Date;
  expiresAt: Date;
  redeemedAt: Date | null;
  revokedAt: Date | null;
}

/** A personal access token to mint — only its sha256 crosses this boundary. */
export interface NewApiToken {
  userId: number;
  name: string;
  tokenHash: string;
  roleCap: string;
  expiresAt: Date;
}

/** A token joined with its owner's live identity, for resolving a request. */
export interface ApiTokenWithUser {
  id: number;
  userId: number;
  username: string;
  /** The owner's CURRENT role; the effective role is min(this, roleCap). */
  role: string;
  roleCap: string;
  mustChange: boolean;
  disabled: boolean;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** A token as its owner's list shows it — no token_hash, like InviteSummary. */
export interface ApiTokenSummary {
  id: number;
  name: string;
  roleCap: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Outcome of an atomic last-admin-guarded mutation (`disableUserGuarded` /
 * `setUserRoleGuarded`):
 *   - `applied`      → the change was made;
 *   - `would_orphan` → refused: it would remove the LAST enabled admin;
 *   - `not_found`    → the target row no longer exists.
 */
export type AdminGuardOutcome = "applied" | "would_orphan" | "not_found";

export interface AuthStore {
  /** Apply the (idempotent) schema migration. */
  init(): Promise<void>;
  countUsers(): Promise<number>;
  /** Enabled admins only — the guard denominator for "last admin" checks
   *  (never demote/disable the final one who can still log in). */
  countEnabledAdmins(): Promise<number>;
  getUserByUsername(username: string): Promise<UserRow | null>;
  getUserById(id: number): Promise<UserRow | null>;
  /** Every user, secret-free, for the admin console. */
  listUsers(): Promise<UserSummary[]>;
  createUser(user: NewUser): Promise<UserRow>;
  /** Hard-delete a user by id (FK-cascades their sessions). Used ONLY to roll
   *  back the loser of a concurrent invite-claim race — never a UI action. */
  deleteUser(userId: number): Promise<void>;
  /** Rotate credentials and clear the mustChange flag in one write. */
  updateCredentials(
    userId: number,
    username: string,
    passwordHash: string,
  ): Promise<void>;
  /** Admin password reset: rotate the hash and (re)set mustChange WITHOUT
   *  touching the username (unlike `updateCredentials`). Clears lock counters. */
  updatePassword(
    userId: number,
    passwordHash: string,
    mustChange: boolean,
  ): Promise<void>;
  setUserDisabled(userId: number, disabled: boolean): Promise<void>;
  setUserRole(userId: number, role: string): Promise<void>;
  /**
   * ATOMIC last-admin-guarded disable: set `disabled=TRUE` for `userId` ONLY if
   * doing so would not remove the last enabled admin. Closes the check-then-
   * mutate race where two concurrent disables each read `countEnabledAdmins()>1`
   * and both proceed to zero (recoverable only via psql). PgStore locks the
   * enabled-admin rows `FOR UPDATE` inside a transaction so a concurrent guarded
   * mutation serializes behind it; MemoryStore decides+writes with no await gap
   * (atomic under the single-threaded event loop). Returns the outcome.
   */
  disableUserGuarded(userId: number): Promise<AdminGuardOutcome>;
  /**
   * ATOMIC last-admin-guarded role change: set `role` for `userId` ONLY if it
   * would not demote the last enabled admin (a lateral/promotion to `admin`, or
   * any change to a non-admin / already-disabled target, always applies). Same
   * serialization contract as `disableUserGuarded`.
   */
  setUserRoleGuarded(userId: number, role: string): Promise<AdminGuardOutcome>;
  setFailedLogins(
    userId: number,
    failedLogins: number,
    lockedUntil: Date | null,
  ): Promise<void>;
  createSession(session: NewSession): Promise<void>;
  getSession(tokenHash: string): Promise<SessionWithUser | null>;
  touchSession(tokenHash: string, idleExpiresAt: Date): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  /** Revoke all of a user's sessions, optionally keeping one (the caller's). */
  deleteUserSessions(userId: number, exceptTokenHash?: string): Promise<void>;
  audit(entry: AuditEntry): Promise<void>;
  /**
   * The most recent audit rows, newest first, capped at `limit` (the handler
   * clamps `limit` to a sane range before calling). Read-only surface for the
   * admin "Recent auth events" panel — every login/mutation/invite action
   * already writes here, this just reads it back.
   */
  listAudit(limit: number): Promise<AuditView[]>;

  // ── Invites (Phase C) ──────────────────────────────────────────────────────
  createInvite(invite: NewInvite): Promise<InviteRow>;
  getInviteByTokenHash(tokenHash: string): Promise<InviteRow | null>;
  /** Every invite, secret-free (no token_hash), newest first, for the console. */
  listInvites(): Promise<InviteSummary[]>;
  /** Revoke an un-redeemed, un-revoked invite (idempotent no-op otherwise). */
  revokeInvite(id: number): Promise<void>;
  /**
   * ATOMIC single-use consume: stamp redeemed_by/redeemed_at ONLY while the
   * invite is still un-redeemed AND un-revoked. Returns true iff THIS caller won
   * the race (rowcount 1); false means a concurrent claim already consumed it.
   */
  redeemInvite(id: number, userId: number): Promise<boolean>;

  // ── Personal access tokens (API v1, EDGE_FACTORY_PLAN §7.2) ────────────────
  /**
   * Whether `webui_api_tokens` exists. False on a scoped deploy whose DBA has
   * not applied fks 027 yet: tokens are then refused, and login is unaffected.
   */
  apiTokensAvailable(): boolean;
  createApiToken(token: NewApiToken): Promise<ApiTokenSummary>;
  getApiTokenByHash(tokenHash: string): Promise<ApiTokenWithUser | null>;
  /** One user's tokens, newest first, secret-free. */
  listApiTokens(userId: number): Promise<ApiTokenSummary[]>;
  /** Revoke one of `userId`'s own tokens; true iff it was live and is now revoked. */
  revokeApiToken(id: number, userId: number): Promise<boolean>;
  /** Stamp `last_used_at` with the service clock (one clock, testable). */
  touchApiToken(id: number, at: Date): Promise<void>;
}
