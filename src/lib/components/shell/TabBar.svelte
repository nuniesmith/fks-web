<script lang="ts">
    import { page } from "$app/stores";
    import { goto } from "$app/navigation";

    type Tab = {
        id: string;
        label: string;
        dot?: string;
        key?: string;
        shiftKey?: string;
        href: string;
    };

    type Group = {
        label: string;
        color: string;
        tabs: Tab[];
    };

    // ── Nav groups ────────────────────────────────────────────────────────
    //
    // 2026-10-26: the nav follows the edge process — capture data, find and
    // validate edges, run tasks, see the money — then System. The futures
    // co-pilot (Cockpit, Futures), Trading, Signals, Perf, Janus AI, Journal
    // and Workspace tabs were removed with their pages: their backends (Ruby,
    // Rithmic, the old spot/funding bots, janus paper trading) are gone.
    // Charts and the DB explorer stay reachable from Data and System.
    const pipelineGroup: Group = {
        label: "FKS",
        color: "var(--cyan, #00e5ff)",
        tabs: [
            { id: "home", label: "Home", dot: "var(--cyan)", key: "1", href: "/" },
            // Recorders from a form, coverage and gaps, market data, charts.
            { id: "data", label: "Data", key: "2", href: "/data" },
            // The edge ladder: hypothesis → search → holdout → forward → live.
            { id: "edges", label: "Edges", key: "3", href: "/edges" },
            // Everything spawned from a template: recorders, jobs and bots.
            { id: "tasks", label: "Tasks", key: "4", href: "/tasks" },
            // Net worth, P&L and holdings per account, transfers.
            { id: "money", label: "Money", dot: "var(--amber)", key: "5", href: "/money" },
        ],
    };

    // Users is admin-only: the tab is appended to the System group ONLY when
    // the signed-in role is admin ($page.data.user, exposed via
    // +layout.server.ts). Non-admins never see it, and direct nav to /users
    // already redirects home at the seam (adapter R5). Derived so the tab
    // appears/disappears live on identity change (login/logout/role-change).
    const systemGroup: Group = $derived({
        label: "System",
        color: "var(--t3, #555)",
        tabs: [
            { id: "settings", label: "Settings", key: "7", href: "/settings" },
            {
                id: "monitoring",
                label: "Monitoring",
                dot: "var(--purple)",
                key: "8",
                href: "/monitoring",
            },
            { id: "docs", label: "Docs", shiftKey: "1", href: "/docs" },
            ...($page.data.user?.role === "admin"
                ? [{ id: "users", label: "Users", href: "/users" }]
                : []),
        ],
    });

    const groups: Group[] = $derived([pipelineGroup, systemGroup]);

    // ── Active-state helpers ──────────────────────────────────────────────

    const allTabs = $derived(groups.flatMap((g) => g.tabs));

    let currentPath = $derived($page.url.pathname);

    function isActive(href: string): boolean {
        if (href === "/") return currentPath === "/";
        // Segment match, so /data/x lights Data but /database would not.
        return currentPath === href || currentPath.startsWith(href + "/");
    }

    // ── Keyboard shortcuts ────────────────────────────────────────────────

    function handleKeydown(e: KeyboardEvent) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const tag = document.activeElement?.tagName ?? "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

        const digit = e.code.startsWith("Digit") ? e.code.slice(5) : null;

        if (e.shiftKey) {
            const tab = digit
                ? allTabs.find((t) => t.shiftKey === digit)
                : undefined;
            if (tab) {
                e.preventDefault();
                goto(tab.href);
            }
        } else {
            const tab =
                allTabs.find((t) => t.key === e.key) ??
                (digit ? allTabs.find((t) => t.key === digit) : undefined);
            if (tab) {
                e.preventDefault();
                goto(tab.href);
            }
        }
    }

    $effect(() => {
        document.addEventListener("keydown", handleKeydown, true);
        return () =>
            document.removeEventListener("keydown", handleKeydown, true);
    });

    // ── Phone nav: keep the ACTIVE tab on screen + show that the strip scrolls ─
    //
    // A-3. Measured on the installed PWA at 390x844 on /cockpit: the strip's
    // scrollWidth is 1288 against a 390 clientWidth, scrollLeft 0, and the
    // Cockpit tab sits at left=738 — ENTIRELY off-screen. The scrollbar is
    // hidden (scrollbar-width:none + ::-webkit-scrollbar), so the operator got
    // no active-tab indicator anywhere AND no hint the strip continued: the app
    // looked like it had opened on a page that isn't in the nav.
    //
    // Two cheap fixes, no tab reordering:
    //  (1) centre the active tab in the strip on mount and on every navigation;
    //  (2) fade the overflowing edge(s) so the strip visibly continues.
    let barEl: HTMLElement | null = $state(null);
    /** false ⇒ there is hidden content off that edge ⇒ paint the fade. */
    let atStart = $state(true);
    let atEnd = $state(true);

    function syncEdges() {
        const bar = barEl;
        if (!bar) return;
        const max = bar.scrollWidth - bar.clientWidth;
        // No overflow ⇒ both edges are "reached" ⇒ no fade at all (desktop).
        atStart = max <= 1 || bar.scrollLeft <= 1;
        atEnd = max <= 1 || bar.scrollLeft >= max - 1;
    }

    // Scroll the strip ITSELF rather than calling scrollIntoView: that walks
    // every scrollable ancestor, and on navigation it can also scroll the
    // page's own `.page-scroll` region (block:'nearest' mitigates but does not
    // eliminate it). Rect maths, not offsetLeft — `.group` is position:relative
    // so a tab's offsetParent is its group, not the bar.
    $effect(() => {
        // Re-run on navigation, and when the admin-only Users tab appears or
        // disappears (either changes which tab is active / how wide the strip is).
        currentPath;
        groups;
        const bar = barEl;
        if (!bar) return;
        const active = bar.querySelector<HTMLElement>(".tab.active");
        if (active && bar.scrollWidth > bar.clientWidth) {
            const barRect = bar.getBoundingClientRect();
            const tabRect = active.getBoundingClientRect();
            bar.scrollLeft +=
                tabRect.left -
                barRect.left -
                (bar.clientWidth - tabRect.width) / 2;
        }
        // A delta of 0 fires no scroll event, so seed the fades directly.
        syncEdges();
    });

    // A window resize (or a desktop→narrow drag) changes whether the strip
    // overflows at all; without this the fades would lie until the next nav.
    $effect(() => {
        window.addEventListener("resize", syncEdges);
        return () => window.removeEventListener("resize", syncEdges);
    });
