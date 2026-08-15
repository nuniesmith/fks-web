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

    // The per-venue breakdown lists every spot venue (paper included, tagged
    // by its `mode` badge) — same as the /exchanges reference page's venue grid.
    const venues = $derived<VenueStatus[]>([
        ...(status?.spot?.exchanges ?? []),
    ]);
    // Real net worth = live/dry-run venues only (paper excluded). Mirrors the
    // reference implementation on /exchanges (src/routes/exchanges/+page.svelte
    // `realNetWorth`): filter out mode="paper" venues and sum their own
    // total_value, rather than trusting the bot's indiscriminate net_worth_usd
    // field (which includes paper cash — notional, not money).
    const netWorth = $derived(
        venues.filter((v) => v.mode !== 'paper').reduce((s, v) => s + v.total_value, 0),
    );
    const hasData = $derived(status?.spot != null);
    // Bug 3: the bot may know it has more venues configured than it reported
    // in this snapshot (e.g. one is mid-restart). Advisory only — never
    // silently fabricate a corrected total.
    const expectedVenues = $derived(status?.spot?.expected_venues);
    const venueSetIncomplete = $derived(
        expectedVenues != null && expectedVenues > 0 && venues.length < expectedVenues,
    );
</script>

<div class="nw-panel">
    {#if !hasData}
        <EmptyState icon="◇" title="No net-worth data" hint="Spot bot /status unavailable." />
    {:else}
        <div class="hero">
            <StatCard label="Net worth" value={fmtDollar(netWorth)} color="cyan" />
        </div>
        {#if venueSetIncomplete}
            <p class="venue-incomplete">
                {venues.length}/{expectedVenues} venues reporting — total may be understated.
            </p>
        {/if}
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
    .venue-incomplete {
        margin: -4px 0 10px;
        padding: 4px 8px;
        font-size: 10px;
        color: var(--amber);
        background: var(--amber-dim);
        border: 1px solid var(--amber-brd);
        border-radius: var(--r);
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
