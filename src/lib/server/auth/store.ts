// AuthStore — the persistence contract for Phase 1 user management. Two
// implementations: `PgStore` (production, ruby_db) and `MemoryStore` (tests).
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
  getUserByUsername(username: string): Promise<UserRow | null>;
  getUserById(id: number): Promise<UserRow | null>;
  createUser(user: NewUser): Promise<UserRow>;
  /** Rotate credentials and clear the mustChange flag in one write. */
  updateCredentials(
    userId: number,
    username: string,
    passwordHash: string,
  ): Promise<void>;
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