</script>

<!-- The wrapper exists ONLY to host the edge fades (the nav is the scroller, so
     an overlay inside it would scroll away with the tabs). `nav.tabbar` stays
     the nav landmark and keeps its selector — specs anchor to it. -->
<div
    class="tabbar-wrap"
    class:fade-start={!atStart}
    class:fade-end={!atEnd}
>
<nav
    class="tabbar"
    aria-label="Main navigation"
    bind:this={barEl}
    onscroll={syncEdges}
>
    {#each groups as group, gi}
        {#if gi > 0}
            <div class="group-sep" aria-hidden="true"></div>
        {/if}
        <div class="group" role="group" aria-label="{group.label} sections">
            <span
                class="group-lbl"
                aria-hidden="true"
                style="color: {group.color}">{group.label}</span
            >
            {#each group.tabs as tab}
                <a
                    class="tab"
                    class:active={isActive(tab.href)}
                    href={tab.href}
                    aria-current={isActive(tab.href) ? "page" : undefined}
                    data-sveltekit-preload-data="hover"
                >
                    {#if tab.dot}
                        <span class="dot" style="background: {tab.dot}"></span>
                    {/if}
                    {tab.label}
                    {#if tab.key}
                        <kbd class="shortcut" aria-hidden="true">{tab.key}</kbd>
                    {:else if tab.shiftKey}
                        <kbd class="shortcut" aria-hidden="true"
                            >⇧{tab.shiftKey}</kbd
                        >
                    {/if}
                </a>
            {/each}
        </div>
    {/each}
</nav>
</div>

<style>
    /* Positioning context for the fades; it is the flex item .tabbar used to be,
       so the shell's column layout is unchanged. */
    .tabbar-wrap {
        position: relative;
        flex-shrink: 0;
        min-width: 0;
        /* The topmost row owns the iOS top safe-area inset (viewport-fit=cover
           draws under the status bar). The layout zeroes this while a banner
           is showing, since the banner is then the topmost row. 0 on desktop. */
        padding-top: env(safe-area-inset-top, 0px);
        background: var(--bg1);
    }
    /* A-3 affordance: a fade on whichever edge still hides tabs. pointer-events
       is none on purpose — the strip navigates, and an overlay that swallowed a
       tap would send the operator to the wrong page.
       32px, not 16: a tab carries ~11-14px of side padding, so a narrower fade
       lands entirely on that padding and dims NOTHING the operator can see. It
       has to reach into the adjacent label to read as "there is more here". */
    .tabbar-wrap::before,
    .tabbar-wrap::after {
        content: "";
        position: absolute;
        top: env(safe-area-inset-top, 0px);
        bottom: 0;
        width: 32px;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.15s;
        z-index: 1;
    }
    .tabbar-wrap::before {
        left: 0;
        background: linear-gradient(to right, var(--bg1), transparent);
    }
    .tabbar-wrap::after {
        right: 0;
        background: linear-gradient(to left, var(--bg1), transparent);
    }
    .tabbar-wrap.fade-start::before,
    .tabbar-wrap.fade-end::after {
        opacity: 1;
    }

    .tabbar {
        height: var(--tabbar-h);
        background: var(--bg1);
        border-bottom: 1px solid var(--b2);
        display: flex;
        align-items: stretch;
        padding-top: 14px;
        overflow-x: auto;
        overflow-y: hidden;
        flex-shrink: 0;
        scrollbar-width: none;
    }
    .tabbar::-webkit-scrollbar {
        display: none;
    }

    .group {
        display: flex;
        align-items: flex-end;
        position: relative;
        padding-bottom: 2px;
    }

    .group-lbl {
        position: absolute;
        top: -12px;
        left: 0;
        font-size: 7px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        opacity: 0.7;
        white-space: nowrap;
        pointer-events: none;
        line-height: 1;
    }

    .group-sep {
        width: 1px;
        background: var(--b2);
        margin: 8px 2px 4px;
        align-self: stretch;
        flex-shrink: 0;
    }

    .tab {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 0 11px;
        font-size: 11px;
        color: var(--t2);
        text-decoration: none;
        white-space: nowrap;
        border-bottom: 2px solid transparent;
        transition:
            color 0.15s,
            border-color 0.15s;
        cursor: pointer;
    }
    .tab:hover {
        color: var(--t1);
        background: var(--bg3);
    }
    .tab.active {
        color: var(--t1);
        border-bottom-color: var(--accent);
    }

    .dot {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        flex-shrink: 0;
    }

    .shortcut {
        font-size: 8px;
        color: var(--t3);
        opacity: 0.5;
        margin-left: 2px;
        font-family: inherit;
    }

    /* ── Touch: ≥44px tap targets (Apple HIG) ───────────────────────────────
       The 34px tabbar / tab row is below the 44px touch guideline. On coarse
       pointers grow the bar so each tab is ≥44px tall (fixed height would clip
       it under overflow-y:hidden), and drop the keyboard-shortcut badges —
       dead weight without a keyboard. Desktop (pointer: fine) is untouched. */
    @media (pointer: coarse) {
        .tabbar { height: 60px; }
        .tab { min-height: 44px; padding-left: 14px; padding-right: 14px; }
        .shortcut { display: none; }
    }
</style>
