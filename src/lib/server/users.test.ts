// `/api/users` handler-level tests — driven with a MemoryStore-backed service
// injected (cockpit-test style), so the seam's defense-in-depth + the
// temp-password-exactly-once contract are pinned without a live Postgres:
//   - no auth / operator / mustChange-admin / WEBUI_AUTH=disabled → 403;
//   - admin GET lists (secret-free), admin POST creates;
//   - tempPassword appears in the create + reset responses and NOWHERE else.

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { usersDispatch } from "./users";
import { AuthService } from "./auth/service";
import { MemoryStore } from "./auth/memoryStore";
import type { ScryptParams } from "./auth/hash";
import type { AuthState, SessionInfo } from "./adapter";

const CHEAP: ScryptParams = { N: 1 << 12, r: 8, p: 1, keyLen: 32 };
const CTX = { ip: "10.0.0.1", userAgent: "test" };

async function harness() {
  const store = new MemoryStore();
  const svc = new AuthService(store, {
    hashParams: CHEAP,
    failureDelayMs: 0,
    bootstrapPassword: `test-bootstrap-${randomUUID().slice(0, 8)}`,
  });
  await svc.bootstrap();
  const admin = await store.getUserByUsername("admin");
  const adminSession: SessionInfo = {
    userId: admin!.id,
    username: "admin",
    role: "admin",
    mustChange: false,
  };
  const getService = async () => svc;
  return { store, svc, adminSession, getService };
}

const adminAuth = (s: SessionInfo): AuthState => ({ mode: "enabled", session: s });

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://x${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("defense in depth — non-admins are refused at the dispatch", () => {
  it("undefined auth (outage path) → 403 admin_required, service never resolved", async () => {
    let touched = false;
    const throwingGetService = async (): Promise<never> => {
      touched = true;
      throw new Error("store must not be touched on the unauthenticated path");
    };
    const res = await usersDispatch(
      req("GET", "/api/users"),
      "/api/users",
      undefined,
      CTX,
      throwingGetService as never,
    );
    expect(res.status).toBe(403);
    expect(touched).toBe(false);
  });

  it("operator session → 403", async () => {
    const { getService } = await harness();
    const op: SessionInfo = { userId: 5, username: "op", role: "operator", mustChange: false };
    const res = await usersDispatch(req("GET", "/api/users"), "/api/users", adminAuth(op), CTX, getService);
    expect(res.status).toBe(403);
  });

  it("mustChange admin → 403 (confined to /setup)", async () => {
    const { adminSession, getService } = await harness();
    const mc = { ...adminSession, mustChange: true };
    const res = await usersDispatch(req("GET", "/api/users"), "/api/users", adminAuth(mc), CTX, getService);
    expect(res.status).toBe(403);
  });

  it("WEBUI_AUTH=disabled → 403 user_management_requires_auth", async () => {
    const { getService } = await harness();
    const res = await usersDispatch(req("GET", "/api/users"), "/api/users", { mode: "disabled" }, CTX, getService);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("user_management_requires_auth");
  });
});

describe("admin flow", () => {
  it("GET lists users with no secret fields", async () => {
    const { adminSession, getService } = await harness();
    const res = await usersDispatch(req("GET", "/api/users"), "/api/users", adminAuth(adminSession), CTX, getService);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.users[0]).not.toHaveProperty("passwordHash");
    expect(body.users[0]).not.toHaveProperty("password_hash");
    expect(body.users[0]).not.toHaveProperty("tempPassword");
  });

  it("POST create returns the temp password exactly once; it is absent elsewhere", async () => {
    const { adminSession, getService, store } = await harness();
    const create = await usersDispatch(
      req("POST", "/api/users", { username: "friend", role: "operator" }),
      "/api/users",
      adminAuth(adminSession),
      CTX,
      getService,
    );
    expect(create.status).toBe(200);
    const created = await create.json();
    expect(created.ok).toBe(true);
    expect(typeof created.tempPassword).toBe("string");
    expect(created.tempPassword.length).toBeGreaterThan(0);
    const tempPw = created.tempPassword as string;
    const newId = created.user.id as number;

    // The list NEVER echoes the temp password back.
    const listRes = await usersDispatch(req("GET", "/api/users"), "/api/users", adminAuth(adminSession), CTX, getService);
    const listBody = await listRes.text();
    expect(listBody).not.toContain(tempPw);

    // Disable/enable/role/revoke responses carry NO tempPassword.
    for (const path of [
      `/api/users/${newId}/disable`,
      `/api/users/${newId}/enable`,
      `/api/users/${newId}/revoke-sessions`,
    ]) {
      const r = await usersDispatch(req("POST", path), path, adminAuth(adminSession), CTX, getService);
      expect(r.status).toBe(200);
      const b = await r.json();
      expect(b).not.toHaveProperty("tempPassword");
    }

    const roleRes = await usersDispatch(
      req("POST", `/api/users/${newId}/role`, { role: "viewer" }),
      `/api/users/${newId}/role`,
      adminAuth(adminSession),
      CTX,
      getService,
    );
    expect(roleRes.status).toBe(200);
    expect(await roleRes.json()).not.toHaveProperty("tempPassword");

    // Reset DOES return a fresh temp password (the only other place it appears).
    const resetRes = await usersDispatch(
      req("POST", `/api/users/${newId}/reset-password`),
      `/api/users/${newId}/reset-password`,
      adminAuth(adminSession),
      CTX,
      getService,
    );
    expect(resetRes.status).toBe(200);
    const resetBody = await resetRes.json();
    expect(typeof resetBody.tempPassword).toBe("string");
    expect(resetBody.tempPassword).not.toBe(tempPw);

    // No temp password ever reached the audit trail.
    expect(JSON.stringify(store.auditLog)).not.toContain(tempPw);
    expect(JSON.stringify(store.auditLog)).not.toContain(resetBody.tempPassword);
  });

  it("create duplicate → 409, invalid role → 400", async () => {
    const { adminSession, getService } = await harness();
    await usersDispatch(
      req("POST", "/api/users", { username: "dup", role: "viewer" }),
      "/api/users",
      adminAuth(adminSession),
      CTX,
      getService,
    );
    const dup = await usersDispatch(
      req("POST", "/api/users", { username: "DUP", role: "viewer" }),
      "/api/users",
      adminAuth(adminSession),
      CTX,
      getService,
    );
    expect(dup.status).toBe(409);
    const bad = await usersDispatch(
      req("POST", "/api/users", { username: "x", role: "root" }),
      "/api/users",
      adminAuth(adminSession),
      CTX,
      getService,
    );
    expect(bad.status).toBe(400);
  });

  it("unknown subpath → 404, wrong method → 405", async () => {
    const { adminSession, getService } = await harness();
    const nf = await usersDispatch(req("POST", "/api/users/1/nuke"), "/api/users/1/nuke", adminAuth(adminSession), CTX, getService);
    expect(nf.status).toBe(404);
    const na = await usersDispatch(req("DELETE", "/api/users"), "/api/users", adminAuth(adminSession), CTX, getService);
    expect(na.status).toBe(405);
  });
});
