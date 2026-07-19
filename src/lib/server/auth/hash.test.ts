import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, type ScryptParams } from "./hash";

// Cheap params keep the suite fast; the algorithm/serialization is identical to
// production (which uses N=2^17). Verify reads params back out of the PHC string.
const CHEAP: ScryptParams = { N: 1 << 12, r: 8, p: 1, keyLen: 32 };

describe("scrypt hashing", () => {
  it("produces a PHC string with a per-hash random salt", async () => {
    const a = await hashPassword("example-passphrase-03", CHEAP);
    const b = await hashPassword("example-passphrase-03", CHEAP);
    expect(a).toMatch(/^\$scrypt\$ln=12,r=8,p=1\$[^$]+\$[^$]+$/);
    // Salted → identical passwords hash to different strings.
    expect(a).not.toBe(b);
  });

  it("verifies the correct password and rejects a wrong one", async () => {
    const phc = await hashPassword("example-passphrase-01", CHEAP);
    expect(await verifyPassword("example-passphrase-01", phc)).toBe(true);
    expect(await verifyPassword("example-passphrase-02", phc)).toBe(false);
    expect(await verifyPassword("", phc)).toBe(false);
  });

  it("never leaks the plaintext and never returns the raw key alone", async () => {
    const phc = await hashPassword("example-plainpass-01", CHEAP);
    expect(phc).not.toContain("example-plainpass-01");
  });

  it("returns false (never throws) for a malformed/unknown hash", async () => {
    expect(await verifyPassword("x", "not-a-phc-string")).toBe(false);
    expect(await verifyPassword("x", "$bcrypt$foo$bar")).toBe(false);
    expect(await verifyPassword("x", "$scrypt$ln=12$onlythree")).toBe(false);
  });
});
