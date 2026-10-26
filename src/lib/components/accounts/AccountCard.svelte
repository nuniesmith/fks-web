<!--
  One exchange account you have set up (src/lib/accounts.ts), with the bot
  that trades it and that bot's own /status (net worth, P&L, cash, holdings).

  The status is the bot's view of the venue, fetched through the spawner
  (GET /bots/{id}/status). It is polled only while the bot runs, and its age
  is on screen: a frozen number must never read as a current one.

  `detail` adds the holdings table (Money page); Home shows the summary.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { createPoll } from '$stores/poll';
  import Badge from '$components/ui/Badge.svelte';
  import Freshness from '$components/ui/Freshness.svelte';
  import { fmtMoney, fmtSignedMoney, fmtRelative } from '$lib/utils/format';
  import type { AccountView } from '$lib/accounts';
  import type { BotStatusResponse, TradingBotStatus } from '$lib/types/spawner';

  let { account, detail = false }: { account: AccountView; detail?: boolean } = $props();

  const STATUS_POLL_MS = 30_000;
  /** Three missed polls: the status document itself is no longer current. */
  const STATUS_STALE_MS = 95_000;
  /**
   * The venue's own stamp (`updated`, seconds) goes stale with the
   * BotVenueStale Prometheus rule (> 540 s), so the screen and the pager agree
   * (fks-web CLAUDE.md, "Truth & freshness"). Move both together.
   */
  const VENUE_STALE_MS = 540_000;

  // The parent keys this card by account + bot, so the bot is fixed for the
  // card's lifetime and the poll can be created once.
  const bot = untrack(() => account.bot);
  const status = bot?.running
    ? createPoll<BotStatusResponse<TradingBotStatus>>(
        `/api/spawner/bots/${encodeURIComponent(bot.botId)}/status`,
        STATUS_POLL_MS,
      )
    : null;
  const statusError = status?.error;
  const statusUpdated = status?.updatedAt;
  // Client only: a poll started during SSR would fetch a relative URL there.
  onMount(() => {
    status?.start();
    return () => status?.stop();
  });

  let doc = $derived(status && $status?.ok ? ($status.status ?? null) : null);
  let venue = $derived(
    doc?.exchanges?.find((e) => e.exchange?.toLowerCase() === account.venue) ?? doc?.exchanges?.[0] ?? null,
  );
  let holdings = $derived(
    [...(venue?.holdings ?? [])].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
  );

  function modeVariant(mode: string): 'red' | 'amber' | 'cyan' | 'default' {
    if (mode === 'live') return 'red';
    if (mode === 'dry-run') return 'amber';
    if (mode === 'paper') return 'cyan';
    return 'default';
  }

  function pct(x: number | undefined | null, digits = 1): string {
    return x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(digits)}%`;
  }

  let deployHref = $derived(
    `/tasks/new?kind=bot&account=${encodeURIComponent(account.market ? account.id : `${account.venue}:spot:default`)}`,
  );
</script>

<article class="acct" data-testid="account-card" data-account={account.id}>
  <header class="acct-head">
    <h3 class="acct-name">{account.label}</h3>
    {#if bot}
      <Badge variant={modeVariant(bot.mode)}>{bot.mode.toUpperCase()}</Badge>
      <a class="acct-bot" href="/tasks" title="The bot that trades this account">{bot.botId}</a>
      {#if !bot.running}
        <Badge variant="amber">{bot.state ?? 'not running'}</Badge>
      {/if}
    {/if}
  </header>

  {#if !bot}
    <p class="acct-empty">
      No bot trades this account yet.
      <a href={deployHref}>Deploy one from a form</a>
    </p>
  {:else if !bot.running}
    <p class="acct-empty">The bot is not running, so there are no live figures.</p>
  {:else if !doc}
    <p class="acct-empty" role="status">
      {#if $statusError}
        Status unavailable — {$statusError.includes('404') ? 'the spawner does not serve bot status yet' : $statusError}
      {:else}
        Loading the bot's status…
      {/if}
    </p>
  {:else}
    <div class="figures">
      <div class="fig">
        <span class="fig-lbl">Net worth</span>
        <span class="fig-val big">{fmtMoney(doc.net_worth_usd ?? venue?.total_value ?? null)}</span>
      </div>
      <div class="fig">
        <span class="fig-lbl">P&amp;L</span>
        <span
          class="fig-val"
          class:green={(doc.pnl_usd ?? 0) > 0}
          class:red={(doc.pnl_usd ?? 0) < 0}>{fmtSignedMoney(doc.pnl_usd ?? null)}</span
        >
      </div>
      <div class="fig">
        <span class="fig-lbl">Cash</span>
        <span class="fig-val">{fmtMoney(venue?.cash ?? null)} {venue?.cash_asset ?? ''}</span>
      </div>
      <div class="fig">
        <span class="fig-lbl">Fills</span>
        <span class="fig-val">{doc.trades_total ?? '—'}</span>
      </div>
    </div>
    <p class="acct-line">
      {holdings.length} holdings · drift {pct(venue?.max_drift)}
      {#if venue?.triggered}<Badge variant="amber">rebalance due</Badge>{/if}
      {#if venue?.last_rebalance}· rebalanced {fmtRelative(venue.last_rebalance * 1000)}{/if}
      · <Freshness updated={venue?.updated ?? null} unit="s" staleAfterMs={VENUE_STALE_MS} label="venue" compact />
    </p>
    {#if detail && holdings.length}
      <table class="holdings" aria-label="Holdings on {account.label}">
        <thead>
          <tr><th>Asset</th><th class="r">Qty</th><th class="r">Value</th><th class="r">Weight</th><th class="r">Target</th></tr>
        </thead>
        <tbody>
          {#each holdings as h (h.asset)}
            <tr>
              <td>{h.asset}</td>
              <td class="r">{h.qty?.toPrecision(6)}</td>
              <td class="r">{fmtMoney(h.value)}</td>
              <td class="r">{pct(h.weight)}</td>
              <td class="r muted">{pct(h.target_weight)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}

  <footer class="acct-foot">
    {#if account.hasKey}
      <span>key stored{account.keyUpdatedAt ? ` ${fmtRelative(account.keyUpdatedAt)}` : ''}</span>
    {:else}
      <span class="warn">no key stored — <a href="/settings">add it in Settings</a></span>
    {/if}
    {#if account.lease}
      <span class:warn={!account.lease.live}>
        · lease {account.lease.live ? 'held' : 'lapsed'} by {account.lease.botId}
      </span>
    {/if}
    {#if status && $statusUpdated}
      <span class="muted">· status <Freshness updated={$statusUpdated} unit="ms" staleAfterMs={STATUS_STALE_MS} compact /></span>
    {/if}
  </footer>
</article>

<style>
  .acct {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    background: var(--bg2);
    border: 1px solid var(--b2);
    border-radius: var(--r-md);
    min-width: 0;
  }
  .acct-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .acct-name {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--t1);
  }
  .acct-bot {
    font-size: 11px;
    color: var(--t2);
    text-decoration: none;
  }
  .acct-bot:hover {
    color: var(--cyan);
    text-decoration: underline;
  }
  .acct-empty {
    margin: 0;
    font-size: 11px;
    color: var(--t2);
  }
  .acct-empty a {
    color: var(--cyan);
  }
  .figures {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 8px;
  }
  .fig {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .fig-lbl {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--t3);
  }
  .fig-val {
    font-size: 13px;
    color: var(--t1);
    font-variant-numeric: tabular-nums;
  }
  .fig-val.big {
    font-size: 18px;
    font-weight: 600;
  }
  .green {
    color: var(--green);
  }
  .red {
    color: var(--red);
  }
  .acct-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin: 0;
    font-size: 11px;
    color: var(--t2);
  }
  .holdings {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .holdings th {
    text-align: left;
    font-size: 9px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--t3);
    padding: 3px 4px;
    border-bottom: 1px solid var(--b1);
  }
  .holdings td {
    padding: 3px 4px;
    border-bottom: 1px solid var(--b1);
    color: var(--t1);
  }
  .holdings .r {
    text-align: right;
  }
  .muted {
    color: var(--t3);
  }
  .acct-foot {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    font-size: 10px;
    color: var(--t3);
  }
  .acct-foot .warn {
    color: var(--amber);
  }
  .acct-foot a {
    color: inherit;
  }
</style>
