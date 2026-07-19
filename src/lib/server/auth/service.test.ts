import { beforeEach, describe, expect, it } from "vitest";
import { AuthService, DUMMY_HASH } from "./service";
import { MemoryStore } from "./memoryStore";
import { DEFAULT_SCRYPT, type ScryptParams } from "./hash";
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from "./policy";

const CHEAP: ScryptParams = { N: 1 << 12, r: 8, p: 1, keyLen: 32 };
const CTX = { ip: "10.0.0.1", userAgent: "test" };

function makeService(store: MemoryStore, now?: () => number) {
  return new AuthService(store, {
    hashParams: CHEAP,
    failureDelayMs: 0, // keep the suite fast; production keeps 300ms
    now,
  });
}

describe("bootstrap", () => {
  it("creates exactly one admin with a random 24+ char password, once", async () => {
    const store = new MemoryStore();
    const svc = makeService(store);

    const first = await svc.bootstrap();
    expect(first.created).toBe(true);
    expect(first.fromEnv).toBe(false);
    expect(first.password!.length).toBeGreaterThanOrEqual(24);
    expect(await store.countUsers()).toBe(1);

    // Idempotent: a second bootstrap is a no-op, no new user, no password.
    const second = await svc.bootstrap();
    expect(second.created).toBe(false);
    expect(second.password).toBeUndefined();
    expect(await store.countUsers()).toBe(1);

    // The created admin must rotate its credential before use.
    const admin = await store.getUserByUsername("admin");
    expect(admin?.mustChange).toBe(true);
    expect(admin?.role).toBe("admin");
    // The bootstrap password is never persisted in plaintext.
    expect(admin?.passwordHash).not.toContain(first.password!);
  });

  it("two independent bootstraps generate DIFFERENT random passwords", async () => {
    const a = await makeService(new MemoryStore()).bootstrap();
    const b = await makeService(new MemoryStore()).bootstrap();
    expect(a.password).not.toBe(b.password);
  });

  it("uses WEBUI_BOOTSTRAP_PASSWORD when provided, without printing it", async () => {
    const store = new MemoryStore();
    const svc = new AuthService(store, {
      hashParams: CHEAP,
      bootstrapPassword: "example-operator-01",
    });
    const r = await svc.bootstrap();
    expect(r.created).toBe(true);
    expect(r.fromEnv).toBe(true);
    expect(r.password).toBeUndefined(); // env-provided → not echoed to logs
  });
});

// REGRESSION: a fresh DB must never carry a usable known/default credential.
describe("fresh-DB has no usable default credential", () => {
  it("cannot log in with any guessable default before/after bootstrap", async () => {
    const store = new MemoryStore();
    const svc = makeService(store);

    // Before bootstrap: no users at all.
    expect(await svc.login("admin", "admin", CTX)).toMatchObject({ ok: false });

    await svc.bootstrap();

    // After bootstrap: the well-known guesses must all fail.
    for (const guess of ["nomatch-alpha", "nomatch-bravo", "nomatch-charlie", "nomatch-delta", ""]) {
      expect(await svc.login("admin", guess, CTX)).toMatchObject({ ok: false });
    }
  });
});

describe("login — scrypt verify + wrong-password reject + lockout", () => {
  let store: MemoryStore;
  let svc: AuthService;
  const PW = "example-operator-01";

  beforeEach(async () => {
    store = new MemoryStore();
    svc = new AuthService(store, {
      hashParams: CHEAP,
      failureDelayMs: 0,
      bootstrapPassword: PW,
    });
    await svc.bootstrap();
  });

  it("accepts the correct password and returns a session token + mustChange", async () => {
    const r = await svc.login("admin", PW, CTX);
    expect(r).toMatchObject({ ok: true, mustChange: true });
    if (r.ok) expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects a wrong password", async () => {
    expect(await svc.login("admin", "wrong-password-x", CTX)).toMatchObject({ ok: false });
  });

  it("is case-insensitive on username but exact on password", async () => {
    expect(await svc.login("ADMIN", PW, CTX)).toMatchObject({ ok: true });
    expect(await svc.login("admin", PW.toUpperCase(), CTX)).toMatchObject({ ok: false });
  });

  it("locks the account after 10 failures and blocks even the correct password", async () => {
    for (let i = 0; i < 10; i++) {
      await svc.login("admin", "nope-nope-nope", CTX);
    }
    const locked = await svc.login("admin", PW, CTX);
    expect(locked).toMatchObject({ ok: false, locked: true });

    const user = await store.getUserByUsername("admin");
    expect(user?.lockedUntil).toBeInstanceOf(Date);
    // Audit trail recorded the lockout.
    expect(store.auditLog.some((a) => a.action === "lockout")).toBe(true);
  });

  it("a successful login resets the failure counter", async () => {
    await svc.login("admin", "nope-nope-nope", CTX);
    await svc.login("admin", "nope-nope-nope", CTX);
    await svc.login("admin", PW, CTX);
    const user = await store.getUserByUsername("admin");
    expect(user?.failedLogins).toBe(0);
    expect(user?.lockedUntil).toBeNull();
  });
});

