<!--
  Stop / Start / Delete for one template instance, shared by the Data page's
  cards. Deleting removes the container and the saved config; the data
  folder is always kept. Operator or admin only (R3 in the adapter decides;
  this only greys the buttons out for a viewer).
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { spawner } from '$api/spawner';
  import { ApiError } from '$api/client';
  import ConfirmButton from '$components/ui/ConfirmButton.svelte';
  import type { Instance } from '$lib/types/spawner';

  let {
    instance,
    running,
    noun,
    onchanged,
  }: { instance: Instance; running: boolean; noun: string; onchanged?: () => void } = $props();

  let role = $derived(($page.data.user?.role as string | undefined) ?? null);
  let canOperate = $derived(role == null || role === 'admin' || role === 'operator');
  let busy = $state<'stop' | 'start' | 'delete' | null>(null);
  let actionError = $state('');

  async function act(kind: 'stop' | 'start' | 'delete') {
    busy = kind;
    actionError = '';
    try {
      if (kind === 'stop') await spawner.stopInstance(instance.name);
      else if (kind === 'start') await spawner.startInstance(instance.name);
      else await spawner.deleteInstance(instance.name);
      onchanged?.();
    } catch (e) {
      actionError =
        e instanceof ApiError ? `${e.status}: ${typeof e.body === 'string' ? e.body : e.statusText}` : String(e);
    } finally {
      busy = null;
    }
  }
</script>

<footer class="actions">
  {#if running}
    <button class="btn" disabled={!canOperate || busy !== null} onclick={() => act('stop')}>
      {busy === 'stop' ? 'Stopping…' : 'Stop'}
    </button>
  {:else}
    <button class="btn" disabled={!canOperate || busy !== null} onclick={() => act('start')}>
      {busy === 'start' ? 'Starting…' : 'Start'}
    </button>
  {/if}
  <ConfirmButton
    label="Delete"
    confirmLabel="Delete? Data is kept"
    busyLabel="Deleting…"
    busy={busy === 'delete'}
    disabled={!canOperate || busy !== null}
    onconfirm={() => act('delete')}
    ariaLabel="Delete {noun} {instance.name} (its data folder is kept)"
  />
  <span class="dir" title="Data folder">{instance.data_dir ?? ''}</span>
</footer>
{#if actionError}<p class="error" role="alert">{actionError}</p>{/if}

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .btn {
    min-height: 28px;
    padding: 3px 12px;
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
  .dir {
    margin-left: auto;
    font-size: 10px;
    color: var(--t3);
    overflow-wrap: anywhere;
  }
  .error {
    margin: 0;
    font-size: 11px;
    color: var(--amber);
  }
  @media (pointer: coarse) {
    .btn {
      min-height: 44px;
    }
  }
</style>
