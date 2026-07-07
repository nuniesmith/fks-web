import { describe, it, expect } from "vitest";
import type { SerializedDockview } from "dockview-core";
import {
    LAYOUT_VERSION,
    wrapLayout,
    serializeLayout,
    deserializeLayout,
    isSerializedDockview,
    isStoredLayout,
    panelComponentIds,
    allPanelsKnown,
} from "./serialize";

/** A minimal but structurally-valid dockview layout referencing real panels. */
function fakeLayout(components: string[]): SerializedDockview {
    const panels: Record<string, unknown> = {};
    components.forEach((comp, i) => {
        panels[`p${i}`] = {
            id: `p${i}`,
            contentComponent: comp,
            title: comp,
        };
    });
    return {
        grid: { root: { type: "leaf" }, width: 800, height: 600, orientation: "HORIZONTAL" },
        panels,
        activeGroup: "g0",
    } as unknown as SerializedDockview;
}

describe("layout serialization", () => {
    it("wraps a layout in a versioned, timestamped envelope", () => {
        const env = wrapLayout(fakeLayout(["chart"]), 12345);
        expect(env.version).toBe(LAYOUT_VERSION);
        expect(env.savedAt).toBe(12345);
        expect(env.layout).toBeTruthy();
    });

    it("round-trips through serialize/deserialize", () => {
        const layout = fakeLayout(["chart", "signals"]);
        const restored = deserializeLayout(serializeLayout(layout, 1));
        expect(restored).toEqual(layout);
    });

    it("deserialize returns null for missing / empty input", () => {
        expect(deserializeLayout(null)).toBeNull();
        expect(deserializeLayout("")).toBeNull();
    });

    it("deserialize returns null for corrupt JSON", () => {
        expect(deserializeLayout("{not json")).toBeNull();
    });

    it("deserialize rejects a version mismatch", () => {
        const bad = JSON.stringify({
            version: LAYOUT_VERSION + 1,
            savedAt: 1,
            layout: fakeLayout(["chart"]),
        });
        expect(deserializeLayout(bad)).toBeNull();
    });

    it("deserialize rejects a structurally-invalid layout", () => {
        const bad = JSON.stringify({
            version: LAYOUT_VERSION,
            savedAt: 1,
            layout: { grid: null, panels: null },
        });
        expect(deserializeLayout(bad)).toBeNull();
    });

    it("isSerializedDockview guards on grid + panels", () => {
        expect(isSerializedDockview(fakeLayout(["chart"]))).toBe(true);
        expect(isSerializedDockview({})).toBe(false);
        expect(isSerializedDockview(null)).toBe(false);
        expect(isSerializedDockview({ grid: {} })).toBe(false);
    });

    it("isStoredLayout guards the full envelope", () => {
        expect(isStoredLayout(wrapLayout(fakeLayout(["chart"])))).toBe(true);
        expect(isStoredLayout({ version: LAYOUT_VERSION })).toBe(false);
    });

    it("panelComponentIds lists every referenced panel id", () => {
        const ids = panelComponentIds(fakeLayout(["chart", "signals", "notes"]));
        expect(ids.sort()).toEqual(["chart", "notes", "signals"]);
    });

    it("allPanelsKnown is true for registered panels, false otherwise", () => {
        expect(allPanelsKnown(fakeLayout(["chart", "signals"]))).toBe(true);
        expect(allPanelsKnown(fakeLayout(["chart", "ghost-panel"]))).toBe(false);
    });
});
