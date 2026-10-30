<!--
  One edge deployment on the ladder (stages 5–6): where it stands, what it
  waits for, and the one move it can make next.

  The moves are requests; Postgres decides (fks 018/020): forward needs a
  USABLE verdict and the session count declared now (frozen from then on),
  live needs every declared session observed, retired is terminal. A refusal
  comes back in the database's own words and is shown as is.

  Live needs an admin (EDGE_PROCESS §6, the adapter's R2b) and a typed
  confirmation naming the account and the symbol. Retiring is always open to
  an operator, with a reason: demotion is cheaper than promotion on purpose.
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { spawner } from '$api/spawner';
  import { errorLines } from '$api/errors';
  import Badge from '$components/ui/Badge.svelte';
  import ConfirmButton from '$components/ui/ConfirmButton.svelte';
  import { deploymentNext } from '$lib/ladder';
  import type { Deployment } from '$lib/types/spawner';

  let { deployment: d, onchanged }: { deployment: Deployment; onchanged?: () => void } = $props();

  let role = $derived(($page.data.user?.role as string | undefined) ?? null);
  let canOperate = $derived(role == null || role === 'admin' || role === 'operator');
  let isAdmin = $derived(role == null || role === 'admin');

  let open = $state<'forward' | 'live' | 'retire' | null>(null);
  let sessions = $state('20');
  let typed = $state('');
  let reason = $state('');
  let busy = $state(false);
  let errors = $state<string[]>([]);

  let phrase = $derived(`${d.account_id}/${d.symbol}`);
  const stageVariant = { backtest: 'default', forward: 'cyan', live: 'green', retired: 'amber' } as const;

  function toggle(which: 'forward' | 'live' | 'retire') {
    open = open === which ? null : which;
    errors = [];
    typed = '';
  }

  async function run(action: () => Promise<unknown>) {
    busy = true;
    errors = [];
    try {
      await action();
      open = null;
      onchanged?.();
    } catch (e) {
      errors = errorLines(e);
    } finally {
      busy = false;
    }
  }
</script>

<article class="card" data-testid="deployment-card" data-deployment={d.id} data-stage={d.stage}>
  <header class="head">
    <span class="id mono">#{d.id}</span>
    <Badge variant={stageVariant[d.stage]}>{d.stage}</Badge>
    <span class="what">{d.symbol} · {d.account_id}</span>
    {#if d.execution === 'auto'}<Badge variant="purple">auto</Badge>{/if}
  </header>
  <p class="next">{deploymentNext(d)}</p>
  <p class="meta">experiment #{d.experiment_id} · since {d.since.slice(0, 10)}</p>

  {#if d.stage !== 'retired'}
    <div class="actions">
      {#if d.stage === 'backtest'}
        <button class="btn" disabled={!canOperate || busy} onclick={() => toggle('forward')}>Start forward…</button>
      {:else if d.stage === 'forward'}
        <button
          class="btn"
          disabled={!isAdmin || busy}
          title={isAdmin ? '' : 'Going live needs an admin'}
          onclick={() => toggle('live')}
        >
          Go live…
        </button>
      {/if}
      <button class="btn" disabled={!canOperate || busy} onclick={() => toggle('retire')}>Retire…</button>
    </div>
  {/if}

  {#if open === 'forward'}
    <form class="form" onsubmit={(e) => { e.preventDefault(); run(() => spawner.promoteDeployment(d.id, { to: 'forward', forward_sessions_required: Number(sessions) })); }}>
      <label>
        Sessions required
        <input type="number" min="1" max="1000" bind:value={sessions} />
      </label>
      <p class="hint">
        Declared now and frozen once the forward test starts. EDGE_PROCESS proposes at least 20 trading days and
        20 expected trades.
      </p>
      <button class="btn primary" type="submit" disabled={busy || !(Number(sessions) >= 1)}>
        {busy ? 'Promoting…' : `Forward, ${sessions || '?'} sessions`}
      </button>
    </form>
  {:else if open === 'live'}
    <form class="form" onsubmit={(e) => { e.preventDefault(); run(() => spawner.promoteDeployment(d.id, { to: 'live' })); }}>
      <label>
        Type <code>{phrase}</code> to go live
        <input bind:value={typed} autocomplete="off" spellcheck="false" />
      </label>
      <p class="hint">Real money on {d.account_id}. Start small: EDGE_PROCESS proposes at most 10% of the account or $100.</p>
      <button class="btn danger" type="submit" disabled={busy || typed.trim() !== phrase}>
        {busy ? 'Promoting…' : 'Go live'}
      </button>
    </form>
  {:else if open === 'retire'}
    <div class="form">
      <label>
        Why
        <input bind:value={reason} placeholder="e.g. drift on 2 consecutive days" />
      </label>
      <ConfirmButton
        label="Retire"
        confirmLabel="Retire? It's final"
        busyLabel="Retiring…"
        {busy}
        disabled={reason.trim().length < 3}
        onconfirm={() => run(() => spawner.retireDeployment(d.id, reason.trim()))}
        ariaLabel="Retire deployment {d.id}"
      />
    </div>
  {/if}

  {#if errors.length}
    <ul class="errors" role="alert">
      {#each errors as line, i (i)}<li>{line}</li>{/each}
    </ul>
  {/if}
</article>

<style>
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
  .next {
    margin: 0;
    font-size: 11px;
    color: var(--t2);
  }
  .meta {
    margin: 0;
    font-size: 10px;
    color: var(--t3);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 2px;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 0 0;
    font-size: 11px;
    color: var(--t2);
  }
  .form label {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .form input {
    min-height: 28px;
    padding: 3px 6px;
    background: var(--bg1);
    border: 1px solid var(--b2);
    border-radius: var(--r);
    color: var(--t1);
    font: inherit;
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
  .btn.danger {
    border-color: var(--red);
    color: var(--red);
  }
  .errors {
    margin: 0;
    padding-left: 16px;
    font-size: 11px;
    color: var(--amber);
  }
  .mono {
    font-family: var(--font-mono, monospace);
  }
  @media (pointer: coarse) {
    .btn,
    .form input {
      min-height: 44px;
    }
  }
</style>
