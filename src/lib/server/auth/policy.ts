// Pure auth policy: password strength + lockout arithmetic + session lifetimes
// (design §4.1). No I/O — unit-tested directly.

/** Minimum new-password length. No complexity theatre (design §4.7). */
export const MIN_PASSWORD_LENGTH = 12;

/** Failed logins tolerated before the account locks. */
export const LOCKOUT_THRESHOLD = 10;
/** First lock duration; doubles per subsequent failure past the threshold. */
export const LOCKOUT_BASE_MINUTES = 15;
/** Hard cap so a locked-out solo operator recovers within a day. */
export const LOCKOUT_MAX_MINUTES = 24 * 60;

/** Sliding idle window — refreshed on each authenticated request. */
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Absolute cap from creation, never extended. */
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** In-process cache TTL for a resolved session (revoke visible within this). */
export const SESSION_CACHE_TTL_MS = 60 * 1000;

export type PasswordCheck = { ok: true } | { ok: false; error: string };

/**
 * Validate a proposed new credential. Rejects: too short, equals username,
 * equals the current/bootstrap password (caller passes it), and empty username.
 */
export function validateNewCredentials(
  username: string,
  password: string,
  currentPassword?: string,
): PasswordCheck {
  const u = username.trim();
  if (u.length < 1) return { ok: false, error: "Username is required." };
  if (u.length > 64) return { ok: false, error: "Username is too long." };
  if (!/^[A-Za-z0-9._-]+$/.test(u)) {
    return {
      ok: false,
      error: "Username may use letters, digits, dot, underscore, hyphen only.",
    };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (password === u) {
    return { ok: false, error: "Password must not equal the username." };
  }
  if (currentPassword !== undefined && password === currentPassword) {
    return {
      ok: false,
      error: "New password must differ from the current password.",
    };
  }
  return { ok: true };
}

/**
 * Given a running failed-login count (this failure already included), return the
 * lock expiry, or `null` if still under the threshold. 10th failure → 15 min,
 * 11th → 30, 12th → 60 … capped at 24 h.
 */
export function computeLockUntil(failedLogins: number, now: number): Date | null {
  if (failedLogins < LOCKOUT_THRESHOLD) return null;
  const steps = failedLogins - LOCKOUT_THRESHOLD; // 0,1,2,…
  const minutes = Math.min(
    LOCKOUT_BASE_MINUTES * 2 ** steps,
    LOCKOUT_MAX_MINUTES,
  );
  return new Date(now + minutes * 60 * 1000);
}

/** Whether a stored `lockedUntil` still blocks a login at `now`. */
export function isLocked(lockedUntil: Date | null, now: number): boolean {
  return !!lockedUntil && lockedUntil.getTime() > now;
}
