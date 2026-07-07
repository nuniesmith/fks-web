<script lang="ts">
    /**
     * PlaceholderPanel — a stub for registered-but-not-yet-built panels.
     *
     * Registry entries with `status: 'placeholder'` render this so the dock is
     * genuinely usable end to end (you can add/drag/tab/persist them) while the
     * real panel extraction (roadmap Phase A) lands page by page. `label` and
     * `route` params tell the operator what it will become.
     */
    let { label = "Panel", route = "" } = $props<{
        label?: string;
        route?: string;
    }>();
</script>

<div class="placeholder">
    <div class="icon">▨</div>
    <div class="title">{label}</div>
    <div class="hint">Coming soon — panel extraction in progress.</div>
    {#if route}
        <a class="link" href={route}>Open the full page →</a>
    {/if}
</div>

<style>
    .placeholder {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        background:
            repeating-linear-gradient(
                45deg,
                var(--bg1),
                var(--bg1) 10px,
                var(--bg2) 10px,
                var(--bg2) 20px
            );
        color: var(--t2);
        text-align: center;
        padding: 16px;
        box-sizing: border-box;
    }
    .icon {
        font-size: 28px;
        color: var(--t3);
    }
    .title {
        font-size: 13px;
        font-weight: 700;
        color: var(--t1);
    }
    .hint {
        font-size: 11px;
        color: var(--t3);
    }
    .link {
        font-size: 11px;
        color: var(--cyan);
        text-decoration: none;
    }
    .link:hover {
        text-decoration: underline;
    }
</style>
