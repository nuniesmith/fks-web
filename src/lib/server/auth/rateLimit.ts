// In-app per-IP login rate limiter (design §4.1 — "both halves required":
// nginx is bypassable via a direct :3001 tunnel, so the authoritative limit
// lives here). A fixed-window counter per IP; cheap, memory-only, self-pruning.
// Per-username lockout is enforced separately in the AuthService.

export interface RateLimitOptions {
  /** Max attempts per window per key. */
  max: number;
  /** Window length in ms. */
  windowMs: number;
  now?: () => number;
}

interface Window {
  count: number;
  resetAt: number;
}

export class LoginRateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, Window>();

  constructor(opts: RateLimitOptions) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Register an attempt from `key` (an IP). Returns true if allowed, false if
   * the window is exhausted. Empty keys are never limited (can't attribute).
   */
  hit(key: string): boolean {
    if (!key) return true;
    const now = this.now();
    const w = this.windows.get(key);
    if (!w || now >= w.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      this.prune(now);
      return true;
    }
    if (w.count >= this.max) return false;
    w.count += 1;
    return true;
  }

  private prune(now: number): void {
    if (this.windows.size < 1024) return;
    for (const [k, w] of this.windows) {
      if (now >= w.resetAt) this.windows.delete(k);
    }
  }
}
