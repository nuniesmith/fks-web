<!--
  EdgeResultsView — renders one backtest run's `results` JSON.

  Completed runs get the per-asset table: trades / win rate / net bps per
  trade with its price + funding − cost decomposition, return, max drawdown
  and the grid-positive fraction. Skipped assets are shown honestly with
  their reason. The harness + params_effective provenance strings render
  under the table — they are the honesty label for every number above them.
  Failed runs show `results.error`; running runs show an in-flight note.
-->
<script lang="ts">
  import EmptyState from '$components/ui/EmptyState.svelte';
  import { assetRows, fmtSigned, fmtRatePct } from '$lib/utils/edgeResults';
  import { fmtInt } from '$lib/utils/format';
  import type { BacktestAssetBase, EdgeBacktestRun } from '$lib/types/spawner';

  let { run } = $props<{ run: EdgeBacktestRun }>();

  let rows = $derived(assetRows(run.results));
  let harness = $derived(run.results?.harness ?? null);
  let paramsEffective = $derived(run.results?.params_effective ?? null);

  /** Return column: prefer annualised, fall back to total, then —. */
  function returnLabel(b: BacktestAssetBase): string {
    if (b.ann_return_pct != null && Number.isFinite(b.ann_return_pct)) {
      return `${fmtSigned(b.ann_return_pct)}% ann`;
    }
    if (b.total_return_pct != null && Number.isFinite(b.total_return_pct)) {
      return `${fmtSigned(b.total_return_pct)}% total`;
    }
    return '—';
  }
</script>

{#if run.status === 'failed'}
  <EmptyState
    icon="⚠️"
    title="Backtest failed"
    variant="error"
    hint={run.results?.error ?? 'No error recorded for this run.'}
  />
{:else if run.status === 'running'}
  <EmptyState
    icon="⏳"
    title="Backtest in progress"
    hint="Results appear here when the container finishes — the run list refreshes every 10s."
  />
{:else if rows.length === 0}
  <EmptyState
    icon="∅"
    title="No per-asset results recorded"
    hint="The run completed but its results carry no assets — check the harness output."
  />
{:else}
  <div class="results">
    <table class="assets">
      <thead>
        <tr>
          <th class="l">Asset</th>
          <th>Trades</th>
          <th>Win</th>
          <th title="Average net edge per trade = price + funding − cost">Net bps/tr</th>
          <th title="Price component (bps/trade)">Price</th>
          <th title="Funding component (bps/trade)">+ Funding</th>
          <th title="Cost component (bps/trade), subtracted">− Cost</th>
          <th>Return</th>
          <th>Max DD</th>
          <th title="Fraction of the parameter grid with positive expectancy">Grid+</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.symbol)}
          <tr class:skip={row.skipped != null}>
            <td class="l sym mono">{row.symbol}</td>
            {#if row.skipped != null}
              <td class="l skipped" colspan="9">skipped — {row.skipped}</td>
            {:else if row.base}
              <td class="mono">{fmtInt(row.base.trades)}</td>
              <td class="mono">{fmtRatePct(row.base.win_rate)}</td>
              <td
                class="mono net"
                class:pos={row.base.avg_net_bps >= 0}
                class:neg={row.base.avg_net_bps < 0}>{fmtSigned(row.base.avg_net_bps)}</td
              >
              <td class="mono dim">{fmtSigned(row.base.price_bps_per_trade)}</td>
              <td class="mono dim">{fmtSigned(row.base.funding_bps_per_trade)}</td>
              <td class="mono dim">{row.base.cost_bps_per_trade.toFixed(1)}</td>
              <td class="mono">{returnLabel(row.base)}</td>
              <td class="mono">{row.base.max_dd_pct.toFixed(1)}%</td>
              <td class="mono">{fmtRatePct(row.gridPositiveFraction)}</td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>

    {#if harness || paramsEffective}
      <div class="provenance">
        {#if harness}
          <div class="prov-row">
            <span class="prov-key">harness</span>
            <code class="prov-val">{harness}</code>
          </div>
        {/if}
        {#if paramsEffective}
          <div class="prov-row">
            <span class="prov-key">params_effective</span>
            <code class="prov-val">{paramsEffective}</code>
          </div>
        {/if}
      </div>
    {:else}
      <p class="no-prov">
        No harness / params_effective provenance recorded for this run — treat the
        numbers above with suspicion.
      </p>
    {/if}
  </div>
{/if}

<style>
  .results {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .assets {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }
  .assets th {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--t3);
    font-weight: 600;
    padding: 4px 8px;
    text-align: right;
    border-bottom: 1px solid var(--b2);
    white-space: nowrap;
  }
  .assets td {
    padding: 5px 8px;
    text-align: right;
    border-bottom: 1px solid var(--b1);
    color: var(--t1);
    white-space: nowrap;
  }
  .assets .l {
    text-align: left;
  }
  .sym {
    font-weight: 600;
  }
  .mono {
    font-family: var(--mono, 'SF Mono', 'Fira Code', monospace);
  }
  .dim {
    color: var(--t2);
  }
  .net {
    font-weight: 700;
  }
  .pos {
    color: var(--green, #16c784);
  }
  .neg {
    color: var(--red, #ea3943);
  }
  tr.skip .sym {
    color: var(--t3);
  }
  .skipped {
    color: var(--t3);
    font-style: italic;
  }
  .provenance {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 6px 8px;
    background: var(--bg2);
    border: 1px solid var(--b1);
    border-radius: var(--r);
  }
  .prov-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 10px;
  }
  .prov-key {
    color: var(--t3);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex-shrink: 0;
    min-width: 110px;
  }
  .prov-val {
    color: var(--t2);
    font-family: var(--mono, 'SF Mono', 'Fira Code', monospace);
    word-break: break-all;
    white-space: pre-wrap;
  }
  .no-prov {
    margin: 0;
    font-size: 10px;
    color: var(--amber, #f0a500);
  }
</style>
