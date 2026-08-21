<!--
  Root layout — wraps every route in the terminal chrome.

  - Reads the workspace config loaded by +layout.ts and pushes it into
    Svelte context under the key 'workspace' so any descendant page can
    `getContext<WorkspaceConfig>('workspace')` without prop-drilling.
  - Renders the persistent shell: Strip (top), TabBar (nav), workspace
    (main slot), StatusBar (bottom).

  History note: this file briefly had two <script> blocks (and two
  {@render children()} calls) after a bad merge — kept the markup from
  the first version and the data/context wiring from the second.
-->
<script lang="ts">
    import "../app.css";
    import { setContext, untrack } from "svelte";
    import { page } from "$app/stores";
    import Strip from "$components/shell/Strip.svelte";
    import TabBar from "$components/shell/TabBar.svelte";
    import StatusBar from "$components/shell/StatusBar.svelte";
    import { sessionExpired } from "$stores/session";
    import { alertInbox, describeChip, promDownStreak } from "$stores/alertInbox";
    import type { WorkspaceConfig } from "$lib/workspaces";

    // Data is loaded by +layout.ts — workspace is already resolved there.
    let { data, children } = $props();

    // Push the resolved config into context so every sub-page can read it
    // without prop-drilling. SvelteKit re-runs the layout when the active
    // route changes, so capturing the value at mount is the intended
    // behavior — `untrack` makes that explicit and silences svelte-check.
    setContext<WorkspaceConfig>("workspace", untrack(() => data.workspace));

    // ── Session-expiry banner (R2) ───────────────────────────────────────────
    // Sessions are 7d idle / 30d absolute, so the absolute cap fires on an
    // installed PWA roughly monthly. Before this, every poll just started
    // failing: /cockpit printed `request failed — 401: {"error":"unauthorized"}`
    // and M4's Freshness went amber — "stale", never "you are logged out".
    //
    // DELIBERATELY NOT AN AUTO-REDIRECT. The banner has to be able to appear
    // while the cockpit's typed KILL confirmation is half-entered; navigating
    // away would destroy state the operator cannot cheaply reproduce at 3am.
    // It is a passive notice plus one link — never a control that acts.
    const GATE_PATHS = ["/login", "/logout", "/setup", "/invite"];
    let onGate = $derived(
        GATE_PATHS.some(
            (p) =>
                $page.url.pathname === p ||
                $page.url.pathname.startsWith(p + "/"),
        ),
    );
    // Suppressed on the auth gates: "sign in again" above the sign-in form is
    // noise, and it would otherwise survive a client-side nav onto /login.
    let showSessionBanner = $derived($sessionExpired && !onGate);
    // login/+page.server.ts honours (and sanitises) ?next=, so signing in
    // returns the operator to the exact screen they were on.
    let signInHref = $derived(
        "/login?next=" +
            encodeURIComponent($page.url.pathname + $page.url.search),
    );

    // ── Age-escalated alert banner (§2.3 — the 43h-unacked incident) ────────
    // StatusBar's chip already carries this alert, but the chip lives in a
    // 10px footer row that is trivially easy to stop seeing — which is
    // exactly what happened for 43 hours. Past ALERT_AGE_BANNER_MS the SAME
    // pure `describeChip` (already unit-tested for the honesty rules) also
    // returns a `banner`, and this is the one shell-level place that renders
    // it, so it survives every route change until the alert is acked or
    // resolves. StatusBar keeps the underlying `alertInbox` poll warm
    // app-wide (`alertInbox.start()`/`stop()` in its own onMount) — this
    // layout only subscribes, it does not manage the poll's lifecycle.
    const alertMountedAt = Date.now();
    const inboxUpdatedAt = alertInbox.updatedAt;
    let alertChip = $derived(
        describeChip({
            inbox: $alertInbox,
            updatedAt: $inboxUpdatedAt,
            since: alertMountedAt,
            promDownStreak: $promDownStreak,
            // Recomputed whenever the inbox/streak store changes (the 30s
            // poll tick), not on a 1s ticker — the banner's threshold is
            // hours wide, so up-to-30s lag at the boundary is immaterial,
            // and it avoids a second per-second timer duplicating
            // StatusBar's for a shell element mounted on every route.
            nowMs: Date.now(),
        }),
    );
    let showAlertBanner = $derived(alertChip.banner != null);
