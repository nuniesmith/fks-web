<script lang="ts">
  /**
   * Experience Map — the "what is janus thinking" view.
   *
   * Fetches recent experience vectors (9-dim pooled GASF decision states)
   * from /api/janus/experiences/sample, projects them to 2-D with UMAP
   * client-side (seeded PRNG → stable layout for the same data), and draws
   * a canvas scatter colored by action / reward / confidence / regime.
   * Every point is one per-bar decision transition from live paper trading
   * (EXPERIENCE_PIPELINE.md §8).
   */
  import { onMount } from 'svelte';
  import { api } from '$api/client';
  import { confidenceColor, mulberry32, regimeColor, rewardColor } from '$lib/utils/experienceMap';

  interface SamplePoint {
    id: string;
    vector: number[];
    payload: {
      action_type?: number;
      action_symbol?: string;
      reward?: number;
      timestamp_ms?: number;
      confidence?: number | null;
      blocked?: boolean | null;
      interval?: string | null;
      regime?: string | null;
      [k: string]: unknown;
    };
  }

  let canvasEl: HTMLCanvasElement;
  let points = $state<SamplePoint[]>([]);
  let coords = $state<[number, number][]>([]);
  let total = $state(0);
  let loading = $state(false);
  let projecting = $state(false);
  let error = $state('');
  let colorBy = $state<'action' | 'reward' | 'confidence' | 'regime'>('action');
  let sampleSize = $state(2000);
  let symbolFilter = $state('');
  let hover = $state<{ x: number; y: number; p: SamplePoint } | null>(null);

  const ACTION_NAMES = ['Buy', 'Sell', 'Hold', 'Close'];
  const ACTION_COLORS = ['#16c784', '#ea3943', '#5c6480', '#f0b90b'];

  let regimesSeen = $derived.by(() => {
    const set = new Set<string>();
    for (const p of points) if (p.payload.regime) set.add(p.payload.regime as string);
    return [...set].sort();
  });

  let rewardBound = $derived.by(() => {
    const abs = points.map((p) => Math.abs(p.payload.reward ?? 0)).sort((a, b) => a - b);
    return abs.length ? abs[Math.floor(abs.length * 0.95)] || 1e-6 : 1e-6;
  });

  function pointColor(p: SamplePoint): string {
    switch (colorBy) {
      case 'action': return ACTION_COLORS[p.payload.action_type ?? 2] ?? '#5c6480';
      case 'reward': return rewardColor(p.payload.reward ?? 0, rewardBound);
      case 'confidence': return confidenceColor(p.payload.confidence);
      case 'regime': return regimeColor(p.payload.regime);
    }
  }

  async function load() {
    loading = true;
    error = '';
    hover = null;
    try {
      const params = new URLSearchParams({ limit: String(sampleSize) });
      if (symbolFilter.trim()) params.set('symbol', symbolFilter.trim().toUpperCase());
      const res = await api.get<{ points: SamplePoint[]; total: number }>(
        `/api/janus/experiences/sample?${params}`
      );
      points = (res?.points ?? []).filter((p) => Array.isArray(p.vector) && p.vector.length > 0);
      total = res?.total ?? 0;
      await project();
    } catch (e: any) {
      error = e?.message ?? 'sample endpoint unreachable';
      points = [];
      coords = [];
    } finally {
      loading = false;
    }
  }

  async function project() {
    coords = [];
    if (points.length < 5) {
      draw();
      return;
    }
    projecting = true;
    // Yield a frame so the busy indicator paints before the CPU burn.
    await new Promise((r) => setTimeout(r, 30));
    try {
      const { UMAP } = await import('umap-js');
      const umap = new UMAP({
        nComponents: 2,
        nNeighbors: Math.min(15, points.length - 1),
        minDist: 0.1,
        random: mulberry32(0x1a2b3c4d), // stable layout per dataset
      });
      const raw = umap.fit(points.map((p) => p.vector)) as [number, number][];
      // Normalize into [0,1]² for canvas mapping.
      const xs = raw.map((c) => c[0]);
      const ys = raw.map((c) => c[1]);
      const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
      const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
      coords = raw.map(([x, y]) => [
        x1 > x0 ? (x - x0) / (x1 - x0) : 0.5,
        y1 > y0 ? (y - y0) / (y1 - y0) : 0.5,
      ]);
    } finally {
      projecting = false;
      draw();
    }
  }

  const PAD = 14;
  function draw() {
    const ctx = canvasEl?.getContext('2d');
    if (!ctx) return;
    const { width, height } = canvasEl;
    ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < coords.length; i++) {
      const [nx, ny] = coords[i];
      ctx.beginPath();
      ctx.arc(
        PAD + nx * (width - 2 * PAD),
        PAD + (1 - ny) * (height - 2 * PAD),
        points[i].payload.action_type === 2 ? 2 : 3.5,
        0,
        Math.PI * 2
      );
      ctx.fillStyle = pointColor(points[i]);
      ctx.globalAlpha = points[i].payload.action_type === 2 ? 0.45 : 0.95;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function onMove(e: MouseEvent) {
    if (!coords.length) return;
    const rect = canvasEl.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * canvasEl.width;
    const my = ((e.clientY - rect.top) / rect.height) * canvasEl.height;
    let best = -1;
    let bestD = 12 * 12;
    for (let i = 0; i < coords.length; i++) {
      const px = PAD + coords[i][0] * (canvasEl.width - 2 * PAD);
      const py = PAD + (1 - coords[i][1]) * (canvasEl.height - 2 * PAD);
      const d = (px - mx) ** 2 + (py - my) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    hover = best >= 0 ? { x: e.clientX - rect.left, y: e.clientY - rect.top, p: points[best] } : null;
  }

  function fmtTime(ms?: number): string {
    if (!ms) return '—';
    return new Date(ms).toLocaleTimeString('en-US', { hour12: false });
  }

  $effect(() => {
    // Redraw when the color dimension changes (coords unchanged).
    void colorBy;
    draw();
  });

  onMount(() => {
    load();
  });
</script>

<div class="map-wrap">
  <div class="map-controls">
    <label class="ctl">
      Color by
      <select bind:value={colorBy}>
        <option value="action">Action</option>
        <option value="reward">Reward</option>
        <option value="confidence">Confidence</option>
        <option value="regime">Regime</option>
      </select>
    </label>
    <label class="ctl">
      Sample
      <select bind:value={sampleSize} onchange={load}>
        <option value={500}>500</option>
        <option value={2000}>2000</option>
        <option value={5000}>5000</option>
      </select>
    </label>
    <input
      class="sym-input"
      type="text"
      placeholder="symbol filter…"
      bind:value={symbolFilter}
      onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && load()}
    />
    <button class="btn-ghost" onclick={load} disabled={loading || projecting}>
      {loading ? '⏳ Loading…' : projecting ? '⏳ Projecting…' : '↻ Refresh'}
    </button>
    <span class="meta">{points.length.toLocaleString()} shown / {total.toLocaleString()} total</span>
  </div>

  {#if colorBy === 'action'}
    <div class="legend">
      {#each ACTION_NAMES as name, i}
        <span class="legend-item"><span class="dot" style="background:{ACTION_COLORS[i]}"></span>{name}</span>
      {/each}
    </div>
  {:else if colorBy === 'regime' && regimesSeen.length}
    <div class="legend">
      {#each regimesSeen as r}
        <span class="legend-item"><span class="dot" style="background:{regimeColor(r)}"></span>{r}</span>
      {/each}
    </div>
  {:else if colorBy === 'reward'}
    <div class="legend"><span class="legend-item"><span class="dot" style="background:#ea3943"></span>loss</span><span class="legend-item"><span class="dot" style="background:#16c784"></span>gain</span></div>
  {/if}

  <div class="canvas-holder">
    <canvas bind:this={canvasEl} width="860" height="440" onmousemove={onMove} onmouseleave={() => (hover = null)}></canvas>
    {#if loading || projecting}
      <div class="overlay">{loading ? 'Sampling experiences…' : 'Computing UMAP projection…'}</div>
    {:else if error}
      <div class="overlay err">Sample endpoint unreachable — {error}</div>
    {:else if points.length === 0}
      <div class="overlay">No experiences yet — the pipeline populates this during paper trading.</div>
    {/if}
    {#if hover}
      <div class="tooltip" style="left: {hover.x + 12}px; top: {hover.y + 12}px;">
        <div><b>{hover.p.payload.action_symbol}</b> · {ACTION_NAMES[hover.p.payload.action_type ?? 2]}{hover.p.payload.blocked ? ' (blocked)' : ''}</div>
        <div>reward {(hover.p.payload.reward ?? 0).toExponential(2)} · conf {hover.p.payload.confidence?.toFixed(2) ?? '—'}</div>
        <div>{hover.p.payload.regime ?? 'regime —'} · {hover.p.payload.interval ?? ''} · {fmtTime(hover.p.payload.timestamp_ms)}</div>
      </div>
    {/if}
  </div>
</div>

<style>
  .map-wrap { display: flex; flex-direction: column; gap: 6px; }
  .map-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 11px; }
  .ctl { display: flex; align-items: center; gap: 5px; color: var(--t3); text-transform: uppercase; font-size: 9px; letter-spacing: 0.05em; }
  .ctl select, .sym-input {
    background: var(--bg2); border: 1px solid var(--b2); color: var(--t1);
    border-radius: var(--r); padding: 3px 6px; font-family: inherit; font-size: 11px;
  }
  .sym-input { width: 110px; }
  .meta { margin-left: auto; color: var(--t3); font-size: 10px; }
  .legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 10px; color: var(--t2); }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .canvas-holder { position: relative; }
  canvas { width: 100%; height: auto; background: var(--bg0); border: 1px solid var(--b1); border-radius: var(--r-md); cursor: crosshair; }
  .overlay {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: var(--t3); font-size: 12px; pointer-events: none;
  }
  .overlay.err { color: var(--red); }
  .tooltip {
    position: absolute; z-index: 10; pointer-events: none;
    background: var(--bg1); border: 1px solid var(--b2); border-radius: var(--r-md);
    padding: 6px 9px; font-size: 10px; color: var(--t1); line-height: 1.5;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5); max-width: 260px;
  }
</style>
