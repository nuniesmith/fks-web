/**
 * FKS API Client — typed fetch wrapper for the Ruby Data Service.
 *
 * All requests go through the Vite dev proxy or the Nginx reverse proxy
 * in production, so we use relative URLs.
 */

import { isSessionRequired, sessionExpired } from '$stores/session';

const DEFAULT_TIMEOUT = 15_000;

export class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body?: unknown,
  ) {
    super(`API ${status}: ${statusText}`);
    this.name = 'ApiError';
  }
}

interface FetchOptions extends Omit<RequestInit, 'body'> {
  timeout?: number;
  body?: unknown;
  /**
   * Treat an "unmapped" backend response (see below) as a soft empty instead
   * of a thrown error. Off by default — verified (audit 2026-07-31, gap 19)
   * that no current call site needs this; it exists for a future caller that
   * genuinely wants to render an unmapped route as empty rather than failed.
   */
  allowUnmapped?: boolean;
}

async function request<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { timeout = DEFAULT_TIMEOUT, body, allowUnmapped, ...init } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(init.headers as Record<string, string> ?? {}),
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      // Raise the app-wide "sign in again" banner ONLY for the adapter's own
      // session denial (401 + `x-fks-auth: session-required`). A proxied
      // upstream 401 — e.g. a spawner X-Internal-Token mismatch — is a backend
      // config fault that signing in cannot fix, and must NOT trigger it.
      // Throwing is unchanged either way: callers keep their existing ApiError.
      if (isSessionRequired(res)) sessionExpired.set(true);
      const errBody = await res.text().catch(() => undefined);
      throw new ApiError(res.status, res.statusText, errBody);
    }

    // ── Gap 19: an "unmapped" fabricated-empty response must not read as
    //    fresh, real data ────────────────────────────────────────────────
    //
    // `hooks.server.ts`'s `gracefulEmpty()` answers a backend path with no
    // dispatch with a well-formed `200 {}`/`[]` (see the CLAUDE.md "Unmapped
    // READS degrade" note — that server-side behaviour is UNCHANGED and
    // stays deliberate: it's what keeps a not-yet-wired panel from throwing
    // mid-render instead of rendering an honest empty state). It stamps
    // `x-fks-unmapped: 1` on that response so a caller CAN tell the
    // difference between "really nothing there" and "we never asked" — but
    // until now nothing read the header, so a 200 with an empty body looked
    // exactly like real, current data:
    //   - `poll.ts`'s `updatedAt` (last SUCCESSFUL fetch) advanced on every
    //     tick, so an unmapped feed reported itself FRESH, never stale.
    //   - Read-only panels rendered the resulting `{}`/`[]` as a genuine
    //     empty result ("No tables found") rather than "we could not see
    //     real data" — e.g. the `/db` explorer's Postgres/QuestDB/Janus/Redis
    //     panels, which are all unmapped at this seam despite the tables
    //     genuinely existing server-side (a live DR rehearsal verified 20).
    //
    // Throwing here turns that into an ordinary failed fetch: every caller's
    // existing catch block already sets its own error state (they already
    // say "Failed to load …" / "unavailable" for a thrown ApiError), and
    // `poll.ts`'s `updatedAt` correctly stops advancing. A call site that
    // GENUINELY wants the soft empty (none exist today — checked) can opt
    // out with `{ allowUnmapped: true }`.
    if (res.headers.get('x-fks-unmapped') === '1' && !allowUnmapped) {
      throw new ApiError(
        res.status,
        'unmapped — no backend wired for this route',
        await res.text().catch(() => undefined),
      );
    }

    const text = await res.text();
    return text ? JSON.parse(text) : ({} as T);
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  get: <T>(url: string, opts?: FetchOptions) => request<T>(url, { ...opts, method: 'GET' }),
  post: <T>(url: string, body?: unknown, opts?: FetchOptions) =>
    request<T>(url, { ...opts, method: 'POST', body }),
  put: <T>(url: string, body?: unknown, opts?: FetchOptions) =>
    request<T>(url, { ...opts, method: 'PUT', body }),
  delete: <T>(url: string, opts?: FetchOptions) => request<T>(url, { ...opts, method: 'DELETE' }),
};
