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
    expect(routeRequest(KILL, "", "POST", bootstrap)).toEqual({ kind: "unauthorized" });
  });

  it("an unrotated bootstrap credential (mustChange) cannot fire the kill", () => {
    expect(routeRequest(KILL, "", "POST", mustChange)).toEqual({ kind: "forbidden" });
  });

  it("a full session reaches the backend dispatcher", () => {
    expect(routeRequest(KILL, "", "POST", fullSession)).toEqual({ kind: "backend" });
    expect(routeRequest(STATE, "", "GET", fullSession)).toEqual({ kind: "backend" });
  });
});
