// Auth pins for the alert-ack routes at the same pure decision core the hook
// runs (routeRequest), mirroring cockpitAuth.test.ts. An ack silences an
// armed-path page, so the money-critical property is "the ack button is
// session-gated AND the disabled dev bypass can never fire it".

import { describe, expect, it } from "vitest";
import { AUTH_DISABLED_BLOCKED_MUTATIONS, routeRequest, type AuthState } from "./adapter";

const ACK = "/api/alerts/ack";
const INBOX = "/api/alerts/inbox";

const enabledNoSession: AuthState = { mode: "enabled", session: null };
const operator: AuthState = {
  mode: "enabled",
  session: { userId: 2, username: "jordan", role: "operator", mustChange: false },
};
const viewer: AuthState = {
  mode: "enabled",
  session: { userId: 3, username: "reader", role: "viewer", mustChange: false },
};

describe("alert-ack routes behind the auth seam", () => {
  it("the ack path is in AUTH_DISABLED_BLOCKED_MUTATIONS (OD-3)", () => {
    expect(AUTH_DISABLED_BLOCKED_MUTATIONS).toContain(ACK);
  });

  it("WEBUI_AUTH=disabled still refuses the ack — an unauthenticated tailnet curl must not silence the pager", () => {
    const disabled: AuthState = { mode: "disabled" };
    expect(routeRequest(ACK, "", "POST", disabled)).toEqual({
      kind: "forbidden",
      reason: "live_mutation_requires_auth",
    });
    // The inbox READ keeps today's disabled-mode behaviour (mutation-only wall).
    expect(routeRequest(INBOX, "", "GET", disabled)).toEqual({ kind: "backend" });
  });

  it("ack POST without a session → 401, never dispatched", () => {
    expect(routeRequest(ACK, "", "POST", enabledNoSession)).toEqual({ kind: "unauthorized" });
  });

  it("bootstrap mode denies the ack mutation", () => {
    expect(routeRequest(ACK, "", "POST", { mode: "bootstrap" })).toEqual({ kind: "unauthorized" });
  });

  it("a full operator session reaches the backend dispatcher", () => {
    expect(routeRequest(ACK, "", "POST", operator)).toEqual({ kind: "backend" });
    expect(routeRequest(INBOX, "", "GET", operator)).toEqual({ kind: "backend" });
  });

  // RBAC (M2A R3 catch-all, on main): a mutating POST requires operator+. A
  // viewer is refused 403 (role_denied) BEFORE dispatch — a read-only account
  // must never be able to silence an armed-path page.
  it("viewer POST → 403 role_denied (operator+ required to ack)", () => {
    expect(routeRequest(ACK, "", "POST", viewer)).toEqual({
      kind: "forbidden",
      reason: "role_denied",
    });
  });

  it("viewer GET inbox is allowed (reads are not role-gated)", () => {
    expect(routeRequest(INBOX, "", "GET", viewer)).toEqual({ kind: "backend" });
  });
});
