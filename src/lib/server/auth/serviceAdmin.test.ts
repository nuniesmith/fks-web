// Admin user-management logic (Phase B) — driven against MemoryStore so every
// guard is pinned DB-free: last-admin (disable + demote), self-disable, reset
// flips mustChange AND revokes sessions, one audit row per mutation, duplicate
// username rejected case-insensitively, and the B2 cache sweep (a role change
// is authoritative on the very next in-process resolve).

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AuthService } from "./service";
import { MemoryStore } from "./memoryStore";
import type { ScryptParams } from "./hash";
import type { SessionInfo } from "../adapter";

const CHEAP: ScryptParams = { N: 1 << 12, r: 8, p: 1, keyLen: 32 };
const CTX = { ip: "10.0.0.1", userAgent: "test" };
// Generated per run — no literal password-shaped strings in the tree.
const ADMIN_PW = `test-admin-${randomUUID().slice(0, 8)}`;

async function setup() {
  const store = new MemoryStore();
  const svc = new AuthService(store, {
    hashParams: CHEAP,
    failureDelayMs: 0,
    bootstrapPassword: ADMIN_PW,
  });
  await svc.bootstrap();
  const admin = await store.getUserByUsername("admin");
  if (!admin) throw new Error("bootstrap failed");
  const actor: SessionInfo = {
    userId: admin.id,
    username: "admin",
    role: "admin",
    mustChange: false,
  };
  return { store, svc, actor };
}

describe("adminCreateUser", () => {
  it("creates with a temp password + mustChange, audits, never leaks the pw", async () => {
    const { store, svc, actor } = await setup();
    const r = await svc.adminCreateUser("friend", "operator", actor, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tempPassword).toHaveLength(24);
    expect(r.user.role).toBe("operator");

    const row = await store.getUserByUsername("friend");
    expect(row?.mustChange).toBe(true);
    // The new user can log in with the temp password (proves it was set).
    const login = await svc.login("friend", r.tempPassword, CTX);
    expect(login.ok).toBe(true);

    // Audit row exists and does NOT contain the temp password anywhere.
    const created = store.auditLog.find((a) => a.action === "user_created");
    expect(created).toMatchObject({ username: "friend" });
    expect(created?.detail).toContain("by admin");
    expect(JSON.stringify(store.auditLog)).not.toContain(r.tempPassword);
  });

  it("rejects a duplicate username case-insensitively (409)", async () => {
    const { svc, actor } = await setup();
    await svc.adminCreateUser("Friend", "viewer", actor, CTX);
    const dup = await svc.adminCreateUser("friend", "operator", actor, CTX);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.status).toBe(409);
  });

  it("rejects an invalid role (400) and a bad username (400)", async () => {
    const { svc, actor } = await setup();
    const badRole = await svc.adminCreateUser("ok", "root", actor, CTX);
    expect(badRole.ok).toBe(false);
    if (!badRole.ok) expect(badRole.status).toBe(400);
    const badName = await svc.adminCreateUser("bad name!", "viewer", actor, CTX);
    expect(badName.ok).toBe(false);
    if (!badName.ok) expect(badName.status).toBe(400);
  });
});

describe("adminSetDisabled — guards", () => {
  it("refuses to disable your own account", async () => {
    const { svc, actor } = await setup();
    const r = await svc.adminSetDisabled(actor.userId, true, actor, CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/your own/i);
  });

  it("refuses to disable the last enabled admin (target ≠ self)", async () => {
    const { svc, actor } = await setup();
    // A ghost admin actor disabling the sole real admin — pins the guard even
    // though the seam would never mint this actor.
    const ghost: SessionInfo = { userId: 9999, username: "ghost", role: "admin", mustChange: false };
    const r = await svc.adminSetDisabled(actor.userId, true, ghost, CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/last enabled admin/i);
  });

  it("disables a non-last user, revokes their sessions, and audits", async () => {
    const { store, svc, actor } = await setup();
    const c = await svc.adminCreateUser("op", "operator", actor, CTX);
    if (!c.ok) throw new Error("create failed");
    const login = await svc.login("op", c.tempPassword, CTX);
    if (!login.ok) throw new Error("login failed");
    expect(await svc.resolveSession(login.token)).not.toBeNull();

    const r = await svc.adminSetDisabled(c.user.id, true, actor, CTX);
    expect(r.ok).toBe(true);
    // Session gone (deleteUserSessions) AND disabled join → null.
    expect(await svc.resolveSession(login.token)).toBeNull();
    expect(store.auditLog.some((a) => a.action === "user_disabled")).toBe(true);

    // Re-enable is unguarded + audited.
    const back = await svc.adminSetDisabled(c.user.id, false, actor, CTX);
    expect(back.ok).toBe(true);
    expect(store.auditLog.some((a) => a.action === "user_enabled")).toBe(true);
  });
});

