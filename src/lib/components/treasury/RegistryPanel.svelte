<script lang="ts">
  /**
   * Accounts registry — the multi-account treasury topology (source of
   * truth for tier / class / role / compliance; NO credentials by design).
   *
   * Compact table + the same deliberately-simple JSON upsert modal /edges
   * uses (POST /api/spawner/accounts, keyed by account_id). The primary
   * /treasury flows are the transfer form and the profit cards — registry
   * edits are occasional topology changes.
   */
  import Badge from '$components/ui/Badge.svelte';
  import EmptyState from '$components/ui/EmptyState.svelte';
  import Modal from '$components/ui/Modal.svelte';
  import Panel from '$components/ui/Panel.svelte';
  import Skeleton from '$components/ui/Skeleton.svelte';
  import { spawner } from '$api/spawner';
  import { ApiError } from '$api/client';
  import type { TreasuryAccount, UpsertAccountRequest } from '$lib/types/spawner';
  import { classVariant, complianceVariant, roleVariant, tierVariant } from '$lib/treasury/cards';

  let { accounts, dbEnabled, loading, error, onChanged, onRefresh } = $props<{
    accounts: TreasuryAccount[];
    dbEnabled: boolean;
    loading: boolean;
    error: string | null;
    /** Fired after a successful upsert so the parent reloads the registry. */
    onChanged: () => void;
    onRefresh: () => void;
  }>();

  // ── JSON upsert modal (v1, mirrors /edges) ────────────────────────────────

  let editorOpen = $state(false);
  let editorTitle = $state('New account');
  let editorText = $state('');
  let editorError = $state<string | null>(null);
  let editorSaving = $state(false);

  const ACCOUNT_TEMPLATE: UpsertAccountRequest = {
    account_id: '',
    display_name: '',
    tier: 1,
    account_class: 'personal-crypto',
    venue: null,
    role: 'watch',
    firm: null,
    compliance_flag: 'manual-mirror',
    risk_caps: {},
    sizing: {},
    active: true,
  };

  function openNew() {
    editorTitle = 'New account';
    editorText = JSON.stringify(ACCOUNT_TEMPLATE, null, 2);
    editorError = null;
    editorOpen = true;
  }

  function openEdit(a: TreasuryAccount) {
    editorTitle = `Edit ${a.account_id}`;
    editorText = JSON.stringify(
      {
        account_id: a.account_id,
        display_name: a.display_name,
        tier: a.tier,
        account_class: a.account_class,
        venue: a.venue,
        role: a.role,
        firm: a.firm,
        compliance_flag: a.compliance_flag,
        risk_caps: a.risk_caps,
        sizing: a.sizing,
        active: a.active,
      },
      null,
      2,
    );
    editorError = null;
    editorOpen = true;
  }

  async function save() {
    if (editorSaving) return;
    let body: UpsertAccountRequest;
    try {
      const parsed: unknown = JSON.parse(editorText);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('must be a JSON object');
      }
      const p = parsed as Record<string, unknown>;
      if (typeof p.account_id !== 'string' || !p.account_id.trim()) {
        throw new Error('account_id (non-empty string) is required');
      }
      if (typeof p.tier !== 'number' || !Number.isInteger(p.tier)) {
        throw new Error('tier (integer) is required');
      }
      if (typeof p.account_class !== 'string' || !p.account_class.trim()) {
        throw new Error('account_class (non-empty string) is required');
      }
      if (typeof p.role !== 'string' || !p.role.trim()) {
        throw new Error('role (non-empty string) is required');
      }
      body = p as unknown as UpsertAccountRequest;
    } catch (e) {
      editorError = `Invalid account JSON: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    editorSaving = true;
    editorError = null;
    try {
      await spawner.upsertAccount(body);
      editorOpen = false;
      onChanged();
    } catch (e) {
      editorError =
        e instanceof ApiError
          ? `${e.status} ${e.statusText}${e.body ? ` — ${e.body}` : ''}`
          : String(e);
    } finally {
      editorSaving = false;
    }
  }
</script>

<Panel title="Accounts registry">
  {#snippet header()}
    <button type="button" class="btn" onclick={onRefresh} disabled={loading} title="Reload the registry">
      ↻
    </button>
    <button type="button" class="btn new" onclick={openNew} disabled={!dbEnabled} title="Register or update an account (UPSERT)">
      ＋ Add account
    </button>
  {/snippet}

  {#if loading && accounts.length === 0}
    <Skeleton lines={3} height="24px" />
  {:else if error}
    <EmptyState
      icon="⚠️"
      title="Couldn't load the accounts registry"
      variant="error"
      hint={`GET /api/spawner/accounts failed (${error}). Check that the spawner is reachable.`}
    />
  {:else if !dbEnabled}
    <EmptyState
      icon="🗄️"
      title="Accounts registry unavailable"
      hint="The spawner has no database configured — set SPAWNER_DATABASE_URL to enable the registry."
    />
  {:else if accounts.length === 0}
    <EmptyState icon="∅" title="No accounts registered yet">
      {#snippet action()}
        <button type="button" class="btn new" onclick={openNew}>＋ Add account</button>
      {/snippet}
    </EmptyState>
  {:else}
    <div class="scroll">
      <table class="reg">
        <thead>
          <tr>
            <th>Account</th>
            <th>Tier</th>
            <th>Class</th>
            <th>Role</th>
            <th>Compliance</th>
            <th class="r"></th>
          </tr>
        </thead>
        <tbody>
          {#each accounts as a (a.account_id)}
            <tr class:inactive={!a.active}>
              <td>
                <div class="names">
                  <span class="dn">
                    {a.display_name ?? a.account_id}
                    {#if !a.active}<Badge variant="default">inactive</Badge>{/if}
                  </span>
                  <span class="sub mono">
                    {a.account_id}{#if a.venue}&nbsp;· {a.venue}{/if}{#if a.firm}&nbsp;· {a.firm}{/if}
                  </span>
                </div>
              </td>
              <td><Badge variant={tierVariant(a.tier)}>T{a.tier}</Badge></td>
              <td><Badge variant={classVariant(a.account_class)}>{a.account_class}</Badge></td>
              <td><Badge variant={roleVariant(a.role)}>{a.role}</Badge></td>
              <td><Badge variant={complianceVariant(a.compliance_flag)}>{a.compliance_flag}</Badge></td>
              <td class="r">
                <button type="button" class="btn" onclick={() => openEdit(a)} title="Edit this account (UPSERT)">
                  ✎
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</Panel>

<Modal open={editorOpen} title={editorTitle} onclose={() => (editorOpen = false)}>
  <div class="editor">
    <p class="editor-hint">
      UPSERT (POST /api/spawner/accounts), keyed by <code>account_id</code>.
      <code>tier</code>: 0 cold-BTC backbone · 1 personal-crypto · 2 rithmic-main ·
      3 prop-copy-target. <code>account_class</code>: personal-crypto | paper | prop |
      cold-storage. <code>role</code>: watch | bot-trade | human-trade-source |
      copy-target. <code>compliance_flag</code>: manual-mirror | auto-fill.
      No credentials here — keys live in the encrypted secrets store.
    </p>
    <textarea class="editor-json" bind:value={editorText} rows="14" spellcheck="false"></textarea>
    {#if editorError}
      <p class="editor-err">{editorError}</p>
    {/if}
  </div>
  {#snippet actions()}
    <button type="button" class="btn" onclick={() => (editorOpen = false)} disabled={editorSaving}>
      Cancel
    </button>
    <button type="button" class="btn new" onclick={save} disabled={editorSaving}>
      {editorSaving ? 'Saving…' : 'Save account'}
    </button>
  {/snippet}
</Modal>

<style>
  .btn {
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
  .btn:hover:not(:disabled) {
    border-color: var(--cyan, #22d3ee);
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .btn.new {
    border-color: var(--accent, #5b6ef5);
  }
  .scroll {
    overflow-x: auto;
  }
  .reg {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }
  .reg th {
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
  .reg td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--b1);
    vertical-align: middle;
    white-space: nowrap;
  }
  .reg tbody tr:hover {
    background: var(--bg2);
  }
  .reg tr.inactive td {
    opacity: 0.55;
  }
  .r {
    text-align: right !important;
  }
  .names {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .dn {
    font-weight: 600;
    color: var(--t1);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .sub {
    font-size: 9px;
    color: var(--t3);
  }
  .mono {
    font-family: var(--mono, 'SF Mono', 'Fira Code', monospace);
  }
  .editor {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .editor-hint {
    margin: 0;
    font-size: 10px;
    color: var(--t3);
    line-height: 1.5;
  }
  .editor-hint code {
    color: var(--cyan, #22d3ee);
  }
  .editor-json {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg2);
    border: 1px solid var(--b2);
    border-radius: var(--r);
    color: var(--t1);
    font-family: var(--mono, 'SF Mono', 'Fira Code', monospace);
    font-size: 11px;
    padding: 8px;
    resize: vertical;
  }
  .editor-err {
    margin: 0;
    font-size: 11px;
    color: var(--red, #ea3943);
  }
</style>
