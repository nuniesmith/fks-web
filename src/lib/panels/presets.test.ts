import { describe, it, expect } from "vitest";
import { PRESETS, getPreset, validatePreset } from "./presets";
import { isPanelId } from "./registry";

describe("layout presets", () => {
    it("exposes at least the Trading and Monitoring presets", () => {
        const ids = PRESETS.map((p) => p.id);
        expect(ids).toContain("trading");
        expect(ids).toContain("monitoring");
    });

    it("preset ids are unique", () => {
        const ids = PRESETS.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("every preset references only registered panels", () => {
        for (const preset of PRESETS) {
            for (const p of preset.panels) {
                expect(isPanelId(p.panelId)).toBe(true);
            }
        }
    });

    it("every preset validates (panels known + refs point backwards)", () => {
        for (const preset of PRESETS) {
            expect(validatePreset(preset)).toEqual([]);
        }
    });

    it("validatePreset flags a forward/self reference", () => {
        const problems = validatePreset({
            id: "bad",
            label: "Bad",
            description: "",
            panels: [
                { panelId: "chart" },
                { panelId: "signals", referenceIndex: 2 }, // points past itself
            ],
        });
        expect(problems.length).toBeGreaterThan(0);
    });

    it("getPreset resolves by id", () => {
        expect(getPreset("trading")?.label).toBe("Trading");
        expect(getPreset("nope")).toBeUndefined();
    });
});
