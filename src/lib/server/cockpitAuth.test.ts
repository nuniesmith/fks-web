// The cockpit routes sit on backend prefixes, so the #47 seam gates them:
// this pins that the KILL mutation (and the reads) can never reach the
// handler without a valid, fully-rotated session — the money-critical
// property "the kill button is session-gated" — at the same pure decision
// core the hook executes (routeRequest), mirroring the auth integration test.

import { describe, expect, it } from "vitest";
import { routeRequest, type AuthState } from "./adapter";

const KILL = "/api/cockpit/kill";
const REARM = "/api/cockpit/rearm";
const STATE = "/api/cockpit/state";
const TELEMETRY = "/api/cockpit/telemetry";

const enabledNoSession: AuthState = { mode: "enabled", session: null };
const fullSession: AuthState = {
  mode: "enabled",
  session: { userId: 1, username: "jordan", role: "admin", mustChange: false },
};
const mustChange: AuthState = {
  mode: "enabled",
  session: { userId: 1, username: "admin", role: "admin", mustChange: true },
};

describe("cockpit routes behind the auth seam", () => {
  it("kill/re-arm POST without a session → 401, never dispatched", () => {
    expect(routeRequest(KILL, "", "POST", enabledNoSession)).toEqual({ kind: "unauthorized" });
    expect(routeRequest(REARM, "", "POST", enabledNoSession)).toEqual({ kind: "unauthorized" });
  });

  it("reads are gated too (fail-closed: state/telemetry need a session)", () => {
    expect(routeRequest(STATE, "", "GET", enabledNoSession)).toEqual({ kind: "unauthorized" });
    expect(routeRequest(TELEMETRY, "", "GET", enabledNoSession)).toEqual({ kind: "unauthorized" });
  });

  it("bootstrap mode (no users yet) denies the kill mutation", () => {
    const bootstrap: AuthState = { mode: "bootstrap" };
    expect(routeRequest(KILL, "", "POST", bootstrap)).toEqual({
      kind: "unauthorized",
      // First-run refusal, not an expired session — see adapter.ts. The KILL is
      // still refused either way; only the message the operator gets changes.
      reason: "bootstrap",
    });
  });

  it("an unrotated bootstrap credential (mustChange) cannot fire the kill", () => {
    expect(routeRequest(KILL, "", "POST", mustChange)).toEqual({ kind: "forbidden" });
  });

  it("a full session reaches the backend dispatcher", () => {
    expect(routeRequest(KILL, "", "POST", fullSession)).toEqual({ kind: "backend" });
    expect(routeRequest(STATE, "", "GET", fullSession)).toEqual({ kind: "backend" });
  });

  it("WEBUI_AUTH=disabled still refuses the kill/re-arm mutations — the dev bypass must never arm an unauthenticated live-money halt", () => {
    // In disabled mode routeRequest passes ALL backend traffic, and the CSRF
    // origin check accepts requests with no Origin header — so without this
    // carve-out a bare `curl -XPOST .../api/cockpit/kill` from anything that
    // can reach the socket would halt (or worse, RE-ARM) real money.
    const disabled: AuthState = { mode: "disabled" };
    expect(routeRequest(KILL, "", "POST", disabled)).toEqual({
      kind: "forbidden",
      reason: "live_mutation_requires_auth",
    });
    expect(routeRequest(REARM, "", "POST", disabled)).toEqual({
      kind: "forbidden",
      reason: "live_mutation_requires_auth",
    });
    // Reads keep today's disabled-mode behaviour (this is a mutation-only wall).
    expect(routeRequest(STATE, "", "GET", disabled)).toEqual({ kind: "backend" });
    expect(routeRequest(TELEMETRY, "", "GET", disabled)).toEqual({ kind: "backend" });
    // Other backend mutations are unchanged in disabled mode.
    expect(routeRequest("/api/spawner/x", "", "POST", disabled)).toEqual({ kind: "backend" });
  });
});
