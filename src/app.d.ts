// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}

    /** The signed-in identity, exposed to page loads via +layout.server.ts.
     *  Display-only — the real access gate is `routeRequest` in the hook. */
    interface SessionUser {
      username: string;
      /** admin | operator | viewer (free string; ranked by `roleRank`). */
      role: string;
      mustChange: boolean;
    }

    interface Locals {
      /** Non-null only for a full session in `mode:"enabled"`; null when
       *  unauthenticated OR `WEBUI_AUTH=disabled`. */
      user: SessionUser | null;
      /** True only under `WEBUI_AUTH=disabled` — lets the UI badge "auth off"
       *  while `user` stays null (no fabricated identity). */
      authDisabled: boolean;
    }

    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

declare module "$env/dynamic/public" {
  /**
   * Dynamic public environment variables, accessible on the client.
   *
   * These are read at runtime (not inlined at build time) so they can
   * be changed per-deployment without rebuilding.
   */
  export const env: {
    /**
     * SSE reconnect interval in milliseconds.
     *
     * How long to wait before reconnecting a dropped SSE connection.
     * @default '5000'
     */
    PUBLIC_SSE_RECONNECT_MS: string;

    /**
     * Default polling interval in milliseconds.
     *
     * Suggested interval for non-SSE periodic data fetching.
     * @default '30000'
     */
    PUBLIC_POLL_INTERVAL_MS: string;

    /**
     * API base URL.
     *
     * Leave empty to use relative URLs (same origin).
     * Set when the data service lives on a different host/port.
     * @default ''
     */
    PUBLIC_API_BASE_URL: string;

    /**
     * Backend API URL used by the Vite dev proxy and SSR fetch calls.
     * @default 'http://localhost:8000'
     */
    PUBLIC_API_URL: string;

    /**
     * Janus service URL.
     * @default 'http://localhost:7000'
     */
    PUBLIC_JANUS_URL: string;

    /** Allow additional PUBLIC_ variables without explicit declarations. */
    [key: `PUBLIC_${string}`]: string | undefined;
  };
}

export {};
