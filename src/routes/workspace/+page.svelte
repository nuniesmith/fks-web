<script lang="ts">
    /**
     * /workspace — the dockable panel layout ("snap windows like a real
     * trading platform").
     *
     * Hosts `DockviewHost` (dockview-core) and drives it from the panel
     * registry: a "+ Add panel" menu, preset layouts, and a reset button. The
     * layout is persisted to localStorage on every change and restored on
     * mount, so an operator's arrangement survives reloads.
     *
     * This route is purely additive — every existing route-per-page surface is
     * untouched and keeps working.
     */
    import { onMount } from "svelte";
    import type { SerializedDockview } from "dockview-core";
    import DockviewHost from "$lib/panels/DockviewHost.svelte";
    import { panelsByCategory } from "$lib/panels/registry";
    import { PRESETS, getPreset, type LayoutPreset } from "$lib/panels/presets";
    import {
        STORAGE_KEY,
        serializeLayout,
        deserializeLayout,
        allPanelsKnown,
    } from "$lib/panels/serialize";

    interface DockHost {
        addPanel(panelId: string, params?: Record<string, unknown>): string | undefined;
        applyPreset(preset: LayoutPreset): void;
        loadLayout(layout: SerializedDockview): boolean;
        reset(): void;
        toJSON(): SerializedDockview | null;
        panelCount(): number;
    }

    let host = $state<DockHost | undefined>();
    let ready = $state(false);
    let addMenuOpen = $state(false);

    const groups = panelsByCategory();

    function persist(layout: SerializedDockview) {
        if (!ready) return;
        try {
            localStorage.setItem(STORAGE_KEY, serializeLayout(layout));
        } catch {
            /* quota / privacy mode — non-fatal */
        }
    }

    function restore(): boolean {
        try {
            const saved = deserializeLayout(localStorage.getItem(STORAGE_KEY));
            if (saved && allPanelsKnown(saved) && host?.loadLayout(saved)) {
                return true;
            }
        } catch {
            /* fall through to default preset */
        }
        return false;
    }

    onMount(() => {
        // Child (DockviewHost) has already mounted at this point, so `host` is
        // bound and its dockview api is live.
        if (!restore()) {
            const trading = getPreset("trading");
            if (trading) host?.applyPreset(trading);
        }
        ready = true;
    });

    function addPanel(panelId: string) {
        host?.addPanel(panelId);
        addMenuOpen = false;
    }

    function applyPreset(preset: LayoutPreset) {
        host?.applyPreset(preset);
    }

    function resetLayout() {
        host?.reset();
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch {
            /* ignore */
        }
    }
</script>

<div class="workspace">
    <header class="ws-toolbar">
        <div class="ws-title">
            <span class="dot"></span>
            Workspace
        </div>

        <div class="ws-actions">
            <!-- Add panel menu -->
            <div class="menu-wrap">
                <button
                    class="btn primary"
                    onclick={() => (addMenuOpen = !addMenuOpen)}
                    aria-expanded={addMenuOpen}
                >
                    + Add panel
                </button>
                {#if addMenuOpen}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div
                        class="menu"
                        role="menu"
                        tabindex="-1"
                    >
                        {#each groups as group (group.category)}
                            <div class="menu-group-label">{group.category}</div>
                            {#each group.panels as panel (panel.id)}
                                <button
                                    class="menu-item"
                                    role="menuitem"
                                    onclick={() => addPanel(panel.id)}
                                >
                                    <span class="mi-title">{panel.title}</span>
                                    {#if panel.status === "placeholder"}
                                        <span class="mi-tag">stub</span>
                                    {/if}
                                    <span class="mi-desc">{panel.description}</span>
                                </button>
                            {/each}
                        {/each}
                    </div>
                {/if}
            </div>

            <!-- Presets -->
            <div class="preset-group">
                <span class="lbl">Presets</span>
                {#each PRESETS as preset (preset.id)}
                    <button
                        class="btn"
                        title={preset.description}
                        onclick={() => applyPreset(preset)}
                    >
                        {preset.label}
                    </button>
                {/each}
            </div>

            <button class="btn ghost" onclick={resetLayout}>Reset</button>
        </div>
    </header>

    <!-- Click-away catcher for the add menu -->
    {#if addMenuOpen}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="scrim" onclick={() => (addMenuOpen = false)}></div>
    {/if}

    <div class="ws-body">
        <DockviewHost bind:this={host} onLayoutChange={persist} />
    </div>
</div>

<style>
    .workspace {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        background: var(--bg0);
    }

    .ws-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 6px 12px;
        background: var(--bg1);
        border-bottom: 1px solid var(--b2);
        flex-shrink: 0;
    }

    .ws-title {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        font-weight: 700;
        color: var(--t1);
    }
    .ws-title .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--accent);
    }

    .ws-actions {
        display: flex;
        align-items: center;
        gap: 12px;
    }

    .preset-group {
        display: flex;
        align-items: center;
        gap: 4px;
    }
    .preset-group .lbl {
        font-size: 8px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--t3);
        margin-right: 2px;
    }

    .btn {
        font-family: inherit;
        font-size: 11px;
        color: var(--t2);
        background: var(--bg2);
        border: 1px solid var(--b2);
        border-radius: var(--r-md, 5px);
        padding: 4px 10px;
        cursor: pointer;
        transition:
            color 0.15s,
            background 0.15s,
            border-color 0.15s;
    }
    .btn:hover {
        color: var(--t1);
        background: var(--bg3);
        border-color: var(--accent);
    }
    .btn.primary {
        color: var(--t1);
        border-color: var(--accent);
    }
    .btn.ghost {
        background: transparent;
    }

    .menu-wrap {
        position: relative;
    }
    .menu {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        z-index: 30;
        min-width: 280px;
        max-height: 70vh;
        overflow-y: auto;
        background: var(--bg2);
        border: 1px solid var(--b2);
        border-radius: var(--r-md, 5px);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
        padding: 4px;
    }
    .menu-group-label {
        font-size: 8px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--t3);
        padding: 6px 8px 2px;
    }
    .menu-item {
        display: grid;
        grid-template-columns: auto auto;
        grid-template-rows: auto auto;
        gap: 2px 6px;
        align-items: center;
        justify-content: start;
        width: 100%;
        text-align: left;
        background: transparent;
        border: none;
        border-radius: 4px;
        padding: 6px 8px;
        cursor: pointer;
    }
    .menu-item:hover {
        background: var(--bg3);
    }
    .mi-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--t1);
    }
    .mi-tag {
        font-size: 8px;
        text-transform: uppercase;
        color: var(--amber);
        border: 1px solid var(--amber);
        border-radius: 3px;
        padding: 0 3px;
    }
    .mi-desc {
        grid-column: 1 / -1;
        font-size: 10px;
        color: var(--t3);
    }

    .scrim {
        position: fixed;
        inset: 0;
        z-index: 20;
    }

    .ws-body {
        flex: 1;
        min-height: 0;
        position: relative;
    }
</style>
