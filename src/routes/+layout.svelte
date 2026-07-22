<!--
  Root layout — wraps every route in the terminal chrome.

  - Reads the workspace config loaded by +layout.ts and pushes it into
    Svelte context under the key 'workspace' so any descendant page can
    `getContext<WorkspaceConfig>('workspace')` without prop-drilling.
  - Renders the persistent shell: Strip (top), TabBar (nav), workspace
    (main slot), StatusBar (bottom).

  History note: this file briefly had two <script> blocks (and two
  {@render children()} calls) after a bad merge — kept the markup from
  the first version and the data/context wiring from the second.
-->
<script lang="ts">
    import "../app.css";
    import { setContext, untrack } from "svelte";
    import Strip from "$components/shell/Strip.svelte";
    import TabBar from "$components/shell/TabBar.svelte";
    import StatusBar from "$components/shell/StatusBar.svelte";
    import type { WorkspaceConfig } from "$lib/workspaces";

    // Data is loaded by +layout.ts — workspace is already resolved there.
    let { data, children } = $props();

    // Push the resolved config into context so every sub-page can read it
    // without prop-drilling. SvelteKit re-runs the layout when the active
    // route changes, so capturing the value at mount is the intended
    // behavior — `untrack` makes that explicit and silences svelte-check.
    setContext<WorkspaceConfig>("workspace", untrack(() => data.workspace));
</script>

<div class="terminal">
    <Strip />
    <TabBar />
    <main class="workspace">
        {@render children()}
    </main>
    <StatusBar />
</div>

<style>
    .terminal {
        display: flex;
        flex-direction: column;
        height: 100vh;   /* fallback for browsers without dvh */
        height: 100dvh;  /* phone: excludes dynamic browser chrome */
        overflow: hidden;
        /* PWA T3.5 — the shell root also contains overscroll so a drag that
           starts on the chrome never rubber-bands the installed app. */
        overscroll-behavior: none;
        /* Landscape notch: keep chrome + content clear of the side inset
           (viewport-fit=cover draws edge-to-edge). env() is 0 on desktop. */
        padding-left: env(safe-area-inset-left, 0px);
        padding-right: env(safe-area-inset-right, 0px);
    }
    .workspace {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        position: relative;
    }
</style>
