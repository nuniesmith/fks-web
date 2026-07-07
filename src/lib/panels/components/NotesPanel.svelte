<script lang="ts">
    /**
     * NotesPanel — a dockable scratchpad / trade-journal note.
     *
     * Self-contained: text is persisted to localStorage keyed by the panel's
     * `noteKey` param, so multiple note panels in a layout keep separate notes
     * and survive reloads. No backend — a genuinely useful, zero-dependency
     * panel for a trading workspace.
     */
    import { onMount } from "svelte";

    let { noteKey = "default" } = $props<{ noteKey?: string }>();

    const storageKey = $derived(`fks:workspace:note:${noteKey}`);
    let text = $state("");
    let ready = $state(false);

    onMount(() => {
        try {
            text = localStorage.getItem(`fks:workspace:note:${noteKey}`) ?? "";
        } catch {
            /* localStorage unavailable */
        }
        ready = true;
    });

    $effect(() => {
        if (!ready) return;
        try {
            localStorage.setItem(storageKey, text);
        } catch {
            /* ignore quota / privacy mode */
        }
    });
</script>

<div class="notes-panel">
    <textarea
        bind:value={text}
        placeholder="Notes for this workspace…"
        spellcheck="false"
    ></textarea>
</div>

<style>
    .notes-panel {
        width: 100%;
        height: 100%;
        background: var(--bg1);
        box-sizing: border-box;
    }
    textarea {
        width: 100%;
        height: 100%;
        resize: none;
        border: none;
        outline: none;
        background: var(--bg1);
        color: var(--t1);
        font-family: inherit;
        font-size: 12px;
        line-height: 1.5;
        padding: 10px;
        box-sizing: border-box;
    }
    textarea::placeholder {
        color: var(--t3);
    }
</style>