describe("adminSetRole — last-admin demotion guard", () => {
  it("blocks demoting the only admin (even self), allows once another exists", async () => {
    const { svc, actor } = await setup();
    // Self-demotion of the sole admin is blocked.
    const blocked = await svc.adminSetRole(actor.userId, "operator", actor, CTX);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/last enabled admin/i);

    // Add a second admin, then self-demotion is allowed.
    const boss = await svc.adminCreateUser("boss", "admin", actor, CTX);
    if (!boss.ok) throw new Error("create failed");
    const ok = await svc.adminSetRole(actor.userId, "operator", actor, CTX);
    expect(ok.ok).toBe(true);
  });

  it("rejects an invalid role", async () => {
    const { svc, actor } = await setup();
    const r = await svc.adminSetRole(actor.userId, "wheel", actor, CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
});

describe("adminResetPassword", () => {
  it("issues a new temp pw, flips mustChange, and kills all sessions", async () => {
    const { store, svc, actor } = await setup();
    const c = await svc.adminCreateUser("op", "operator", actor, CTX);
    if (!c.ok) throw new Error("create failed");
    // Clear mustChange by simulating a completed setup: update creds directly.
    await store.updatePassword(c.user.id, (await store.getUserById(c.user.id))!.passwordHash, false);
    const login = await svc.login("op", c.tempPassword, CTX);
    if (!login.ok) throw new Error("login failed");
    expect(await svc.resolveSession(login.token)).not.toBeNull();

    const r = await svc.adminResetPassword(c.user.id, actor, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tempPassword).toHaveLength(24);
    expect(r.tempPassword).not.toBe(c.tempPassword);

    const row = await store.getUserById(c.user.id);
    expect(row?.mustChange).toBe(true);
    expect(await svc.resolveSession(login.token)).toBeNull();
    expect(store.auditLog.some((a) => a.action === "password_reset")).toBe(true);
    expect(JSON.stringify(store.auditLog)).not.toContain(r.tempPassword);
  });
});

describe("adminRevokeSessions", () => {
  it("kills sessions + audits", async () => {
    const { store, svc, actor } = await setup();
    const c = await svc.adminCreateUser("op", "operator", actor, CTX);
    if (!c.ok) throw new Error("create failed");
    const login = await svc.login("op", c.tempPassword, CTX);
    if (!login.ok) throw new Error("login failed");
    const r = await svc.adminRevokeSessions(c.user.id, actor, CTX);
    expect(r.ok).toBe(true);
    expect(await svc.resolveSession(login.token)).toBeNull();
    expect(store.auditLog.some((a) => a.action === "sessions_revoked")).toBe(true);
  });
});

describe("adminListUsers — never carries a password hash", () => {
  it("projects to UserSummary (no passwordHash key)", async () => {
    const { svc, actor } = await setup();
    await svc.adminCreateUser("op", "operator", actor, CTX);
    const list = await svc.adminListUsers();
    expect(list.length).toBe(2);
    for (const u of list) {
      expect(u).not.toHaveProperty("passwordHash");
      expect(u).toHaveProperty("createdAt");
    }
  });
});

describe("B2 — cache sweep on role change (no 60s stale window)", () => {
  it("a role change is authoritative on the immediate next resolve", async () => {
    const store = new MemoryStore();
    // Default cache TTL (60s) ON — the sweep, not TTL expiry, is what makes the
    // new role visible with no clock advance.
    let t = 1000;
    const svc = new AuthService(store, {
      hashParams: CHEAP,
      failureDelayMs: 0,
      bootstrapPassword: ADMIN_PW,
      now: () => t,
    });
    await svc.bootstrap();
    const admin = await store.getUserByUsername("admin");
    const actor: SessionInfo = {
      userId: admin!.id,
      username: "admin",
      role: "admin",
      mustChange: false,
    };
    const c = await svc.adminCreateUser("op", "operator", actor, CTX);
    if (!c.ok) throw new Error("create failed");
    const login = await svc.login("op", c.tempPassword, CTX);
    if (!login.ok) throw new Error("login failed");

    // Prime the cache with role=operator.
    expect((await svc.resolveSession(login.token))?.role).toBe("operator");
    // Demote to viewer, no clock advance.
    const r = await svc.adminSetRole(c.user.id, "viewer", actor, CTX);
    expect(r.ok).toBe(true);
    // Without the sweep this would still read "operator" for up to 60s.
    expect((await svc.resolveSession(login.token))?.role).toBe("viewer");
  });
});
