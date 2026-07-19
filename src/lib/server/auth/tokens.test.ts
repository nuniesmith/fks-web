import { describe, expect, it } from "vitest";
import {
  generateBootstrapPassword,
  generateSessionToken,
  hashToken,
} from "./tokens";

describe("session tokens", () => {
  it("generates unique high-entropy tokens", () => {
    const set = new Set(Array.from({ length: 1000 }, generateSessionToken));
    expect(set.size).toBe(1000);
    // 32 bytes base64url → 43 chars, url-safe alphabet only.
    for (const t of set) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("hashes deterministically to sha256 hex (the only stored form)", () => {
    const t = "abc";
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });
});

describe("bootstrap password", () => {
  it("is high-entropy and unique per call (never a static default)", () => {
    const a = generateBootstrapPassword();
    const b = generateBootstrapPassword();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(24);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
