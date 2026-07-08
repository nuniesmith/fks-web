<script lang="ts">
    /**
     * JanusAiPanel — dockable "what is janus thinking" summary.
     *
     * Reuses the `/api/janus/state` adapter (the same source the full
     * `/janus-ai` page reads — janus's Redis-published state): live status +
     * per-symbol market regime + a recent-signals count. A compact, glanceable
     * view for a workspace layout; the full page has the UMAP experience map.
     * Self-contained: polls on mount, tears down on destroy.
     */
    import { createPoll } from "$stores/poll";
    import Badge from "$components/ui/Badge.svelte";
    import EmptyState from "$components/ui/EmptyState.svelte";
    import { fmtPct } from "$lib/utils/format";

    let { intervalMs = 10000 } = $props<{ intervalMs?: number }>();

    interface RegimeEntry {
        regime: string;
        confidence: number;
        symbol?: string;
    }
    interface JanusStateResponse {
        janus: { status: string; uptime?: string; version?: string };
        redis: {
            regime: Record<string, RegimeEntry>;
            signals_recent: unknown[];
        };
    }

    let state = $state<JanusStateResponse | null>(null);

    // createPoll takes a fixed interval, so (re)build the poller whenever
    // `intervalMs` changes. Multiple copies share ONE backend poll via the
    // deduped shared-poller registry in $stores/poll.
    $effect(() => {
        const poll = createPoll<JanusStateResponse>("/api/janus/state", intervalMs);
        const unsub = poll.subscribe((v) => (state = v));
        poll.start();
        return () => {
            unsub();
            poll.stop();
        };
    });

    const status = $derived(state?.janus?.status ?? "");
    const online = $derived(/ok|online|running|healthy/i.test(status));
    const regimes = $derived<[string, RegimeEntry][]>(
        Object.entries(state?.redis?.regime ?? {}),
    );
    const recentCount = $derived(state?.redis?.signals_recent?.length ?? 0);
    const hasData = $derived(state != null);

    function regimeVariant(r: string): "green" | "red" | "amber" | "cyan" | "default" {
        const s = r.toLowerCase();
        if (s.includes("trend")) return "green";
        if (s.includes("volatil") || s.includes("chop")) return "amber";
        if (s.includes("range") || s.includes("mean")) return "cyan";
        if (s.includes("bear") || s.includes("risk")) return "red";
        return "default";
    }
</script>

<div class="janus-panel">
    {#if !hasData}
        <EmptyState icon="◇" title="Janus state unavailable" hint="/api/janus/state didn't respond." />
    {:else}
        <div class="head">
            <Badge variant={online ? "green" : "default"}>{online ? "online" : status || "unknown"}</Badge>
            {#if state?.janus?.version}<span class="ver">v{state.janus.version}</span>{/if}
            {#if state?.janus?.uptime}<span class="dim">up {state.janus.uptime}</span>{/if}
            <span class="dim spacer">{recentCount} recent signals</span>
        </div>

        {#if regimes.length > 0}
            <div class="regime-head">Market regime</div>
            <ul class="regimes">
                {#each regimes as [sym, r] (sym)}
                    <li>
                        <span class="sym">{r.symbol ?? sym}</span>
                        <Badge variant={regimeVariant(r.regime)}>{r.regime}</Badge>
                        <span class="conf">{fmtPct((r.confidence ?? 0) * 100)}</span>
                    </li>
                {/each}
            </ul>
        {:else}
            <p class="dim empty">No regime data published yet.</p>
        {/if}

        <a class="link" href="/janus-ai">Open Janus AI (experience map) →</a>
    {/if}
</div>

<style>
    .janus-panel {
        width: 100%;
        height: 100%;
        box-sizing: border-box;
        padding: 10px 12px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .head {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        font-size: 0.78rem;
    }
    .ver {
        color: var(--t2);
        font-variant-numeric: tabular-nums;
    }
    .spacer {
        margin-left: auto;
    }
    .dim {
        color: var(--t3);
    }
    .regime-head {
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--t3);
        margin-top: 2px;
    }
    .regimes {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .regimes li {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.82rem;
    }
    .sym {
        font-weight: 600;
        color: var(--t1);
        min-width: 76px;
    }
    .conf {
        margin-left: auto;
        color: var(--t2);
        font-variant-numeric: tabular-nums;
    }
    .empty {
        font-size: 0.8rem;
    }
    .link {
        margin-top: auto;
        font-size: 0.76rem;
        color: var(--cyan);
        text-decoration: none;
    }
    .link:hover {
        text-decoration: underline;
    }
</style>
