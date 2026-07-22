<!--
  /treasury — the operator's MONEY HOME PAGE.

  Top to bottom: the carry-forward "Real net worth" headline + sparkline
  (same roll-up math as /bots, shared via $lib/treasury/rollup.ts; paper
  excluded), the phone-friendly record-a-transfer form (the key flow —
  logging paycheck DCA deposits the moment they happen), honest per-account
  profit-vs-deposits cards (7d / 30d / all, ET-anchored windows), the
  transfers ledger, the accounts registry, and a secondary manual-snapshot
  entry. Everything reads/writes the spawner's db-gated treasury endpoints
  through the /api/spawner/* passthrough.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import EmptyState from '$components/ui/EmptyState.svelte';
  import Panel from '$components/ui/Panel.svelte';
  import Skeleton from '$components/ui/Skeleton.svelte';
  import ProfitCard from '$components/treasury/ProfitCard.svelte';
  import TotalProfitCard from '$components/treasury/TotalProfitCard.svelte';
  import RegistryPanel from '$components/treasury/RegistryPanel.svelte';
  import SnapshotForm from '$components/treasury/SnapshotForm.svelte';
  import TransferForm from '$components/treasury/TransferForm.svelte';
  import TransfersTable from '$components/treasury/TransfersTable.svelte';
  import TreasuryHeadline from '$components/treasury/TreasuryHeadline.svelte';
  import { spawner } from '$api/spawner';
  import { ApiError } from '$api/client';
  import { groupSnapshots, staleAccounts, type AccountSeries } from '$lib/treasury/rollup';
  import { paperAccountIds, selectProfitAccounts } from '$lib/treasury/cards';
  import { buildProfitTotalsView } from '$lib/treasury/aggregate';
  import { PROFIT_WINDOWS, windowToSince, type ProfitWindow } from '$lib/treasury/windows';
  import type { ProfitResponse, TransferRow, TreasuryAccount } from '$lib/types/spawner';

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? `${e.status} ${e.statusText}` : String(e);
  }

  // ── Accounts registry ─────────────────────────────────────────────────────

  let accounts = $state<TreasuryAccount[]>([]);
  let dbEnabled = $state(true);
  let accountsLoading = $state(true);
  let accountsError = $state<string | null>(null);

  async function loadAccounts() {
    accountsLoading = true;
    accountsError = null;
    try {
      const res = await spawner.accounts();
      accounts = res.accounts ?? [];
      dbEnabled = res.db_enabled !== false;
    } catch (e) {
      accountsError = errMsg(e);
    } finally {
      accountsLoading = false;
    }
  }

  // ── Net-worth series (headline + card current values) ─────────────────────

  let series = $state<AccountSeries[]>([]);
  let netWorthLoading = $state(true);
  let netWorthError = $state<string | null>(null);

  async function loadNetWorth() {
    netWorthLoading = true;
    netWorthError = null;
    try {
      // 5000 = the endpoint's hard cap (the default 500 is too shallow).
      series = groupSnapshots(await spawner.netWorth({ limit: 5000 }));
    } catch (e) {
      netWorthError = errMsg(e);
    } finally {
      netWorthLoading = false;
    }
  }

  // ── Transfers ledger (kept newest-first; endpoint is oldest → newest) ─────

  let transfers = $state<TransferRow[]>([]);
  let transfersLoading = $state(true);
  let transfersError = $state<string | null>(null);

  async function loadTransfers() {
    transfersLoading = true;
    transfersError = null;
    try {
      const rows = await spawner.transfers({ limit: 200 });
      transfers = [...rows].reverse();
    } catch (e) {
      transfersError = errMsg(e);
    } finally {
      transfersLoading = false;
    }
  }

  onMount(() => {
    void loadAccounts();
    void loadNetWorth();
    void loadTransfers();
  });

  // ── Derived wiring ────────────────────────────────────────────────────────

  let snapshotIds = $derived(new Set(series.map((s) => s.accountId)));
  let paperIds = $derived(paperAccountIds(snapshotIds, accounts));
  let cardAccounts = $derived(selectProfitAccounts(accounts, snapshotIds));
  let seriesById = $derived(new Map(series.map((s) => [s.accountId, s])));
  let activeAccounts = $derived(accounts.filter((a) => a.active));
  let cardsLoading = $derived(accountsLoading || netWorthLoading);
  let hasCards = $derived(cardAccounts.real.length + cardAccounts.paper.length > 0);

  // ── Per-account /profit fetches (lifted out of ProfitCard so the TOTAL card
  //    sums the SAME responses the cards render — D5 by-construction equality) ─

  interface AccountProfitState {
    profits: Partial<Record<ProfitWindow, ProfitResponse>>;
    loading: boolean;
    error: string | null;
  }

  /** Keyed by account_id — one entry per visible profit card. */
  let profitStates = $state<Record<string, AccountProfitState>>({});
  const profitSeq: Record<string, number> = {};

  async function loadProfit(accountId: string) {
    const seq = (profitSeq[accountId] = (profitSeq[accountId] ?? 0) + 1);
    const prev = profitStates[accountId];
    profitStates[accountId] = { profits: prev?.profits ?? {}, loading: true, error: null };
    try {
      const res = await Promise.all(
        PROFIT_WINDOWS.map((w) => spawner.profit(accountId, windowToSince(w))),
      );
      if (seq !== profitSeq[accountId]) return;
      const next: Partial<Record<ProfitWindow, ProfitResponse>> = {};
      PROFIT_WINDOWS.forEach((w, i) => (next[w] = res[i]));
      profitStates[accountId] = { profits: next, loading: false, error: null };
    } catch (e) {
      if (seq !== profitSeq[accountId]) return;
      profitStates[accountId] = {
        profits: profitStates[accountId]?.profits ?? {},
        loading: false,
        error: errMsg(e),
      };
    }
  }

  /** Fetch /profit once for every card account that appears; bumps force reload. */
  $effect(() => {
    for (const a of [...cardAccounts.real, ...cardAccounts.paper]) {
      if (!(a.account_id in profitStates)) void loadProfit(a.account_id);
    }
  });

  function bumpProfit(accountId: string) {
    void loadProfit(accountId);
  }

  // ── Aggregate TOTAL over REAL accounts (D5) ───────────────────────────────
  // An ERRORED account renders NO figures on its own card (ProfitCard shows the
  // error, not numbers) AND its `profits` map may hold stale-prev responses that
  // aren't on screen — so summing it would (a) break by-construction equality
  // and (b) silently fold a failed account into a total that presents as whole.
  // `buildProfitTotalsView` excludes errored accounts from the sum, the count,
  // and the currency set (reporting them as `erroredCount` for an explicit
  // caveat), and flags a mixed-currency contributor set so the bogus bare sum
  // can be suppressed rather than presented as authoritative money.
  let totalsView = $derived(
    buildProfitTotalsView(
      cardAccounts.real.map((a) => ({
        profits: profitStates[a.account_id]?.profits ?? {},
        error: profitStates[a.account_id]?.error,
        currency: seriesById.get(a.account_id)?.currency ?? 'USD',
      })),
    ),
  );
  // The total is honest only once every contributing card has settled (loaded
  // or errored). A still-loading card keeps the skeleton; an errored one does
  // not block the total for the healthy accounts (it's excluded + caveated).
  let totalsLoading = $derived(
    cardAccounts.real.some((a) => {
      const s = profitStates[a.account_id];
      return !s || s.loading;
    }),
  );
  // Stale propagation: a contributing (non-errored) account whose newest
  // snapshot is stale still carries its frozen balance into the profit windows,
  // so surface the same ⚠ caveat the headline does. Series are the source (age),
  // not /profit; errored accounts are excluded to match the total.
  let realStale = $derived(
    staleAccounts(
      cardAccounts.real
        .filter((a) => profitStates[a.account_id]?.error == null)
        .map((a) => seriesById.get(a.account_id))
        .filter((s): s is AccountSeries => s != null),
    ),
  );
  let realStaleValue = $derived(realStale.reduce((sum, s) => sum + s.value, 0));

  /** Optimistic prepend from the form's 201, then refresh the touched card. */
  function handleRecorded(row: TransferRow) {
    transfers = [row, ...transfers];
    bumpProfit(row.account_id);
  }

  /** A manual snapshot moves the series AND the account's /profit end point. */
  function handleSnapshotRecorded(accountId: string) {
    void loadNetWorth();
    bumpProfit(accountId);
  }
