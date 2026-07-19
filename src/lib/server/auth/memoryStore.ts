// In-memory AuthStore — used by the unit tests (and never wired in production).
// Mirrors PgStore semantics closely enough that the service logic exercised
// against it is the same logic that runs against Postgres.

import type {
  AuditEntry,
  AuthStore,
  NewSession,
  NewUser,
  SessionWithUser,
  UserRow,
} from "./store";

interface StoredSession extends NewSession {}

export class MemoryStore implements AuthStore {
  private users = new Map<number, UserRow>();
  private sessions = new Map<string, StoredSession>();
  private seq = 0;
  /** Exposed for test assertions on the append-only audit trail. */
  readonly auditLog: AuditEntry[] = [];

  async init(): Promise<void> {
    /* no schema to apply */
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async getUserByUsername(username: string): Promise<UserRow | null> {
    const key = username.toLowerCase();
    for (const u of this.users.values()) {
      if (u.username.toLowerCase() === key) return { ...u };
    }
    return null;
  }

  async getUserById(id: number): Promise<UserRow | null> {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }

  async createUser(user: NewUser): Promise<UserRow> {
    if (await this.getUserByUsername(user.username)) {
      throw new Error("username_taken");
    }
    const row: UserRow = {
      id: ++this.seq,
      username: user.username,
      passwordHash: user.passwordHash,
      role: user.role,
      mustChange: user.mustChange,
      disabled: false,
      failedLogins: 0,
      lockedUntil: null,
    };
    this.users.set(row.id, row);
    return { ...row };
  }

  async updateCredentials(
    userId: number,
    username: string,
    passwordHash: string,
  ): Promise<void> {
    const u = this.users.get(userId);
    if (!u) throw new Error("no_such_user");
    const clash = await this.getUserByUsername(username);
    if (clash && clash.id !== userId) throw new Error("username_taken");
    u.username = username;
    u.passwordHash = passwordHash;
    u.mustChange = false;
    u.failedLogins = 0;
    u.lockedUntil = null;
  }

  async setFailedLogins(
    userId: number,
    failedLogins: number,
    lockedUntil: Date | null,
  ): Promise<void> {
    const u = this.users.get(userId);
    if (!u) return;
    u.failedLogins = failedLogins;
    u.lockedUntil = lockedUntil;
  }

  async createSession(session: NewSession): Promise<void> {
    this.sessions.set(session.tokenHash, { ...session });
  }

  async getSession(tokenHash: string): Promise<SessionWithUser | null> {
    const s = this.sessions.get(tokenHash);
    if (!s) return null;
    const u = this.users.get(s.userId);
    if (!u) return null;
    return {
      userId: u.id,
      username: u.username,
      role: u.role,
      mustChange: u.mustChange,
      idleExpiresAt: s.idleExpiresAt,
      expiresAt: s.expiresAt,
    };
  }

  async touchSession(tokenHash: string, idleExpiresAt: Date): Promise<void> {
    const s = this.sessions.get(tokenHash);
    if (s) s.idleExpiresAt = idleExpiresAt;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  async deleteUserSessions(
    userId: number,
    exceptTokenHash?: string,
  ): Promise<void> {
    for (const [hash, s] of this.sessions) {
      if (s.userId === userId && hash !== exceptTokenHash) {
        this.sessions.delete(hash);
      }
    }
  }

  async audit(entry: AuditEntry): Promise<void> {
    this.auditLog.push({ ...entry });
  }
}
