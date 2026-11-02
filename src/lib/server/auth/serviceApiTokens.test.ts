// Personal access tokens (API v1, EDGE_FACTORY_PLAN §7.2), driven against
// MemoryStore so every guarantee is pinned DB-free:
//   - the raw token is returned ONCE, only hashToken(it) is stored, and it
//     appears in NO audit row;
//   - no admin tokens, and a cap above the minter's own role is refused;
//   - effective role = min(owner's CURRENT role, cap): demoting the owner
//     demotes the token;
//   - a revoked or expired token, a disabled owner, or an owner still on the
//     bootstrap credential resolves to nothing;
//   - a missing table (fks 027 not applied) turns tokens off, nothing more.

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { API_TOKEN_TOUCH_MS, AuthService, minRole } from "./service";
import { MemoryStore } from "./memoryStore";
import type { ScryptParams } from "./hash";
import { hashToken, looksLikeApiToken } from "./tokens";
import type { SessionInfo } from "../adapter";

const CHEAP: ScryptParams = { N: 1 << 12, r: 8, p: 1, keyLen: 32 };
const CTX = { ip: "10.0.0.1", userAgent: "test" };
const DAY = 24 * 60 * 60 * 1000;

async function setup(opts: { cacheTtlMs?: number } = {}) {
  const store = new MemoryStore();
  let clock = 1_700_000_000_000;
  const svc = new AuthService(store, {
    hashParams: CHEAP,
    failureDelayMs: 0,
    bootstrapPassword: `test-admin-${randomUUID().slice(0, 8)}`,
    now: () => clock,
    cacheTtlMs: opts.cacheTtlMs ?? 0,
  });
  await svc.bootstrap();
  const admin = await store.getUserByUsername("admin");
  if (!admin) throw new Error("bootstrap failed");
  // Past /setup: a token of a user still on the bootstrap credential is dead.
  await store.updateCredentials(admin.id, "admin", admin.passwordHash);
  const actor: SessionInfo = {
    userId: admin.id,
    username: "admin",
    role: "admin",
    mustChange: false,
  };
  return { store, svc, actor, advance: (ms: number) => (clock += ms) };
}

async function mint(svc: AuthService, actor: SessionInfo, role = "viewer", ttlDays = 30) {
  const r = await svc.createApiToken(actor, "agent", role, ttlDays, CTX);
  if (!r.ok) throw new Error(`mint failed: ${r.error}`);
  return r;
}

describe("minting", () => {
  it("returns a fks_pat_ token once and stores only its hash", async () => {
    const { store, svc, actor } = await setup();
    const { token, apiToken } = await mint(svc, actor);
    expect(looksLikeApiToken(token)).toBe(true);
    expect(await store.getApiTokenByHash(hashToken(token))).not.toBeNull();
    expect(JSON.stringify(await svc.listApiTokens(actor))).not.toContain(token);
    expect(JSON.stringify(store.auditLog)).not.toContain(token);
    expect(store.auditLog.at(-1)).toMatchObject({ action: "api_token_created" });
    expect(apiToken).not.toHaveProperty("tokenHash");
  });

  it("refuses admin tokens, a cap above the minter, bad names and lifetimes", async () => {
    const { svc, actor } = await setup();
    expect(await svc.createApiToken(actor, "x", "admin", 30, CTX)).toMatchObject({ ok: false, status: 400 });
    const viewer = { ...actor, role: "viewer" };
    expect(await svc.createApiToken(viewer, "x", "operator", 30, CTX)).toMatchObject({ ok: false, status: 403 });
    expect(await svc.createApiToken(actor, "  ", "viewer", 30, CTX)).toMatchObject({ ok: false, status: 400 });
    expect(await svc.createApiToken(actor, "x", "viewer", 3650, CTX)).toMatchObject({ ok: false, status: 400 });
  });
});

