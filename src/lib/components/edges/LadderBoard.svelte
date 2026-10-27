<!--
  The edge ladder on one screen (EDGE_PROCESS_2026-10-26 §0): every
  hypothesis, search and deployment on its rung, with what it waits for.

    Hypotheses → Searched (verdict) → Forward → Live, and Retired below.

  Data: `GET /ladder` (the parent polls it and passes it in). Postgres guards
  every rung; this board only places items and offers the one next move,
  and shows a refusal in the database's own words.
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { spawner } from '$api/spawner';
  import { errorLines } from '$api/errors';
  import Badge from '$components/ui/Badge.svelte';
  import ConfirmButton from '$components/ui/ConfirmButton.svelte';
  import DeploymentCard from '$components/edges/DeploymentCard.svelte';
  import { board, experimentNext, fmtScore, paramText } from '$lib/ladder';
  import type { Experiment, LadderResponse, TreasuryAccount } from '$lib/types/spawner';

  let {
    ladder,
    highlight = null,
    onchanged,
  }: { ladder: LadderResponse; highlight?: number | null; onchanged?: () => void } = $props();

  let b = $derived(board(ladder));
  let role = $derived(($page.data.user?.role as string | undefined) ?? null);
  let canOperate = $derived(role == null || role === 'admin' || role === 'operator');

  // ── Withdrawing a hypothesis ──────────────────────────────────────────────
  let withdrawing = $state<number | null>(null);
  let withdrawReason = $state('');
  let withdrawBusy = $state(false);
  let withdrawErrors = $state<string[]>([]);

  async function withdraw(id: number) {
    withdrawBusy = true;
    withdrawErrors = [];
    try {
      await spawner.withdrawHypothesis(id, withdrawReason.trim());
      withdrawing = null;
      withdrawReason = '';
      onchanged?.();
    } catch (e) {
      withdrawErrors = errorLines(e);
    } finally {
      withdrawBusy = false;
    }
  }

  // ── Deploying a USABLE experiment (a row at backtest) ─────────────────────
  let deploying = $state<number | null>(null);
  let accounts = $state<TreasuryAccount[] | null>(null);
  let account = $state('');
  let symbol = $state('');
  let snapshot = $state('{}');
  let deployBusy = $state(false);
  let deployErrors = $state<string[]>([]);

  async function openDeploy(e: Experiment) {
    deploying = deploying === e.id ? null : e.id;
    deployErrors = [];
    symbol = e.symbol;
    snapshot = '{}';
    if (accounts === null) {
      try {
        accounts = ((await spawner.accounts()).accounts ?? []).filter((a) => a.active !== false);
      } catch (err) {
        accounts = [];
        deployErrors = errorLines(err);
      }
    }
    account = account || accounts?.[0]?.account_id || '';
  }

  async function deploy(e: Experiment) {
    let params: unknown;
    try {
      params = JSON.parse(snapshot);
    } catch {
      deployErrors = ['The parameters must be JSON, e.g. {"band": 0.05}'];
      return;
    }
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      deployErrors = ['The parameters must be a JSON object: the values this deployment trades'];
      return;
    }
    deployBusy = true;
    deployErrors = [];
    try {
      await spawner.createDeployment({
        experiment_id: e.id,
        account_id: account,
        symbol: symbol.trim().toUpperCase(),
        params_snapshot: params as Record<string, unknown>,
      });
      deploying = null;
      onchanged?.();
    } catch (err) {
      deployErrors = errorLines(err);
    } finally {
      deployBusy = false;
    }
  }

  const ago = (iso: string) => iso.slice(0, 16).replace('T', ' ');
</script>

