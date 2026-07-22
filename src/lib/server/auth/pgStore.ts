// Postgres-backed AuthStore (porsager/postgres — pure JS, no native build).
// Targets ruby_db via the scoped `fks_webui` LOGIN role (design §4.1).
// All timestamp columns come back as JS Date via the driver's default parsing.

import postgres from "postgres";
import { SCHEMA_SQL } from "./schema";
import type {
  AuditEntry,
  AuditView,
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

type Sql = ReturnType<typeof postgres>;

interface UserRecord {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  must_change_credentials: boolean;
  disabled: boolean;
  failed_logins: number;
  locked_until: Date | null;
}

function toUserRow(r: UserRecord): UserRow {
  return {
    id: Number(r.id),
    username: r.username,
    passwordHash: r.password_hash,
    role: r.role,
    mustChange: r.must_change_credentials,
    disabled: r.disabled,
    failedLogins: r.failed_logins,
    lockedUntil: r.locked_until,
  };
}

interface InviteRecord {
  id: string;
  token_hash: string;
  role: string;
  created_by: string;
  created_at: Date;
  expires_at: Date;
  redeemed_by: string | null;
  redeemed_at: Date | null;
  revoked_at: Date | null;
}

function toInviteRow(r: InviteRecord): InviteRow {
  return {
    id: Number(r.id),
    tokenHash: r.token_hash,
    role: r.role,
    createdBy: Number(r.created_by),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    redeemedBy: r.redeemed_by === null ? null : Number(r.redeemed_by),
    redeemedAt: r.redeemed_at,
    revokedAt: r.revoked_at,
  };
}

export class PgStore implements AuthStore {
  private sql: Sql;

  constructor(connectionString: string) {
    this.sql = postgres(connectionString, {
      max: 4,
      idle_timeout: 20,
      connect_timeout: 10,
      // Fail loudly rather than buffer forever if the DB is unreachable.
      onnotice: () => {},
    });
  }

  async init(): Promise<void> {
    // The recommended least-privilege deploy connects as the scoped `fks_webui`
    // role, which holds only DML on the three tables — NOT CREATE on schema
    // public (schema.sql grants it deliberately narrowly). Issuing the DDL under
    // that role would fail permission-denied and, via the fail-closed seam,
    // brick the WHOLE UI (login included) with no browser recovery path. So when
    // the tables already exist (the baked-initdb / DBA path prescribed by the
    // runbook) skip the migration entirely — never attempt a CREATE we can't
    // run. `to_regclass` needs only USAGE + visibility, both of which the scoped
    // role has. Only when the tables are ABSENT do we run the DDL, which
    // succeeds for a privileged connecting role (dev / single-role deploys).
    const present = await this.tablesExist();
    if (present) return;
    // Simple protocol, multiple statements, all idempotent.
    await this.sql.unsafe(SCHEMA_SQL);
  }

  /** Whether the auth tables are already present (migration already applied). */
  private async tablesExist(): Promise<boolean> {
    try {
      // Probe the NEWEST table, not the oldest. Convention: always probe the
      // LAST table this schema adds (currently `webui_invites`, C1). SCHEMA_SQL
      // is one idempotent CREATE-IF-NOT-EXISTS batch, so on a privileged dev DB
      // that already has the Phase-1/B tables but NOT the newly-added one,
      // probing an OLD table (`webui_users`) would report "present" and skip the
      // batch — silently never creating `webui_invites`. Probing the newest
      // table makes an additive migration run exactly when it must. On the
      // scoped live role (no CREATE) the DBA applies the SQL by hand first, so
      // this returns true and the DDL is correctly skipped.
      const rows = await this.sql<{ present: boolean }[]>`
        SELECT to_regclass('public.webui_invites') IS NOT NULL AS present`;
      return rows[0]?.present === true;
    } catch {
      // Couldn't even probe (e.g. no USAGE) — fall through and let the DDL
      // attempt surface the real error rather than silently skipping.
      return false;
    }
  }

  async countUsers(): Promise<number> {
    const rows = await this.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM webui_users`;
    return Number(rows[0]?.n ?? 0);
  }

  async countEnabledAdmins(): Promise<number> {
    const rows = await this.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM webui_users
      WHERE role = 'admin' AND disabled = FALSE`;
    return Number(rows[0]?.n ?? 0);
  }

  async listUsers(): Promise<UserSummary[]> {
    const rows = await this.sql<
      {
        id: string;
        username: string;
        role: string;
        must_change_credentials: boolean;
        disabled: boolean;
        locked_until: Date | null;
        created_at: Date;
      }[]
    >`
      SELECT id, username, role, must_change_credentials, disabled,
             locked_until, created_at
      FROM webui_users
      ORDER BY id`;
    return rows.map((r) => ({
      id: Number(r.id),
      username: r.username,
      role: r.role,
      mustChange: r.must_change_credentials,
      disabled: r.disabled,
      lockedUntil: r.locked_until,
      createdAt: r.created_at,
    }));
  }

  async getUserByUsername(username: string): Promise<UserRow | null> {
    const rows = await this.sql<UserRecord[]>`
      SELECT id, username, password_hash, role, must_change_credentials,
             disabled, failed_logins, locked_until
      FROM webui_users
      WHERE lower(username) = lower(${username})
      LIMIT 1`;
    return rows[0] ? toUserRow(rows[0]) : null;
  }

  async getUserById(id: number): Promise<UserRow | null> {
    const rows = await this.sql<UserRecord[]>`
      SELECT id, username, password_hash, role, must_change_credentials,
             disabled, failed_logins, locked_until
      FROM webui_users WHERE id = ${id} LIMIT 1`;
    return rows[0] ? toUserRow(rows[0]) : null;
  }

  async createUser(user: NewUser): Promise<UserRow> {
    const rows = await this.sql<UserRecord[]>`
      INSERT INTO webui_users (username, password_hash, role,
                               must_change_credentials)
      VALUES (${user.username}, ${user.passwordHash}, ${user.role},
              ${user.mustChange})
      RETURNING id, username, password_hash, role, must_change_credentials,
                disabled, failed_logins, locked_until`;
    return toUserRow(rows[0]);
  }

  async deleteUser(userId: number): Promise<void> {
    // Sessions FK-cascade (webui_sessions.user_id ON DELETE CASCADE).
    await this.sql`DELETE FROM webui_users WHERE id = ${userId}`;
  }

  async updateCredentials(
    userId: number,
    username: string,
    passwordHash: string,
  ): Promise<void> {
    await this.sql`
      UPDATE webui_users
      SET username = ${username}, password_hash = ${passwordHash},
          must_change_credentials = FALSE, failed_logins = 0,
          locked_until = NULL, updated_at = now()
      WHERE id = ${userId}`;
  }

  async updatePassword(
    userId: number,
    passwordHash: string,
    mustChange: boolean,
  ): Promise<void> {
    // Password-only rotation (username untouched, unlike updateCredentials).
    // Clears lock counters so an admin reset also unsticks a locked account.
    await this.sql`
      UPDATE webui_users
      SET password_hash = ${passwordHash},
          must_change_credentials = ${mustChange},
          failed_logins = 0, locked_until = NULL, updated_at = now()
      WHERE id = ${userId}`;
  }

  async setUserDisabled(userId: number, disabled: boolean): Promise<void> {
    await this.sql`
      UPDATE webui_users
      SET disabled = ${disabled}, updated_at = now()
      WHERE id = ${userId}`;
  }

  async setUserRole(userId: number, role: string): Promise<void> {
    await this.sql`
      UPDATE webui_users
      SET role = ${role}, updated_at = now()
      WHERE id = ${userId}`;
  }

  async setFailedLogins(
    userId: number,
    failedLogins: number,
    lockedUntil: Date | null,
  ): Promise<void> {
    await this.sql`
      UPDATE webui_users
      SET failed_logins = ${failedLogins}, locked_until = ${lockedUntil},
          updated_at = now()
      WHERE id = ${userId}`;
  }

  async createSession(session: NewSession): Promise<void> {
    await this.sql`
      INSERT INTO webui_sessions (token_hash, user_id, idle_expires_at,
                                  expires_at, ip, user_agent)
      VALUES (${session.tokenHash}, ${session.userId},
              ${session.idleExpiresAt}, ${session.expiresAt},
              ${session.ip}, ${session.userAgent})`;
  }

  async getSession(tokenHash: string): Promise<SessionWithUser | null> {
    const rows = await this.sql<
      {
        user_id: string;
        username: string;
        role: string;
        must_change_credentials: boolean;
        idle_expires_at: Date;
        expires_at: Date;
      }[]
    >`
      SELECT s.user_id, u.username, u.role, u.must_change_credentials,
             s.idle_expires_at, s.expires_at
      FROM webui_sessions s
      JOIN webui_users u ON u.id = s.user_id
      WHERE s.token_hash = ${tokenHash} AND u.disabled = FALSE
      LIMIT 1`;
    const r = rows[0];
    if (!r) return null;
    return {
      userId: Number(r.user_id),
      username: r.username,
      role: r.role,
      mustChange: r.must_change_credentials,
      idleExpiresAt: r.idle_expires_at,
      expiresAt: r.expires_at,
    };
  }

  async touchSession(tokenHash: string, idleExpiresAt: Date): Promise<void> {
    await this.sql`
      UPDATE webui_sessions
      SET idle_expires_at = ${idleExpiresAt}, last_seen_at = now()
      WHERE token_hash = ${tokenHash}`;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.sql`DELETE FROM webui_sessions WHERE token_hash = ${tokenHash}`;
  }

  async deleteUserSessions(
    userId: number,
    exceptTokenHash?: string,
  ): Promise<void> {
    if (exceptTokenHash) {
      await this.sql`
        DELETE FROM webui_sessions
        WHERE user_id = ${userId} AND token_hash <> ${exceptTokenHash}`;
    } else {
      await this.sql`DELETE FROM webui_sessions WHERE user_id = ${userId}`;
    }
  }

  async audit(entry: AuditEntry): Promise<void> {
    await this.sql`
      INSERT INTO webui_auth_audit (username, action, ip, detail)
      VALUES (${entry.username}, ${entry.action}, ${entry.ip}, ${entry.detail})`;
  }

  async listAudit(limit: number): Promise<AuditView[]> {
    // Newest first; ORDER BY id (monotonic BIGSERIAL) is a stable tiebreak for
    // rows sharing an `at` to the microsecond. `limit` is pre-clamped upstream.
    const rows = await this.sql<
      { at: Date; username: string; action: string; ip: string; detail: string }[]
    >`
      SELECT at, username, action, ip, detail
      FROM webui_auth_audit
      ORDER BY id DESC
      LIMIT ${limit}`;
    return rows.map((r) => ({
      at: r.at,
      username: r.username,
      action: r.action,
      ip: r.ip,
      detail: r.detail,
    }));
  }

  // ── Invites (Phase C) ──────────────────────────────────────────────────────

  async createInvite(invite: NewInvite): Promise<InviteRow> {
    const rows = await this.sql<InviteRecord[]>`
      INSERT INTO webui_invites (token_hash, role, created_by, expires_at)
      VALUES (${invite.tokenHash}, ${invite.role}, ${invite.createdBy},
              ${invite.expiresAt})
      RETURNING id, token_hash, role, created_by, created_at, expires_at,
                redeemed_by, redeemed_at, revoked_at`;
    return toInviteRow(rows[0]);
  }

  async getInviteByTokenHash(tokenHash: string): Promise<InviteRow | null> {
    const rows = await this.sql<InviteRecord[]>`
      SELECT id, token_hash, role, created_by, created_at, expires_at,
             redeemed_by, redeemed_at, revoked_at
      FROM webui_invites WHERE token_hash = ${tokenHash} LIMIT 1`;
    return rows[0] ? toInviteRow(rows[0]) : null;
  }

  async listInvites(): Promise<InviteSummary[]> {
    const rows = await this.sql<
      {
        id: string;
        role: string;
        created_by_username: string;
        created_at: Date;
        expires_at: Date;
        redeemed_at: Date | null;
        revoked_at: Date | null;
      }[]
    >`
      SELECT i.id, i.role, u.username AS created_by_username,
             i.created_at, i.expires_at, i.redeemed_at, i.revoked_at
      FROM webui_invites i
      JOIN webui_users u ON u.id = i.created_by
      ORDER BY i.id DESC`;
    return rows.map((r) => ({
      id: Number(r.id),
      role: r.role,
      createdByUsername: r.created_by_username,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      redeemedAt: r.redeemed_at,
      revokedAt: r.revoked_at,
    }));
  }

  async revokeInvite(id: number): Promise<void> {
    await this.sql`
      UPDATE webui_invites SET revoked_at = now()
      WHERE id = ${id} AND revoked_at IS NULL AND redeemed_at IS NULL`;
  }

  async redeemInvite(id: number, userId: number): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE webui_invites
      SET redeemed_by = ${userId}, redeemed_at = now()
      WHERE id = ${id} AND redeemed_at IS NULL AND revoked_at IS NULL
      RETURNING id`;
    return rows.length === 1;
  }
}
