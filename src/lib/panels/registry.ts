/**
 * Panel Registry
 * ==============
 *
 * The typed catalogue of dockable panels for the `/workspace` route. Each entry
 * maps a stable `panelId` → { title, load (the Svelte component), defaultParams }.
 * The `/workspace` dockview host and its "+ Add panel" menu are driven entirely
 * by this map, and layout JSON references panels by `panelId`, so the registry
 * is the single source of truth for what can be docked.
 *
 * This is the "spiritual successor" to the dormant `$lib/workspaces.ts`
 * described in the WebUI Platform Roadmap (§2.2): `workspaces.ts` binds an API
 * base to a *page group* (nav-level); this registry binds data + a component to
 * a *panel instance* (layout-level). They are complementary — `workspaces.ts`
 * stays for nav grouping.
 *
 * Why `load: () => import(...)` instead of a direct component import?
 *   - It keeps this module free of static `.svelte` imports, so it stays a
 *     pure, framework-free data module that unit tests (and the layout
 *     serializers) can import under a plain node environment.
 *   - It code-splits each panel, so `/workspace` only downloads the panels the
 *     operator actually opens.
 *
 * Adding a panel:
 *   1. Build a self-contained Svelte component under `./components/` that takes
 *      its inputs as props and does its own polling/SSE (see the existing ones).
 *   2. Register it below with a stable `id`, a `title`, and `defaultParams`.
 *   3. It automatically appears in the "+ Add panel" menu and can be saved into
 *      layouts / presets.
 */
import type { Component } from "svelte";

/**
 * Lazily resolves a panel's Svelte component (code-split).
 *
 * The component's props are intentionally loose (`Component<any>`): each panel
 * declares its own prop shape, and the host mounts it with the panel's params
 * spread as props. A stricter type here would reject prop-less panels because
 * of prop contravariance.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PanelLoader = () => Promise<{ default: Component<any> }>;

/** Which broad area a panel belongs to — drives grouping in the Add menu. */
export type PanelCategory = "Markets" | "Trading" | "System" | "Notes";

/** Whether a panel renders real data or is a not-yet-extracted stub. */
export type PanelStatus = "real" | "placeholder";

export interface PanelDef {
    /** Stable id — persisted in layout JSON. Never rename in place. */
    id: string;
    /** Human-readable title shown in the tab + Add menu. */
    title: string;
    /** Add-menu grouping. */
    category: PanelCategory;
    /** Lazy loader for the Svelte 5 component mounted into the panel body. */
    load: PanelLoader;
    /**
     * Default params spread as props onto the component when a fresh instance
     * is added. Round-trips through dockview's layout JSON.
     */
    defaultParams?: Record<string, unknown>;
    /** Real data vs. placeholder — surfaced as a badge in the Add menu. */
    status: PanelStatus;
    /** One-line description for the Add menu. */
    description: string;
    /**
     * If true, only one instance is expected at a time (advisory; the host does
     * not currently enforce it). Useful for heavy/singleton surfaces.
     */
    singleton?: boolean;
}

/**
 * The registry. Keys are the stable panel ids used everywhere (Add menu,
 * presets, serialized layouts). Order here is the Add-menu order.
 */
export const PANELS = {
    chart: {
        id: "chart",
        title: "Chart",
        category: "Markets",
        load: () => import("./components/ChartPanel.svelte"),
        defaultParams: { symbol: "MGC", interval: "5m" },
        status: "real",
        description: "Candlestick chart with live bars (reuses MiniChart).",
    },
    signals: {
        id: "signals",
        title: "Signals",
        category: "Trading",
        load: () => import("./components/SignalsPanel.svelte"),
        defaultParams: { status: "staging" },
        status: "real",
        description: "Live signals feed from /api/signals.",
    },
    netWorth: {
        id: "netWorth",
        title: "Net Worth",
        category: "Trading",
        load: () => import("./components/NetWorthPanel.svelte"),
        defaultParams: {},
        status: "real",
        description: "Net worth + per-venue balances from the spot bot /status.",
    },
    monitorStat: {
        id: "monitorStat",
        title: "Monitor Stat",
        category: "System",
        load: () => import("./components/MonitoringStatPanel.svelte"),
        defaultParams: {
            query: "100 - avg(rate(node_cpu_seconds_total{mode='idle'}[5m]))*100",
            label: "CPU %",
            unit: "%",
            decimals: 1,
        },
        status: "real",
        description: "A single Prometheus metric (PromQL) as a big-number stat.",
    },
    notes: {
        id: "notes",
        title: "Notes",
        category: "Notes",
        load: () => import("./components/NotesPanel.svelte"),
        defaultParams: { noteKey: "default" },
        status: "real",
        description: "A localStorage-backed scratchpad / trade-journal note.",
    },

    bots: {
        id: "bots",
        title: "Bots",
        category: "System",
        load: () => import("./components/BotsPanel.svelte"),
        defaultParams: { intervalMs: 3000 },
        status: "real",
        description: "Compact running-bots list from /api/spawner/containers.",
    },
    performance: {
        id: "performance",
        title: "Performance",
        category: "Trading",
        load: () => import("./components/PerformancePanel.svelte"),
        defaultParams: { intervalMs: 10000 },
        status: "real",
        description: "Key PnL / win-rate / Sharpe stats from /api/performance.",
    },

    janusAi: {
        id: "janusAi",
        title: "Janus AI",
        category: "Markets",
        load: () => import("./components/JanusAiPanel.svelte"),
        defaultParams: { intervalMs: 10000 },
        status: "real",
        description: "Live janus status + market regime from /api/janus/state.",
    },
    docs: {
        id: "docs",
        title: "Docs",
        category: "Notes",
        load: () => import("./components/DocsPanel.svelte"),
        defaultParams: { src: "/docs-viewer/" },
        status: "real",
        description: "In-app documentation (embedded MkDocs site).",
    },
} as const satisfies Record<string, PanelDef>;

/** The set of valid panel ids. */
export type PanelId = keyof typeof PANELS;

/** Look up a panel definition by id. Returns undefined for unknown ids. */
export function getPanel(id: string): PanelDef | undefined {
    return (PANELS as Record<string, PanelDef>)[id];
}

/** True if `id` is a registered panel. */
export function isPanelId(id: string): id is PanelId {
    return Object.prototype.hasOwnProperty.call(PANELS, id);
}

/** All panel definitions, in registry (Add-menu) order. */
export function listPanels(): PanelDef[] {
    return Object.values(PANELS) as PanelDef[];
}

/** Panel definitions grouped by category, preserving registry order. */
export function panelsByCategory(): { category: PanelCategory; panels: PanelDef[] }[] {
    const order: PanelCategory[] = ["Markets", "Trading", "System", "Notes"];
    const groups = new Map<PanelCategory, PanelDef[]>();
    for (const p of listPanels()) {
        const arr = groups.get(p.category) ?? [];
        arr.push(p);
        groups.set(p.category, arr);
    }
    return order
        .filter((c) => groups.has(c))
        .map((category) => ({ category, panels: groups.get(category)! }));
}

/** Merge a panel's defaults with caller-supplied params (params win). */
export function paramsFor(
    id: string,
    overrides?: Record<string, unknown>,
): Record<string, unknown> {
    const def = getPanel(id);
    return { ...(def?.defaultParams ?? {}), ...(overrides ?? {}) };
}
