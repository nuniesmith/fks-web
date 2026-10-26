<!--
  Data — step 1 of the edge process: capture.

  Two sources, kept apart on purpose (EDGE_FACTORY_PLAN §12, "do not add a
  second kline path"):
    - Recorders: raw exchange events the platform cannot download later
      (liquidations, top of book, 1 s mark price), written append-only to the
      lake by template instances, with a gap ledger.
    - janus: 1m/5m candles for the coins it follows, in QuestDB.

  Everything later in the process (search, validation, forward tests) reads
  what is recorded here, so this page answers "do I have the data, and where
  are the holes".
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { createPoll } from '$stores/poll';
  import Panel from '$components/ui/Panel.svelte';
  import EmptyState from '$components/ui/EmptyState.svelte';
  import Freshness from '$components/ui/Freshness.svelte';
  import RecorderCard from '$components/data/RecorderCard.svelte';
  import { workloadKind } from '$lib/accounts';
  import { byCoin, completeness, intervalsOf } from '$lib/market';
  import { fmtRelative } from '$lib/utils/format';
  import type { InstancesResponse } from '$lib/types/spawner';
  import type { MarketCoverageResponse } from '$lib/types/market';

  const instances = createPoll<InstancesResponse>('/api/spawner/instances', 30_000);
  const instancesError = instances.error;
  const market = createPoll<MarketCoverageResponse>('/api/market/coverage', 60_000);
  const marketUpdated = market.updatedAt;
  const marketError = market.error;
  // Client only: a poll started during SSR would fetch a relative URL there.
  onMount(() => {
    instances.start();
    market.start();
    return () => {
      instances.stop();
      market.stop();
    };
  });

  let recorders = $derived(
    ($instances?.instances ?? []).filter((i) => workloadKind(i.mode, i.kind) === 'recorder'),
  );
  let marketRows = $derived($market?.ok ? $market.rows : []);
  let coins = $derived(byCoin(marketRows));
  let intervals = $derived(intervalsOf(marketRows));

  function pct(x: number | null): string {
    return x == null ? '—' : `${(x * 100).toFixed(x > 0.999 ? 2 : 1)}%`;
  }
</script>

<svelte:head>
  <title>Data — FKS Terminal</title>
</svelte:head>

<div class="page-scroll page">
  <header class="intro">
    <div>
      <h1>Data</h1>
      <p>
        Step 1 of the edge process: <strong>capture</strong>. Recorders keep the raw exchange data
        nobody can download later; janus keeps candles. Search and validation only ever read what is
        recorded here.
      </p>
    </div>
    <a class="btn-primary" href="/tasks/new?kind=recorder">+ New recorder</a>
  </header>

  <Panel title="Recorders">
    {#if $instances === null && $instancesError}
      <EmptyState
        icon="⚠️"
        variant="error"
        title="Couldn't list recorders"
        hint={`GET /api/spawner/instances failed (${$instancesError}).`}
      />
    {:else if $instances && !$instances.db_enabled}
      <EmptyState icon="🗄️" title="The spawner has no database" hint="Recorders are saved in Postgres." />
    {:else if $instances === null}
      <p class="muted" role="status">Loading recorders…</p>
    {:else}
      <div class="stack">
        {#each recorders as r (`${r.name}:${r.container?.id ?? ''}:${r.container?.state ?? ''}`)}
          <RecorderCard instance={r} onchanged={() => instances.refresh()} />
        {:else}
          <EmptyState
            icon="⏺"
            title="No recorders yet"
            hint="A recorder streams one exchange's raw events for the symbols you pick, into the data lake, with a ledger of every gap."
          >
            {#snippet action()}
              <a class="btn-primary" href="/tasks/new?kind=recorder">Start a recorder</a>
            {/snippet}
          </EmptyState>
        {/each}
      </div>
    {/if}
  </Panel>

  <Panel title="Market data (janus candles)">
    {#if $market && !$market.ok}
      <EmptyState icon="⚠️" variant="error" title="QuestDB did not answer" hint={$market.error ?? ''} />
    {:else if $market === null && $marketError}
      <EmptyState icon="⚠️" variant="error" title="Couldn't read market data" hint={$marketError} />
    {:else if $market === null}
      <p class="muted" role="status">Reading candles_crypto…</p>
    {:else if coins.length === 0}
      <EmptyState icon="📉" title="No candles recorded" hint="janus writes candles_crypto once its ingestion is started." />
    {:else}
      <div class="table-wrap">
        <table class="market" aria-label="Candles janus has recorded">
          <thead>
            <tr>
              <th>Symbol</th>
              {#each intervals as iv (iv)}<th class="r">{iv} bars</th><th class="r">{iv} complete</th>{/each}
              <th class="r">Since</th>
              <th class="r">Last bar</th>
            </tr>
          </thead>
          <tbody>
            {#each coins as c (c.symbol)}
              <tr>
                <td><a href={`/charts?symbol=${encodeURIComponent(c.symbol.replace(/USDT$/, '/USD'))}`}>{c.symbol}</a></td>
                {#each intervals as iv (iv)}
                  {@const row = c.intervals[iv]}
                  <td class="r">{row ? row.bars.toLocaleString() : '—'}</td>
                  <td class="r">{row ? pct(completeness(row)) : '—'}</td>
                {/each}
                <td class="r muted">{Object.values(c.intervals)[0]?.first?.slice(0, 10) ?? '—'}</td>
                <td class="r">{fmtRelative(c.last)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="foot">
        {coins.length} symbols · completeness counts holes between the first and last bar; the last-bar
        age shows a stall at the end ·
        <Freshness updated={$marketUpdated} unit="ms" staleAfterMs={180_000} label="read" compact />
        · <a href="/charts">Charts</a> · <a href="/charts/grid">Chart grid</a>
      </p>
    {/if}
  </Panel>
</div>

<style>
  .intro {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }
  .intro h1 {
    margin: 0 0 4px;
    font-size: 16px;
    color: var(--t1);
  }
  .intro p {
    margin: 0;
    max-width: 640px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--t2);
  }
  .btn-primary {
    display: inline-flex;
    align-items: center;
    min-height: 30px;
    padding: 4px 12px;
    border: 1px solid var(--cyan);
    border-radius: var(--r);
    color: var(--cyan);
    font-size: 12px;
    text-decoration: none;
    white-space: nowrap;
  }
  .btn-primary:hover {
    background: var(--bg2);
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .muted {
    color: var(--t3);
    font-size: 11px;
  }
  .table-wrap {
    overflow-x: auto;
  }
  .market {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .market th {
    text-align: left;
    font-size: 9px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--t3);
    padding: 4px 6px;
    border-bottom: 1px solid var(--b1);
    white-space: nowrap;
  }
  .market td {
    padding: 4px 6px;
    border-bottom: 1px solid var(--b1);
    color: var(--t1);
    white-space: nowrap;
  }
  .market a {
    color: var(--cyan);
    text-decoration: none;
  }
  .r {
    text-align: right;
  }
  .market td.muted {
    color: var(--t3);
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin: 8px 0 0;
    font-size: 10px;
    color: var(--t3);
  }
  .foot a {
    color: var(--t2);
  }
  @media (pointer: coarse) {
    .btn-primary {
      min-height: 44px;
    }
  }
</style>
