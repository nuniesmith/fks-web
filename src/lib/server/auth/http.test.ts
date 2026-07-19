import { describe, expect, it } from "vitest";
import { clientIp, safeNext } from "./http";

describe("safeNext — same-site redirect guard", () => {
  it("returns rooted same-site paths unchanged", () => {
    expect(safeNext("/settings")).toBe("/settings");
    expect(safeNext("/settings?tab=keys")).toBe("/settings?tab=keys");
    expect(safeNext(null)).toBe("/");
    expect(safeNext("")).toBe("/");
  });

  it("rejects protocol-relative // targets", () => {
    expect(safeNext("//evil.com")).toBe("/");
    expect(safeNext("//evil.com/path")).toBe("/");
  });

  it("rejects absolute URLs", () => {
    expect(safeNext("https://evil.com")).toBe("/");
    expect(safeNext("http://evil.com")).toBe("/");
  });

  // REGRESSION: `/\evil.com` starts with a single '/' and NOT with '//', so a
  // naive check passes it — but browsers normalise the backslash to '/', so the
  // Location resolves to //evil.com → an off-site open redirect after login.
  it("rejects a backslash open-redirect bypass", () => {
    expect(safeNext("/\\evil.com")).toBe("/");
    expect(safeNext("/\\/evil.com")).toBe("/");
    expect(safeNext("/\\\\evil.com")).toBe("/");
    // Percent-encoded backslash (%5C) decodes to '\' and must also be rejected.
    expect(safeNext("/%5Cevil.com")).toBe("/");
    // A backslash anywhere in an otherwise-relative path is refused.
    expect(safeNext("/foo\\bar")).toBe("/");
  });
});

describe("clientIp — trust anchor is the socket peer, not client headers", () => {
  function req(headers: Record<string, string>): Request {
    return new Request("http://fks.local/login", { headers });
  }

  // REGRESSION: on the direct :3001 tunnel the login rate-limiter is built to
  // defend, X-Real-IP / X-Forwarded-For are attacker-set. Trusting them lets a
  // fresh value per request mint a fresh limiter key (and poison the audit IP).
  // With the default (untrusted), a rotating header can NEVER change the key.
  it("ignores spoofed X-Real-IP / X-Forwarded-For by default", () => {
    expect(clientIp(req({ "x-real-ip": "1.2.3.4" }), "10.0.0.9")).toBe("10.0.0.9");
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9" }), "10.0.0.9")).toBe("10.0.0.9");
    // Rotating the header yields the SAME key — the limiter window still applies.
    const a = clientIp(req({ "x-real-ip": "1.1.1.1" }), "10.0.0.9");
    const b = clientIp(req({ "x-real-ip": "2.2.2.2" }), "10.0.0.9");
    expect(a).toBe(b);
  });

  it("consults forwarded headers only when explicitly trusted", () => {
    expect(clientIp(req({ "x-real-ip": "1.2.3.4" }), "10.0.0.9", true)).toBe("1.2.3.4");
    expect(
      clientIp(req({ "x-forwarded-for": "9.9.9.9, 7.7.7.7" }), "10.0.0.9", true),
    ).toBe("9.9.9.9");
    // Falls back to the socket peer when no forwarded header is present.
    expect(clientIp(req({}), "10.0.0.9", true)).toBe("10.0.0.9");
  });
});
