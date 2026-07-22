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
}
