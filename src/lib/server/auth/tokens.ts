// Session-token + bootstrap-password generation (design §4.1).
//
// The raw 32-byte session token lives ONLY in the browser cookie; the server
// stores sha256(token). A DB read (backup leak, scoped-role escape) therefore
// yields no usable sessions. The bootstrap password is CSPRNG randomness printed
// once to the container log — never a static/shipped default.

import { createHash, randomBytes } from "node:crypto";

/** 32 bytes of CSPRNG randomness, base64url — the value placed in the cookie. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** sha256(token) hex — the only representation the server persists. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * A one-time bootstrap admin password: 24 chars of base64url CSPRNG randomness.
 * Printed once to the server log at first startup, `mustChange` forces its
 * immediate rotation. There is intentionally NO static default anywhere.
 */
export function generateBootstrapPassword(): string {
  return randomBytes(18).toString("base64url"); // 18 bytes → 24 base64url chars
}

/**
 * Personal access tokens (API v1): `fks_pat_` + 32 bytes of CSPRNG base64url.
 * The prefix lets the hook tell a PAT from a session at a glance and lets
 * secret scanners recognise one that leaked into a file or a log.
 */
export const API_TOKEN_PREFIX = "fks_pat_";

export function generateApiToken(): string {
  return API_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** Shape check only (prefix + 43 base64url chars); the DB lookup decides. */
export function looksLikeApiToken(token: string): boolean {
  return /^fks_pat_[A-Za-z0-9_-]{43}$/.test(token);
}
