<!--
  Tasks — everything the spawner runs or can run: recorders, jobs and bots,
  whether made from a template form or saved by hand. New work starts from
  /tasks/new (pick a template, fill its form); the raw spawn console, saved
  configs and run history live on /tasks/advanced.

  Stopping or restarting a LIVE bot takes two clicks (ConfirmButton). Starting
  one needs an admin, which the server enforces whatever this page shows.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { createPoll } from '$stores/poll';
  import { spawner } from '$api/spawner';
  import { ApiError } from '$api/client';
  import Panel from '$components/ui/Panel.svelte';
  import Badge from '$components/ui/Badge.svelte';
  import EmptyState from '$components/ui/EmptyState.svelte';
  import ConfirmButton from '$components/ui/ConfirmButton.svelte';
  import LogViewer from '$components/tasks/LogViewer.svelte';
  import { buildTasks, type TaskRow } from '$lib/tasks';
  import type { ConfigsResponse, ContainersResponse, InstancesResponse } from '$lib/types/spawner';

  const configs = createPoll<ConfigsResponse>('/api/spawner/configs', 15_000);
  const instances = createPoll<InstancesResponse>('/api/spawner/instances', 15_000);
  const containers = createPoll<ContainersResponse>('/api/spawner/containers', 10_000);
  const containersError = containers.error;
  // Client only: a poll started during SSR would fetch a relative URL there.
  onMount(() => {
    for (const p of [configs, instances, containers]) p.start();
    return () => {
      for (const p of [configs, instances, containers]) p.stop();
    };
  });

  let rows = $derived(
    buildTasks({
      configs: $configs?.configs ?? [],
      instances: $instances?.instances ?? [],
      containers: $containers?.containers ?? [],
    }),
  );

  let role = $derived(($page.data.user?.role as string | undefined) ?? null);
  let canOperate = $derived(role == null || role === 'admin' || role === 'operator');

  let busyKey = $state<string | null>(null);
  let actionError = $state('');
  let logsFor = $state<{ id: string; title: string } | null>(null);

  async function run(row: TaskRow, what: string, fn: () => Promise<unknown>) {
    busyKey = `${row.key}:${what}`;
    actionError = '';
    try {
      await fn();
      await Promise.all([configs.refresh(), instances.refresh(), containers.refresh()]);
    } catch (e) {
      const body = e instanceof ApiError ? (typeof e.body === 'string' ? e.body : e.statusText) : String(e);
      actionError = `${row.name}: ${what} failed — ${e instanceof ApiError ? `${e.status} ` : ''}${body}`;
    } finally {
      busyKey = null;
    }
  }

  function start(row: TaskRow) {
    if (row.source === 'instance') return run(row, 'start', () => spawner.startInstance(row.name));
    if (row.source === 'config') return run(row, 'start', () => spawner.respawn(row.name));
    return run(row, 'start', () => spawner.restart(row.container!.id));
  }
  function stop(row: TaskRow) {
    if (row.source === 'instance') return run(row, 'stop', () => spawner.stopInstance(row.name));
    return run(row, 'stop', () => spawner.stop(row.container!.id));
  }
  function remove(row: TaskRow) {
    if (row.source === 'instance') return run(row, 'delete', () => spawner.deleteInstance(row.name));
    return run(row, 'remove', () => spawner.remove(row.container!.id));
  }

  function modeVariant(mode: string): 'red' | 'amber' | 'cyan' | 'purple' | 'default' {
    if (mode === 'live') return 'red';
    if (mode === 'dry-run') return 'amber';
    if (mode === 'paper') return 'cyan';
    if (mode === 'record') return 'purple';
    return 'default';
  }
  const busy = (row: TaskRow, what: string) => busyKey === `${row.key}:${what}`;
</script>

<svelte:head>
  <title>Tasks — FKS Terminal</title>
</svelte:head>