<div class="board" data-testid="ladder-board">
  <section class="col" aria-label="Hypotheses">
    <h3>Hypotheses <span class="n">{b.hypotheses.length}</span></h3>
    <p class="rung">Registered before any search, frozen since.</p>
    {#each b.hypotheses as h (h.id)}
      <article class="card" class:hl={highlight === h.id} data-testid="hypothesis-card" data-hypothesis={h.id}>
        <header class="head">
          <span class="id mono">#{h.id}</span>
          <Badge variant="purple">{h.edge_id}</Badge>
          <span class="what">{h.symbols.join(', ')}</span>
        </header>
        <p class="idea">{h.idea}</p>
        <ul class="params" aria-label="Parameters of hypothesis {h.id}">
          {#each h.params as p (p.name)}<li class="mono">{paramText(p)}</li>{/each}
        </ul>
        <p class="meta">
          beat {h.baseline} · {h.metric} · holdout {Math.round(h.holdout_share * 100)}% · {h.dataset}
        </p>
        <p class="meta">registered {ago(h.registered_at)} UTC{h.registered_by ? ` by ${h.registered_by}` : ''}</p>
        <p class="next">Next: search it. Every grid point is a trial and counts toward N; the holdout is scored once.</p>
        <div class="actions">
          <a
            class="btn primary"
            href={`/tasks/new?kind=job&template=job.edge-search&hypothesis_id=${h.id}`}
            aria-disabled={!canOperate}
            data-testid="search-it"
          >
            Search it
          </a>
          <button
            class="btn"
            disabled={!canOperate}
            onclick={() => {
              withdrawing = withdrawing === h.id ? null : h.id;
              withdrawErrors = [];
            }}
          >
            Withdraw…
          </button>
        </div>
        {#if withdrawing === h.id}
          <div class="form">
            <label>
              Why
              <input bind:value={withdrawReason} placeholder="e.g. the dataset has a hole in October" />
            </label>
            <ConfirmButton
              label="Withdraw"
              confirmLabel="Withdraw? It's final"
              busyLabel="Withdrawing…"
              busy={withdrawBusy}
              disabled={withdrawReason.trim().length < 3}
              onconfirm={() => withdraw(h.id)}
              ariaLabel="Withdraw hypothesis {h.id}"
            />
            {#if withdrawErrors.length}
              <ul class="errors" role="alert">{#each withdrawErrors as line, i (i)}<li>{line}</li>{/each}</ul>
            {/if}
          </div>
        {/if}
      </article>
    {:else}
      <p class="empty">None waiting. <a href="/edges/new">Register one</a> before a search, not after.</p>
    {/each}
  </section>

  <section class="col" aria-label="Searched">
    <h3>Searched <span class="n">{b.searched.length}</span></h3>
    <p class="rung">Trials on the training part, one score on a holdout nobody touched.</p>
    {#each b.searched as s (s.experiment.id)}
      {@const e = s.experiment}
      <article class="card" data-testid="experiment-card" data-experiment={e.id}>
        <header class="head">
          <span class="id mono">#{e.id}</span>
          <Badge variant={e.verdict === 'USABLE' ? 'green' : 'amber'}>{e.verdict}</Badge>
          <span class="what">{e.symbol} · {e.bar_minutes}m</span>
        </header>
        <p class="meta mono">{e.study_name}</p>
        <dl class="scores">
          <dt>holdout</dt><dd>{fmtScore(e.holdout_score)} <span class="dim">vs {fmtScore(e.baseline_holdout_score)} baseline</span></dd>
          <dt>selection</dt><dd>{fmtScore(e.selection_score)} <span class="dim">(the flattered one)</span></dd>
          <dt>trades</dt><dd>{e.holdout_trades ?? '—'} on the holdout</dd>
          <dt>trials</dt><dd>{e.n_trials.toLocaleString('en-US')}</dd>
        </dl>
        {#if e.verdict_reasons.length}
          <ul class="reasons" aria-label="Why experiment {e.id} is not usable">
            {#each e.verdict_reasons as r, i (i)}<li>{r}</li>{/each}
          </ul>
        {/if}
        {#if s.hypothesis}<p class="meta">tests #{s.hypothesis.id}: {s.hypothesis.idea}</p>{/if}
        <p class="next">{experimentNext(s)}</p>
        {#if e.verdict === 'USABLE'}
          <div class="actions">
            <button class="btn" disabled={!canOperate} onclick={() => openDeploy(e)}>Deploy…</button>
          </div>
          {#if deploying === e.id}
            <form class="form" onsubmit={(ev) => { ev.preventDefault(); deploy(e); }}>
              <label>
                Account
                <select bind:value={account}>
                  {#each accounts ?? [] as a (a.account_id)}
                    <option value={a.account_id}>{a.display_name ? `${a.display_name} (${a.account_id})` : a.account_id}</option>
                  {/each}
                </select>
              </label>
              <label>
                Symbol
                <input bind:value={symbol} />
              </label>
              <label>
                Parameters it trades (JSON, frozen with the row)
                <textarea rows="3" bind:value={snapshot} spellcheck="false"></textarea>
              </label>
              <p class="hint">Starts at backtest. Forward and live are separate steps, each one guarded.</p>
              <button class="btn primary" type="submit" disabled={deployBusy || !account}>
                {deployBusy ? 'Creating…' : 'Create at backtest'}
              </button>
              {#if accounts !== null && accounts.length === 0}
                <p class="hint">No accounts registered: add one on Money first.</p>
              {/if}
            </form>
          {/if}
        {/if}
        {#if deploying === e.id && deployErrors.length}
          <ul class="errors" role="alert">{#each deployErrors as line, i (i)}<li>{line}</li>{/each}</ul>
        {/if}
      </article>
    {:else}
      <p class="empty">No searches yet. Each one counts toward N, whatever its verdict.</p>
    {/each}
  </section>

  <section class="col" aria-label="Forward">
    <h3>Forward <span class="n">{b.forward.length}</span></h3>
    <p class="rung">Paper on live data, for sessions declared in advance.</p>
    {#each b.forward as d (d.id)}
      <DeploymentCard deployment={d} {onchanged} />
    {:else}
      <p class="empty">Nothing on paper.</p>
    {/each}
  </section>

  <section class="col" aria-label="Live">
    <h3>Live <span class="n">{b.live.length}</span></h3>
    <p class="rung">An admin, a typed confirmation, the account lease and a cap.</p>
    {#each b.live as d (d.id)}
      <DeploymentCard deployment={d} {onchanged} />
    {:else}
      <p class="empty">No edge trades money yet.</p>
    {/each}
  </section>
</div>

{#if b.retired.length || b.withdrawn.length}
  <details class="past">
    <summary>Retired {b.retired.length} · withdrawn {b.withdrawn.length} (kept: they count as tried)</summary>
    <div class="past-grid">
      {#each b.retired as d (d.id)}
        <DeploymentCard deployment={d} {onchanged} />
      {/each}
      {#each b.withdrawn as h (h.id)}
        <article class="card" data-testid="withdrawn-card">
          <header class="head">
            <span class="id mono">#{h.id}</span>
            <Badge variant="default">withdrawn</Badge>
            <span class="what">{h.edge_id}</span>
          </header>
          <p class="idea">{h.idea}</p>
          <p class="meta">{h.withdrawn_reason}</p>
        </article>
      {/each}
    </div>
  </details>
{/if}

<style>
  .board {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }
  @media (max-width: 1100px) {
    .board {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 640px) {
    .board {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  h3 {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--t1);
  }
  .n {
    margin-left: 4px;
    color: var(--t3);
    font-weight: 400;
  }
  .rung,
  .empty {
    margin: 0;
    font-size: 10px;
    color: var(--t3);
  }
  .empty a {
    color: var(--cyan);
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 10px;
    background: var(--bg2);
    border: 1px solid var(--b2);
    border-radius: var(--r-md);
    min-width: 0;
  }
  .card.hl {
    border-color: var(--cyan);
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .id {
    font-size: 11px;
    color: var(--t3);
  }
  .what {
    font-size: 12px;
    color: var(--t1);
  }
  .idea {
    margin: 0;
    font-size: 12px;
    line-height: 1.4;
    color: var(--t1);
    overflow-wrap: anywhere;
  }
  .params,
  .reasons {
    margin: 0;
    padding-left: 14px;
    font-size: 10px;
    color: var(--t2);
  }
  .reasons {
    color: var(--amber);
  }
  .meta {
    margin: 0;
    font-size: 10px;
    color: var(--t3);
    overflow-wrap: anywhere;
  }
  .next {
    margin: 0;
    font-size: 11px;
    color: var(--t2);
  }
  .scores {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 1px 8px;
    margin: 0;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .scores dt {
    color: var(--t3);
  }
  .scores dd {
    margin: 0;
    color: var(--t1);
  }
  .dim {
    color: var(--t3);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 11px;
    color: var(--t2);
  }
  .form label {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .form input,
  .form select,
  .form textarea {
    min-height: 28px;
    padding: 3px 6px;
    background: var(--bg1);
    border: 1px solid var(--b2);
    border-radius: var(--r);
    color: var(--t1);
    font: inherit;
  }
  .form textarea {
    font-family: var(--font-mono, monospace);
  }
  .hint {
    margin: 0;
    font-size: 10px;
    color: var(--t3);
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
    align-self: flex-start;
  }
  .btn:hover:not(:disabled) {
    border-color: var(--cyan);
    color: var(--cyan);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn.primary {
    border-color: var(--cyan);
    color: var(--cyan);
  }
  .errors {
    margin: 0;
    padding-left: 16px;
    font-size: 11px;
    color: var(--amber);
  }
  .past {
    margin-top: 10px;
    font-size: 11px;
    color: var(--t2);
  }
  .past summary {
    cursor: pointer;
  }
  .past-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 8px;
    margin-top: 8px;
  }
  .mono {
    font-family: var(--font-mono, monospace);
  }
  @media (pointer: coarse) {
    .btn,
    .form input,
    .form select {
      min-height: 44px;
    }
  }
  a.btn {
    display: inline-flex;
    align-items: center;
    text-decoration: none;
  }
  a.btn[aria-disabled='true'] {
    opacity: 0.5;
    pointer-events: none;
  }
</style>
