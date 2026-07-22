// Invite logic (plan 01 Phase C) — driven against MemoryStore so every guarantee
// is pinned DB-free:
//   - token hygiene: the raw token is returned ONCE, only hashToken(it) is
//     stored, and it appears in NO audit row;
//   - no admin-by-invite: adminCreateInvite rejects 'admin' and garbage roles;
//   - previewInvite is coarse (valid/invalid only — no exists-vs-revoked oracle);
//   - claimInvite gives DISTINCT rejections (invalid/expired/revoked/redeemed/
//     taken/weak) and creates the invitee with the invite role + mustChange=FALSE;
//   - the acceptance pin: TWO CONCURRENT CLAIMS YIELD EXACTLY ONE USER.

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AuthService, INVITE_TTL_HOURS } from "./service";
import { MemoryStore } from "./memoryStore";
import type { ScryptParams } from "./hash";
import { hashToken } from "./tokens";
import type { SessionInfo } from "../adapter";

const CHEAP: ScryptParams = { N: 1 << 12, r: 8, p: 1, keyLen: 32 };
const CTX = { ip: "10.0.0.1", userAgent: "test" };
// Generated per run — no literal password-shaped strings in the tree.
const ADMIN_PW = `test-admin-${randomUUID().slice(0, 8)}`;
const newPw = () => `claimer-${randomUUID().slice(0, 12)}`;

