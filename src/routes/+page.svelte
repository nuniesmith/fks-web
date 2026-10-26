<!--
  Home — what you have set up, and whether it is working.

  Driven by your configuration, not by a fixed layout: one card per exchange
  account (a stored key, a bot configured for it, or a lease on it — see
  $lib/accounts.ts), then what is running, what is being recorded, where the
  edges stand, and the alerts that are about money.

  Every section degrades on its own: a spawner that cannot answer one read
  says so in that section and the rest still render.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { createPoll } from '$stores/poll';
  import { alertInbox } from '$stores/alertInbox';
  import Panel from '$components/ui/Panel.svelte';
  import Badge from '$components/ui/Badge.svelte';
  import EmptyState from '$components/ui/EmptyState.svelte';
  import AlertInbox from '$components/monitoring/AlertInbox.svelte';
  import AccountCard from '$components/accounts/AccountCard.svelte';
  import { buildAccounts } from '$lib/accounts';
  import { buildTasks } from '$lib/tasks';
  import { byCoin } from '$lib/market';
  import { fmtRelative } from '$lib/utils/format';
  import type {
    ConfigsResponse,
    ContainersResponse,
    EdgesResponse,
    ExchangeKeysStatusResponse,
    InstancesResponse,
    LeasesResponse,
  } from '$lib/types/spawner';
  import type { InboxAlert } from '$lib/types/alertInbox';
  import type { MarketCoverageResponse } from '$lib/types/market';

  const keys = createPoll<ExchangeKeysStatusResponse>('/api/spawner/secrets/status', 60_000);
  const configs = createPoll<ConfigsResponse>('/api/spawner/configs', 30_000);
  const leases = createPoll<LeasesResponse>('/api/spawner/leases', 30_000);
  const containers = createPoll<ContainersResponse>('/api/spawner/containers', 15_000);
  const instances = createPoll<InstancesResponse>('/api/spawner/instances', 30_000);
  const edges = createPoll<EdgesResponse>('/api/spawner/edges', 60_000);
  const market = createPoll<MarketCoverageResponse>('/api/market/coverage', 60_000);
  const polls = [keys, configs, leases, containers, instances, edges, market];
  // Client only: a poll started during SSR would fetch a relative URL there.
  onMount(() => {
    polls.forEach((p) => p.start());
    return () => polls.forEach((p) => p.stop());
  });

  const keysError = keys.error;
  const containersError = containers.error;

  let accounts = $derived(
    buildAccounts({
      keys: $keys?.exchanges ?? [],
      configs: $configs?.configs ?? [],
      leases: $leases?.leases ?? [],
      containers: $containers?.containers ?? [],
    }),
  );
  let tasks = $derived(
    buildTasks({
      configs: $configs?.configs ?? [],
      instances: $instances?.instances ?? [],
      containers: $containers?.containers ?? [],
    }),
  );
  let running = $derived(tasks.filter((t) => t.container?.state === 'running'));
  let recorders = $derived(tasks.filter((t) => t.kind === 'recorder'));
  let coins = $derived($market?.ok ? byCoin($market.rows) : []);
  let lastBar = $derived(coins.reduce<string | null>((m, c) => (c.last && (!m || c.last > m) ? c.last : m), null));

  const STAGES = [
    { id: 'research', label: 'Research' },
    { id: 'paper', label: 'Forward (paper)' },
    { id: 'live', label: 'Live' },
    { id: 'retired', label: 'Retired' },
  ] as const;
  let edgeCounts = $derived(
    Object.fromEntries(
      STAGES.map((s) => [s.id, ($edges?.edges ?? []).filter((e) => e.active !== false && e.status === s.id).length]),
    ) as Record<string, number>,
  );
  let edgeTotal = $derived(Object.values(edgeCounts).reduce((a, b) => a + b, 0));

  /** Alerts about money or critical ones: the rest are on /monitoring. */
  const moneyOrCritical = (a: InboxAlert) => a.labels.channel === 'money' || a.labels.severity === 'critical';
</script>

<svelte:head>
  <title>Home — FKS Terminal</title>
</svelte:head>

