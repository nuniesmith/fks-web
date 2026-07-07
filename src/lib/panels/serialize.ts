/**
 * Layout serialization helpers
 * ============================
 *
 * Pure, framework-free helpers for persisting a dockview layout to
 * localStorage. dockview's `api.toJSON()` produces a `SerializedDockview`
 * object; we wrap it with a version + timestamp envelope so future schema
 * changes can be detected and stale/corrupt blobs discarded gracefully.
 *
 * Kept dockview-free at runtime (only a type import) so it is trivially
 * unit-testable and reusable if the layout engine is ever swapped.
 */
import type { SerializedDockview } from "dockview-core";
import { isPanelId } from "./registry";

/** Bump when the envelope or dockview layout schema changes incompatibly. */
export const LAYOUT_VERSION = 1;

/** localStorage key the `/workspace` route reads/writes. */
export const STORAGE_KEY = "fks:workspace:layout:v1";

/** Versioned envelope stored in localStorage. */
export interface StoredLayout {
    version: number;
    savedAt: number;
    layout: SerializedDockview;
}

/**
 * Wrap a raw dockview layout in the versioned envelope.
 * `now` is injectable for deterministic tests.
 */
export function wrapLayout(
    layout: SerializedDockview,
    now: number = Date.now(),
): StoredLayout {
    return { version: LAYOUT_VERSION, savedAt: now, layout };
}

/** Serialize a raw dockview layout to a storable JSON string. */
export function serializeLayout(
    layout: SerializedDockview,
    now: number = Date.now(),
): string {
    return JSON.stringify(wrapLayout(layout, now));
}

/**
 * Structural guard: does this look like a dockview layout we can restore?
 * Checks the two top-level keys dockview always emits (`grid`, `panels`).
 */
export function isSerializedDockview(v: unknown): v is SerializedDockview {
    if (v == null || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    return (
        typeof o.grid === "object" &&
        o.grid != null &&
        typeof o.panels === "object" &&
        o.panels != null
    );
}

/** Guard for the stored envelope (correct version + valid inner layout). */
export function isStoredLayout(v: unknown): v is StoredLayout {
    if (v == null || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    return (
        o.version === LAYOUT_VERSION &&
        typeof o.savedAt === "number" &&
        isSerializedDockview(o.layout)
    );
}

/**
 * Parse a stored JSON string back into a dockview layout, or `null` if it is
 * missing / corrupt / a different version. Never throws.
 */
export function deserializeLayout(raw: string | null): SerializedDockview | null {
    if (!raw) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!isStoredLayout(parsed)) return null;
    return parsed.layout;
}

/**
 * List the `contentComponent` (panel) ids referenced by a serialized layout.
 * Used to detect layouts that reference panels no longer in the registry.
 */
export function panelComponentIds(layout: SerializedDockview): string[] {
    const panels = layout.panels ?? {};
    const ids: string[] = [];
    for (const key of Object.keys(panels)) {
        const comp = panels[key]?.contentComponent;
        if (typeof comp === "string") ids.push(comp);
    }
    return ids;
}

/**
 * True if every panel in the layout maps to a registered panel id. A layout
 * referencing an unknown panel would render dockview's fallback, so callers
 * may choose to discard it and fall back to a preset.
 */
export function allPanelsKnown(layout: SerializedDockview): boolean {
    return panelComponentIds(layout).every((id) => isPanelId(id));
}
