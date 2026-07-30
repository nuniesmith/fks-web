// R2 — the session-expiry marker. The ONE thing these tests exist to pin is the
// DISTINCTION: the adapter's own denial is a session expiry; a PROXIED upstream
// 401 (a spawner X-Internal-Token mismatch, a janus Bearer fault) is not. A
// banner that fires on the second case trains the operator to ignore the first.
import { describe, expect, it } from "vitest";
import { get } from "svelte/store";
import {
  SESSION_HEADER,
  SESSION_REQUIRED,
  isSessionRequired,
  sessionExpired,
} from "./session";

/** A Response-shaped stand-in using real (case-insensitive) Headers. */
function probe(status: number, headers: Record<string, string> = {}) {
  return { status, headers: new Headers(headers) };
}

describe("isSessionRequired — the adapter's own denial only", () => {
  it("TRUE for 401 + x-fks-auth: session-required (the adapter refused us)", () => {
    expect(isSessionRequired(probe(401, { [SESSION_HEADER]: SESSION_REQUIRED }))).toBe(
      true,
    );
  });

  it("case-insensitive on the header NAME (Node/undici may normalise either way)", () => {
    expect(isSessionRequired(probe(401, { "X-FKS-Auth": SESSION_REQUIRED }))).toBe(true);
  });

  it("FALSE for a bare proxied 401 — a spawner token mismatch is NOT an expiry", () => {
    // This is the exact false-positive the header exists to prevent: the
    // adapter streams upstream statuses back verbatim, so a bad
    // X-Internal-Token arrives at the browser as an unmarked 401.
    expect(isSessionRequired(probe(401))).toBe(false);
    expect(
      isSessionRequired(probe(401, { "content-type": "application/json" })),
    ).toBe(false);
  });

  it("FALSE for a 401 carrying some OTHER x-fks-auth value", () => {
    expect(isSessionRequired(probe(401, { [SESSION_HEADER]: "role-denied" }))).toBe(
      false,
    );
  });

  it("FALSE for the marker on a non-401 status (both halves are required)", () => {
    for (const s of [200, 403, 502, 503]) {
      expect(isSessionRequired(probe(s, { [SESSION_HEADER]: SESSION_REQUIRED }))).toBe(
        false,
      );
    }
  });

  it("FALSE for a 403 role denial — authenticated, just not permitted", () => {
    expect(isSessionRequired(probe(403))).toBe(false);
  });

  it("tolerates a header-less / null / undefined response object", () => {
    expect(isSessionRequired({ status: 401 })).toBe(false);
    expect(isSessionRequired({ status: 401, headers: null })).toBe(false);
    expect(isSessionRequired(null)).toBe(false);
    expect(isSessionRequired(undefined)).toBe(false);
  });
});

describe("sessionExpired store", () => {
  it("starts false — nothing has denied us yet", () => {
    // Read-then-restore so this file stays order-independent.
    const before = get(sessionExpired);
    sessionExpired.set(false);
    expect(get(sessionExpired)).toBe(false);
    sessionExpired.set(before);
  });

  it("is settable and notifies subscribers (drives the layout banner)", () => {
    sessionExpired.set(false);
    const seen: boolean[] = [];
    const stop = sessionExpired.subscribe((v) => seen.push(v));
    sessionExpired.set(true);
    stop();
    expect(seen).toEqual([false, true]);
    sessionExpired.set(false);
  });
});
