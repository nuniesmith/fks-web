<script lang="ts">
  /**
   * Transfers ledger history — newest first, kind badges, signed coloured
   * amounts. Rows arrive already reversed (the endpoint returns oldest →
   * newest); optimistic rows from the form are prepended by the parent.
   */
  import Badge from '$components/ui/Badge.svelte';
  import EmptyState from '$components/ui/EmptyState.svelte';
  import Panel from '$components/ui/Panel.svelte';
  import Skeleton from '$components/ui/Skeleton.svelte';
  import { fmtDateTime } from '$lib/utils/format';
  import { fmtSignedMoney, kindVariant, moneyTone } from '$lib/treasury/cards';
  import type { TransferRow } from '$lib/types/spawner';

  let { transfers, loading, error, dbEnabled, onRefresh } = $props<{
    /** Newest first. */
    transfers: TransferRow[];
    loading: boolean;
    error: string | null;
    dbEnabled: boolean;
    onRefresh: () => void;
  }>();
</script>

<Panel title="Transfers — cash-flow ledger">
  {#snippet header()}
    <button
      type="button"
      class="refresh"
      onclick={onRefresh}
      disabled={loading}
      title="Reload the transfers ledger"
    >
      ↻ Refresh
    </button>
  {/snippet}

  {#if loading && transfers.length === 0}
    <Skeleton lines={4} height="20px" />
  {:else if error}
    <EmptyState
      icon="⚠️"
      title="Couldn't load the transfers ledger"
      variant="error"
      hint={`GET /api/spawner/transfers failed (${error}). Check that the spawner is reachable.`}
    />
  {:else if !dbEnabled}
    <EmptyState
      icon="🗄️"
      title="Transfer ledger unavailable"
      hint="The spawner has no database configured — set SPAWNER_DATABASE_URL to enable the transfers ledger."
    />
  {:else if transfers.length === 0}
    <EmptyState
      icon="∅"
      title="No transfers recorded yet"
      hint="Record your first deposit with the form above — /profit needs the ledger to separate deposits from trading profit."
    />
  {:else}
    <div class="scroll">
      <table class="ledger">
        <thead>
          <tr>
            <th>When</th>
            <th>Account</th>
            <th>Kind</th>
            <th class="r">Amount</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {#each transfers as t (t.id)}
            <tr>
              <td class="mono when">{fmtDateTime(t.ts)}</td>
              <td class="mono acct">{t.account_id}</td>
              <td>
                <Badge variant={kindVariant(t.kind)}>{t.kind}</Badge>
                {#if t.source && t.source !== 'manual'}
                  <span class="src" title="Written by a bot-detected balance jump">{t.source}</span>
                {/if}
              </td>
              <td class="mono r amount {moneyTone(t.amount)}">
                {fmtSignedMoney(t.amount, t.currency)}
              </td>
              <td class="note">{t.note ?? ''}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</Panel>

<style>
  .refresh {
    background: var(--bg3);
    border: 1px solid var(--b2);
    color: var(--t1);
    font-size: 11px;
    font-family: inherit;
    padding: 3px 10px;
    border-radius: var(--r);
    cursor: pointer;
    white-space: nowrap;
  }
  .refresh:hover:not(:disabled) {
    border-color: var(--cyan, #22d3ee);
  }
  .refresh:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .scroll {
    overflow-x: auto;
  }
  .ledger {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }
  .ledger th {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--t3);
    font-weight: 600;
    text-align: left;
    padding: 4px 8px;
    border-bottom: 1px solid var(--b2);
    white-space: nowrap;
  }
  .ledger td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--b1);
    vertical-align: middle;
  }
  .ledger tbody tr:hover {
    background: var(--bg2);
  }
  .mono {
    font-family: var(--mono, 'SF Mono', 'Fira Code', monospace);
  }
  .r {
    text-align: right !important;
  }
  .when {
    color: var(--t2);
    white-space: nowrap;
    font-size: 10px;
  }
  .acct {
    color: var(--t1);
    white-space: nowrap;
  }
  .amount {
    font-weight: 700;
    white-space: nowrap;
  }
  .amount.pos {
    color: var(--green, #16c784);
  }
  .amount.neg {
    color: var(--red, #ea3943);
  }
  .amount.flat {
    color: var(--t2);
  }
  .src {
    font-size: 9px;
    color: var(--t3);
    margin-left: 4px;
  }
  .note {
    color: var(--t2);
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