// REGRESSION: the unknown-user timing-equalisation path must burn the SAME
// scrypt work as a real stored hash, else its cheaper cost is a
// username-enumeration oracle. DUMMY_HASH's params must track DEFAULT_SCRYPT.
describe("unknown-user dummy hash has full production cost (no timing oracle)", () => {
  it("DUMMY_HASH uses the same scrypt params as DEFAULT_SCRYPT", () => {
    const m = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$/.exec(DUMMY_HASH);
    expect(m).not.toBeNull();
    const [, ln, r, p] = m!;
    expect(Number(ln)).toBe(Math.log2(DEFAULT_SCRYPT.N)); // 17, NOT the old 14
    expect(Number(r)).toBe(DEFAULT_SCRYPT.r);
    expect(Number(p)).toBe(DEFAULT_SCRYPT.p);
  });
});

describe("locked-account path is not a fast-path timing oracle", () => {
  it("applies the failure delay before answering a locked login", async () => {
    let t = 1000;
    const store = new MemoryStore();
    const svc = new AuthService(store, {
      hashParams: CHEAP,
      failureDelayMs: 40, // measurable but fast
      bootstrapPassword: "example-bootstrap-01",
      now: () => t,
    });
    await svc.bootstrap();
    // Drive the account into a lock.
    for (let i = 0; i < 10; i++) await svc.login("admin", "nope-nope-nope", { ip: "x", userAgent: "t" });

    const start = Date.now();
    const locked = await svc.login("admin", "example-bootstrap-01", { ip: "x", userAgent: "t" });
    const elapsed = Date.now() - start;
    expect(locked).toMatchObject({ ok: false, locked: true });
    // The locked branch used to return near-instantly with NO delay; it now
    // burns the same failure delay as the wrong-password branch.
    expect(elapsed).toBeGreaterThanOrEqual(35);
  });
});

// REGRESSION: with the resolve cache DISABLED (cacheTtlMs=0 — the multi-replica
// posture), a logout/revocation must be authoritative on the very next resolve,
// not survive a 60s per-process cache window.
describe("cache disabled — revocation is immediate (no per-process TTL window)", () => {
  it("logout is visible on the next resolveSession with no clock advance", async () => {
    let t = 1000;
    const store = new MemoryStore();
    const svc = new AuthService(store, {
      hashParams: CHEAP,
      failureDelayMs: 0,
      bootstrapPassword: "example-bootstrap-01",
      cacheTtlMs: 0,
      now: () => t,
    });
    await svc.bootstrap();
    const r = await svc.login("admin", "example-bootstrap-01", { ip: "x", userAgent: "t" });
    if (!r.ok) throw new Error("login failed");
    expect(await svc.resolveSession(r.token)).not.toBeNull();
    await svc.logout(r.token, { ip: "x", userAgent: "t" });
    // No time advance at all — with caching this would still resolve for 60s.
    expect(await svc.resolveSession(r.token)).toBeNull();
  });
});

