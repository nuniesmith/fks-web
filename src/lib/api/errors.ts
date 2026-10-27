/**
 * An API failure as lines a person can act on. The spawner answers a refused
 * write with `{errors: [...]}` (one line per problem) or `{error}` (a
 * database refusal in Postgres's own words, e.g. a ladder guard); anything
 * else falls back to the HTTP status.
 */
import { ApiError } from '$api/client';

export function errorLines(e: unknown): string[] {
  if (e instanceof ApiError && typeof e.body === 'string' && e.body) {
    try {
      const b = JSON.parse(e.body);
      if (Array.isArray(b.errors) && b.errors.length) return b.errors.map(String);
      if (b.detail && b.error === 'forbidden') return [String(b.detail)];
      if (b.error) return [String(b.error)];
      if (b.detail) return [String(b.detail)];
    } catch {
      return [e.body];
    }
  }
  return [e instanceof ApiError ? `${e.status}: ${e.statusText}` : String(e)];
}