</script>

<svelte:head>
  <title>Treasury — FKS Terminal</title>
</svelte:head>

<div class="page">
  <TreasuryHeadline
    {series}
    {paperIds}
    loading={netWorthLoading}
    error={netWorthError}
    onRefresh={loadNetWorth}
  />

  <nav class="daily-links" aria-label="Related operator views">
    <a href="/bots">bots</a>
    <span aria-hidden="true">·</span>
    <a href="/exchanges">exchanges</a>
    <span aria-hidden="true">·</span>
    <a href="/cockpit">cockpit</a>
  </nav>

  <TransferForm
    accounts={activeAccounts}
    {dbEnabled}
    loading={accountsLoading}
    loadError={accountsError}
    onRecorded={handleRecorded}
  />

  <Panel title="Per-account profit vs deposits">
    {#if accountsError}
      <EmptyState
        icon="⚠️"
        title="Couldn't load the accounts registry"
        variant="error"
        hint={`GET /api/spawner/accounts failed (${accountsError}). Check that the spawner is reachable.`}
      />
    {:else if !dbEnabled}
      <EmptyState
        icon="🗄️"
        title="Treasury database unavailable"
        hint="The spawner has no database configured — set SPAWNER_DATABASE_URL to enable /profit, the transfers ledger, and the registry."
      />
    {:else if cardsLoading && !hasCards}
      <div class="cards">
        {#each Array(2) as _unused, i (i)}
          <div class="card-skel"><Skeleton lines={4} height="14px" /></div>
        {/each}
      </div>
    {:else if !hasCards}
      <EmptyState
        icon="∅"
        title="No active accounts with snapshots yet"
        hint="Cards appear for ACTIVE registry accounts that have net-worth snapshots — register the account below, then let the sampler run or record a manual snapshot."
      />
    {:else}
      {#if cardAccounts.real.length > 0}
        <TotalProfitCard
          totals={totalsView.totals}
          currency={totalsView.currency}
          accountCount={totalsView.accountCount}
          erroredCount={totalsView.erroredCount}
          currencyMismatch={totalsView.currencyMismatch}
          loading={totalsLoading}
          stale={realStale}
          staleValue={realStaleValue}
        />
        <div class="cards">
          {#each cardAccounts.real as a (a.account_id)}
            <ProfitCard
              account={a}
              series={seriesById.get(a.account_id)}
              profits={profitStates[a.account_id]?.profits ?? {}}
              loading={profitStates[a.account_id]?.loading ?? true}
              error={profitStates[a.account_id]?.error ?? null}
            />
          {/each}
        </div>
      {/if}
      {#if cardAccounts.paper.length > 0}
        <div class="paper-sep">Paper — excluded from real net worth</div>
        <div class="cards">
          {#each cardAccounts.paper as a (a.account_id)}
            <ProfitCard
              account={a}
              series={seriesById.get(a.account_id)}
              profits={profitStates[a.account_id]?.profits ?? {}}
              loading={profitStates[a.account_id]?.loading ?? true}
              error={profitStates[a.account_id]?.error ?? null}
            />
          {/each}
        </div>
      {/if}
    {/if}
  </Panel>

  <TransfersTable
    {transfers}
    loading={transfersLoading}
    error={transfersError}
    {dbEnabled}
    onRefresh={loadTransfers}
  />

  <div class="two-col">
    <RegistryPanel
      {accounts}
      {dbEnabled}
      loading={accountsLoading}
      error={accountsError}
      onChanged={loadAccounts}
      onRefresh={loadAccounts}
    />
    <SnapshotForm
      {accounts}
      {dbEnabled}
      loading={accountsLoading}
      onRecorded={handleSnapshotRecorded}
    />
  </div>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    height: 100%;
    overflow: auto;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(270px, 1fr));
    gap: 8px;
  }
  .card-skel {
    padding: 10px;
    background: var(--bg2);
    border: 1px solid var(--b2);
    border-radius: var(--r-md);
  }
  .paper-sep {
    margin-top: 10px;
    padding: 4px 2px;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--amber, #f0a500);
    border-bottom: 1px solid var(--b1);
    margin-bottom: 8px;
  }
  .daily-links {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: -2px 2px 0;
    font-size: 11px;
    color: var(--t3);
  }
  .daily-links a {
    color: var(--t3);
    text-decoration: none;
  }
  .daily-links a:hover {
    color: var(--cyan);
    text-decoration: underline;
  }
  .two-col {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    gap: 8px;
    align-items: start;
  }
  @media (max-width: 760px) {
    .two-col {
      grid-template-columns: 1fr;
    }
  }
</style>
