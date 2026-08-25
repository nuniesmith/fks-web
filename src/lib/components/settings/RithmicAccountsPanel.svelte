<script lang="ts">
  /**
   * Rithmic account management.
   *
   * Rithmic permits ONE session per credential, so the operator holds several
   * logins: a DATA-only feed that streams continuously, and prop-firm TRADING
   * logins. This panel is where they are declared, categorised and switched.
   *
   * NO CREDENTIAL IS EVER RENDERED OR SUBMITTED HERE. Usernames and passwords
   * live in `exchange_secrets` under `rithmic:<id>` and are entered through the
   * existing submit-only key flow; this panel shows only whether one is stored.
   *
   * ONE HAND-TRADED ACCOUNT. Exactly one row may be an enabled `main`, enforced
   * by a partial unique index in Postgres. Promoting a different account does
   * NOT error — the server demotes the incumbent in the same transaction — so
   * the job here is to SAY SO before saving. Silently flipping which funded
   * account is live is precisely what must not be discovered afterwards.
   */
  import Badge from '$lib/components/ui/Badge.svelte';
  import ConfirmButton from '$lib/components/ui/ConfirmButton.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import { api, ApiError } from '$api/client';
  import {
    STAGE_META,
    mainToDemote,
    validateRithmicAccount,
    type RithmicAccount,
    type RithmicAccountsView,
  } from '$lib/types/rithmic';

  let view = $state<RithmicAccountsView | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let notice = $state('');

  /** The row being edited, or null when the form is closed. */
  let draft = $state<Partial<RithmicAccount> | null>(null);

  const BLANK: Partial<RithmicAccount> = {
    id: '',
    label: '',
    kind: 'trading',
    enabled: false,
    role: 'main',
    stage: 'test',
  };

  async function load(): Promise<void> {
    try {
      view = await api.get<RithmicAccountsView>('/api/rithmic/accounts');
      error = '';
    } catch (e) {
      // A failed load is NOT "no accounts". Say which it is.
      view = null;
      error = describe(e);
    } finally {
      loading = false;
    }
  }

  function describe(e: unknown): string {
    if (e instanceof ApiError) {
      if (e.status === 403) return 'admin role required to change accounts';
      return `${e.status}: ${typeof e.body === 'string' ? e.body : e.statusText}`;
    }
    return String(e);
  }

  let accounts = $derived(view?.accounts ?? []);
  let dataAccounts = $derived(accounts.filter((a) => a.kind === 'data'));
  let tradingAccounts = $derived(accounts.filter((a) => a.kind === 'trading'));

  /** Live validation of the open draft, so Save can be disabled with a reason. */
  let draftErrors = $derived(draft ? validateRithmicAccount(draft, accounts) : []);
  /** Which account this save would demote — a consequence, not an error. */
  let demotes = $derived(draft ? mainToDemote(draft, accounts) : null);

  function openNew(): void {
    draft = { ...BLANK };
    notice = '';
    error = '';
  }
  function openEdit(a: RithmicAccount): void {
    draft = { ...a };
    notice = '';
    error = '';
  }

  async function save(): Promise<void> {
    if (!draft || saving || draftErrors.length > 0) return;
    saving = true;
    error = '';
    notice = '';
    try {
      await api.post('/api/rithmic/accounts', draft);
      // Re-read rather than patching local state: the server may have demoted
      // another row, and the list must show what IS, not what we assumed.
      await load();
      notice = demotes
        ? `${draft.label} is now the hand-traded account; ${demotes.label} was disabled.`
        : `${draft.label} saved.`;
      draft = null;
    } catch (e) {
      error = `Save failed — ${describe(e)}. Nothing was changed.`;
    } finally {
      saving = false;
    }
  }

  async function toggleEnabled(a: RithmicAccount): Promise<void> {
    if (saving) return;
    saving = true;
    error = '';
    notice = '';
    const next = { ...a, enabled: !a.enabled };
    const victim = mainToDemote(next, accounts);
    try {
      await api.post('/api/rithmic/accounts', next);
      await load();
      notice = victim
        ? `${a.label} is now the hand-traded account; ${victim.label} was disabled.`
        : `${a.label} ${next.enabled ? 'enabled' : 'disabled'}.`;
    } catch (e) {
      error = `Could not ${next.enabled ? 'enable' : 'disable'} ${a.label} — ${describe(e)}.`;
    } finally {
      saving = false;
    }
  }

  async function remove(a: RithmicAccount): Promise<void> {
    saving = true;
    error = '';
    notice = '';
    try {
      const r = await api.delete<{ note?: string }>(
        `/api/rithmic/accounts/${encodeURIComponent(a.id)}`
      );
      await load();
      notice = r?.note ?? `${a.label} removed.`;
    } catch (e) {
      error = `Could not remove ${a.label} — ${describe(e)}.`;
    } finally {
      saving = false;
    }
  }

  $effect(() => {
    load();
  });
</script>

