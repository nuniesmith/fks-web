<script lang="ts">
  import { createSSE } from '$stores/sse';
  import { focusSymbol } from '$stores/focusSymbol';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import type { StripData } from '$lib/types';
  import { fmtPrice, fmtPct, pnlVariant } from '$lib/utils/format';

  const sse = createSSE<StripData>('/sse/strip');

  let data = $derived($sse);

  // ─── Identity (A3/A4) ───────────────────────────────────────────────
  // Set on event.locals by the hook, surfaced via +layout.server.ts. Null
  // for unauthenticated pages and for WEBUI_AUTH=disabled (then authDisabled
  // is true so we badge "auth off" instead of an identity).
  let user = $derived($page.data.user as { username: string; role: string } | null);
  let authDisabled = $derived($page.data.authDisabled === true);

  // ─── The hand-traded account ────────────────────────────────────────
  // Loaded in +layout.server.ts and null on ANY failure, so this cell shows
  // "no account" rather than the shell failing to render. The strip is
  // decoration; reaching /cockpit to hit the kill switch is not.
  let account = $derived(
    $page.data.focusAccount as
      | { id: string; label: string; stage: string | null; positions_ready: boolean }
      | null,
  );

  $effect(() => {
    const sym = data?.focus?.symbol;
    if (sym) {
      focusSymbol.set(sym);
    }
  });

  // ─── Live clock ─────────────────────────────────────────────────────
  let clock = $state('');

  function updateClock() {
    clock = new Date().toLocaleTimeString('en-US', {
      hour12: false,
      timeZoneName: 'short',
    });
  }

  onMount(() => {
    sse.connect();
    updateClock();
    const clockInterval = setInterval(updateClock, 1_000);

    return () => {
      sse.disconnect();
      clearInterval(clockInterval);
    };
  });
</script>

