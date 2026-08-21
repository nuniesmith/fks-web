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

  <div class="strip-cell" aria-label="Profit and loss">
    <span class="lbl">P&L</span>
    <!-- `/sse/strip` has no adapter dispatch (gracefulEmpty's idle SSE stub),
         so `data` is permanently null in the shipped app today. `pnlVariant`
         returns 'default' (no colour class) for null/undefined — the `?? 0`
         fallback this replaced made `0 >= 0` true forever, painting a
         fabricated green P&L on every page, desktop and phone. -->
    <span
      class="val"
      class:green={pnlVariant(data?.pnl?.daily) === 'green'}
      class:red={pnlVariant(data?.pnl?.daily) === 'red'}
    >
      ${data?.pnl?.daily?.toFixed(2) ?? '—'}
    </span>
  </div>

  <div class="strip-cell" aria-label="Risk drawdown">
    <span class="lbl">RISK</span>
    <span
      class="val"
      class:amber={(data?.risk?.dd_pct ?? 0) > 2}
      class:red={(data?.risk?.dd_pct ?? 0) > 5}
    >
      DD {data?.risk?.dd_pct?.toFixed(1) ?? '—'}%
    </span>
  </div>

  <div class="strip-cell" aria-label="Market regime">
    <span class="lbl">REGIME</span>
    <span class="val muted">{data?.regime?.label ?? '—'}</span>
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
</style>
