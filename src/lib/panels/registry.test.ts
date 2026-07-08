import { describe, it, expect } from "vitest";
import {
    PANELS,
    getPanel,
    isPanelId,
    listPanels,
    panelsByCategory,
    paramsFor,
} from "./registry";

describe("panel registry", () => {
    it("every entry's id matches its map key", () => {
        for (const [key, def] of Object.entries(PANELS)) {
            expect(def.id).toBe(key);
        }
    });

    it("every panel has a loader, title, category and status", () => {
        for (const def of listPanels()) {
            expect(def.title.length).toBeGreaterThan(0);
            expect(typeof def.load).toBe("function");
            expect(["real", "placeholder"]).toContain(def.status);
            expect(["Markets", "Trading", "System", "Notes"]).toContain(
                def.category,
            );
        }
    });

    it("panel ids are unique", () => {
        const ids = listPanels().map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("ships a full set of real panels (all placeholders now extracted)", () => {
        const real = listPanels().filter((p) => p.status === "real");
        const stub = listPanels().filter((p) => p.status === "placeholder");
        // Every registered panel now renders real data. The `placeholder`
        // status remains a valid option for future not-yet-built panels.
        expect(real.length).toBeGreaterThanOrEqual(6);
        expect(real.length).toBe(listPanels().length);
        expect(stub.length).toBe(0);
    });

    it("getPanel resolves known ids and rejects unknown ones", () => {
        expect(getPanel("chart")?.id).toBe("chart");
        expect(getPanel("does-not-exist")).toBeUndefined();
    });

    it("isPanelId is a correct type guard", () => {
        expect(isPanelId("signals")).toBe(true);
        expect(isPanelId("nope")).toBe(false);
    });

    it("panelsByCategory partitions all panels with no loss", () => {
        const grouped = panelsByCategory();
        const total = grouped.reduce((n, g) => n + g.panels.length, 0);
        expect(total).toBe(listPanels().length);
    });

    it("paramsFor merges defaults with overrides (overrides win)", () => {
        const p = paramsFor("chart", { symbol: "BTCUSDT" });
        expect(p.symbol).toBe("BTCUSDT"); // override
        expect(p.interval).toBe("5m"); // default preserved
    });

    it("paramsFor on an unknown panel returns just the overrides", () => {
        expect(paramsFor("unknown", { a: 1 })).toEqual({ a: 1 });
        expect(paramsFor("unknown")).toEqual({});
    });
});