</script>

<div class="terminal" class:has-banner={showSessionBanner || showAlertBanner}>
    {#if showAlertBanner && alertChip.banner}
        <!-- §2.3 — rendered ABOVE the session banner (always the topmost row
             when shown, and the sole owner of the iOS top inset below) because
             this is the money-safety escalation: an unacked alert that has
             been firing for ALERT_AGE_BANNER_MS+ (6h). Same in-flow /
             above-Modal-overlay / z-index:1100 reasoning as the session
             banner below — a kill-dialog tap must never fall through this
             either. Text and severity both come straight from `describeChip`
             (pure, unit-tested); nothing here decides tone. -->
        <div
            class="alert-age-banner"
            class:critical={alertChip.banner.severity === 'critical'}
            class:warning={alertChip.banner.severity === 'warning'}
            role="alert"
        >
            <span class="ab-msg">⚠ {alertChip.banner.text}</span>
            <a class="ab-link" href={alertChip.banner.href}>Open alerts</a>
        </div>
    {/if}
    {#if showSessionBanner}
        <!-- IN FLOW and at the VERY TOP, both measured decisions.
             In flow (not a fixed overlay) so it can only ever push content
             down, never hide a control.
             At the top because Modal.svelte centres its card in the viewport:
             measured at 1280x720 with the kill dialog open, a banner placed
             below the Strip spans y 48-83 while the card header spans 57-102 —
             it covered the dialog TITLE ("KILL PAPER — trip the durable kill
             sentinel", i.e. WHICH bot is about to be halted) and 14 of the 20px
             of the × button. Above the Strip the banner ends at y~35 and the
             card starts at 56, so it clears every dialog control. Pinned by
             tests/e2e/session.spec.ts.
             `no-top-inset` when the alert banner is ALSO showing: only the
             topmost row may claim the iOS safe-area inset, or a notched phone
             reserves it twice and opens a dead band under the pair. -->
        <div class="session-banner" class:no-top-inset={showAlertBanner} role="alert">
            <span class="sb-msg">Session expired — sign in again</span>
            <a class="sb-link" href={signInHref}>Sign in</a>
        </div>
    {/if}
    <Strip />
    <TabBar />
    <main class="workspace">
        {@render children()}
    </main>
    <StatusBar />
</div>

<style>
    .terminal {
        display: flex;
        flex-direction: column;
        height: 100vh;   /* fallback for browsers without dvh */
        height: 100dvh;  /* phone: excludes dynamic browser chrome */
        overflow: hidden;
        /* PWA T3.5 — the shell root also contains overscroll so a drag that
           starts on the chrome never rubber-bands the installed app. */
        overscroll-behavior: none;
        /* Landscape notch: keep chrome + content clear of the side inset
           (viewport-fit=cover draws edge-to-edge). env() is 0 on desktop. */
        padding-left: env(safe-area-inset-left, 0px);
        padding-right: env(safe-area-inset-right, 0px);
    }
    .workspace {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        position: relative;
    }

    /* Only ONE row may claim the iOS top inset. While the banner is up it is
       the topmost row and owns it; Strip's own reservation is zeroed here so
       the two do not stack into a double gap on a notched phone. Global
       because .strip is Svelte-scoped to its own component. */
    .terminal.has-banner :global(.strip) {
        height: var(--strip-h);
        padding-top: 0;
    }

    .session-banner {
        /* MONEY SAFETY: paint ABOVE Modal.svelte's .overlay (z-index 1000).
           The overlay is `position:fixed; inset:0` with a click handler that
           closes the dialog — and the cockpit's closeDialog() CLEARS the typed
           KILL phrase. If the banner sat under it, a tap on the banner would
           fall through to the backdrop and wipe a half-typed confirmation.
           Painting above the overlay makes the banner both legible and
           click-safe while a kill dialog is open. `position: relative` keeps it
           in the flex flow while still resolving against the root stacking
           context — .workspace is position:relative with z-index:auto, so it
           creates no competing context. */
        position: relative;
        z-index: 1100;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 5px 10px;
        /* It is now the topmost row, so IT owns the iOS top inset — and the
           Strip's copy is suppressed below, or a notched phone reserves the
           inset TWICE and opens a dead band under the banner. */
        padding-top: calc(5px + env(safe-area-inset-top, 0px));
        background: var(--amber-dim);
        border-bottom: 1px solid var(--amber-brd);
        color: var(--amber);
        font-size: 11px;
        letter-spacing: 0.04em;
    }
    /* Set only when the alert-age banner is ALSO rendering above this one —
       that banner is then the topmost row and the sole owner of the inset. */
    .session-banner.no-top-inset {
        padding-top: 5px;
    }
    .sb-msg {
        min-width: 0;
    }
    .sb-link {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 3px 10px;
        border: 1px solid var(--amber-brd);
        border-radius: var(--r);
        color: var(--amber);
        text-decoration: none;
        text-transform: uppercase;
        font-weight: 600;
    }
    .sb-link:hover,
    .sb-link:focus-visible {
        background: var(--amber-dim);
        border-color: var(--amber);
    }
    /* M5 precedent: 44px minimum on a coarse pointer. */
    @media (pointer: coarse) {
        .sb-link {
            min-height: 44px;
            min-width: 88px;
        }
    }

    /* ── Age-escalated alert banner (§2.3) ───────────────────────────────────
       Deliberately its own block rather than a generalised "banner" component:
       it shares the session banner's flow/z-index/inset reasoning verbatim
       (see the comments above and in the markup) but is a DIFFERENT claim —
       an unacked alert, not an expired session — so it keeps its own class
       and its own severity-driven colour rather than inheriting amber. */
    .alert-age-banner {
        position: relative;
        z-index: 1100;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 5px 10px;
        padding-top: calc(5px + env(safe-area-inset-top, 0px));
        font-size: 11px;
        letter-spacing: 0.04em;
        font-weight: 600;
    }
    .alert-age-banner.critical {
        background: var(--red-dim, rgba(220, 60, 60, 0.12));
        border-bottom: 1px solid var(--red-brd, rgba(220, 60, 60, 0.4));
        color: var(--red);
    }
    .alert-age-banner.warning {
        background: var(--amber-dim);
        border-bottom: 1px solid var(--amber-brd);
        color: var(--amber);
    }
    .ab-msg {
        min-width: 0;
    }
    .alert-age-banner.critical .ab-link {
        border-color: var(--red-brd, rgba(220, 60, 60, 0.4));
        color: var(--red);
    }
    .alert-age-banner.warning .ab-link {
        border-color: var(--amber-brd);
        color: var(--amber);
    }
    .ab-link {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 3px 10px;
        border: 1px solid;
        border-radius: var(--r);
        text-decoration: none;
        text-transform: uppercase;
        font-weight: 600;
    }
    .alert-age-banner.critical .ab-link:hover,
    .alert-age-banner.critical .ab-link:focus-visible {
        background: var(--red-dim, rgba(220, 60, 60, 0.12));
    }
    .alert-age-banner.warning .ab-link:hover,
    .alert-age-banner.warning .ab-link:focus-visible {
        background: var(--amber-dim);
    }
    /* M5 precedent: 44px minimum on a coarse pointer. */
    @media (pointer: coarse) {
        .ab-link {
            min-height: 44px;
            min-width: 88px;
        }
    }
</style>
