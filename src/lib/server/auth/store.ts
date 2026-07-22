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
}
