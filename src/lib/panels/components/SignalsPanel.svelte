<script lang="ts">
    /**
     * SignalsPanel — a compact, dockable live signals feed.
     *
     * A lighter view of `/signals`: it polls the same `/api/signals` adapter
     * endpoint (via `createPoll`) and renders the staging/approved feed as a
     * dense list. No approve/reject actions here — those stay on the full page;
     * this is a monitoring surface for a workspace layout.
     */
    import { createPoll } from "$stores/poll";
    import Badge from "$components/ui/Badge.svelte";
    import EmptyState from "$components/ui/EmptyState.svelte";
    import { fmtDateTime } from "$lib/utils/format";

    interface Signal {
        id: string;
        symbol: string;
        type?: string;
        side?: string;
        status?: string;
        price?: number;
        timestamp?: string;
        message?: string;
    }
    interface SignalsResponse {
        signals: Signal[];
    }

    let { status = "staging" } = $props<{ status?: string }>();

    let signals = $state<Signal[]>([]);

    function buildUrl(s: string): string {
        return s ? `/api/signals?status=${s}` : "/api/signals";
    }

    // createPoll takes a fixed URL, so (re)build the poller whenever `status`
    // changes. The effect handles both the initial start and cleanup.
    $effect(() => {
        const poll = createPoll<SignalsResponse>(buildUrl(status), 8000);
        const unsub = poll.subscribe((v) => {
            signals = v?.signals ?? [];
        });
        poll.start();
        return () => {
            unsub();
            poll.stop();
        };
    });

    function statusVariant(s?: string): "green" | "amber" | "red" | "default" {
        if (s === "approved") return "green";
        if (s === "rejected") return "red";
        if (s === "staging") return "amber";
        return "default";
    }
</script>

<div class="signals-panel">
    {#if signals.length === 0}
        <EmptyState icon="∅" title="No signals" hint="No {status || 'live'} signals right now." />
    {:else}
        <ul class="feed">
            {#each signals as sig (sig.id)}
                <li class="row">
                    <span class="sym">{sig.symbol}</span>
                    {#if sig.side}<span class="side">{sig.side}</span>{/if}
                    {#if sig.type}<span class="type">{sig.type}</span>{/if}
                    <Badge variant={statusVariant(sig.status)}>{sig.status ?? "?"}</Badge>
                    <span class="ts">{sig.timestamp ? fmtDateTime(sig.timestamp) : ""}</span>
                </li>
            {/each}
        </ul>
    {/if}
</div>

<style>
    .signals-panel {
        width: 100%;
        height: 100%;
        overflow-y: auto;
        background: var(--bg1);
        font-size: 11px;
    }
    .feed {
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
    .sym {
        font-weight: 700;
        color: var(--t1);
        min-width: 60px;
    }
    .side {
        color: var(--cyan);
        text-transform: uppercase;
        font-size: 10px;
    }
    .type {
        color: var(--t2);
        font-size: 10px;
    }
    .ts {
        margin-left: auto;
        color: var(--t3);
        font-size: 10px;
        white-space: nowrap;
    }
</style>