<header class="strip" aria-label="Trading status strip">
  <div class="strip-cell" aria-label="Focus symbol">
    <span class="lbl">FOCUS</span>
    <a href="/trading" class="val accent focus-link">{data?.focus?.symbol ?? '—'}</a>
    <span class="val">{fmtPrice(data?.focus?.price)}</span>
    <span
      class="val"
      class:green={pnlVariant(data?.focus?.change_pct) === 'green'}
      class:red={pnlVariant(data?.focus?.change_pct) === 'red'}
    >
      {fmtPct(data?.focus?.change_pct)}
    </span>
  </div>

  <!-- ACCOUNT replaces the old REGIME cell. Regime had the same dead feed as
       P&L/RISK below, and the strip must not grow: it is the one row present on
       every page including a 320px phone. Which account you are trading is also
       the more useful fact — it is the thing every number further down the
       screen is implicitly about. -->
  <div class="strip-cell" aria-label="Hand-traded account">
    <span class="lbl">ACCT</span>
    {#if account}
      <span class="val" title="{account.label} ({account.id})">
        {account.label}
        {#if account.stage}<span class="acct-stage">{account.stage}</span>{/if}
        <!-- Positions need account_id + fcm_id + ib_id; the connector skips the
             reader SILENTLY without them, so an unmarked account name would
             imply a working positions feed that is not running. -->
        {#if !account.positions_ready}<span class="acct-warn" title="account_id / fcm_id / ib_id incomplete — the positions reader is not running">no pos</span>{/if}
      </span>
    {:else}
      <span class="val muted" title="No enabled main trading account is declared in Settings">none</span>
    {/if}
  </div>

  <!-- ⚠ P&L AND RISK ARE NOT WIRED. `/sse/strip` has no adapter dispatch, so it
       falls to gracefulEmpty's idle SSE stub and `data` is permanently null in
       the shipped app. These render "n/a", NOT "—": a dash next to a dollar
       sign reads as a real, flat number, and a fabricated flat P&L on every
       page is the exact failure a previous fix here already had to undo (a
       `?? 0` fallback made `0 >= 0` true forever and painted it green).
       "n/a" cannot be misread as a value.

       Do not "restore" a dash, and do not delete these cells either — the
       layout slot is where a real feed will land, and removing them hides that
       the platform still owes the operator a P&L. -->
  <div class="strip-cell" aria-label="Profit and loss (no data source)">
    <span class="lbl">P&L</span>
    <span
      class="val muted"
      title="Not wired: /sse/strip has no backend. This is not a flat P&L."
    >
      {data?.pnl?.daily != null ? `$${data.pnl.daily.toFixed(2)}` : 'n/a'}
    </span>
  </div>

  <div class="strip-cell" aria-label="Risk drawdown (no data source)">
    <span class="lbl">RISK</span>
    <span
      class="val"
      class:muted={data?.risk?.dd_pct == null}
      class:amber={(data?.risk?.dd_pct ?? 0) > 2}
      class:red={(data?.risk?.dd_pct ?? 0) > 5}
      title="Not wired: /sse/strip has no backend. This is not a zero drawdown."
    >
      {data?.risk?.dd_pct != null ? `DD ${data.risk.dd_pct.toFixed(1)}%` : 'n/a'}
    </span>
  </div>

  <div class="strip-cell clock" aria-label="Clock" aria-live="off">
    <span class="val muted" id="fks-clock">{clock}</span>
  </div>

  {#if user}
    <div class="strip-cell identity" aria-label="Signed-in user">
      <span class="lbl">USER</span>
      <span class="val">{user.username}</span>
      <span class="val role" data-role={user.role}>{user.role}</span>
      <a href="/logout" class="val logout-link" data-sveltekit-preload-data="off">logout</a>
    </div>
  {:else if authDisabled}
    <div class="strip-cell identity" aria-label="Authentication disabled">
      <span class="val role" data-role="disabled">auth off</span>
    </div>
  {/if}
</header>

<style>
  .strip {
    /* Grow by the top safe-area inset so the strip's --bg1 fills the status-bar
       zone (standalone/black-translucent) while the 48px content row keeps its
       size. env() is 0 on desktop → pixel-identical there. */
    height: calc(var(--strip-h) + env(safe-area-inset-top, 0px));
    padding-top: env(safe-area-inset-top, 0px);
    background: var(--bg1);
    border-bottom: 1px solid var(--b1);
    display: flex;
    align-items: center;
    padding-left: 12px;
    padding-right: 12px;
    gap: 2px;
    overflow: hidden;
    flex-shrink: 0;
  }
  .strip-cell {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px;
    border-right: 1px solid var(--b1);
    height: 100%;
    white-space: nowrap;
  }
  .strip-cell:last-child { border-right: none; margin-left: auto; }
  .lbl {
    font-size: 9px;
    color: var(--t3);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .val {
    font-size: 13px;
    font-weight: 600;
  }
  .clock { margin-left: auto; }
  /* When the identity cell is present it becomes the last child; keep it snug
     against the clock (the clock's margin-left:auto already pushes the group
     right) rather than inheriting the last-child auto gap. */
  .identity { margin-left: 0; }
  .focus-link {
    color: var(--accent);
    text-decoration: none;
    cursor: pointer;
  }
  .focus-link:hover { text-decoration: underline; }
  .role {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 1px 6px;
    border-radius: 3px;
    border: 1px solid var(--b1);
    color: var(--t2);
  }
  .role[data-role="admin"] { color: var(--accent); border-color: var(--accent); }
  .role[data-role="operator"] { color: var(--cyan); border-color: var(--cyan); }
  .role[data-role="disabled"] { color: var(--amber, #e0a000); border-color: var(--amber, #e0a000); }
  .logout-link {
    color: var(--t3);
    text-decoration: none;
    font-size: 11px;
  }
  .logout-link:hover { color: var(--t1); text-decoration: underline; }

  /* ── Phone width: stop the silent cell clipping ─────────────────────────
     5 fixed cells + overflow:hidden clip RISK/REGIME/clock mid-glyph at phone
     widths. Drop the redundant REGIME + clock (the OS status bar already shows
     a clock), tighten padding, and fall back to a hidden-scrollbar horizontal
     scroll so nothing is ever clipped mid-glyph on SE-class widths. */
  @media (max-width: 640px) {
    .strip {
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
    }
    .strip::-webkit-scrollbar { display: none; }
    .strip-cell { padding: 0 8px; }
    /* 4th cell = REGIME; .clock = trailing clock — both dropped on phone. */
    .strip-cell:nth-child(4),
    .strip-cell.clock { display: none; }
    /* RISK (now the last visible cell) sheds its trailing divider. */
    .strip-cell:nth-child(3) { border-right: none; }
  }
  /* Stage and the incomplete-triple flag ride inside the ACCT value so the cell
     stays one grid slot — the strip is the only row on a 320px phone. */
  .acct-stage {
    font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--t2); margin-left: 0.3rem;
  }
  .acct-warn {
    font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--amber); margin-left: 0.3rem;
  }

</style>
