import { describe, it, expect } from "vitest";
import { isGetLike } from "./adapter";

// The hook's unmapped-path fall-through degrades reads to an empty 200 but
// answers 501 for anything else. That split is entirely delegated to
// isGetLike, so widening it (e.g. treating PATCH or POST as "read-like")
// would silently restore the fake-success bug this guards: the /trading order
// ticket reporting "BUY order submitted" against a stub that never placed an
// order. Pin the contract.
describe("mutation guard — the read/write split the 501 fall-through relies on", () => {
  it("treats ONLY GET/HEAD as reads", () => {
    expect(isGetLike("GET")).toBe(true);
    expect(isGetLike("HEAD")).toBe(true);
  });

  it("treats every state-changing verb as a mutation (must NOT degrade to 200)", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isGetLike(method), `${method} must be a mutation`).toBe(false);
    }
  });

  it("is case-sensitive on the wire spelling (no lowercase escape hatch)", () => {
    expect(isGetLike("get")).toBe(false);
    expect(isGetLike("post")).toBe(false);
  });
});
