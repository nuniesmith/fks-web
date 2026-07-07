<script lang="ts">
    /**
     * MonitoringStatPanel — a single dockable Prometheus stat.
     *
     * Reuses the `/api/metrics/query` adapter endpoint (the same PromQL surface
     * the `/monitoring` page uses). Params `query`, `label` and `unit`
     * round-trip through the layout JSON, so one panel type covers CPU, memory,
     * ops/s, etc. — the user picks the metric via the panel's default params.
     */
    import { onMount, onDestroy } from "svelte";

    interface MetricResponse {
        data?: { result?: { value?: [number, string] }[] };
    }

    let {
        query = "up",
        label = "Metric",
        unit = "",
        decimals = 1,
    } = $props<{
        query?: string;
        label?: string;
        unit?: string;
        decimals?: number;
    }>();

    let value = $state<number | null>(null);
    let loading = $state(true);
    let timer: ReturnType<typeof setInterval> | null = null;

    async function fetchOnce() {
        try {
            const res = await fetch(
                `/api/metrics/query?query=${encodeURIComponent(query)}`,
                { headers: { Accept: "application/json" } },
            );
            const json: MetricResponse = await res.json();
            const raw = json?.data?.result?.[0]?.value?.[1];
            const n = raw != null ? parseFloat(raw) : NaN;
            value = isNaN(n) ? null : n;
        } catch {
            /* keep previous value */
        } finally {
            loading = false;
        }
    }

    onMount(() => {
        fetchOnce();
        timer = setInterval(fetchOnce, 10_000);
    });
    onDestroy(() => {
        if (timer) clearInterval(timer);
    });

    const display = $derived(
        value == null ? "—" : value.toFixed(decimals),
    );
</script>

<div class="stat-panel">
    <span class="lbl">{label}</span>
    <span class="val" class:loading>
        {display}{#if unit && value != null}<span class="unit">{unit}</span>{/if}
    </span>
    <span class="q" title={query}>{query}</span>
</div>

<style>
    .stat-panel {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        background: var(--bg1);
        padding: 10px;
        box-sizing: border-box;
    }
    .lbl {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--t3);
    }
    .val {
        font-size: 34px;
        font-weight: 700;
        color: var(--cyan);
        line-height: 1;
    }
    .val.loading {
        opacity: 0.5;
    }
    .unit {
        font-size: 15px;
        color: var(--t2);
        margin-left: 3px;
    }
    .q {
        font-size: 9px;
        color: var(--t3);
        max-width: 90%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
</style>
