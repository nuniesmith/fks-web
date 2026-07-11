<script lang="ts">
  /**
   * Record-a-transfer — THE key /treasury flow: log a paycheck DCA deposit
   * from a phone the moment it happens.
   *
   * Thumb-friendly on purpose: stacked full-width controls, ≥44px touch
   * targets, 16px inputs (kills iOS focus-zoom), kind as four big segmented
   * buttons with `deposit` preselected. Backdate + note hide behind a
   * <details> so the happy path is account → amount → Record.
   *
   * Sign convention: the typed amount is a magnitude; the in/out toggle
   * (defaulted per kind, overridable) is the single source of sign truth —
   * see $lib/treasury/transferForm.ts. On 201 the parent gets an optimistic
   * row to prepend and refreshes the affected profit card.
   */
  import EmptyState from '$components/ui/EmptyState.svelte';
  import Panel from '$components/ui/Panel.svelte';
  import Skeleton from '$components/ui/Skeleton.svelte';
  import { spawner } from '$api/spawner';
  import { ApiError } from '$api/client';
  import type { TransferKind, TransferRow, TreasuryAccount } from '$lib/types/spawner';
  import {
    TRANSFER_KINDS,
    defaultDirection,
    optimisticRow,
    validateTransfer,
    type TransferDirection,
  } from '$lib/treasury/transferForm';
  import { fmtMoney } from '$lib/treasury/cards';

  let { accounts, dbEnabled, loading, loadError, onRecorded } = $props<{
    /** Active registry accounts (the select's options). */
    accounts: TreasuryAccount[];
    dbEnabled: boolean;
    loading: boolean;
    loadError: string | null;
    onRecorded: (row: TransferRow) => void;
  }>();

  let accountId = $state('');
  let amountText = $state('');
  let kind = $state<TransferKind>('deposit');
  let direction = $state<TransferDirection>('in');
  let backdate = $state('');
  let note = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);
  let saved = $state<string | null>(null);

  // Preselect the first active account once the registry loads.
  $effect(() => {
    const list = accounts as TreasuryAccount[];
    if (!accountId && list.length > 0) accountId = list[0].account_id;
  });

  function pickKind(k: TransferKind) {
    kind = k;
    direction = defaultDirection(k);
    saved = null;
  }

  function clearFeedback() {
    error = null;
    saved = null;
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (saving) return;
    const v = validateTransfer({ accountId, amountText, kind, direction, backdate, note });
    if (!v.ok) {
      error = v.error;
      saved = null;
      return;
    }
    saving = true;
    error = null;
    saved = null;
    try {
      const ack = await spawner.recordTransfer(v.req);
      onRecorded(optimisticRow(v.req, ack));
      saved = `${v.req.kind} of ${fmtMoney(Math.abs(v.req.amount), v.req.currency ?? 'USD')} recorded ✓`;
      amountText = '';
      backdate = '';
      note = '';
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

<Panel title="Record a transfer">
  {#if loading && accounts.length === 0}
    <Skeleton lines={3} height="24px" />
  {:else if loadError}
    <EmptyState
      icon="⚠️"
      title="Couldn't load the accounts registry"
      variant="error"
      hint={`GET /api/spawner/accounts failed (${loadError}) — the transfer form needs it for the account picker.`}
    />
  {:else if !dbEnabled}
    <EmptyState
      icon="🗄️"
      title="Transfer ledger unavailable"
      hint="The spawner has no database configured — set SPAWNER_DATABASE_URL to enable the transfers ledger."
    />
  {:else if accounts.length === 0}
    <EmptyState
      icon="∅"
      title="No active accounts registered"
      hint="Add the account to the registry below first — transfers are keyed to registry accounts."
    />
  {:else}
    <form class="form" onsubmit={submit}>
      <label class="field">
        <span class="lbl">Account</span>
        <select class="input" bind:value={accountId} oninput={clearFeedback}>
          {#each accounts as a (a.account_id)}
            <option value={a.account_id}>
              {a.display_name ? `${a.display_name} (${a.account_id})` : a.account_id}
            </option>
          {/each}
        </select>
      </label>

      <div class="field">
        <span class="lbl" id="kind-label">Kind</span>
        <div class="kinds" role="group" aria-labelledby="kind-label">
          {#each TRANSFER_KINDS as k (k)}
            <button
              type="button"
              class="kind"
              class:sel={kind === k}
              aria-pressed={kind === k}
              onclick={() => pickKind(k)}
            >
              {k}
            </button>
          {/each}
        </div>
      </div>

      <div class="row">
        <label class="field grow">
          <span class="lbl">Amount</span>
          <input
            class="input amount"
            type="text"
            inputmode="decimal"
            placeholder="0.00"
            autocomplete="off"
            bind:value={amountText}
            oninput={clearFeedback}
          />
        </label>
        <div class="field">
          <span class="lbl" id="dir-label">Direction</span>
          <div class="dirs" role="group" aria-labelledby="dir-label">
            <button
              type="button"
              class="dir in"
              class:sel={direction === 'in'}
              aria-pressed={direction === 'in'}
              onclick={() => { direction = 'in'; clearFeedback(); }}
              title="Money INTO the account (recorded positive)"
            >
              In +
            </button>
            <button
              type="button"
              class="dir out"
              class:sel={direction === 'out'}
              aria-pressed={direction === 'out'}
              onclick={() => { direction = 'out'; clearFeedback(); }}
              title="Money OUT of the account (recorded negative)"
            >
              Out −
            </button>
          </div>
        </div>
      </div>

      <details class="extras">
        <summary>Backdate / note</summary>
        <div class="extras-body">
          <label class="field">
            <span class="lbl">When (blank = now)</span>
            <input class="input" type="datetime-local" bind:value={backdate} oninput={clearFeedback} />
          </label>
          <label class="field">
            <span class="lbl">Note</span>
            <input
              class="input"
              type="text"
              placeholder="e.g. paycheck DCA"
              maxlength="200"
              bind:value={note}
              oninput={clearFeedback}
            />
          </label>
        </div>
      </details>

      {#if error}
        <p class="feedback err" role="alert">{error}</p>
      {:else if saved}
        <p class="feedback ok" role="status">{saved}</p>
      {/if}

      <button type="submit" class="record" disabled={saving}>
        {saving ? 'Recording…' : `Record ${kind}`}
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
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .grow {
    flex: 1;
  }
  .row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .lbl {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--t3);
  }
  /* 16px font on inputs prevents iOS focus-zoom; 44px = comfortable thumb. */
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
  .amount {
    font-family: var(--mono, 'SF Mono', 'Fira Code', monospace);
    font-weight: 700;
  }
  .kinds {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }
  @media (max-width: 480px) {
    .kinds {
      grid-template-columns: repeat(2, 1fr);
    }
  }
  .kind,
  .dir {
    min-height: 44px;
    background: var(--bg2);
    border: 1px solid var(--b2);
    border-radius: var(--r-md);
    color: var(--t2);
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    padding: 6px 10px;
    text-transform: capitalize;
  }
  .kind.sel {
    border-color: var(--accent, #5b6ef5);
    color: var(--t1);
    background: var(--bg3);
    font-weight: 600;
  }
  .dirs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    min-width: 160px;
  }
  .dir.in.sel {
    border-color: var(--green-brd, #16c78444);
    color: var(--green, #16c784);
    background: var(--green-dim, #16c78418);
    font-weight: 700;
  }
  .dir.out.sel {
    border-color: var(--red-brd, #ea394344);
    color: var(--red, #ea3943);
    background: var(--red-dim, #ea394318);
    font-weight: 700;
  }
  .extras {
    border: 1px solid var(--b1);
    border-radius: var(--r-md);
    padding: 6px 10px;
  }
  .extras summary {
    font-size: 11px;
    color: var(--t2);
    cursor: pointer;
    min-height: 32px;
    display: flex;
    align-items: center;
  }
  .extras-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 8px 0 6px;
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
  .record {
    min-height: 48px;
    background: var(--accent, #5b6ef5);
    border: none;
    border-radius: var(--r-md);
    color: #fff;
    font-family: inherit;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    text-transform: capitalize;
  }
  .record:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  .record:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
