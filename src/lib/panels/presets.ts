/**
 * Preset layouts
 * ==============
 *
 * Ready-made arrangements so `/workspace` is useful before anyone hand-builds a
 * layout. Presets are declarative *data* (pure, testable) — the DockviewHost
 * translates them into `api.addPanel(...)` calls. Each panel is placed relative
 * to an earlier one via `direction` + `referenceIndex` (index into this
 * preset's own `panels` array; omit to attach to the previous panel; the first
 * panel needs neither).
 *
 * Keeping presets as data (not imperative builders) means a unit test can
 * assert every referenced `panelId` exists in the registry.
 */
import { isPanelId, type PanelId } from "./registry";

export type Direction = "left" | "right" | "above" | "below" | "within";

export interface PresetPanel {
    /** Registered panel id. */
    panelId: PanelId;
    /** Param overrides merged over the panel's defaults. */
    params?: Record<string, unknown>;
    /** Placement relative to `referenceIndex` (or previous panel). */
    direction?: Direction;
    /** Index (into this preset's panels) of the panel to place relative to. */
    referenceIndex?: number;
    /** Optional explicit tab title (defaults to the panel's title). */
    title?: string;
}

export interface LayoutPreset {
    id: string;
    label: string;
    description: string;
    panels: PresetPanel[];
}

/**
 * "Trading": chart-centric — a big chart, signals docked to the right, net
 * worth tabbed under signals, and a notes strip along the bottom.
 */
const trading: LayoutPreset = {
    id: "trading",
    label: "Trading",
    description: "Chart + signals + net worth + notes.",
    panels: [
        { panelId: "chart", params: { symbol: "MGC", interval: "5m" } },
        { panelId: "signals", direction: "right", referenceIndex: 0 },
        { panelId: "netWorth", direction: "within", referenceIndex: 1 },
        { panelId: "notes", direction: "below", referenceIndex: 0 },
    ],
};

/**
 * "Monitoring": ops view — CPU + memory stats across the top, bots list below,
 * signals to the side.
 */
const monitoring: LayoutPreset = {
    id: "monitoring",
    label: "Monitoring",
    description: "System stats + bots + signals.",
    panels: [
        {
            panelId: "monitorStat",
            params: {
                query: "100 - avg(rate(node_cpu_seconds_total{mode='idle'}[5m]))*100",
                label: "CPU %",
                unit: "%",
            },
            title: "CPU",
        },
        {
            panelId: "monitorStat",
            params: {
                query: "100*(1-node_memory_MemAvailable_bytes/node_memory_MemTotal_bytes)",
                label: "Memory %",
                unit: "%",
            },
            title: "Memory",
            direction: "right",
            referenceIndex: 0,
        },
        { panelId: "bots", direction: "below", referenceIndex: 0 },
        { panelId: "signals", direction: "right", referenceIndex: 2 },
    ],
};

export const PRESETS: LayoutPreset[] = [trading, monitoring];

/** Look up a preset by id. */
export function getPreset(id: string): LayoutPreset | undefined {
    return PRESETS.find((p) => p.id === id);
}

/**
 * Validate that every panel referenced by a preset is a registered panel and
 * every `referenceIndex` points at an earlier panel. Returns the list of
 * problems (empty ⇒ valid). Used by tests and defensive callers.
 */
export function validatePreset(preset: LayoutPreset): string[] {
    const problems: string[] = [];
    preset.panels.forEach((p, i) => {
        if (!isPanelId(p.panelId)) {
            problems.push(`panel[${i}] unknown panelId "${p.panelId}"`);
        }
        if (p.referenceIndex != null) {
            if (p.referenceIndex < 0 || p.referenceIndex >= i) {
                problems.push(
                    `panel[${i}] referenceIndex ${p.referenceIndex} must point at an earlier panel`,
                );
            }
        }
    });
    return problems;
}
