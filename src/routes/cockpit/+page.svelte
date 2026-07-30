<script lang="ts">
  /**
   * /cockpit — the armed-futures co-pilot (M2). Read dashboard + ONE guarded
   * mutating control (the kill sentinel). No order entry, no strategy config.
   *
   * Data planes (each degrades independently, honest-empty — never fabricated):
   *   - GET /api/cockpit/state      → funding bot Postgres state of record
   *     (kill sentinel, open trades, persisted gate rows, session ledger PnL)
   *   - GET /api/cockpit/telemetry  → Prometheus armed-path series (#18 :9092
   *     exporter; scraped ONLY for mode="live" bots — zero series while the
   *     bot is paper is the honest "awaiting arm" state)
   *   - GET /api/exchanges/status   → the paper twin's /status document
   *     (unrealized ret% on open paper positions)
   *
   * The KILL control POSTs /api/cockpit/kill — session-gated at the hooks
   * seam, typed-confirmation ("KILL"), explicit instance (killing paper can
   * never touch live and vice versa — the sentinel is FR_INSTANCE-keyed).
   * Re-arm is POST /api/cockpit/rearm, equally gated ("REARM").
   */
  import Panel from '$lib/components/ui/Panel.svelte';
  import Badge from '$lib/components/ui/Badge.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import StatCard from '$lib/components/ui/StatCard.svelte';
  import Modal from '$lib/components/ui/Modal.svelte';
  import Freshness from '$lib/components/ui/Freshness.svelte';
  import { createPoll } from '$lib/stores/poll';
  import { api, ApiError } from '$api/client';
  import {
    KILL_CONFIRM_PHRASE,
    REARM_CONFIRM_PHRASE,
    type CockpitInstance,
    type GateRowView,
    type OpenPositionView,
    type SentinelView,
    type SessionPnlView,
  } from '$lib/cockpit/model';
  import type { ArmedTelemetry } from '$lib/cockpit/promParse';
  import type { ExchangesStatus } from '$lib/types/exchanges';
  import type { LiveStatusResp } from '$lib/types/cockpit-live';
  import AlertInbox from '$lib/components/monitoring/AlertInbox.svelte';
  import { fmtPrice } from '$lib/utils/format';
  import { alertInbox } from '$lib/stores/alertInbox';
  import type { InboxAlert } from '$lib/types/alertInbox';

  /**
   * Armed-path alertnames — the LIVE money-path Prometheus rules. Pinned to the
   * actual fks rule names so the cockpit panel shows exactly the 3 a.m. alerts,
   * even if a future rule omits the `mode="live"` label. Source of truth:
   *   fks/infrastructure/config/prometheus/alerts/armed-path.yml
   *   fks/infrastructure/config/prometheus/alerts/crash-supervision.yml
   * Keep in sync when those rules change (webui plan 04 OD-4 — allowlist).
   */
  const ARMED_ALERTNAMES = new Set<string>([
    // armed-path.yml (bot money-path, severity=critical, mode="live")
    'LiveSessionHalted',
    'LiveCircuitBreakerTripped',
    'LiveSustainedOrderErrors',
    'LiveRestingStopDivergence',
    'LivePositionStuckNoFill',
    'LiveFundingNotBooked',
    'LiveFillAnomaly',
    'LiveCloseBookedFromModel',
    // crash-supervision.yml (live bot crashed / metrics down)
    'LiveBotCrashed',
    'LiveBotMetricsDown',
  ]);

  /** Armed-path filter: an explicit live-mode label OR a known armed alertname. */
  function isArmedAlert(a: InboxAlert): boolean {
    // `channel: money` is load-bearing, not decoration. Several money-path
    // rules AGGREGATE AWAY the mode label and so can never match mode==='live':
    //   BotAllVenuesStale          count by (bot_id) (...)  -> no mode
    //   NetWorthSamplingPausedTooLong  increase(counter)    -> no mode
    // Without this clause the CRITICAL "all venues stale — bot is blind" alert
    // was filtered out of the cockpit while the per-venue WARNING was shown —
    // the precise inversion this panel exists to prevent, and the shape a
    // repeat of the 2026-07-22 blackout would take on the phone.
    //
    // It also catches BotVenueStale on a `dry-run` venue: dry-run is REAL money
    // (real balances, no orders), so mode==='live' alone would miss it.
    return (
      a.labels.mode === 'live' ||
      a.labels.channel === 'money' ||
      ARMED_ALERTNAMES.has(a.labels.alertname ?? '')
    );
  }
  import { page } from '$app/stores';

  // Role-aware affordances (A5) — UX honesty only; the seam (routeRequest)
  // is the real gate. KILL is operator+ (R3, panic must be reachable), RE-ARM
  // is admin-only (R2, the dangerous direction). A null role means auth is
  // disabled / no session → don't second-guess the server, leave controls on.
  let role = $derived(($page.data.user?.role as string | undefined) ?? null);
  let canKill = $derived(role == null || role === 'admin' || role === 'operator');
  let canRearm = $derived(role == null || role === 'admin');

  interface InstanceView {
    sentinel: SentinelView;
    sentinelUpdatedAt: string | null;
    positions: OpenPositionView[];
    gates: GateRowView[];
    gateBotName: string;
    session: SessionPnlView;
  }
  interface CockpitStateResp {
    configured: boolean;
    reason?: string;
    generated_at?: number;
    instances?: Record<CockpitInstance, InstanceView>;
    other_instance_keys?: string[];
    /** Sentinel rows keyed by an FR_INSTANCE other than paper/live — a bot
     *  deployed under such a key is NOT reachable by the cockpit's KILL. */
    other_sentinel_instances?: string[];
  }

  const statePoll = createPoll<CockpitStateResp>('/api/cockpit/state', 5_000);
  const telemetry = createPoll<ArmedTelemetry>('/api/cockpit/telemetry', 10_000);
  const exStatus = createPoll<ExchangesStatus>('/api/exchanges/status', 10_000);
  // Live-twin /status feed (M3 Phase A). Three-state, honest: {configured:false}
  // until the live funding bot is spawned (Gate-A ~Aug 1), then reachable/down.
  const liveStatusPoll = createPoll<LiveStatusResp>('/api/cockpit/live-status', 10_000);

  // Freshness of the cockpit's own state feed (M4). The panels below render bot
  // state, positions and gate rows from THIS poll; if it stops succeeding they
  // keep showing the last values with no visual difference at all, which is the
  // failure this indicator exists to remove.
  //
  // 3x the 5s interval: two missed ticks is jitter, three means something is
  // wrong. Deliberately NOT keyed off `loading` — a poll that is busy is not a
  // poll that is current.
  const STATE_STALE_AFTER_MS = 15_000;
  const stateUpdatedAt = statePoll.updatedAt;
  // NOTE: deliberately no `consecutiveErrors` here. Mapping "error is set" to
  // the component's persistence threshold would report a single transient blip
  // as a sustained failure and defeat the flap resistance. It is unnecessary
  // anyway: a failing poll stops advancing updatedAt, so the age grows and
  // crosses staleAfterMs on its own — an error that matters becomes visible
  // after 15s, and one that does not, never does.
  $effect(() => {
    statePoll.start();
    telemetry.start();
    exStatus.start();
    liveStatusPoll.start();
    alertInbox.start(); // shared with /monitoring + the StatusBar chip
    return () => {
      statePoll.stop();
      telemetry.stop();
      exStatus.stop();
      liveStatusPoll.stop();
      alertInbox.stop();
    };
  });

  let selected = $state<CockpitInstance>('paper');

  let cockpit = $derived($statePoll ?? null);
  let tele = $derived($telemetry ?? null);
  let inst = $derived(cockpit?.configured ? (cockpit.instances?.[selected] ?? null) : null);
  let fundingStatus = $derived($exStatus?.funding ?? null);

  /** Evidence a live bot actually exists — telemetry series, live state rows,
   *  or a live sentinel. Without it the LIVE tab says so instead of implying
   *  a running live bot. */
  let liveDetected = $derived(
    (tele?.scraped ?? false) ||
      (cockpit?.configured === true &&
        ((cockpit.instances?.live?.positions?.length ?? 0) > 0 ||
          (cockpit.instances?.live?.gates?.length ?? 0) > 0 ||
          cockpit.instances?.live?.sentinel?.state === 'killed')),
  );

  /** Unrealized ret% per symbol from the paper twin's /status document (shown
   *  only for the paper instance). */
  let paperRetBySym = $derived.by(() => {
    const m: Record<string, number> = {};
    for (const p of fundingStatus?.positions ?? []) m[p.symbol] = p.ret_pct;
    return m;
  });

  // ── Live-twin /status (M3 Phase A) — the honest three-state feed ───────────
  let liveStatus = $derived<LiveStatusResp | null>($liveStatusPoll ?? null);
  /** true only when a live-twin URL is configured (env set). */
  let liveConfigured = $derived(liveStatus?.configured === true);
  /** true = configured but the fetch failed/timed out/returned a non-status
   *  reply. An armed bot whose status server died is an OUTAGE, not "n/a". */
  let liveFeedDown = $derived(liveConfigured && liveStatus?.reachable === false);
  /** true = the env is pointed at a PAPER twin by mistake (paper-as-live trap). */
  let liveModeMismatch = $derived(liveStatus?.mode_mismatch === true);
  /** Unrealized ret% + mark px per symbol from the LIVE twin's /status document
   *  (mirrors paperRetBySym). Empty unless reachable AND not a paper mismatch. */
  let liveRetBySym = $derived.by(() => {
    const m: Record<string, { ret_pct: number; mark_px: number }> = {};
    if (!liveStatus?.reachable || liveModeMismatch) return m;
    for (const p of liveStatus.status?.positions ?? []) {
      m[p.symbol] = { ret_pct: p.ret_pct, mark_px: p.mark_px };
    }
    return m;
  });

  // ── Kill / re-arm dialogs ─────────────────────────────────────────────────
  let dialog = $state<'kill' | 'rearm' | null>(null);
  let confirmText = $state('');
  let note = $state('');
  let submitting = $state(false);
  let actionResult = $state<{ ok: boolean; text: string } | null>(null);

  function openDialog(kind: 'kill' | 'rearm') {
    dialog = kind;
    confirmText = '';
    note = '';
    actionResult = null;
  }
  function closeDialog() {
    dialog = null;
    confirmText = '';
  }
  let requiredPhrase = $derived(dialog === 'rearm' ? REARM_CONFIRM_PHRASE : KILL_CONFIRM_PHRASE);
  let phraseOk = $derived(confirmText === requiredPhrase);

  /**
   * R6 — appended to EVERY failed KILL / RE-ARM outcome.
   *
   * A failed request does not mean the write didn't happen. `client.ts` aborts
   * at 15s, `PgCockpitStore` sets `connect_timeout: 10` with NO statement
   * timeout, and SvelteKit does not cancel an in-flight server handler when the
   * client aborts — so the sentinel write can land AFTER this modal has already
   * reported failure. On the RE-ARM direction that means the operator is told
   * the bot is still halted while it is in fact armed to trade on its next bar.
   * "Failed" here is only ever "unconfirmed", never "definitely didn't happen".
   */
  const UNVERIFIED_HINT =
    ' — outcome unverified; confirm against the sentinel badge before acting.';

  async function fireAction() {
    if (!dialog || submitting) return;
    submitting = true;
    actionResult = null;
    const path = dialog === 'kill' ? '/api/cockpit/kill' : '/api/cockpit/rearm';
    try {
      const r = await api.post<{ ok: boolean; effect?: string; message?: string }>(path, {
        instance: selected,
        confirm: confirmText,
        note: note.trim() || undefined,
      });
      const ok = r.ok === true;
      const text = r.effect ?? r.message ?? 'done';
      actionResult = { ok, text: ok ? text : `${text}${UNVERIFIED_HINT}` };
      if (ok) confirmText = '';
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? `${e.status}: ${typeof e.body === 'string' ? e.body : e.statusText}`
          : String(e);
      actionResult = { ok: false, text: `request failed — ${msg}${UNVERIFIED_HINT}` };
    } finally {
      submitting = false;
      // R6: re-verify on EVERY outcome, not just success. Before this, an
      // aborted/failed KILL left every panel below showing the PRE-ATTEMPT
      // sentinel state until the next 5s poll tick — the operator's next
      // decision was made against a reading the app already knew was suspect.
      // Safe to await unconditionally: poll.ts `fetchOnce` swallows its own
      // errors and never rejects, so this cannot mask the outcome above.
      // `submitting` is cleared FIRST so an emergency retry is never blocked
      // behind a re-verification fetch that may itself be slow.
      await statePoll.refresh();
    }
  }

  // ── Formatting ────────────────────────────────────────────────────────────
  function usdt(n: number): string {
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(2)} USDT`;
  }
  function ago(ms: number): string {
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 90) return `${s}s`;
    if (s < 5400) return `${Math.round(s / 60)}m`;
    if (s < 129_600) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86_400)}d`;
  }
  function tsLabel(ms: number | null): string {
    if (!ms) return '—';
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  }
</script>

