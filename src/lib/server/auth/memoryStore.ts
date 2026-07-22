// In-memory AuthStore — used by the unit tests (and never wired in production).
// Mirrors PgStore semantics closely enough that the service logic exercised
// against it is the same logic that runs against Postgres.

import type {
  AuditEntry,
  AuthStore,
  InviteRow,
  InviteSummary,
  NewInvite,
  NewSession,
  NewUser,
  SessionWithUser,
  UserRow,
  UserSummary,
} from "./store";

interface StoredSession extends NewSession {}

export class MemoryStore implements AuthStore {
  private users = new Map<number, UserRow>();
  private createdAt = new Map<number, Date>();
  private sessions = new Map<string, StoredSession>();
  private invites = new Map<number, InviteRow>();
  private seq = 0;
  private inviteSeq = 0;
  /** Exposed for test assertions on the append-only audit trail. */
  readonly auditLog: AuditEntry[] = [];
  /**
   * Test seam for the concurrent-claim race: an async hook awaited INSIDE the
   * atomic `redeemInvite` (after the read, before the write), so a test can
   * interleave two claims deterministically and prove exactly one wins.
   */
  onRedeemInvite: ((id: number) => Promise<void>) | null = null;

  async init(): Promise<void> {
    /* no schema to apply */
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async countEnabledAdmins(): Promise<number> {
    let n = 0;
    for (const u of this.users.values()) {
      if (u.role === "admin" && !u.disabled) n++;
    }
    return n;
  }

  async listUsers(): Promise<UserSummary[]> {
    return [...this.users.values()]
      .sort((a, b) => a.id - b.id)
      .map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        mustChange: u.mustChange,
        disabled: u.disabled,
        lockedUntil: u.lockedUntil,
        createdAt: this.createdAt.get(u.id) ?? new Date(0),
      }));
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
    this.createdAt.set(row.id, new Date());
    return { ...row };
  }

  async deleteUser(userId: number): Promise<void> {
    this.users.delete(userId);
    this.createdAt.delete(userId);
    for (const [hash, s] of this.sessions) {
      if (s.userId === userId) this.sessions.delete(hash);
    }
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

  async updatePassword(
    userId: number,
    passwordHash: string,
    mustChange: boolean,
  ): Promise<void> {
    const u = this.users.get(userId);
    if (!u) throw new Error("no_such_user");
    u.passwordHash = passwordHash;
    u.mustChange = mustChange;
    u.failedLogins = 0;
    u.lockedUntil = null;
  }

  async setUserDisabled(userId: number, disabled: boolean): Promise<void> {
    const u = this.users.get(userId);
    if (u) u.disabled = disabled;
  }

  async setUserRole(userId: number, role: string): Promise<void> {
    const u = this.users.get(userId);
    if (u) u.role = role;
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
    // Mirror PgStore's `AND u.disabled = FALSE` join filter: a disabled user's
    // sessions resolve to null (die at the next resolve) even if a stray row
    // outlives the cascade delete.
    if (!u || u.disabled) return null;
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

  // ── Invites (Phase C) ──────────────────────────────────────────────────────

  async createInvite(invite: NewInvite): Promise<InviteRow> {
    const row: InviteRow = {
      id: ++this.inviteSeq,
      tokenHash: invite.tokenHash,
      role: invite.role,
      createdBy: invite.createdBy,
      createdAt: new Date(),
      expiresAt: invite.expiresAt,
      redeemedBy: null,
      redeemedAt: null,
      revokedAt: null,
    };
    this.invites.set(row.id, row);
    return { ...row };
  }

  async getInviteByTokenHash(tokenHash: string): Promise<InviteRow | null> {
    for (const i of this.invites.values()) {
      if (i.tokenHash === tokenHash) return { ...i };
    }
    return null;
  }

  async listInvites(): Promise<InviteSummary[]> {
    return [...this.invites.values()]
      .sort((a, b) => b.id - a.id)
      .map((i) => ({
        id: i.id,
        role: i.role,
        createdByUsername: this.users.get(i.createdBy)?.username ?? "",
        createdAt: i.createdAt,
        expiresAt: i.expiresAt,
        redeemedAt: i.redeemedAt,
        revokedAt: i.revokedAt,
      }));
  }

  async revokeInvite(id: number): Promise<void> {
    const i = this.invites.get(id);
    if (i && i.revokedAt === null && i.redeemedAt === null) {
      i.revokedAt = new Date();
    }
  }

  async redeemInvite(id: number, userId: number): Promise<boolean> {
    const i = this.invites.get(id);
    // Read the guard state BEFORE the (optional) interleave hook, mirroring the
    // instant Postgres evaluates the WHERE clause; the winner is whoever commits
    // the write first.
    const claimable = !!i && i.redeemedAt === null && i.revokedAt === null;
    if (this.onRedeemInvite) await this.onRedeemInvite(id);
    if (!i) return false;
    // Re-check under the "lock": if a concurrent claim wrote redeemed_at during
    // the await, we lost. This is the MemoryStore analogue of the atomic
    // conditional UPDATE ... WHERE redeemed_at IS NULL RETURNING id.
    if (!claimable || i.redeemedAt !== null || i.revokedAt !== null) return false;
    i.redeemedBy = userId;
    i.redeemedAt = new Date();
    return true;
  }
}