describe("sessions — issue / validate / revoke / expire", () => {
  const PW = "example-operator-01";

  async function loggedIn(now: () => number) {
    const store = new MemoryStore();
    const svc = new AuthService(store, {
      hashParams: CHEAP,
      failureDelayMs: 0,
      bootstrapPassword: PW,
      now,
    });
    await svc.bootstrap();
    const r = await svc.login("admin", PW, CTX);
    if (!r.ok) throw new Error("login failed");
    return { store, svc, token: r.token };
  }

  it("validates a freshly-issued token", async () => {
    const { svc, token } = await loggedIn(() => 1000);
    const info = await svc.resolveSession(token);
    expect(info).toMatchObject({ username: "admin", role: "admin", mustChange: true });
  });

  it("rejects a garbage / empty token", async () => {
    const { svc } = await loggedIn(() => 1000);
    expect(await svc.resolveSession("")).toBeNull();
    expect(await svc.resolveSession("not-a-real-token")).toBeNull();
  });

  it("logout revokes the session server-side (real revocation)", async () => {
    let t = 1000;
    const { svc, token } = await loggedIn(() => t);
    expect(await svc.resolveSession(token)).not.toBeNull();
    await svc.logout(token, CTX);
    // Past the 60s cache window → the revoked session is gone.
    t += 61_000;
    expect(await svc.resolveSession(token)).toBeNull();
  });

  it("expires past the absolute cap", async () => {
    let t = 1000;
    const { svc, token } = await loggedIn(() => t);
    t = 1000 + SESSION_ABSOLUTE_MS + 1;
    expect(await svc.resolveSession(token)).toBeNull();
  });

  it("expires after the idle window without use", async () => {
    let t = 1000;
    const { svc, token } = await loggedIn(() => t);
    // Jump just past idle but well within absolute — no intervening request.
    t = 1000 + SESSION_IDLE_MS + 1;
    expect(await svc.resolveSession(token)).toBeNull();
  });

  it("slides the idle window on use", async () => {
    let t = 1000;
    const { svc, token } = await loggedIn(() => t);
    // Use it near the idle edge → window slides forward.
    t = 1000 + SESSION_IDLE_MS - 1000;
    expect(await svc.resolveSession(token)).not.toBeNull();
    // Jump past the ORIGINAL idle expiry (and past the 60s resolve cache so this
    // is a real DB re-check, not a cache hit). The slide must have kept it alive.
    t = 1000 + SESSION_IDLE_MS + 100_000;
    expect(await svc.resolveSession(token)).not.toBeNull();
  });
});

describe("forced credential change", () => {
  const PW = "example-bootstrap-01";
  let store: MemoryStore;
  let svc: AuthService;
  let token: string;
  let t = 1000;

  beforeEach(async () => {
    t = 1000;
    store = new MemoryStore();
    svc = new AuthService(store, {
      hashParams: CHEAP,
      failureDelayMs: 0,
      bootstrapPassword: PW,
      now: () => t,
    });
    await svc.bootstrap();
    const r = await svc.login("admin", PW, CTX);
    if (!r.ok) throw new Error("login failed");
    token = r.token;
  });

  it("rejects a weak new password, one equal to username, or equal to current", async () => {
    expect((await svc.changeCredentials(1, token, "jordan", "short", CTX)).ok).toBe(false);
    expect((await svc.changeCredentials(1, token, "jordan", "jordan", CTX)).ok).toBe(false);
    expect((await svc.changeCredentials(1, token, "jordan", PW, CTX)).ok).toBe(false);
    // The account is still locked to mustChange after every rejection.
    const info = await svc.resolveSession(token);
    expect(info?.mustChange).toBe(true);
  });

  it("rotates username+password, clears mustChange, and keeps the caller's session", async () => {
    const r = await svc.changeCredentials(1, token, "jordan", "example-newpass-strong-01", CTX);
    expect(r.ok).toBe(true);

    // Same cookie now resolves as a full (non-mustChange) session — no re-login.
    const info = await svc.resolveSession(token);
    expect(info).toMatchObject({ username: "jordan", mustChange: false });

    // The old bootstrap credential no longer works; the new one does.
    expect(await svc.login("admin", PW, CTX)).toMatchObject({ ok: false });
    expect(await svc.login("jordan", "example-newpass-strong-01", CTX)).toMatchObject({ ok: true });
    expect(store.auditLog.some((a) => a.action === "credential_change")).toBe(true);
  });

  it("revokes all OTHER sessions on change (keeps only the caller's)", async () => {
    // A second device logs in with the bootstrap credential.
    const other = await svc.login("admin", PW, CTX);
    if (!other.ok) throw new Error("second login failed");

    await svc.changeCredentials(1, token, "jordan", "example-newpass-strong-01", CTX);

    t += 61_000; // clear the resolve cache for both tokens
    expect(await svc.resolveSession(token)).not.toBeNull(); // caller kept
    expect(await svc.resolveSession(other.token)).toBeNull(); // other revoked
  });
});
