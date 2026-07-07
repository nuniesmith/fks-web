<script lang="ts">
    /**
     * ChartPanel — a dockable candlestick panel.
     *
     * Reuses the existing `MiniChart` component (which owns its own REST load +
     * SSE live-bar subscription and a ResizeObserver, so it resizes correctly
     * inside a dockview group without any extra wiring). Panel params `symbol`
     * and `interval` round-trip through the dockview layout JSON.
     */
    import MiniChart from "$components/ui/MiniChart.svelte";

    let { symbol = "MGC", interval = "5m" } = $props<{
        symbol?: string;
        interval?: string;
    }>();
</script>

<div class="chart-panel">
    <MiniChart {symbol} {interval} showToolbar={true} height="100%" />
</div>

<style>
    .chart-panel {
        width: 100%;
        height: 100%;
        padding: 6px;
        box-sizing: border-box;
        background: var(--bg0);
    }
</style>