async function setup() {
  const store = new MemoryStore();
  let clock = 1_700_000_000_000;
  const svc = new AuthService(store, {
    hashParams: CHEAP,
    failureDelayMs: 0,
    bootstrapPassword: ADMIN_PW,
    now: () => clock,
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
  return {
    store,
    svc,
    actor,
    advance: (ms: number) => (clock += ms),
    at: () => clock,
  };
}

async function mint(
  svc: AuthService,
  actor: SessionInfo,
  role = "operator",
  ttl = INVITE_TTL_HOURS,
): Promise<string> {
  const r = await svc.adminCreateInvite(role, ttl, actor, CTX);
  if (!r.ok) throw new Error(`mint failed: ${r.error}`);
  return r.token;
}

describe("adminCreateInvite — token hygiene + role restriction", () => {
  it("returns the raw token once, stores ONLY its hash, never audits the token", async () => {
    const { store, svc, actor } = await setup();
    const r = await svc.adminCreateInvite("operator", 48, actor, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The stored invite carries the HASH, never the raw token.
    const byHash = await store.getInviteByTokenHash(hashToken(r.token));
    expect(byHash).not.toBeNull();
    expect(byHash?.tokenHash).toBe(hashToken(r.token));
    expect(byHash?.tokenHash).not.toBe(r.token);
    expect(byHash?.role).toBe("operator");
    // No lookup by the RAW token succeeds (only the hash is persisted).
    expect(await store.getInviteByTokenHash(r.token)).toBeNull();
    // The audit row records role + expiry + actor, NEVER the token.
    const created = store.auditLog.find((a) => a.action === "invite_created");
    expect(created).toBeTruthy();
    expect(created?.detail).toContain("role=operator");
    expect(created?.detail).not.toContain(r.token);
    // The token appears in NO audit row at all.
    for (const a of store.auditLog) {
      expect(a.detail).not.toContain(r.token);
      expect(a.username).not.toContain(r.token);
    }
  });

  it("grants operator/viewer only — 'admin' and garbage are rejected 400", async () => {
    const { svc, actor } = await setup();
    for (const bad of ["admin", "root", "", "Operator", "viewer "]) {
      const r = await svc.adminCreateInvite(bad, 48, actor, CTX);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
    for (const good of ["operator", "viewer"]) {
      const r = await svc.adminCreateInvite(good, 48, actor, CTX);
      expect(r.ok).toBe(true);
    }
  });

  it("rejects a non-positive or absurd TTL", async () => {
    const { svc, actor } = await setup();
    for (const ttl of [0, -1, 24 * 31]) {
      const r = await svc.adminCreateInvite("viewer", ttl, actor, CTX);
      expect(r.ok).toBe(false);
    }
  });
});

describe("previewInvite — coarse, no oracle", () => {
  it("valid invite → {valid, role, expiresAt}", async () => {
    const { svc, actor } = await setup();
    const token = await mint(svc, actor, "viewer");
    const p = await svc.previewInvite(token);
    expect(p.valid).toBe(true);
    expect(p.role).toBe("viewer");
    expect(p.expiresAt).toBeInstanceOf(Date);
  });

  it("absent / expired / revoked / redeemed ALL collapse to the same invalid shape", async () => {
    const { svc, actor, advance } = await setup();
    // absent
    expect(await svc.previewInvite("nope")).toEqual({ valid: false, role: null, expiresAt: null });
    expect(await svc.previewInvite("")).toEqual({ valid: false, role: null, expiresAt: null });
    // expired
    const expiring = await mint(svc, actor, "operator", 1);
    advance(2 * 60 * 60 * 1000);
    expect(await svc.previewInvite(expiring)).toEqual({ valid: false, role: null, expiresAt: null });
  });

  it("revoked and redeemed previews are invalid + indistinguishable", async () => {
    const { store, svc, actor } = await setup();
    const revoked = await mint(svc, actor, "operator");
    const rInv = await store.getInviteByTokenHash(hashToken(revoked));
    await svc.adminRevokeInvite(rInv!.id, actor, CTX);
    expect(await svc.previewInvite(revoked)).toEqual({ valid: false, role: null, expiresAt: null });

    const redeemed = await mint(svc, actor, "viewer");
    const claim = await svc.claimInvite(redeemed, `zoe${randomUUID().slice(0, 6)}`, newPw(), CTX);
    expect(claim.ok).toBe(true);
    expect(await svc.previewInvite(redeemed)).toEqual({ valid: false, role: null, expiresAt: null });
  });
});

describe("claimInvite — happy path", () => {
  it("creates the invitee with the invite role + mustChange=FALSE, mints a session, audits", async () => {
    const { store, svc, actor } = await setup();
    const token = await mint(svc, actor, "operator");
    const uname = `friend${randomUUID().slice(0, 6)}`;
    const pw = newPw();
    const r = await svc.claimInvite(token, uname, pw, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.role).toBe("operator");

    const user = await store.getUserByUsername(uname);
    expect(user?.role).toBe("operator");
    expect(user?.mustChange).toBe(false); // invitee set their OWN creds

    // The returned session token resolves to that user (minted like login).
    const session = await svc.resolveSession(r.token);
    expect(session?.username).toBe(uname);
    expect(session?.mustChange).toBe(false);

    // The invitee can also log in with the creds they chose.
    const login = await svc.login(uname, pw, CTX);
    expect(login.ok).toBe(true);

    // Exactly one invite_redeemed audit, and it never carries the raw token.
    const redeemed = store.auditLog.filter((a) => a.action === "invite_redeemed");
    expect(redeemed).toHaveLength(1);
    expect(redeemed[0].detail).not.toContain(token);
    expect(redeemed[0].detail).not.toContain(r.token);
  });
});

describe("claimInvite — distinct rejections", () => {
  it("invalid / expired / revoked / redeemed / taken / weak each give a distinct error", async () => {
    const { store, svc, actor, advance } = await setup();

    // invalid token
    const invalid = await svc.claimInvite("bogus", `a${randomUUID().slice(0, 6)}`, newPw(), CTX);
    expect(invalid).toEqual({ ok: false, error: "This invite link is not valid." });

    // expired
    const exp = await mint(svc, actor, "viewer", 1);
    advance(2 * 60 * 60 * 1000);
    const expired = await svc.claimInvite(exp, `b${randomUUID().slice(0, 6)}`, newPw(), CTX);
    expect(expired).toEqual({ ok: false, error: "This invite link has expired." });

    // revoked
    const rev = await mint(svc, actor, "viewer");
    const revInv = await store.getInviteByTokenHash(hashToken(rev));
    await svc.adminRevokeInvite(revInv!.id, actor, CTX);
    const revoked = await svc.claimInvite(rev, `c${randomUUID().slice(0, 6)}`, newPw(), CTX);
    expect(revoked).toEqual({ ok: false, error: "This invite link has been revoked." });

    // redeemed (reuse)
    const once = await mint(svc, actor, "operator");
    const first = await svc.claimInvite(once, `d${randomUUID().slice(0, 6)}`, newPw(), CTX);
    expect(first.ok).toBe(true);
    const reuse = await svc.claimInvite(once, `e${randomUUID().slice(0, 6)}`, newPw(), CTX);
    expect(reuse).toEqual({ ok: false, error: "This invite link has already been used." });

    // taken username
    const taken = await mint(svc, actor, "viewer");
    const dupe = await svc.claimInvite(taken, "admin", newPw(), CTX);
    expect(dupe).toEqual({ ok: false, error: "That username is taken." });

    // weak password (validateNewCredentials) — a DIFFERENT error string
    const weakTok = await mint(svc, actor, "viewer");
    const weak = await svc.claimInvite(weakTok, `f${randomUUID().slice(0, 6)}`, "short", CTX);
    expect(weak.ok).toBe(false);
    if (!weak.ok) {
      expect(weak.error).not.toBe("This invite link is not valid.");
      expect(weak.error.toLowerCase()).toContain("password");
    }
  });
});

describe("claimInvite — concurrency: two claims yield EXACTLY ONE user (the pin)", () => {
  it("only one concurrent claim wins the atomic redeem; the loser is rolled back", async () => {
    const { store, svc, actor } = await setup();
    const token = await mint(svc, actor, "operator");

    // Interleave both claims at the redeem point: the first to arrive parks
    // until the second reaches redeem, then both race the conditional write.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let entered = 0;
    store.onRedeemInvite = async () => {
      entered += 1;
      if (entered === 1) await gate; // first parks
      else release(); // second unparks the first; now they race
    };

    const uA = `raceA${randomUUID().slice(0, 6)}`;
    const uB = `raceB${randomUUID().slice(0, 6)}`;
    const [a, b] = await Promise.all([
      svc.claimInvite(token, uA, newPw(), CTX),
      svc.claimInvite(token, uB, newPw(), CTX),
    ]);

    // Exactly one ok, exactly one "already used".
    const oks = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as { error: string }).error).toBe(
      "This invite link has already been used.",
    );

    // EXACTLY ONE user was created from the invite (admin + one invitee = 2).
    expect(await store.countUsers()).toBe(2);
    // Only the two race usernames — exactly one survives.
    const survivedA = await store.getUserByUsername(uA);
    const survivedB = await store.getUserByUsername(uB);
    expect([survivedA, survivedB].filter(Boolean)).toHaveLength(1);

    // The winner's session resolves; exactly one invite_redeemed audit exists.
    const winner = (oks[0] as { token: string }).token;
    expect(await svc.resolveSession(winner)).not.toBeNull();
    expect(store.auditLog.filter((x) => x.action === "invite_redeemed")).toHaveLength(1);
  });
});

describe("adminListInvites — derived status", () => {
  it("reports active / expired / redeemed / revoked and the creator username", async () => {
    const { store, svc, actor, advance } = await setup();
    const active = await mint(svc, actor, "operator");
    const toExpire = await mint(svc, actor, "viewer", 1);
    const toRedeem = await mint(svc, actor, "operator");
    const toRevoke = await mint(svc, actor, "viewer");

    await svc.claimInvite(toRedeem, `g${randomUUID().slice(0, 6)}`, newPw(), CTX);
    const revInv = await store.getInviteByTokenHash(hashToken(toRevoke));
    await svc.adminRevokeInvite(revInv!.id, actor, CTX);
    advance(2 * 60 * 60 * 1000); // expire the 1h one (active is 48h, still active)

    const list = await svc.adminListInvites();
    const statuses = list.map((i) => i.status).sort();
    expect(statuses).toEqual(["active", "expired", "redeemed", "revoked"]);
    for (const i of list) expect(i.createdBy).toBe("admin");
    // active is the 48h invite → still valid after +2h.
    const activeInv = await store.getInviteByTokenHash(hashToken(active));
    expect(list.find((i) => i.id === activeInv!.id)?.status).toBe("active");
  });
});
