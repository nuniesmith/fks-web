// End-to-end composition of the auth pieces as the request hook wires them:
// AuthService (MemoryStore) → AuthState → routeRequest. This is the honest
// stand-in for the design's single Playwright spec (which needs a live
// Postgres): bootstrap → login → forced change → a mutating call that succeeds
// WITH a session and is denied WITHOUT one. Proves the fail-closed guard and the
// forced-change confinement at the seam, not just in isolation.

import { describe, expect, it } from "vitest";
import { AuthService } from "./service";
import { MemoryStore } from "./memoryStore";
import type { ScryptParams } from "./hash";
import { routeRequest, type AuthState } from "../adapter";

const CHEAP: ScryptParams = { N: 1 << 12, r: 8, p: 1, keyLen: 32 };
const CTX = { ip: "10.0.0.1", userAgent: "e2e" };
const MUTATION = "/api/spawner/bots/kill"; // representative armed-money write

// Mirror the hook: cookie token → AuthState.
async function stateFor(svc: AuthService, token: string): Promise<AuthState> {
  if (!(await svc.hasUsers())) return { mode: "bootstrap" };
  return { mode: "enabled", session: await svc.resolveSession(token) };
}

describe("auth seam — full lifecycle", () => {
  it("bootstrap → login → forced change → mutation gated throughout", async () => {
    let t = 1000;
    const store = new MemoryStore();
    const svc = new AuthService(store, {
      hashParams: CHEAP,
      failureDelayMs: 0,
      bootstrapPassword: "example-bootstrap-01",
      now: () => t,
    });
    await svc.init();
    const boot = await svc.bootstrap();
    expect(boot.created).toBe(true);

    // 1. No session → a mutating call is refused (401), pages bounce to /login.
    let auth = await stateFor(svc, "");
    expect(routeRequest(MUTATION, "", "POST", auth)).toEqual({ kind: "unauthorized" });
    expect(routeRequest("/bots", "", "GET", auth)).toMatchObject({ kind: "redirect" });

    // 2. Log in with the bootstrap credential → mustChange session.
    const login = await svc.login("admin", "example-bootstrap-01", CTX);
    expect(login).toMatchObject({ ok: true, mustChange: true });
    const token = login.ok ? login.token : "";

    // 3. mustChange confines the operator: mutation 403, app pages → /setup.
    auth = await stateFor(svc, token);
    expect(routeRequest(MUTATION, "", "POST", auth)).toEqual({ kind: "forbidden" });
    expect(routeRequest("/bots", "", "GET", auth)).toEqual({ kind: "redirect", location: "/setup" });
    expect(routeRequest("/setup", "", "GET", auth)).toEqual({ kind: "pass" });

    // 4. Rotate credentials (the /setup action).
    const adminId = (await store.getUserByUsername("admin"))!.id;
    const changed = await svc.changeCredentials(
      adminId,
      token,
      "jordan",
      "example-newpass-strong-01",
      CTX,
    );
    expect(changed.ok).toBe(true);

    // 5. SAME cookie now unlocks the app; the mutation is proxied to the backend.
    t += 61_000; // bust the 60s resolve cache
    auth = await stateFor(svc, token);
    expect((auth as { session: unknown }).session).toMatchObject({ mustChange: false });
    expect(routeRequest(MUTATION, "", "POST", auth)).toEqual({ kind: "backend" });
    expect(routeRequest("/bots", "", "GET", auth)).toEqual({ kind: "pass" });

    // 6. Logout revokes → the very same mutation is 401 again (fail closed).
    await svc.logout(token, CTX);
    t += 61_000;
    auth = await stateFor(svc, token);
    expect(routeRequest(MUTATION, "", "POST", auth)).toEqual({ kind: "unauthorized" });
  });
});
