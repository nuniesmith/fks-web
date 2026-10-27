<!--
  One recorder instance (a template instance with kind=recorder): what it is
  recording right now, and what it has written.

  Live: the recorder's own /status through the spawner, polled every 10 s.
  Message rates are computed here from two successive counts, so the first
  poll shows totals and the second shows rates.

  Written: GET /instances/{name}/files, the files actually on disk, turned into
  a 30-day calendar by $lib/coverage. A hole in the calendar is a day nobody
  can download later for liquidations or 1 s mark price, which is why the
  calendar is the centre of this card.

  Actions: stop, start, delete (InstanceActions). Deleting removes the
  container and the saved config; the data folder is always kept.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { createPoll } from '$stores/poll';
  import Badge from '$components/ui/Badge.svelte';
  import InstanceActions from '$components/data/InstanceActions.svelte';
  import { calendar, completeShare, fmtBytes, fmtDuration, utcDay, type DayCell } from '$lib/coverage';
  import type {
    BotStatusResponse,
    Instance,
    InstanceFilesResponse,
    RecorderStatus,
  } from '$lib/types/spawner';

  let { instance, onchanged }: { instance: Instance; onchanged?: () => void } = $props();

  // The parent re-keys this card when the container changes, so what the
  // polls address is fixed for the card's lifetime.
  const fixed = untrack(() => ({
    name: instance.name,
    botId: instance.bot_id,
    running: instance.container?.state === 'running',
    symbols: Array.isArray(instance.params?.symbols) ? (instance.params!.symbols as string[]) : [],
  }));
  const running = fixed.running;
  const status = running
    ? createPoll<BotStatusResponse<RecorderStatus>>(
        `/api/spawner/bots/${encodeURIComponent(fixed.botId)}/status`,
        10_000,
      )
    : null;
  const files = createPoll<InstanceFilesResponse>(
    `/api/spawner/instances/${encodeURIComponent(fixed.name)}/files?days=30`,
    60_000,
  );
  const statusError = status?.error;
  const filesError = files.error;
  // Client only: a poll started during SSR would fetch a relative URL there.
  onMount(() => {
    status?.start();
    files.start();
    return () => {
      status?.stop();
      files.stop();
    };
  });

  // ── Live rates from two successive counts ─────────────────────────────────
  let prev: { at: number; counts: Record<string, number> } | null = null;
  let rates = $state<Record<string, number>>({});
  let now = $state(Date.now());
  onMount(() => {
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(tick);
  });

  let doc = $derived(status && $status?.ok ? ($status.status ?? null) : null);
  $effect(() => {
    if (!doc) return;
    const counts = Object.fromEntries(Object.entries(doc.streams ?? {}).map(([k, v]) => [k, v.count]));
    const at = doc.updated_at_ms;
    if (prev && at > prev.at) {
      const dt = (at - prev.at) / 1000;
      rates = Object.fromEntries(
        Object.entries(counts).map(([k, c]) => [k, Math.max(0, (c - (prev!.counts[k] ?? c)) / dt)]),
      );
    }
    prev = { at, counts };
  });

  let streams = $derived(
    doc
      ? Object.entries(doc.streams ?? {})
          .map(([key, s]) => ({ key, ...s }))
          .sort((a, b) => a.stream.localeCompare(b.stream))
      : [],
  );
  let groups = $derived(doc ? Object.entries(doc.groups ?? {}) : []);

  // ── Coverage ──────────────────────────────────────────────────────────────
  let coverage = $derived($files?.ok ? $files.coverage : null);
  let today = $derived(utcDay(now));
  let cells = $derived(coverage ? calendar(coverage, today, 30) : []);
  let share = $derived(completeShare(cells));
  let todayBytes = $derived(cells.find((c) => c.day === today)?.bytes ?? 0);

  function ageText(ms: number | null | undefined): string {
    if (!ms) return '—';
    const s = Math.max(0, (now - ms) / 1000);
    return s < 1 ? 'now' : `${fmtDuration(s)} ago`;
  }

  function cellTitle(c: DayCell): string {
    const head = `${c.day}: ${c.state}`;
    const size = c.bytes ? ` · ${fmtBytes(c.bytes)}` : '';
    const gaps = c.gapCount ? ` · ${c.gapCount} gaps, ${fmtDuration(c.gapSeconds)}` : '';
    const why = c.reasons.length ? ` — ${c.reasons.join('; ')}` : '';
    return head + size + gaps + why;
  }

  const symbols = fixed.symbols;
</script>

