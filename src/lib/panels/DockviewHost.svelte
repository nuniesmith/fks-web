<script lang="ts">
    /**
     * DockviewHost — a thin Svelte 5 adapter over dockview-core's vanilla API.
     *
     * dockview-core is framework-agnostic: panels are plain DOM elements. This
     * component owns the imperative `DockviewApi` and bridges it to Svelte by
     * `mount()`-ing the registered panel component into dockview's supplied
     * element (and `unmount()`-ing on dispose). Panel params round-trip through
     * dockview's own `params`, so `api.toJSON()` fully captures the layout.
     *
     * The parent (`/workspace/+page.svelte`) drives it via the exported
     * instance methods (`addPanel`, `applyPreset`, `loadLayout`, `reset`,
     * `toJSON`) accessed through `bind:this`, and is notified of every change
     * via `onLayoutChange` for persistence.
     */
    import { onMount, onDestroy, mount, unmount } from "svelte";
    import {
        createDockview,
        themeDark,
        type DockviewApi,
        type IContentRenderer,
        type GroupPanelPartInitParameters,
        type SerializedDockview,
    } from "dockview-core";
    import "dockview-core/dist/styles/dockview.css";
    import "./theme.css";
    import { getPanel, paramsFor } from "./registry";
    import type { LayoutPreset, Direction } from "./presets";

    let { onLayoutChange }: { onLayoutChange?: (json: SerializedDockview) => void } =
        $props();

    let el: HTMLDivElement;
    let api: DockviewApi | null = null;

    function uid(): string {
        return typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID().slice(0, 8)
            : Math.random().toString(36).slice(2, 10);
    }

    /**
     * dockview calls this once per panel it needs to render. We return a
     * content renderer that mounts the Svelte component for `options.name`
     * (the registered panel id) into dockview's element.
     */
    function createComponent(options: { id: string; name: string }): IContentRenderer {
        const element = document.createElement("div");
        element.style.height = "100%";
        element.style.width = "100%";
        element.style.overflow = "hidden";

        let instance: Record<string, unknown> | null = null;
        let disposed = false;
        // Bumped on every render so a slow async load that resolves after a
        // newer render (or after dispose) is discarded.
        let renderToken = 0;

        function render(params: Record<string, unknown>) {
            const def = getPanel(options.name);
            if (!def) return;
            const token = ++renderToken;
            if (instance) {
                unmount(instance);
                instance = null;
            }
            void def.load().then((mod) => {
                if (disposed || token !== renderToken) return;
                instance = mount(mod.default, { target: element, props: params });
            });
        }

        return {
            element,
            init(parameters: GroupPanelPartInitParameters) {
                render(parameters.params ?? {});
            },
            // Params changed (e.g. reconfigured panel) → remount with new props.
            update(event) {
                const next = (event.params ?? {}) as Record<string, unknown>;
                render(next);
            },
            dispose() {
                disposed = true;
                if (instance) {
                    unmount(instance);
                    instance = null;
                }
            },
        };
    }

    onMount(() => {
        api = createDockview(el, {
            theme: themeDark,
            createComponent,
            disableFloatingGroups: false,
        });

        // Persist on every layout mutation (add/remove/move/resize/tab).
        const sub = api.onDidLayoutChange(() => {
            if (api) onLayoutChange?.(api.toJSON());
        });

        return () => sub.dispose();
    });

    onDestroy(() => {
        api?.dispose();
        api = null;
    });

    // ── Exported instance API (called by the /workspace route) ──────────────

    /** Add a fresh panel instance to the active group (as a new tab). */
    export function addPanel(
        panelId: string,
        params?: Record<string, unknown>,
    ): string | undefined {
        if (!api) return undefined;
        const def = getPanel(panelId);
        if (!def) return undefined;
        const id = `${panelId}-${uid()}`;
        api.addPanel({
            id,
            component: panelId,
            title: def.title,
            params: paramsFor(panelId, params),
        });
        return id;
    }

    /** Replace the current layout with a preset arrangement. */
    export function applyPreset(preset: LayoutPreset): void {
        if (!api) return;
        api.clear();
        const placed: string[] = [];
        preset.panels.forEach((p, i) => {
            const def = getPanel(p.panelId);
            if (!def) return;
            const id = `${p.panelId}-${uid()}`;
            const refIndex = p.referenceIndex ?? i - 1;
            const refId = refIndex >= 0 ? placed[refIndex] : undefined;
            const direction: Direction = p.direction ?? "right";

            api!.addPanel({
                id,
                component: p.panelId,
                title: p.title ?? def.title,
                params: paramsFor(p.panelId, p.params),
                ...(refId
                    ? { position: { referencePanel: refId, direction } }
                    : {}),
            });
            placed[i] = id;
        });
    }

    /** Restore a previously serialized layout. Returns false on failure. */
    export function loadLayout(layout: SerializedDockview): boolean {
        if (!api) return false;
        try {
            api.fromJSON(layout);
            return true;
        } catch (e) {
            console.warn("[DockviewHost] failed to restore layout:", e);
            return false;
        }
    }

    /** Clear all panels. */
    export function reset(): void {
        api?.clear();
    }

    /** Current serialized layout, or null if not ready. */
    export function toJSON(): SerializedDockview | null {
        return api ? api.toJSON() : null;
    }

    /** Number of open panels. */
    export function panelCount(): number {
        return api ? api.panels.length : 0;
    }
</script>

<div class="fks-dock" bind:this={el}></div>

<style>
    .fks-dock {
        width: 100%;
        height: 100%;
        overflow: hidden;
    }
</style>
