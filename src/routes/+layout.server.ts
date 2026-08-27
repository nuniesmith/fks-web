import { getRithmicAccountStore } from '$lib/server/rithmicAccounts/store';
import type { RithmicFocusAccount } from '$lib/server/rithmicAccounts/store';
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

/**
 * The hand-traded account, for the shell strip.
 *
 * THIS MUST NEVER BREAK A PAGE. It runs on every load, and it is decoration:
 * the operator's ability to reach /cockpit and hit the kill switch cannot
 * depend on a Postgres round-trip for a label. Every failure — no store
 * configured, table absent, connection refused — collapses to null, and the
 * strip renders its unknown state.
 *
 * Only for signed-in pages. /login and /setup have no session, and an account
 * label is real operational information; it does not belong on a page reachable
 * without authenticating.
 */
async function focusAccount(locals: App.Locals): Promise<RithmicFocusAccount | null> {
  if (!locals.user && !locals.authDisabled) return null;
  try {
    return (await getRithmicAccountStore()?.focused()) ?? null;
  } catch {
    return null;
  }
}

export const load: LayoutServerLoad = async ({ locals }) => {
  return {
    user: locals.user ?? null,
    authDisabled: locals.authDisabled ?? false,
    focusAccount: await focusAccount(locals),
  };
};