<article class="rec" data-testid="recorder-card" data-instance={instance.name}>
  <header class="rec-head">
    <h3 class="rec-name">{instance.name}</h3>
    <Badge variant={running ? 'green' : 'amber'}>{instance.container?.state ?? 'no container'}</Badge>
    <span class="rec-meta">{instance.template ?? 'unknown template'} · {symbols.join(', ') || '—'}</span>
  </header>

  {#if running}
    {#if doc}
      <table class="streams" aria-label="Streams recorded by {instance.name}">
        <thead>
          <tr><th>Stream</th><th>Symbol</th><th class="r">msg/s</th><th class="r">Last message</th><th class="r">Messages</th></tr>
        </thead>
        <tbody>
          {#each streams as s (s.key)}
            <tr>
              <td>{s.stream}</td>
              <td>{s.symbol}</td>
              <td class="r">{rates[s.key] != null ? rates[s.key].toFixed(rates[s.key] < 10 ? 2 : 0) : '…'}</td>
              <td class="r" class:warn={s.stream !== 'forceOrder' && !!s.last_recv_ts_ms && now - s.last_recv_ts_ms > 120_000}>
                {ageText(s.last_recv_ts_ms)}
              </td>
              <td class="r">{s.count.toLocaleString()}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="rec-line">
        {#each groups as [name, g] (name)}
          <span class="grp" class:down={!g.connected}>
            {name} {g.connected ? 'connected' : 'DISCONNECTED'} · {g.disconnects} reconnects · gaps {fmtDuration(g.gap_ms_total / 1000)}
          </span>
        {/each}
      </p>
    {:else}
      <p class="rec-line" role="status">
        {#if $statusError}
          Live status unavailable — {$statusError.includes('404') ? 'the spawner does not serve bot status yet' : $statusError}
        {:else}
          Loading live status…
        {/if}
      </p>
    {/if}
  {:else}
    <p class="rec-line warn">Not recording. Start it to resume; the gap will be in the ledger.</p>
  {/if}

  <section class="cal-wrap" aria-label="Coverage, last 30 days (UTC)">
    {#if coverage}
      <div class="cal" role="list">
        {#each cells as c (c.day)}
          <span class="cell {c.state}" role="listitem" title={cellTitle(c)} aria-label={cellTitle(c)}></span>
        {/each}
      </div>
      <p class="rec-line">
        {#if share != null}{Math.round(share * 100)}% of recorded days complete ·{/if}
        today {fmtBytes(todayBytes)} · {coverage.total_days} days, {fmtBytes(coverage.total_bytes)} on disk
        {#if coverage.first_day}· since {coverage.first_day}{/if}
        {#if $files?.disk}· {fmtBytes($files.disk.free_bytes)} free{/if}
      </p>
      <p class="legend" aria-hidden="true">
        <span class="cell complete"></span>complete <span class="cell gaps"></span>gaps
        <span class="cell partial"></span>partial <span class="cell missing"></span>missing
        <span class="cell open"></span>today
      </p>
    {:else if $filesError}
      <p class="rec-line" role="status">
        Coverage unavailable — {$filesError.includes('404') ? 'the spawner does not serve recorder files yet' : $filesError}
      </p>
    {:else}
      <p class="rec-line" role="status">Reading the data folder…</p>
    {/if}
  </section>

  <InstanceActions {instance} {running} noun="recorder" {onchanged} />
</article>

<style>
  .rec {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    background: var(--bg2);
    border: 1px solid var(--b2);
    border-radius: var(--r-md);
    min-width: 0;
  }
  .rec-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .rec-name {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--t1);
  }
  .rec-meta {
    font-size: 11px;
    color: var(--t3);
  }
  .streams {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .streams th {
    text-align: left;
    font-size: 9px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--t3);
    padding: 3px 4px;
    border-bottom: 1px solid var(--b1);
  }
  .streams td {
    padding: 3px 4px;
    border-bottom: 1px solid var(--b1);
    color: var(--t1);
  }
  .r {
    text-align: right;
  }
  .rec-line {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    margin: 0;
    font-size: 11px;
    color: var(--t2);
  }
  .warn,
  .streams td.warn {
    color: var(--amber);
  }
  .grp.down {
    color: var(--red);
    font-weight: 600;
  }
  .cal {
    display: grid;
    grid-template-columns: repeat(30, minmax(0, 1fr));
    gap: 2px;
    max-width: 560px;
  }
  .cell {
    display: inline-block;
    height: 14px;
    border-radius: 2px;
    background: var(--bg3);
    border: 1px solid var(--b1);
  }
  .cell.complete {
    background: var(--green);
    border-color: var(--green);
  }
  .cell.gaps {
    background: var(--amber);
    border-color: var(--amber);
  }
  .cell.partial {
    background: var(--amber-dim, #5a4300);
    border-color: var(--amber);
  }
  .cell.missing {
    background: var(--red);
    border-color: var(--red);
  }
  .cell.open {
    background: transparent;
    border-color: var(--cyan);
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    margin: 0;
    font-size: 9px;
    color: var(--t3);
  }
  .legend .cell {
    width: 10px;
    height: 10px;
    margin-right: 2px;
  }
</style>
