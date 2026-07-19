// Password hashing — node:crypto scrypt, zero native dependencies (design §4.1).
//
// OWASP lists scrypt (N=2^17, r=8, p=1) as the sanctioned alternative to
// argon2id; using node's builtin keeps the open-source git-clone Docker build
// free of any native-module burden. Hashes serialize to a PHC-style string so
// the embedded parameters travel with the hash and a future migration to
// argon2id is verify-then-rehash on login. A hash is NEVER logged or returned.

import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

// Manual promise wrapper (not promisify) so the options overload is preserved.
function scrypt(
  password: string,
  salt: Buffer,
  keyLen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keyLen, options, (err, derivedKey) =>
      err ? reject(err) : resolve(derivedKey as Buffer),
    );
  });
}

export interface ScryptParams {
  /** CPU/memory cost — a power of two. */
  N: number;
  /** Block size. */
  r: number;
  /** Parallelization. */
  p: number;
  /** Derived-key length in bytes. */
  keyLen: number;
}

/** OWASP-recommended production parameters (~128 MiB, ~100 ms). */
export const DEFAULT_SCRYPT: ScryptParams = { N: 1 << 17, r: 8, p: 1, keyLen: 32 };

const SALT_BYTES = 32;

function maxmemFor(p: ScryptParams): number {
  // scrypt needs ~128 * N * r bytes; grant generous headroom over the default
  // 32 MiB cap so the OWASP params don't throw.
  return 128 * p.N * p.r * 2 + (1 << 20);
}

function isPow2(n: number): boolean {
  return n > 1 && (n & (n - 1)) === 0;
}

async function derive(
  password: string,
  salt: Buffer,
  params: ScryptParams,
): Promise<Buffer> {
  return scrypt(password, salt, params.keyLen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: maxmemFor(params),
  });
}

/**
 * Hash a password with a fresh per-user 32-byte random salt. Returns a PHC
 * string: `$scrypt$ln=<log2N>,r=<r>,p=<p>$<saltB64>$<keyB64>`.
 */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  const ln = Math.log2(params.N);
  return `$scrypt$ln=${ln},r=${params.r},p=${params.p}$${salt.toString(
    "base64",
  )}$${key.toString("base64")}`;
}

/**
 * Constant-time verify. Parses the stored PHC string, re-derives with the
 * embedded params + salt, and compares in constant time. Any malformed input
 * returns `false` (never throws) — a corrupt/unknown hash can never authenticate.
 */
export async function verifyPassword(
  password: string,
  phc: string,
): Promise<boolean> {
  try {
    const parts = phc.split("$");
    // ["", "scrypt", "ln=..,r=..,p=..", "<salt>", "<key>"]
    if (parts.length !== 5 || parts[1] !== "scrypt") return false;
    const opts = Object.fromEntries(
      parts[2].split(",").map((kv) => {
        const [k, v] = kv.split("=");
        return [k, Number(v)];
      }),
    ) as { ln: number; r: number; p: number };
    const N = 2 ** opts.ln;
    if (!isPow2(N) || !opts.r || !opts.p) return false;
    const salt = Buffer.from(parts[3], "base64");
    const expected = Buffer.from(parts[4], "base64");
    const actual = await derive(password, salt, {
      N,
      r: opts.r,
      p: opts.p,
      keyLen: expected.length,
    });
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
