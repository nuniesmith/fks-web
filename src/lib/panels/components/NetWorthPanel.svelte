<script lang="ts">
    /**
     * NetWorthPanel — dockable net-worth summary.
     *
     * Reuses the `/api/exchanges/status` adapter endpoint (the same source the
     * `/exchanges` page reads — the bots' `/status` servers) and the shared
     * `ExchangesStatus` type. Shows the real (non-paper) net worth plus a
     * per-venue breakdown. A lighter view than the full holdings/rebalance page.
     */
    import { onMount, onDestroy } from "svelte";
    import { createPoll } from "$stores/poll";
    import StatCard from "$components/ui/StatCard.svelte";
    import EmptyState from "$components/ui/EmptyState.svelte";
    import { fmtDollar } from "$lib/utils/format";
    import type { ExchangesStatus, VenueStatus } from "$lib/types/exchanges";

    const poll = createPoll<ExchangesStatus>("/api/exchanges/status", 10_000);
    let status = $state<ExchangesStatus | null>(null);
    let unsub: (() => void) | null = null;

    onMount(() => {
        unsub = poll.subscribe((v) => (status = v));
        poll.start();
    });
    onDestroy(() => {
        unsub?.();
        poll.stop();
    });

    // Real net worth = live/dry-run spot venues only (paper excluded).
    const venues = $derived<VenueStatus[]>([
        ...(status?.spot?.exchanges ?? []),
    ]);
    const netWorth = $derived(status?.spot?.net_worth_usd ?? 0);
    const hasData = $derived(status?.spot != null);
</script>

<div class="nw-panel">
    {#if !hasData}
        <EmptyState icon="◇" title="No net-worth data" hint="Spot bot /status unavailable." />
    {:else}
        <div class="hero">
            <StatCard label="Net worth" value={fmtDollar(netWorth)} color="cyan" />
        </div>
        <ul class="venues">
            {#each venues as v (v.exchange)}
                <li class="venue">
                    <span class="vx">{v.exchange}</span>
                    <span class="mode">{v.mode}</span>
                    <span class="val">{fmtDollar(v.total_value)}</span>
                </li>
            {/each}
        </ul>
    {/if}
</div>

<style>
    .nw-panel {
        width: 100%;
        height: 100%;
        overflow-y: auto;
        padding: 10px;
        box-sizing: border-box;
        background: var(--bg1);
    }
    .hero {
        margin-bottom: 10px;
    }
    .venues {
        list-style: none;
        margin: 0;
        padding: 0;
    }
    .venue {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 4px;
        border-bottom: 1px solid var(--b1);
        font-size: 11px;
    }
    .vx {
        font-weight: 700;
        color: var(--t1);
        text-transform: capitalize;
    }
    .mode {
        color: var(--t3);
        font-size: 10px;
        text-transform: uppercase;
    }
    .val {
        margin-left: auto;
        color: var(--green);
        font-weight: 600;
    }
</style>
