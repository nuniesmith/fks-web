<script lang="ts">
    /**
     * BotsPanel — a compact, dockable running-bots list.
     *
     * A lighter, read-only view of `/bots`: it polls the same
     * `/api/spawner/containers` endpoint (via `createPoll`, so multiple copies
     * of this panel share ONE backend poll) and renders each container as a
     * dense row — state, name, mode, live uptime, CPU + memory. Lifecycle
     * actions (spawn/stop/restart/logs) stay on the full `/bots` page; this is a
     * monitoring surface for a workspace layout.
     *
     * Reuses the shared spawner types (`ContainerInfo`, `ContainersResponse`).
     */
    import { createPoll } from "$stores/poll";
    import Badge from "$components/ui/Badge.svelte";
    import EmptyState from "$components/ui/EmptyState.svelte";
    import type {
        ContainerInfo,
        ContainersResponse,
    } from "$lib/types/spawner";

    let { intervalMs = 3000 } = $props<{ intervalMs?: number }>();

    let resp = $state<ContainersResponse | null>(null);

    // createPoll takes a fixed interval, so (re)build the poller whenever
    // `intervalMs` changes. Multiple copies of this panel share ONE backend
    // poll via the deduped shared-poller registry in $stores/poll.
    $effect(() => {
        const poll = createPoll<ContainersResponse>(
            "/api/spawner/containers",
            intervalMs,
        );
        const unsub = poll.subscribe((v) => (resp = v));
        poll.start();
        return () => {
            unsub();
            poll.stop();
        };
    });

    let loaded = $derived(resp != null);
    let containers = $derived<ContainerInfo[]>(resp?.containers ?? []);
    let running = $derived<number>(resp?.running ?? 0);
    let total = $derived<number>(resp?.total ?? containers.length);

    function stateBadge(
        state: string,
    ): "green" | "red" | "amber" | "cyan" | "default" {
        const s = state.toLowerCase();
        if (s === "running") return "green";
        if (s === "exited" || s === "dead") return "red";
        if (s === "created" || s === "restarting") return "amber";
        if (s === "paused") return "cyan";
        return "default";
    }

    function fmtBytes(b: number | null): string {
        if (b == null) return "—";
        if (b < 1024) return `${b} B`;
        if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
        if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
        return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }

    function fmtRuntime(secs: number): string {
        if (secs < 60) return `${secs}s`;
        if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        return `${h}h ${m}m`;
    }

    /// Live uptime for a running container, derived from its start time.
    /// Refreshes on each poll (list re-renders every intervalMs).
    function uptime(c: ContainerInfo): string {
        if (c.state !== "running") return "—";
        const start = c.started_at ?? c.created_at;
        if (!start) return "—";
        const ms = Date.now() - Date.parse(start);
        if (!Number.isFinite(ms) || ms < 0) return "—";
        return fmtRuntime(Math.floor(ms / 1000));
    }
</script>

<div class="bots-panel">
    {#if !loaded}
        <div class="head dim">Loading bots…</div>
    {:else if containers.length === 0}
        <EmptyState
            icon="◍"
            title="No bot containers"
            hint="Spawn one from the /bots page."
        />
    {:else}
        <div class="head">
            <span class="running">{running} running</span>
            <span class="dim">/ {total} total</span>
        </div>
        <ul class="list">
            {#each containers as c (c.id)}
                <li class="row">
                    <Badge variant={stateBadge(c.state)}>{c.state}</Badge>
                    <span class="name" title={c.name}>{c.name}</span>
                    <span class="mode dim">{c.mode}</span>
                    <span class="meta">
                        {#if c.state === "running"}
                            <span class="cell mono" title="Uptime"
                                >↑ {uptime(c)}</span
                            >
                        {/if}
                        {#if c.cpu_percent != null}
                            <span class="cell mono" title="CPU"
                                >{c.cpu_percent.toFixed(1)}%</span
                            >
                        {/if}
                        {#if c.memory_bytes != null}
                            <span class="cell mono" title="Memory"
                                >{fmtBytes(c.memory_bytes)}</span
                            >
                        {/if}
                    </span>
                </li>
            {/each}
        </ul>
    {/if}
</div>

<style>
    .bots-panel {
        width: 100%;
        height: 100%;
        overflow-y: auto;
        background: var(--bg1);
        font-size: 11px;
    }
    .head {
        display: flex;
        align-items: baseline;
        gap: 6px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--b1);
        font-size: 11px;
    }
    .running {
        font-weight: 700;
        color: var(--green);
    }
    .dim {
        color: var(--t3);
    }
    .list {
        list-style: none;
        margin: 0;
        padding: 0;
    }
    .row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 10px;
        border-bottom: 1px solid var(--b1);
    }
    .name {
        font-weight: 600;
        color: var(--t1);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 40%;
    }
    .mode {
        font-size: 10px;
        text-transform: uppercase;
    }
    .meta {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 8px;
        white-space: nowrap;
    }
    .cell {
        color: var(--t2);
        font-size: 10px;
    }
    .mono {
        font-variant-numeric: tabular-nums;
    }
</style>
