<!--
  Live logs of one container, over the spawner's SSE stream
  (GET /api/spawner/container/{id}/logs?tail=N, `event: log` per line).

  Follows the tail until the reader scrolls up, and offers a button to follow
  again. The buffer is capped so a chatty container cannot grow the DOM
  without bound. Closing (or switching container) closes the stream.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { spawner } from '$api/spawner';

  let { containerId, title, onclose }: { containerId: string; title: string; onclose: () => void } = $props();

  const MAX_LINES = 2000;
  let lines = $state<string[]>([]);
  let connected = $state(false);
  let follow = $state(true);
  let pane = $state<HTMLDivElement | null>(null);
  let source: EventSource | null = null;

  $effect(() => {
    const id = containerId;
    source?.close();
    lines = [];
    connected = false;
    follow = true;
    const ev = spawner.openLogStream(id, 200);
    source = ev;
    ev.addEventListener('log', (e: MessageEvent) => {
      connected = true;
      const next = [...lines, e.data];
      lines = next.length > MAX_LINES ? next.slice(-Math.floor(MAX_LINES * 0.75)) : next;
    });
    ev.onopen = () => (connected = true);
    ev.onerror = () => (connected = false);
    return () => ev.close();
  });
  onDestroy(() => source?.close());

  $effect(() => {
    void lines.length;
    if (follow && pane) {
      const el = pane;
      requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
    }
  });

  function onScroll(e: Event) {
    const el = e.currentTarget as HTMLDivElement;
    follow = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  }
</script>

<section class="logs" aria-label="Logs of {title}">
  <header class="logs-head">
    <span class="logs-title">{title}</span>
    <span class="dot" class:on={connected} aria-label={connected ? 'connected' : 'disconnected'}></span>
    <span class="muted">{lines.length.toLocaleString()} lines</span>
    {#if !follow}
      <button class="btn" onclick={() => (follow = true)}>Follow tail</button>
    {/if}
    <button class="btn close" onclick={onclose} aria-label="Close logs">Close</button>
  </header>
  <div class="pane" bind:this={pane} onscroll={onScroll} role="log" aria-live="off">
    {#if lines.length === 0}
      <p class="muted">{connected ? 'No output yet.' : 'Connecting…'}</p>
    {/if}
    {#each lines as line, i (i)}
      <div class="line">{line}</div>
    {/each}
  </div>
</section>

<style>
  .logs {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .logs-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: 11px;
  }
  .logs-title {
    font-weight: 600;
    color: var(--t1);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--t3);
  }
  .dot.on {
    background: var(--green);
  }
  .muted {
    color: var(--t3);
    font-size: 11px;
  }
  .btn {
    padding: 2px 10px;
    min-height: 26px;
    background: transparent;
    border: 1px solid var(--b2);
    border-radius: var(--r);
    color: var(--t1);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .close {
    margin-left: auto;
  }
  .pane {
    max-height: 360px;
    overflow: auto;
    padding: 6px 8px;
    background: var(--bg0, #050505);
    border: 1px solid var(--b1);
    border-radius: var(--r);
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 10.5px;
    line-height: 1.45;
    overscroll-behavior: contain;
  }
  .line {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--t2);
  }
  @media (pointer: coarse) {
    .btn {
      min-height: 44px;
    }
  }
</style>