<div class="page-scroll page">
  <header class="intro">
    <div>
      <h1>Tasks</h1>
      <p>
        Every recorder, job and bot the spawner runs. New ones start from a template's form, the same
        form an agent can fill through the API.
      </p>
    </div>
    <a class="btn-primary" href="/tasks/new">+ New task</a>
  </header>

  {#if actionError}
    <p class="error" role="alert">{actionError}</p>
  {/if}

  <Panel title="Running and saved">
    {#if $containers === null && $containersError}
      <EmptyState icon="⚠️" variant="error" title="The spawner did not answer" hint={$containersError} />
    {:else if $containers === null}
      <p class="muted" role="status">Loading tasks…</p>
    {:else if rows.length === 0}
      <EmptyState icon="▶" title="Nothing yet" hint="Start with a recorder: data first, then edges.">
        {#snippet action()}
          <a class="btn-primary" href="/tasks/new?kind=recorder">New recorder</a>
        {/snippet}
      </EmptyState>
    {:else}
      <div class="table-wrap">
        <table class="tasks" aria-label="Tasks">
          <thead>
            <tr><th>Name</th><th>Kind</th><th>Mode</th><th>State</th><th>From</th><th class="actions-h">Actions</th></tr>
          </thead>
          <tbody>
            {#each rows as row (row.key)}
              {@const isRunning = row.container?.state === 'running'}
              {@const live = row.mode === 'live'}
              <tr data-testid="task-row" data-task={row.name}>
                <td>
                  <span class="name">{row.name}</span>
                  {#if row.account}<span class="sub">{row.account}</span>{/if}
                </td>
                <td>{row.kind}</td>
                <td><Badge variant={modeVariant(row.mode)}>{row.mode}</Badge></td>
                <td>
                  <Badge variant={isRunning ? 'green' : row.container ? 'amber' : 'default'}>
                    {row.container?.state ?? 'not started'}
                  </Badge>
                  {#if row.container?.status}<span class="sub">{row.container.status}</span>{/if}
                </td>
                <td class="from">{row.template ?? row.image}</td>
                <td class="actions">
                  {#if row.container}
                    <button class="btn" onclick={() => (logsFor = { id: row.container!.id, title: row.name })}>Logs</button>
                  {/if}
                  {#if isRunning}
                    {#if live}
                      <ConfirmButton
                        label="Stop"
                        confirmLabel="Stop LIVE bot?"
                        busyLabel="Stopping…"
                        busy={busy(row, 'stop')}
                        disabled={!canOperate || busyKey !== null}
                        onconfirm={() => stop(row)}
                        ariaLabel="Stop the live bot {row.name}"
                      />
                    {:else}
                      <button class="btn" disabled={!canOperate || busyKey !== null} onclick={() => stop(row)}>
                        {busy(row, 'stop') ? 'Stopping…' : 'Stop'}
                      </button>
                    {/if}
                  {:else if live}
                    <ConfirmButton
                      label="Start"
                      confirmLabel="Start LIVE bot?"
                      busyLabel="Starting…"
                      busy={busy(row, 'start')}
                      disabled={!canOperate || busyKey !== null}
                      onconfirm={() => start(row)}
                      ariaLabel="Start the live bot {row.name} (needs an admin)"
                    />
                  {:else if row.source !== 'container' || row.container}
                    <button class="btn" disabled={!canOperate || busyKey !== null} onclick={() => start(row)}>
                      {busy(row, 'start') ? 'Starting…' : 'Start'}
                    </button>
                  {/if}
                  {#if row.source === 'instance'}
                    <ConfirmButton
                      label="Delete"
                      confirmLabel="Delete? Data is kept"
                      busyLabel="Deleting…"
                      busy={busy(row, 'delete')}
                      disabled={!canOperate || busyKey !== null}
                      onconfirm={() => remove(row)}
                      ariaLabel="Delete {row.name} (its data folder is kept)"
                    />
                  {:else if row.source === 'container' && row.container && !isRunning}
                    <ConfirmButton
                      label="Remove"
                      confirmLabel="Remove container?"
                      busyLabel="Removing…"
                      busy={busy(row, 'remove')}
                      disabled={!canOperate || busyKey !== null}
                      onconfirm={() => remove(row)}
                    />
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Panel>

  {#if logsFor}
    <Panel title="Logs">
      {#key logsFor.id}
        <LogViewer containerId={logsFor.id} title={logsFor.title} onclose={() => (logsFor = null)} />
      {/key}
    </Panel>
  {/if}

  <p class="foot">
    Raw spawn, saved configs and run history: <a href="/tasks/advanced">Advanced</a>
  </p>
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
  .error {
    margin: 0;
    padding: 6px 9px;
    font-size: 11px;
    color: var(--red);
    border: 1px solid var(--red);
    border-radius: var(--r);
  }
  .muted {
    color: var(--t3);
    font-size: 11px;
  }
  .table-wrap {
    overflow-x: auto;
  }
  .tasks {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }
  .tasks th {
    text-align: left;
    font-size: 9px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--t3);
    padding: 4px 6px;
    border-bottom: 1px solid var(--b1);
  }
  .tasks td {
    padding: 6px;
    border-bottom: 1px solid var(--b1);
    color: var(--t1);
    vertical-align: middle;
  }
  .name {
    display: block;
    font-weight: 600;
  }
  .sub {
    display: block;
    font-size: 10px;
    color: var(--t3);
  }
  .from {
    color: var(--t2);
    max-width: 260px;
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .btn {
    min-height: 28px;
    padding: 3px 10px;
    background: transparent;
    border: 1px solid var(--b2);
    border-radius: var(--r);
    color: var(--t1);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .btn:hover:not(:disabled) {
    border-color: var(--cyan);
    color: var(--cyan);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .foot {
    margin: 0;
    font-size: 11px;
    color: var(--t3);
  }
  .foot a {
    color: var(--t2);
  }
  @media (pointer: coarse) {
    .btn,
    .btn-primary {
      min-height: 44px;
    }
  }
</style>
