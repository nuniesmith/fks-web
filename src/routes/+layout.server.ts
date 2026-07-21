import type { LayoutServerLoad } from './$types';

/**
 * Exposes the resolved session identity (set on `event.locals` by the
 * `hooks.server.ts` handle — A3) to every page as `$page.data.user`. Coexists
 * with the universal `+layout.ts` (workspace data) — SvelteKit merges the two
 * loads' return values into the final `data`.
 *
 * No leak: `locals.user` is null for unauthenticated pages (login/setup) and
 * for `WEBUI_AUTH=disabled`; the store-outage open-page branch also renders
 * with the null default the hook sets before auth resolves. `authDisabled` only
 * flags the disabled-mode badge — it never fabricates an identity.
 */
export const load: LayoutServerLoad = ({ locals }) => {
  return {
    user: locals.user ?? null,
    authDisabled: locals.authDisabled ?? false,
  };
};
