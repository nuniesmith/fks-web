<script lang="ts">
  /**
   * Manual net-worth snapshot (secondary flow) — hand-enter a balance
   * reading for a registry account without a watcher node of its own (prop
   * payout account, bank balance, hardware wallet). POST /net-worth persists
   * it with source='manual'; it records a READING only and can never move
   * funds. On 201 the parent reloads the series + the account's profit card.
   */
  import EmptyState from '$components/ui/EmptyState.svelte';
  import Panel from '$components/ui/Panel.svelte';
  import Skeleton from '$components/ui/Skeleton.svelte';
  import { spawner } from '$api/spawner';
  import { ApiError } from '$api/client';
  import type { TreasuryAccount } from '$lib/types/spawner';

  let { accounts, dbEnabled, loading, onRecorded } = $props<{
    /** All registry accounts (manual readings may target inactive ones too). */
    accounts: TreasuryAccount[];
    dbEnabled: boolean;
    loading: boolean;
    onRecorded: (accountId: string) => void;
  }>();

  let accountId = $state('');
  let valueText = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);
  let saved = $state<string | null>(null);

  $effect(() => {
    const list = accounts as TreasuryAccount[];
    if (!accountId && list.length > 0) accountId = list[0].account_id;
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (saving) return;
    saved = null;
    if (!accountId.trim()) {
      error = 'Pick an account.';
      return;
    }
    const cleaned = valueText.replace(/[$,\s]/g, '');
    const value = Number(cleaned);
    if (cleaned === '' || !Number.isFinite(value)) {
      error = 'Enter the account value as a number.';
      return;
    }
    saving = true;
    error = null;
    try {
      await spawner.recordNetWorth({ account_id: accountId.trim(), net_worth: value });
      saved = `Snapshot for ${accountId} recorded ✓`;
      valueText = '';
      onRecorded(accountId.trim());
    } catch (err) {
      error =
        err instanceof ApiError
          ? `${err.status} ${err.statusText}${err.body ? ` — ${err.body}` : ''}`
          : String(err);
    } finally {
      saving = false;
    }
  }
</script>

<Panel title="Manual snapshot">
  {#if loading && accounts.length === 0}
    <Skeleton lines={2} height="24px" />
  {:else if !dbEnabled}
    <EmptyState
      icon="🗄️"
      title="Snapshots unavailable"
      hint="The spawner has no database configured — set SPAWNER_DATABASE_URL."
    />
  {:else if accounts.length === 0}
    <EmptyState
      icon="∅"
      title="No accounts registered"
      hint="Add the account to the registry first, then record its balance here."
    />
  {:else}
    <form class="form" onsubmit={submit}>
      <p class="hint">
        Hand-enter a balance reading for an account without a watcher of its
        own (prop payout account, bank, hardware wallet). Stored as
        <code>source='manual'</code> in the same series the sampler writes.
      </p>
      <label class="field">
        <span class="lbl">Account</span>
        <select class="input" bind:value={accountId} oninput={() => { error = null; saved = null; }}>
          {#each accounts as a (a.account_id)}
            <option value={a.account_id}>
              {a.display_name ? `${a.display_name} (${a.account_id})` : a.account_id}
            </option>
          {/each}
        </select>
      </label>
      <label class="field">
        <span class="lbl">Current value (USD)</span>
        <input
          class="input mono"
          type="text"
          inputmode="decimal"
          placeholder="0.00"
          autocomplete="off"
          bind:value={valueText}
          oninput={() => { error = null; saved = null; }}
        />
      </label>
      {#if error}
        <p class="feedback err" role="alert">{error}</p>
      {:else if saved}
        <p class="feedback ok" role="status">{saved}</p>
      {/if}
      <button type="submit" class="save" disabled={saving}>
        {saving ? 'Recording…' : 'Record snapshot'}
      </button>
    </form>
  {/if}
</Panel>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 2px;
  }
  .hint {
    margin: 0;
    font-size: 10px;
    color: var(--t3);
    line-height: 1.5;
  }
  .hint code {
    color: var(--cyan, #22d3ee);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .lbl {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--t3);
  }
  .input {
    box-sizing: border-box;
    width: 100%;
    min-height: 44px;
    background: var(--bg2);
    border: 1px solid var(--b2);
    border-radius: var(--r-md);
    color: var(--t1);
    font-family: inherit;
    font-size: 16px;
    padding: 8px 10px;
  }
  .input:focus {
    outline: none;
    border-color: var(--accent, #5b6ef5);
  }
  .mono {
    font-family: var(--mono, 'SF Mono', 'Fira Code', monospace);
  }
  .feedback {
    margin: 0;
    font-size: 12px;
  }
  .feedback.err {
    color: var(--red, #ea3943);
  }
  .feedback.ok {
    color: var(--green, #16c784);
  }
  .save {
    min-height: 44px;
    background: var(--bg3);
    border: 1px solid var(--accent, #5b6ef5);
    border-radius: var(--r-md);
    color: var(--t1);
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .save:hover:not(:disabled) {
    background: var(--accent, #5b6ef5);
    color: #fff;
  }
  .save:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