<div class="ra">
  {#if loading}
    <div class="ra-note mono">Loading accounts…</div>

  {:else if error && view === null}
    <!-- A failed READ. Distinct from "not configured" and from "none yet". -->
    <div class="ra-note bad mono">⚠ {error}</div>

  {:else if view && !view.configured}
    <!-- NOT the same as an empty list. An empty list says "add one"; this says
         "this platform cannot store one yet", and the fix is a migration. -->
    <div class="ra-note amber mono">
      ⚠ Account storage unavailable — {view.reason}
    </div>
    <p class="ra-hint">
      Apply <code>src/sql/spawner/016_rithmic_accounts.sql</code> to <code>fks_db</code>,
      then reload. Nothing can be saved until then.
    </p>

  {:else}
    {#if notice}<div class="ra-note ok mono">{notice}</div>{/if}
    {#if error}<div class="ra-note bad mono">⚠ {error}</div>{/if}

    <!-- ── Trading logins ────────────────────────────────────────────────── -->
    <div class="ra-group">
      <span class="ra-group-lbl">Trading</span>
      <span class="ra-group-note">One enabled <strong>main</strong> — the account you trade by hand.</span>
    </div>
    {#if tradingAccounts.length === 0}
      <EmptyState title="No trading logins" hint="Add your prop-firm account below." />
    {:else}
      {#each tradingAccounts as a (a.id)}
        <div class="ra-row" class:on={a.enabled}>
          <span class="dot" class:live={a.enabled}></span>
          <span class="ra-label">{a.label}</span>
          <Badge variant={a.role === 'main' ? 'green' : 'default'}>{a.role}</Badge>
          {#if a.stage}<Badge variant="purple">{STAGE_META[a.stage].label}</Badge>{/if}
          {#if !a.has_credentials}
            <!-- Declared but unusable. Silence here would let the operator
                 enable a login that cannot connect and wonder why. -->
            <Badge variant="amber">no credential</Badge>
          {/if}
          <span class="ra-spacer"></span>
          <button class="ra-btn" disabled={saving} onclick={() => toggleEnabled(a)}>
            {a.enabled ? 'Disable' : 'Enable'}
          </button>
          <button class="ra-btn" disabled={saving} onclick={() => openEdit(a)}>Edit</button>
          <ConfirmButton
            label="Remove"
            confirmLabel="Remove {a.label}?"
            busy={saving}
            onconfirm={() => remove(a)}
          />
        </div>
      {/each}
    {/if}

    <!-- ── Data logins ───────────────────────────────────────────────────── -->
    <div class="ra-group">
      <span class="ra-group-lbl">Data</span>
      <span class="ra-group-note">Streams candles. Never holds a position.</span>
    </div>
    {#if dataAccounts.length === 0}
      <EmptyState title="No data login" hint="A dedicated data credential lets the platform stream while you trade." />
    {:else}
      {#each dataAccounts as a (a.id)}
        <div class="ra-row" class:on={a.enabled}>
          <span class="dot" class:live={a.enabled}></span>
          <span class="ra-label">{a.label}</span>
          <Badge variant="cyan">data</Badge>
          {#if !a.has_credentials}<Badge variant="amber">no credential</Badge>{/if}
          <span class="ra-spacer"></span>
          <button class="ra-btn" disabled={saving} onclick={() => toggleEnabled(a)}>
            {a.enabled ? 'Disable' : 'Enable'}
          </button>
          <button class="ra-btn" disabled={saving} onclick={() => openEdit(a)}>Edit</button>
          <ConfirmButton
            label="Remove"
            confirmLabel="Remove {a.label}?"
            busy={saving}
            onconfirm={() => remove(a)}
          />
        </div>
      {/each}
    {/if}

    <!-- ── Editor ────────────────────────────────────────────────────────── -->
    {#if draft}
      <div class="ra-form">
        <div class="ra-form-grid">
          <label class="ra-f">
            <span>ID</span>
            <input bind:value={draft.id} placeholder="tpt-150k" spellcheck="false" autocomplete="off" />
          </label>
          <label class="ra-f">
            <span>Label</span>
            <input bind:value={draft.label} placeholder="TPT 150K" autocomplete="off" />
          </label>
          <label class="ra-f">
            <span>Kind</span>
            <select bind:value={draft.kind}>
              <option value="trading">trading</option>
              <option value="data">data</option>
            </select>
          </label>
          {#if draft.kind === 'trading'}
            <label class="ra-f">
              <span>Role</span>
              <select bind:value={draft.role}>
                <option value="main">main — hand-traded</option>
                <option value="copytrade">copytrade — mirrors main</option>
              </select>
            </label>
            <label class="ra-f">
              <span>Stage</span>
              <select bind:value={draft.stage}>
                <option value="test">Test</option>
                <option value="pro">PRO (80%)</option>
                <option value="pro_plus">PRO+ (90%)</option>
              </select>
            </label>
            <label class="ra-f">
              <span>Max contracts</span>
              <input type="number" min="1" bind:value={draft.max_contracts} placeholder="15" />
            </label>
            <label class="ra-f">
              <span>Profit target $</span>
              <input type="number" step="0.01" bind:value={draft.profit_target} placeholder="159000" />
            </label>
            <label class="ra-f">
              <span>Min account balance $</span>
              <input type="number" step="0.01" bind:value={draft.min_account_balance} placeholder="146703.50" />
            </label>
          {/if}
          <label class="ra-f ra-f-check">
            <input type="checkbox" bind:checked={draft.enabled} />
            <span>Enabled</span>
          </label>
        </div>

        {#if draft.kind === 'trading' && draft.role === 'copytrade'}
          <!-- Do not let this read as a working feature. -->
          <p class="ra-warn">
            Copy trading is <strong>not implemented</strong>. The connector is read-only and
            cannot place orders; this records intent only.
          </p>
        {/if}

        {#if demotes}
          <!-- The consequence, stated BEFORE the click that causes it. -->
          <p class="ra-warn">
            Saving will make this your hand-traded account and
            <strong>disable {demotes.label}</strong>.
          </p>
        {/if}

        {#if draftErrors.length > 0}
          <ul class="ra-errs">
            {#each draftErrors as e}<li>{e}</li>{/each}
          </ul>
        {/if}

        <div class="ra-actions">
          <button
            class="ra-btn primary"
            disabled={saving || draftErrors.length > 0}
            onclick={save}
          >{saving ? 'Saving…' : 'Save'}</button>
          <button class="ra-btn" disabled={saving} onclick={() => (draft = null)}>Cancel</button>
        </div>
      </div>
    {:else}
      <div class="ra-actions">
        <button class="ra-btn primary" onclick={openNew}>Add account</button>
      </div>
    {/if}

    <p class="ra-hint">
      Credentials are entered separately and never shown here — this panel stores only
      which logins exist and what each is for.
    </p>
  {/if}
</div>

<style>
  .ra { display: flex; flex-direction: column; gap: 0.5rem; }
  .ra-note { font-size: 0.78rem; padding: 0.35rem 0.5rem; border-radius: var(--r); }
  .ra-note.ok    { color: var(--green); background: var(--green-dim, rgba(22,199,132,0.1)); }
  .ra-note.bad   { color: var(--red);   background: var(--red-dim, rgba(220,60,60,0.12)); }
  .ra-note.amber { color: var(--amber); background: var(--amber-dim); }
  .ra-hint { margin: 0; font-size: 0.72rem; color: var(--t3); line-height: 1.45; }

  .ra-group { display: flex; align-items: baseline; gap: 0.5rem; margin-top: 0.4rem; }
  .ra-group-lbl {
    font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--t3);
  }
  .ra-group-note { font-size: 0.72rem; color: var(--t3); }

  .ra-row {
    display: flex; align-items: center; gap: 0.45rem;
    padding: 0.35rem 0.5rem; border: 1px solid var(--bdr, #333); border-radius: var(--r);
  }
  .ra-row.on { border-color: var(--green-brd, rgba(22,199,132,0.35)); }
  .ra-label { font-size: 0.82rem; font-weight: 600; }
  .ra-spacer { flex: 1 1 auto; }

  /* Still when idle; the STATE is carried by colour, not motion — same reasoning
     as the status bar, where a pulse on healthy trained the eye wrongly. */
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--t3); flex-shrink: 0; }
  .dot.live { background: var(--green); }

  .ra-btn {
    padding: 0.22rem 0.6rem; font: inherit; font-size: 0.74rem;
    background: transparent; color: var(--t2); border: 1px solid var(--bdr, #333);
    border-radius: var(--r); cursor: pointer;
  }
  .ra-btn.primary { color: var(--cyan); border-color: var(--cyan); }
  .ra-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  @media (pointer: coarse) { .ra-btn { min-height: 44px; padding: 0.22rem 0.8rem; } }

  .ra-form {
    display: flex; flex-direction: column; gap: 0.5rem;
    padding: 0.6rem; border: 1px solid var(--bdr, #333); border-radius: var(--r);
  }
  .ra-form-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.5rem;
  }
  .ra-f { display: flex; flex-direction: column; gap: 0.15rem; font-size: 0.72rem; color: var(--t3); }
  .ra-f input, .ra-f select {
    padding: 0.28rem 0.4rem; font: inherit; font-size: 0.8rem;
    background: var(--bg-input, #111); color: var(--t1);
    border: 1px solid var(--bdr, #333); border-radius: var(--r);
  }
  .ra-f-check { flex-direction: row; align-items: center; gap: 0.4rem; }

  .ra-warn {
    margin: 0; font-size: 0.74rem; color: var(--amber);
    background: var(--amber-dim); padding: 0.3rem 0.5rem; border-radius: var(--r);
  }
  .ra-errs { margin: 0; padding-left: 1.1rem; font-size: 0.74rem; color: var(--red); }
  .ra-actions { display: flex; gap: 0.4rem; align-items: center; }
</style>
