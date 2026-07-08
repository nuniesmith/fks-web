<script lang="ts">
    /**
     * DocsPanel — dockable in-app documentation.
     *
     * Embeds the self-hosted MkDocs site (`/docs-viewer/`, fks #175) — the same
     * source the full `/docs` page shows — via the shared `EmbedPage`
     * component, so a docs pane can live alongside a chart in a workspace
     * layout. `src` is overridable via panel params to deep-link a page.
     */
    import EmbedPage from "$components/ui/EmbedPage.svelte";

    let { src = "/docs-viewer/" } = $props<{ src?: string }>();
</script>

<div class="docs-panel">
    <EmbedPage {src} title="FKS Documentation" popOutHref={src} accent="var(--purple)" />
</div>

<style>
    .docs-panel {
        width: 100%;
        height: 100%;
    }
</style>
