import { describe, expect, it } from "vitest";
import { LoginRateLimiter } from "./rateLimit";

describe("LoginRateLimiter", () => {
  it("allows up to max attempts per window, then blocks", () => {
    let t = 0;
    const rl = new LoginRateLimiter({ max: 3, windowMs: 1000, now: () => t });
    expect(rl.hit("1.2.3.4")).toBe(true);
    expect(rl.hit("1.2.3.4")).toBe(true);
    expect(rl.hit("1.2.3.4")).toBe(true);
    expect(rl.hit("1.2.3.4")).toBe(false); // 4th blocked
  });

  it("resets after the window elapses", () => {
    let t = 0;
    const rl = new LoginRateLimiter({ max: 1, windowMs: 1000, now: () => t });
    expect(rl.hit("ip")).toBe(true);
    expect(rl.hit("ip")).toBe(false);
    t = 1001;
    expect(rl.hit("ip")).toBe(true);
  });

  it("keys independently per IP", () => {
    let t = 0;
    const rl = new LoginRateLimiter({ max: 1, windowMs: 1000, now: () => t });
    expect(rl.hit("a")).toBe(true);
    expect(rl.hit("b")).toBe(true);
    expect(rl.hit("a")).toBe(false);
  });

  it("never limits an empty key (unattributable)", () => {
    const rl = new LoginRateLimiter({ max: 1, windowMs: 1000 });
    expect(rl.hit("")).toBe(true);
    expect(rl.hit("")).toBe(true);
  });
});
