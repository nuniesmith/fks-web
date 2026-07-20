import { describe, expect, it } from "vitest";
import {
  computeLockUntil,
  isLocked,
  LOCKOUT_BASE_MINUTES,
  LOCKOUT_MAX_MINUTES,
  LOCKOUT_THRESHOLD,
  MIN_PASSWORD_LENGTH,
  validateNewCredentials,
} from "./policy";

describe("validateNewCredentials", () => {
  it("accepts a sane username + long password", () => {
    expect(validateNewCredentials("jordan", "example-long-password-1").ok).toBe(true);
  });
  it("rejects short passwords", () => {
    const r = validateNewCredentials("jordan", "a".repeat(MIN_PASSWORD_LENGTH - 1));
    expect(r.ok).toBe(false);
  });
  it("rejects password equal to username", () => {
    expect(validateNewCredentials("longusername1", "longusername1").ok).toBe(false);
  });
  it("rejects password equal to the current/bootstrap password", () => {
    expect(validateNewCredentials("jordan", "example-samepass-01", "example-samepass-01").ok).toBe(false);
  });
  it("rejects empty or illegal usernames", () => {
    expect(validateNewCredentials("", "example-long-password-1").ok).toBe(false);
    expect(validateNewCredentials("has space", "example-long-password-1").ok).toBe(false);
    expect(validateNewCredentials("a@b", "example-long-password-1").ok).toBe(false);
  });
});

describe("computeLockUntil — 10 failures → 15 min, doubling, capped 24h", () => {
  const now = 1_000_000;
  it("does not lock below the threshold", () => {
    for (let f = 0; f < LOCKOUT_THRESHOLD; f++) {
      expect(computeLockUntil(f, now)).toBeNull();
    }
  });
  it("locks 15 min at the threshold and doubles after", () => {
    expect(computeLockUntil(LOCKOUT_THRESHOLD, now)?.getTime()).toBe(
      now + LOCKOUT_BASE_MINUTES * 60_000,
    );
    expect(computeLockUntil(LOCKOUT_THRESHOLD + 1, now)?.getTime()).toBe(
      now + 2 * LOCKOUT_BASE_MINUTES * 60_000,
    );
    expect(computeLockUntil(LOCKOUT_THRESHOLD + 2, now)?.getTime()).toBe(
      now + 4 * LOCKOUT_BASE_MINUTES * 60_000,
    );
  });
  it("caps at 24h", () => {
    expect(computeLockUntil(LOCKOUT_THRESHOLD + 50, now)?.getTime()).toBe(
      now + LOCKOUT_MAX_MINUTES * 60_000,
    );
  });
});

describe("isLocked", () => {
  it("is true only while lockedUntil is in the future", () => {
    expect(isLocked(new Date(2000), 1000)).toBe(true);
    expect(isLocked(new Date(1000), 2000)).toBe(false);
    expect(isLocked(null, 1000)).toBe(false);
  });
});