<div class="page-scroll page">
  <Panel title="Accounts">
    {#if $keys === null && $keysError}
      <EmptyState icon="⚠️" variant="error" title="The spawner did not answer" hint={$keysError} />
    {:else if $keys === null || $configs === null}
      <p class="muted" role="status">Loading accounts…</p>
    {:else if accounts.length === 0}
      <EmptyState
        icon="🔑"
        title="No accounts set up"
        hint="Add an exchange key in Settings. Each account you add shows up here with the bot that trades it."
      >
        {#snippet action()}
          <a class="btn-primary" href="/settings">Add a key</a>
        {/snippet}
      </EmptyState>
    {:else}
      <div class="grid">
        {#each accounts as a (`${a.id}:${a.bot?.botId ?? ''}:${a.bot?.running ?? ''}`)}
          <AccountCard account={a} />
        {/each}
      </div>
    {/if}
  </Panel>

  <div class="two-col">
    <Panel title="Running">
      {#if $containers === null && $containersError}
        <p class="muted">The spawner did not answer: {$containersError}</p>
      {:else if running.length === 0}
        <p class="muted">Nothing is running. <a href="/tasks/new">Start a task</a></p>
      {:else}
        <ul class="list">
          {#each running as t (t.key)}
            <li>
              <span class="item-name">{t.name}</span>
              <Badge variant={t.mode === 'live' ? 'red' : t.kind === 'recorder' ? 'purple' : 'cyan'}>{t.mode}</Badge>
              <span class="muted">{t.kind} · {t.container?.status ?? ''}</span>
            </li>
          {/each}
        </ul>
      {/if}
      <p class="foot"><a href="/tasks">All tasks</a></p>
    </Panel>

    <Panel title="Data capture">
      <ul class="list">
        {#each recorders as r (r.key)}
          <li>
            <span class="item-name">{r.name}</span>
            <Badge variant={r.container?.state === 'running' ? 'green' : 'amber'}>
              {r.container?.state === 'running' ? 'recording' : (r.container?.state ?? 'stopped')}
            </Badge>
            <span class="muted">{r.template ?? ''}</span>
          </li>
        {:else}
          <li class="muted">No recorders. <a href="/tasks/new?kind=recorder">Record a market</a></li>
        {/each}
        <li>
          <span class="item-name">janus candles</span>
          {#if $market?.ok}
            <span class="muted">{coins.length} coins · last bar {fmtRelative(lastBar)}</span>
          {:else if $market}
            <Badge variant="amber">unknown</Badge><span class="muted">{$market.error}</span>
          {:else}
            <span class="muted">…</span>
          {/if}
        </li>
      </ul>
      <p class="foot"><a href="/data">Coverage and gaps</a></p>
    </Panel>
  </div>

  <Panel title="Edges">
    <ol class="ladder" aria-label="Edges by stage">
      {#each STAGES as s (s.id)}
        <li><span class="count">{edgeCounts[s.id] ?? 0}</span><span class="stage">{s.label}</span></li>
      {/each}
    </ol>
    {#if $edges && edgeTotal === 0}
      <p class="muted">
        No edges yet. The process: record data → register a hypothesis → search on old data → validate on
        data the search never saw → forward-test on paper → live, then keep re-checking.
      </p>
    {/if}
    <p class="foot"><a href="/edges">Edges</a></p>
  </Panel>

  <Panel title="Alerts about money">
    <AlertInbox
      inbox={$alertInbox}
      loading={$alertInbox === null}
      filter={moneyOrCritical}
      hideHistory
      onacked={() => alertInbox.refresh()}
    />
    <p class="foot"><a href="/monitoring">All alerts</a></p>
  </Panel>
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 10px;
  }
  .two-col {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px;
    align-items: start;
  }
  @media (max-width: 760px) {
    .two-col {
      grid-template-columns: 1fr;
    }
    .grid {
      grid-template-columns: 1fr;
    }
  }
  .muted {
    font-size: 11px;
    color: var(--t3);
  }
  .muted a,
  .foot a {
    color: var(--t2);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .list li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .item-name {
    font-weight: 600;
    color: var(--t1);
  }
  .foot {
    margin: 8px 0 0;
    font-size: 11px;
  }
  .ladder {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    margin: 0 0 8px;
    padding: 0;
    list-style: none;
  }
  .ladder li {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    background: var(--bg2);
    border: 1px solid var(--b2);
    border-radius: var(--r-md);
  }
  .count {
    font-size: 18px;
    font-weight: 600;
    color: var(--t1);
  }
  .stage {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--t3);
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
  }
  @media (pointer: coarse) {
    .btn-primary {
      min-height: 44px;
    }
  }
</style>