describe("resolving", () => {
  it("acts as the owner, marked as a token, at min(role, cap)", async () => {
    const { svc, actor } = await setup();
    const { token, apiToken } = await mint(svc, actor, "operator");
    expect(await svc.resolveApiToken(token)).toEqual({
      userId: actor.userId,
      username: "admin",
      role: "operator",
      mustChange: false,
      via: "token",
      tokenId: apiToken.id,
    });
  });

  it("follows the owner's CURRENT role: a demoted owner demotes the token", async () => {
    const { store, svc, actor } = await setup();
    const { token } = await mint(svc, actor, "operator");
    await store.setUserRole(actor.userId, "viewer");
    expect((await svc.resolveApiToken(token))?.role).toBe("viewer");
  });

  it("is dead when revoked, expired, its owner is disabled, or garbage", async () => {
    const { store, svc, actor, advance } = await setup();
    const a = await mint(svc, actor, "viewer", 7);
    const b = await mint(svc, actor);
    const c = await mint(svc, actor);

    expect(await svc.revokeApiToken(actor, b.apiToken.id, CTX)).toEqual({ ok: true });
    expect(await svc.resolveApiToken(b.token)).toBeNull();

    advance(7 * DAY);
    expect(await svc.resolveApiToken(a.token)).toBeNull();
    expect((await svc.listApiTokens(actor)).find((t) => t.id === a.apiToken.id)?.status).toBe("expired");

    await store.setUserDisabled(actor.userId, true);
    expect(await svc.resolveApiToken(c.token)).toBeNull();

    expect(await svc.resolveApiToken("fks_pat_short")).toBeNull();
    expect(await svc.resolveApiToken("")).toBeNull();
  });

  it("a revoke takes effect at once even with the cache on", async () => {
    const { svc, actor } = await setup({ cacheTtlMs: 60_000 });
    const { token, apiToken } = await mint(svc, actor);
    expect(await svc.resolveApiToken(token)).not.toBeNull();
    await svc.revokeApiToken(actor, apiToken.id, CTX);
    expect(await svc.resolveApiToken(token)).toBeNull();
  });

  it("only the owner can revoke, and only once", async () => {
    const { svc, actor } = await setup();
    const { apiToken } = await mint(svc, actor);
    const other = { ...actor, userId: actor.userId + 99 };
    expect(await svc.revokeApiToken(other, apiToken.id, CTX)).toMatchObject({ ok: false, status: 404 });
    expect(await svc.revokeApiToken(actor, apiToken.id, CTX)).toEqual({ ok: true });
    expect(await svc.revokeApiToken(actor, apiToken.id, CTX)).toMatchObject({ ok: false, status: 404 });
  });

  it("writes last_used_at at most once a minute", async () => {
    const { store, svc, actor, advance } = await setup();
    const { token } = await mint(svc, actor);
    let touches = 0;
    const touch = store.touchApiToken.bind(store);
    store.touchApiToken = async (id, at) => {
      touches++;
      await touch(id, at);
    };
    await svc.resolveApiToken(token);
    await svc.resolveApiToken(token);
    expect(touches).toBe(1);
    advance(API_TOKEN_TOUCH_MS);
    await svc.resolveApiToken(token);
    expect(touches).toBe(2);
  });
});

describe("without the table (fks 027 not applied)", () => {
  it("tokens are off: none resolve and none can be minted", async () => {
    const { store, svc, actor } = await setup();
    const { token } = await mint(svc, actor);
    store.tokensTablePresent = false;
    expect(svc.apiTokensAvailable()).toBe(false);
    expect(await svc.resolveApiToken(token)).toBeNull();
    expect(await svc.createApiToken(actor, "x", "viewer", 30, CTX)).toMatchObject({ ok: false, status: 503 });
  });
});

describe("minRole", () => {
  it("is the lower rank; unknown roles count as viewer", () => {
    expect(minRole("admin", "operator")).toBe("operator");
    expect(minRole("operator", "admin")).toBe("operator");
    expect(minRole("viewer", "operator")).toBe("viewer");
    expect(minRole("garbage", "operator")).toBe("viewer");
  });
});
