<script lang="ts">
    /**
     * PerformancePanel — a compact, dockable performance-stats view.
     *
     * A lighter view of `/performance`: it polls the same `/api/performance`
     * adapter endpoint (via `createPoll`, so multiple copies share ONE backend
     * poll) and renders the key metrics as a small StatCard grid. The full
     * trades table + CSV export stay on the `/performance` page; this is a
     * glanceable summary for a workspace layout.
     *
     * The `Performance` shape mirrors the `/performance` page (a slim projection
     * of the backend's perf payload — the same convention SignalsPanel uses for
     * its row type).
     */
    import { createPoll } from "$stores/poll";
    import StatCard from "$components/ui/StatCard.svelte";
    import EmptyState from "$components/ui/EmptyState.svelte";
    import { fmtDollar, fmtPct, fmtFixed } from "$lib/utils/format";

    interface Performance {
        total_trades?: number;
        win_rate?: number;
        total_pnl?: number;
        profit_factor?: number;
        sharpe_ratio?: number;
        max_drawdown?: number;
    }

    type CardColor = "green" | "red" | "amber" | "cyan" | "default";
    interface MetricCard {
        label: string;
        value: string;
        color?: CardColor;
    }

    let { intervalMs = 10000 } = $props<{ intervalMs?: number }>();

    // `perf` stays null until the first fetch resolves; track the error store
    // separately to distinguish "still loading" from "loaded but failed".
    let perf = $state<Performance | null>(null);
    let err = $state<string | null>(null);

    // createPoll takes a fixed interval, so (re)build the poller whenever
    // `intervalMs` changes. Multiple copies share ONE backend poll via the
    // deduped shared-poller registry in $stores/poll.
    $effect(() => {
        const poll = createPoll<Performance>("/api/performance", intervalMs);
        const unsubData = poll.subscribe((v) => (perf = v));
        const unsubErr = poll.error.subscribe((e) => (err = e));
        poll.start();
        return () => {
            unsubData();
            unsubErr();
            poll.stop();
        };
    });

    let cards = $derived.by<MetricCard[]>(() => {
        const p = perf;
        if (!p) return [];
        const pnl = p.total_pnl ?? 0;
        return [
            { label: "Total P&L", value: p.total_pnl != null ? fmtDollar(pnl) : "—", color: pnl >= 0 ? "green" : "red" },
            { label: "Win Rate", value: p.win_rate != null ? fmtPct(p.win_rate) : "—", color: (p.win_rate ?? 0) >= 0.5 ? "green" : "red" },
            { label: "Trades", value: p.total_trades != null ? String(p.total_trades) : "—" },
            { label: "Profit Factor", value: p.profit_factor != null ? fmtFixed(p.profit_factor, 2) : "—", color: (p.profit_factor ?? 0) >= 1 ? "green" : "red" },
            { label: "Sharpe", value: p.sharpe_ratio != null ? fmtFixed(p.sharpe_ratio, 2) : "—" },
            { label: "Max Drawdown", value: p.max_drawdown != null ? fmtDollar(p.max_drawdown) : "—", color: "red" },
        ];
    });
</script>

<div class="perf-panel">
    {#if err && perf == null}
        <EmptyState
            icon="⚠"
            title="Couldn't load performance"
            variant="error"
            hint={err}
        />
    {:else if perf == null}
        <div class="loading">Loading performance…</div>
    {:else}
        <div class="grid">
            {#each cards as c (c.label)}
                <StatCard label={c.label} value={c.value} color={c.color} />
            {/each}
        </div>
    {/if}
</div>

<style>
    .perf-panel {
        width: 100%;
        height: 100%;
        overflow-y: auto;
        background: var(--bg1);
        padding: 10px;
        box-sizing: border-box;
    }
    .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
        gap: 8px;
    }
    .loading {
        color: var(--t3);
        font-size: 11px;
        padding: 10px;
    }
</style>