<svelte:head>
  <title>Cockpit — FKS Terminal</title>
</svelte:head>

<div class="cockpit-page">
  <p class="page-blurb">
    Armed-futures co-pilot for the KuCoin funding-reversion bot — bot state of
    record from its Postgres store, armed-path telemetry from Prometheus, and
    the durable kill sentinel. Read-only except the guarded KILL / RE-ARM.
    <span class="blurb-links">
      <a href="/monitoring">monitoring</a>
      <span aria-hidden="true">·</span>
      <a href="/treasury">treasury</a>
    </span>
  </p>

  <!-- ── Instance selector + mode banner ─────────────────────────────────── -->
  <div class="mode-row">
    <!-- M4: the age of the feed every panel below is drawn from. A frozen
         cockpit is indistinguishable from a calm one without this. -->
    <Freshness
      updated={$stateUpdatedAt}
      unit="ms"
      staleAfterMs={STATE_STALE_AFTER_MS}
      label="state"
    />
    <div class="inst-tabs" role="tablist" aria-label="Bot instance">
      {#each ['paper', 'live'] as const as i (i)}
        <button
          role="tab"
          aria-selected={selected === i}
          class="inst-tab"
          class:active={selected === i}
          onclick={() => (selected = i)}
        >
          {i.toUpperCase()}
        </button>
      {/each}
    </div>
    {#if selected === 'paper'}
      <Badge variant="amber">PAPER — simulated money</Badge>
      <span class="mode-hint">Gate-A measurement twin. No real orders can exist on this instance.</span>
    {:else if liveDetected}
      <Badge variant="red">LIVE — real money</Badge>
      <span class="mode-hint">Armed instance detected (FR_INSTANCE=live).</span>
    {:else}
      <Badge variant="default">LIVE — no live bot detected</Badge>
      <span class="mode-hint">
        No live series, state rows, or sentinel yet — awaiting arm. Panels below stay honestly empty.
      </span>
    {/if}
  </div>

  {#if cockpit && !cockpit.configured}
    <Panel title="Cockpit store">
      <EmptyState
        icon="🔌"
        variant="error"
        title="Cockpit database not available"
        hint={cockpit.reason ?? 'unknown reason'}
      />
    </Panel>
  {/if}

  <!-- ── Kill switch ─────────────────────────────────────────────────────── -->
  <Panel title="Kill switch — durable sentinel ({selected})">
    <div class="kill-row">
      <div class="kill-state">
        {#if !cockpit?.configured}
          <Badge variant="default">UNKNOWN</Badge>
          <span class="kill-desc">Sentinel unreadable while the cockpit store is unavailable.</span>
        {:else if inst?.sentinel.state === 'killed'}
          <Badge variant="red">KILLED</Badge>
          <span class="kill-desc">
            {inst.sentinel.reason ?? 'no reason recorded'}
            {#if inst.sentinel.trippedAtMs}&nbsp;({tsLabel(inst.sentinel.trippedAtMs)}){/if}
            — the {selected} bot refuses entries and flattens reduce-only on its next live bar,
            and stays halted across respawns until re-armed.
          </span>
        {:else}
          <Badge variant="green">CLEAR</Badge>
          <span class="kill-desc">No kill sentinel set for “{selected}” — normal running.</span>
        {/if}
      </div>
      <div class="kill-actions">
        {#if inst?.sentinel.state === 'killed'}
          <button
            class="btn-rearm"
            disabled={!cockpit?.configured || !canRearm}
            onclick={() => openDialog('rearm')}
          >
            RE-ARM {selected}…
          </button>
          {#if !canRearm}
            <span class="role-hint">read-only ({role}) — re-arm is admin-only</span>
          {/if}
        {:else}
          <button
            class="btn-kill"
            disabled={!cockpit?.configured || !canKill}
            onclick={() => openDialog('kill')}
          >
            KILL {selected}…
          </button>
          {#if !canKill}
            <span class="role-hint">read-only (viewer)</span>
          {/if}
        {/if}
      </div>
    </div>
    <p class="kill-footnote">
      Setting the sentinel is NOT an instant venue flatten — the bot acts on its next live bar
      (60m cadence). For an immediate venue-direct flatten, run <code>live-flatten</code> per the
      kill-switch drill runbook. Instances are independent: killing “paper” can never touch
      “live” and vice-versa (FR_INSTANCE-keyed sentinel rows). The cockpit targets the literal
      keys “paper”/“live” — the deploy convention FR_INSTANCE=live must hold for KILL to reach
      the armed bot.
    </p>
    {#if (cockpit?.other_sentinel_instances?.length ?? 0) > 0}
      <p class="data-flag">
        ⚠️ Sentinel rows exist under unexpected instance keys:
        {cockpit?.other_sentinel_instances?.join(', ')} — a bot running under such an FR_INSTANCE
        is NOT reachable by this cockpit's KILL (which only writes “paper”/“live”).
      </p>
    {/if}
    {#if actionResult && !dialog}
      <p class="action-result" class:err={!actionResult.ok}>{actionResult.text}</p>
    {/if}
  </Panel>

  <!-- ── Session stats ───────────────────────────────────────────────────── -->
  <!-- Gated on liveDetected for the LIVE tab: an empty live ledger folds to
       honest zeros, but a green "+0.00 / 0 / 0" row under the "no live bot
       detected" banner reads like a running, flat bot. Absence of a bot must
       not look like a breakeven bot. Zero renders neutral, not green. -->
  {#if inst && (selected !== 'live' || liveDetected)}
    <div class="stat-row">
      <StatCard
        label="Session realized (UTC day)"
        value={usdt(inst.session.realizedUsdt)}
        valueColor={inst.session.realizedUsdt > 0
          ? 'var(--green)'
          : inst.session.realizedUsdt < 0
            ? 'var(--red)'
            : undefined}
      />
      <StatCard label="Closes today" value={inst.session.closes} />
      <StatCard label="Entries today" value={inst.session.entries} />
      <StatCard
        label="Kill exits today"
        value={inst.session.killExits}
        color={inst.session.killExits > 0 ? 'red' : 'default'}
      />
      <StatCard label="Open positions" value={inst.positions.length} />
      {#if selected === 'live'}
        <StatCard
          label="Live notional (telemetry)"
          value={tele?.scraped && tele.openNotionalUsd !== null
            ? `$${tele.openNotionalUsd.toFixed(0)}`
            : '—'}
        />
      {/if}
    </div>
    {#if inst.session.closesWithoutUsdt > 0}
      <p class="data-flag">
        ⚠️ {inst.session.closesWithoutUsdt} close(s) today carry no USDT booking — excluded from
        the realized sum (flagged, not imputed).
      </p>
    {/if}
  {:else if inst}
    <p class="mode-hint">
      Session stats suppressed — no live bot detected (an empty ledger would render as a running,
      flat bot).
    </p>
  {/if}

  <div class="panel-grid">
    <!-- ── Open positions (state of record) ──────────────────────────────── -->
    <Panel title="Open positions — funding_open_trades ({selected})">
      {#if !cockpit?.configured}
        <EmptyState icon="🔌" title="Store unavailable" hint="Position records unreadable." />
      {:else if !inst || inst.positions.length === 0}
        <EmptyState icon="∅" title="No open positions" hint="No persisted open trade for this instance." />
      {:else}
        <!-- A-4: the widest table in the app (6 columns, measured 436.6px) inside
             a 368px panel body on a phone. Panel is overflow:hidden, so without
             this wrapper the "Close status" column was CUT AT THE PANEL BORDER
             with no scrollbar and no page overflow to hint at it — a row reading
             "CLOSING (funding_flip, attempt 3)" looked complete and the operator
             never learned the close was failing. -->
        <div class="table-scroll">
        <table class="ck-table">
          <thead>
            <tr><th>Symbol</th><th>Side</th><th>Entry px</th><th>Age</th><th>Unrealized</th><th>Close status</th></tr>
          </thead>
          <tbody>
            {#each inst.positions as p (p.symbol)}
              <tr>
                <td>{p.symbol}</td>
                <td class={p.dir > 0 ? 'pos' : 'neg'}>{p.side}</td>
                <!-- Q3: entry_px is a bare JSONB float from the bot's store.
                     Default stringification gave ragged precision and no
                     grouping ("60000") on the one table the operator reads
                     while deciding whether to KILL, while every other price
                     surface in the app uses fmtPrice. -->
                <td>{fmtPrice(p.entryPx)}</td>
                <td>{ago(p.entryTMs)}</td>
                <td>
                  {#if selected === 'paper'}
                    {#if paperRetBySym[p.symbol] !== undefined}
                      <span class={paperRetBySym[p.symbol] >= 0 ? 'pos' : 'neg'}>
                        {paperRetBySym[p.symbol].toFixed(2)}%
                      </span>
                    {:else}
                      <span class="muted" title="Unrealized PnL needs the instance's own /status feed — not wired for this instance yet.">n/a</span>
                    {/if}
                  {:else if !liveConfigured}
                    <!-- env unset: honest n/a, tooltip names the var to set -->
                    <span class="muted" title="Live unrealized needs the live twin's /status feed — set CRYPTO_FUNDING_LIVE_INTERNAL_URL (empty by default) to enable.">n/a</span>
                  {:else if liveModeMismatch}
                    <!-- env pointed at a PAPER twin: refuse to render paper PnL as live -->
                    <span class="neg" title="The configured live-status URL serves a PAPER document (mode is not live) — refusing to show paper PnL as live.">⚠ paper doc</span>
                  {:else if liveFeedDown}
                    <!-- armed bot whose status server died = OUTAGE, never n/a -->
                    <span class="feed-down" title={liveStatus?.reason ?? 'live status feed unreachable'}>status feed down</span>
                  {:else if liveRetBySym[p.symbol] !== undefined}
                    <span
                      class={liveRetBySym[p.symbol].ret_pct >= 0 ? 'pos' : 'neg'}
                      title="mark {liveRetBySym[p.symbol].mark_px}"
                    >
                      {liveRetBySym[p.symbol].ret_pct.toFixed(2)}%
                    </span>
                  {:else}
                    <!-- DB row is source of record; /status only enriches -->
                    <span class="muted" title="This symbol is in funding_open_trades (state of record) but absent from the live /status feed.">not in /status feed</span>
                  {/if}
                </td>
                <td>
                  {#if p.closing}
                    <Badge variant="amber">CLOSING ({p.closing.reason}, attempt {p.closing.attempts})</Badge>
                  {:else}
                    <Badge variant="default">holding</Badge>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        </div>
      {/if}
      {#if (cockpit?.other_instance_keys?.length ?? 0) > 0}
        <p class="data-flag">
          Keys under other instance prefixes exist: {cockpit?.other_instance_keys?.join(', ')}
        </p>
      {/if}
      {#if selected === 'live' && liveModeMismatch}
        <p class="data-flag-red">
          ⚠ Live-status feed is serving a PAPER document (mode = “{liveStatus?.status?.mode}”).
          Unrealized PnL is suppressed — check that CRYPTO_FUNDING_LIVE_INTERNAL_URL points at
          the LIVE twin, not the paper container.
        </p>
      {:else if selected === 'live' && liveFeedDown}
        <p class="data-flag">
          Live-status feed unreachable ({liveStatus?.reason ?? 'no reason'}) — an armed bot's
          status server is down. Unrealized shows an outage, not n/a.
        </p>
      {/if}
    </Panel>

    <!-- ── Risk gates (persisted) ────────────────────────────────────────── -->
    <Panel title="Risk gates — framework_risk_state ({inst?.gateBotName ?? '…'})">
      {#if !cockpit?.configured}
        <EmptyState icon="🔌" title="Store unavailable" hint="Gate rows unreadable." />
      {:else if !inst || inst.gates.length === 0}
        <EmptyState
          icon="∅"
          title="No persisted gate state"
          hint="No halt/breaker snapshot rows for this instance yet (written on realized trades)."
        />
      {:else}
        <div class="table-scroll">
        <table class="ck-table">
          <thead>
            <tr><th>Symbol</th><th>Session halt (−1% eq/day)</th><th>Circuit breaker (4-loss)</th></tr>
          </thead>
          <tbody>
            {#each inst.gates as g (g.symbol)}
              <tr>
                <td>{g.symbol}</td>
                <td>
                  {#if g.haltedNow}
                    <Badge variant="red">HALTED</Badge>
                  {:else if g.haltedPersisted}
                    <Badge variant="default">cleared by UTC rollover</Badge>
                  {:else}
                    <Badge variant="green">clear</Badge>
                  {/if}
                </td>
                <td>
                  {#if g.breakerActiveNow}
                    <Badge variant="red">TRIPPED</Badge>
                  {:else if g.breakerTrippedAtUnix}
                    <Badge variant="default">cooldown elapsed</Badge>
                  {:else}
                    <Badge variant="green">clear</Badge>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        </div>
      {/if}
    </Panel>

    <!-- ── Live armed-path telemetry ─────────────────────────────────────── -->
    <Panel title="Armed-path telemetry — Prometheus :9092 (live only)">
      {#if !tele}
        <EmptyState icon="⏳" title="Loading telemetry…" />
      {:else if !tele.available}
        <EmptyState
          icon="⚠️"
          variant="error"
          title="Prometheus unreachable"
          hint="Telemetry outage — halt/breaker/stop divergence cannot be observed right now."
        />
      {:else if !tele.scraped}
        <EmptyState
          icon="🛰️"
          title="No live armed-path series"
          hint="The :9092 money-path exporter is scraped only for LIVE bots — paper mode / awaiting arm. This is the honest state, not zeros."
        />
      {:else}
        <!-- Per-column: a FAILED query renders an explicit unobserved-error,
             never the benign "no series" (a failed stop-expected query must
             not read as "no stop expected" on a live position). -->
        <div class="tele-grid">
          <div>
            <h4>Session halt</h4>
            {#if tele.failed.includes('halt')}
              <span class="tele-err">query failed — halt state unobserved</span>
            {:else}
              {#each Object.entries(tele.haltBySymbol) as [sym, v] (sym)}
                <div class="tele-line">
                  <span>{sym}</span>
                  {#if v > 0}<Badge variant="red">HALTED</Badge>{:else}<Badge variant="green">clear</Badge>{/if}
                </div>
              {:else}
                <span class="muted">no series</span>
              {/each}
            {/if}
          </div>
          <div>
            <h4>Circuit breaker</h4>
            {#if tele.failed.includes('breaker')}
              <span class="tele-err">query failed — breaker state unobserved</span>
            {:else}
              {#each Object.entries(tele.breakerBySymbol) as [sym, v] (sym)}
                <div class="tele-line">
                  <span>{sym}</span>
                  {#if v > 0}<Badge variant="red">TRIPPED</Badge>{:else}<Badge variant="green">clear</Badge>{/if}
                </div>
              {:else}
                <span class="muted">no series</span>
              {/each}
            {/if}
          </div>
          <div>
            <h4>Resting stop (present / expected)</h4>
            {#if tele.failed.includes('stopPresent') || tele.failed.includes('stopExpected')}
              <span class="tele-err">
                stop telemetry incomplete — divergence cannot be assessed (a live position may be
                unprotected without showing DIVERGED)
              </span>
            {:else}
              {#each Object.entries(tele.stops) as [sym, s] (sym)}
                <div class="tele-line">
                  <span>{sym}: {s.present}/{s.expected}</span>
                  {#if s.diverged}
                    <Badge variant="red">DIVERGED — position may be unprotected</Badge>
                  {:else if s.expected > 0}
                    <Badge variant="green">protected</Badge>
                  {:else}
                    <Badge variant="default">none expected</Badge>
                  {/if}
                </div>
              {:else}
                <span class="muted">no series</span>
              {/each}
            {/if}
          </div>
        </div>
        {#if tele.failed.length > 0}
          <p class="data-flag">
            ⚠️ Failed telemetry queries: {tele.failed.join(', ')} — treat the affected columns as
            unobserved, not clear.
          </p>
        {/if}
      {/if}
    </Panel>

    <!-- ── Order errors ──────────────────────────────────────────────────── -->
    <Panel title="Order errors by class — fks_bot_order_errors_total (live)">
      {#if !tele || !tele.available}
        <EmptyState icon="⚠️" variant={tele ? 'error' : 'default'} title={tele ? 'Prometheus unreachable' : 'Loading…'} />
      {:else if tele.failed.includes('orderErrors')}
        <!-- The counter query itself failed — this must NEVER render as the
             green "zero errors" all-clear (a failed query is not an empty
             counter). -->
        <EmptyState
          icon="⚠️"
          variant="error"
          title="Order-error counter unobserved"
          hint="The fks_bot_order_errors_total query failed while Prometheus otherwise answered — error state cannot be asserted right now (this is NOT a zero-errors all-clear)."
        />
      {:else if !tele.scraped}
        <EmptyState icon="🛰️" title="No live bot scraped" hint="Awaiting arm — error counters exist only on a live instance." />
      {:else if tele.orderErrors.length === 0}
        <EmptyState icon="✓" title="No order errors recorded" hint="Counter series present, zero errors." />
      {:else}
        <div class="table-scroll">
        <table class="ck-table">
          <thead><tr><th>Class</th><th>Total</th></tr></thead>
          <tbody>
            {#each tele.orderErrors as e (e.cls)}
              <tr>
                <td>{e.cls}</td>
                <td class={e.total > 0 ? 'neg' : ''}>{e.total}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        </div>
      {/if}
    </Panel>
  </div>

  <!-- ── Armed-path alerts (M3 Phase B) ──────────────────────────────────── -->
  <!-- The alert-ack inbox filtered to the live money-path rules, with inline
       Ack — the 3 a.m. flow: the cockpit shows the alert, the operator reads
       the gate/telemetry panels above, and acks from this same screen. Shares
       the /monitoring poll + StatusBar chip (one poll, three surfaces). -->
  <Panel title="Armed-path alerts">
    <p class="armed-blurb">
      Live money-path alerts (halt · breaker · stop-divergence · crash) from
      Prometheus, acknowledgeable inline. Full feed on
      <a href="/monitoring">/monitoring</a>.
    </p>
    <AlertInbox
      inbox={$alertInbox}
      loading={$alertInbox === null}
      filter={isArmedAlert}
      onacked={() => alertInbox.refresh()}
    />
  </Panel>
</div>

<!-- ── Typed-confirmation dialog ────────────────────────────────────────── -->
<Modal
  open={dialog !== null}
  title={dialog === 'rearm'
    ? `Re-arm ${selected.toUpperCase()} — clear the kill sentinel`
    : `KILL ${selected.toUpperCase()} — trip the durable kill sentinel`}
  onclose={closeDialog}
>
  <div class="dialog-body">
    {#if dialog === 'kill'}
      <p>
        This writes the durable kill sentinel for instance
        <strong>“{selected}”</strong>{selected === 'live' ? ' — the REAL-MONEY instance' : ' — the paper measurement twin'}.
        On its next live bar the bot refuses new entries and routes any open trade to a
        reduce-only <code>kill_exit</code>, then stays halted (across respawns) until re-armed.
      </p>
      {#if selected === 'paper'}
        <p class="warn-line">
          ⚠️ Killing “paper” halts the Gate-A measurement twin — its window is sacred until ~Aug 1.
        </p>
      {/if}
      <p>
        It does <strong>not</strong> instantly flatten the venue. If the bot may be hung or you
        need immediate flatness, run <code>live-flatten</code> (runbook §0).
      </p>
    {:else}
      <p>
        This clears the kill sentinel for instance <strong>“{selected}”</strong> — the bot may
        trade again on its next live bar. <strong>Never re-arm with an unreconciled venue</strong>
        (confirm flat + stops cancelled first, runbook §0 step 4).
      </p>
    {/if}
    <label class="confirm-label">
      Type <code>{requiredPhrase}</code> to confirm targeting <strong>{selected}</strong>:
      <input
        class="confirm-input"
        type="text"
        bind:value={confirmText}
        placeholder={requiredPhrase}
        autocomplete="off"
        spellcheck="false"
      />
    </label>
    <label class="confirm-label">
      Note (optional, recorded on the sentinel):
      <input class="confirm-input" type="text" bind:value={note} maxlength="200" />
    </label>
    {#if actionResult}
      <p class="action-result" class:err={!actionResult.ok}>{actionResult.text}</p>
    {/if}
  </div>
  {#snippet actions()}
    <button class="btn-cancel" onclick={closeDialog}>Cancel</button>
    <button
      class={dialog === 'rearm' ? 'btn-rearm' : 'btn-kill'}
      disabled={!phraseOk || submitting}
      onclick={fireAction}
    >
      {submitting ? 'Writing…' : dialog === 'rearm' ? `RE-ARM ${selected}` : `KILL ${selected}`}
    </button>
  {/snippet}
</Modal>

<style>
  .cockpit-page {
    /* One scroll region (page archetype) so the below-fold risk-gate,
       telemetry and order-error panels are reachable on laptop viewports. */
    height: 100%;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    max-width: 1200px;
  }
  .page-blurb {
    font-size: 12px;
    color: var(--t2);
    margin: 0;
  }
  .blurb-links {
    white-space: nowrap;
    margin-left: 4px;
    color: var(--t3);
  }
  .blurb-links a {
    color: var(--t3);
    text-decoration: none;
  }
  .blurb-links a:hover {
    color: var(--cyan);
    text-decoration: underline;
  }
  .mode-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .inst-tabs {
    display: inline-flex;
    border: 1px solid var(--b2);
    border-radius: var(--r);
    overflow: hidden;
  }
  .inst-tab {
    background: var(--bg2);
    color: var(--t2);
    border: none;
    padding: 6px 16px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    letter-spacing: 0.06em;
  }
  .inst-tab.active {
    background: var(--bg3);
    color: var(--t1);
  }
  /* A-2 — PAPER/LIVE is not a view filter: it chooses WHICH INSTANCE the kill
     button below targets. On a phone it computed to 26px, well under the 44px
     touch floor, so a thumb aiming at PAPER could land on LIVE.
     The floor alone would make that WORSE, not better: two flush segments in a
     seamless control mean a bigger target is also a bigger overlap with its
     neighbour. So the seam is broken at the same time — the shared frame moves
     onto each button and a real 12px moat opens between them, and the group
     gets more air from the Freshness/Badge chips either side. Fills and text
     colours are untouched, so `.active` still reads exactly as before. */
  @media (pointer: coarse) {
    .mode-row {
      gap: 14px;
    }
    .inst-tabs {
      gap: 12px;
      border: none;
      border-radius: 0;
      overflow: visible;
    }
    .inst-tab {
      min-height: 44px;
      padding: 6px 18px;
      border: 1px solid var(--b2);
      border-radius: var(--r);
    }
  }
  .mode-hint {
    font-size: 11px;
    color: var(--t3);
  }
  .kill-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .kill-state {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 240px;
  }
  .kill-desc {
    font-size: 12px;
    color: var(--t2);
  }
  .btn-kill {
    background: var(--red-dim);
    color: var(--red);
    border: 1px solid var(--red-brd);
    border-radius: var(--r);
    padding: 8px 18px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    cursor: pointer;
  }
  .btn-kill:disabled,
  .btn-rearm:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .btn-rearm {
    background: var(--green-dim);
    color: var(--green);
    border: 1px solid var(--green-brd);
    border-radius: var(--r);
    padding: 8px 18px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }
  .btn-cancel {
    background: var(--bg3);
    color: var(--t2);
    border: 1px solid var(--b2);
    border-radius: var(--r);
    padding: 8px 14px;
    font-size: 12px;
    cursor: pointer;
  }
  .kill-footnote {
    font-size: 11px;
    color: var(--t3);
    margin: 8px 0 0;
  }
  .role-hint {
    font-size: 11px;
    color: var(--amber, #e0a000);
    align-self: center;
    white-space: nowrap;
  }
  .action-result {
    font-size: 12px;
    color: var(--green);
    margin: 8px 0 0;
  }
  .action-result.err {
    color: var(--red);
  }
  .stat-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 8px;
  }
  .data-flag {
    font-size: 11px;
    color: var(--amber);
    margin: 0;
  }
  .data-flag-red {
    font-size: 11px;
    color: var(--red);
    margin: 0;
    font-weight: 600;
  }
  .feed-down {
    color: var(--amber);
    font-size: 11px;
  }
  .panel-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    gap: 12px;
    align-items: start;
  }
  /* A-4 — the only sanctioned inner scroller here. CLAUDE.md forbids wrapping a
     table in its own overflow:auto INSIDE A `fill` PANEL (that is the nested
     double-scroll); every cockpit Panel is rigid, so this absorbs the extra
     width horizontally while the PAGE still owns the single vertical scroll.
     overscroll-behavior-x keeps a swipe that runs off the end of the table from
     propagating out to the shell. */
  .table-scroll {
    overflow-x: auto;
    overscroll-behavior-x: contain;
  }
  .ck-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .ck-table th {
    text-align: left;
    color: var(--t3);
    font-weight: 600;
    padding: 4px 8px;
    border-bottom: 1px solid var(--b2);
  }
  .ck-table td {
    padding: 5px 8px;
    border-bottom: 1px solid var(--b1);
    color: var(--t1);
  }
  .pos {
    color: var(--green);
  }
  .neg {
    color: var(--red);
  }
  .muted {
    color: var(--t3);
  }
  .tele-err {
    color: var(--red);
    font-size: 12px;
  }
  .tele-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
  }
  .tele-grid h4 {
    font-size: 11px;
    color: var(--t3);
    margin: 0 0 6px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .tele-line {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    font-size: 12px;
    padding: 2px 0;
  }
  .armed-blurb {
    font-size: 11px;
    color: var(--t3);
    margin: 0 0 8px;
  }
  .dialog-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-size: 13px;
    max-width: 460px;
  }
  .dialog-body p {
    margin: 0;
  }
  .warn-line {
    color: var(--amber);
  }
  .confirm-label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--t2);
  }
  .confirm-input {
    background: var(--bg1);
    border: 1px solid var(--b2);
    border-radius: var(--r);
    color: var(--t1);
    padding: 7px 10px;
    font-size: 13px;
    font-family: inherit;
  }
</style>
