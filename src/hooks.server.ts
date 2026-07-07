import type { Handle, RequestEvent } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { computeIndicators, INDICATOR_CATALOG, type Candle } from "$lib/server/indicators";
import {
  type CandleRow,
  humanizeSince,
  intervalToSeconds,
  mapCandleRows,
  reshapeHealth,
  reshapePerformance,
  reshapeRiskConfig,
  resampleCandles,
  sanitizeInterval,
  sanitizeSymbol,
  signalStatus,
  toRiskConfigPayload,
  wantsArrayResponse,
} from "$lib/server/reshape";
import { routeRequest, upstreamHeaders } from "$lib/server/adapter";

// ════════════════════════════════════════════════════════════════════════════
// Backend proxy  (replaces the old vite/nginx → fks_ruby reverse proxy)
// ════════════════════════════════════════════════════════════════════════════
// The dashboard makes same-origin calls to /api, /sse, /bars, /factory, /kraken,
// /fapi. Those used to be proxied to the Python "Ruby" service, which is gone.
// This hook is the single backend seam: it maps each path to janus
// (fks_janus:8080 api / :8180 forward), Prometheus, QuestDB, or the spawner —
// reshaping where the WebUI's shape differs — and gracefully absorbs anything
// not yet mapped (empty REST / idle SSE) so panels degrade quietly instead of
// flooding the console with 404s.
//
// Mapped today: /api/spawner/* (spawner); the dashboard / signals / health /
// performance / janus-ai / risk paths + the front-page scores / trades / factory
// panels (janus); /api/metrics/* (Prometheus); /bars + /charts candles (QuestDB);
// /sse/bars (janus live tail when JANUS_BARS_SSE_URL is set). Unmapped backend
// paths → graceful empty. See docs/architecture/WEBUI_JANUS_REPOINT.md.
//
// Upstreams use in-container Docker-network addresses (overridable via env).
// NB: from inside the webui container, janus is fks_janus:8080 (api) /
//     fks_janus:8180 (forward) — NOT the host-published :7000/:7001.
const SPAWNER_URL = env.SPAWNER_INTERNAL_URL ?? "http://fks_bot_spawner:8090";
const JANUS_URL = env.JANUS_INTERNAL_URL ?? "http://fks_janus:8080"; // janus-api
const JANUS_FORWARD_URL = env.JANUS_FORWARD_INTERNAL_URL ?? "http://fks_janus:8180"; // forward (brain/risk)
const PROMETHEUS_URL = env.PROMETHEUS_INTERNAL_URL ?? "http://fks_prometheus:9090"; // /monitoring
const QUESTDB_URL = env.QUESTDB_INTERNAL_URL ?? "http://fks_questdb:9000"; // /charts OHLC (HTTP query API)
// Crypto bot status servers (/exchanges page). Defaults are the Phase-2
// container DNS names (spawner-managed fks-bot-* on fks_network); during the
// transitional systemd phase set these to the host bridge instead, e.g.
// http://host.docker.internal:9091 (spot) / :9095 (funding) — the webui
// container needs extra_hosts host-gateway for that name on Linux. `||` (not
// ??) so an empty compose passthrough falls back to the defaults.
const CRYPTO_SPOT_URL = env.CRYPTO_SPOT_INTERNAL_URL || "http://fks-bot-crypto-spot:9091";
const CRYPTO_FUNDING_URL = env.CRYPTO_FUNDING_INTERNAL_URL || "http://fks-bot-crypto-funding:9091";
// Futures live-bars SSE bridge (D1). Empty by default → /sse/bars/:sym serves the
// graceful idle stub (unchanged). Set to a janus SSE base (the symbol is appended
// as "/<sym>", emitting `event: bar` frames) to pipe futures bars to the chart.
const JANUS_BARS_SSE_URL = env.JANUS_BARS_SSE_URL ?? "";
// Backward service HTTP API inside the janus container (unified binary
// serves it from start_module; port = janus http 8080 + 200). Must match
// janus PR #140's wiring — env-correctable if that ever moves.
const BACKWARD_URL = env.BACKWARD_INTERNAL_URL ?? "http://fks_janus:8280";

// Forward a request to `base + path`, streaming the response straight back.
async function forward(
  event: RequestEvent,
  base: string,
  path: string,
): Promise<Response> {
  const method = event.request.method;
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: upstreamHeaders(event.request.headers),
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = await event.request.arrayBuffer();
    init.duplex = "half";
  }
  try {
    const res = await fetch(base + path, init);
    const headers = upstreamHeaders(res.headers);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } catch {
    return new Response(JSON.stringify({ error: "upstream_unreachable", upstream: base }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}

// Unmapped backend path → degrade quietly so the UI doesn't error.
function gracefulEmpty(pathname: string): Response {
  // SSE / streaming endpoints: hold an idle, well-formed event stream so the
  // browser's EventSource stays "connected" (no error + reconnect storm).
  const isSse =
    pathname.startsWith("/sse/") ||
    pathname.endsWith("/stream") ||
    /\/sse(\/|$)/.test(pathname);
  if (isSse) {
    let iv: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(": fks — backend not wired yet (janus repoint pending)\n\n"));
        // Heartbeat keeps the connection genuinely alive so EventSource doesn't
        // treat an idle socket as dropped and reconnect-loop.
        iv = setInterval(() => {
          try {
            controller.enqueue(enc.encode(": keepalive\n\n"));
          } catch {
            if (iv) clearInterval(iv);
          }
        }, 25_000);
      },
      cancel() {
        if (iv) clearInterval(iv);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-fks-unmapped": "1",
      },
    });
  }
  // REST: return an empty list or object. Most polled endpoints want an array;
  // singular/status-ish ones want an object — cheap heuristic, good enough to
  // keep components from throwing while the panel is unmapped.
  const wantsArray = wantsArrayResponse(pathname);
  return new Response(wantsArray ? "[]" : "{}", {
    status: 200,
    headers: { "content-type": "application/json", "x-fks-unmapped": "1" },
  });
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Read a janus JSON endpoint, tolerating failure (returns {} on any error).
async function janusJson(event: RequestEvent, base: string, path: string): Promise<any> {
  try {
    const r = await fetch(base + path, { headers: upstreamHeaders(event.request.headers) });
    return await r.json();
  } catch {
    return {};
  }
}

// janus recent signals — { symbol, signal_type, confidence, timestamp }[].
// Sourced from the live /api/signals/latest feed (populated by janus's
// SignalBus→Redis persistence). The old /api/dashboard/signals/summary
// .recent_signals path returned empty on the running stack, so the /signals
// page and the overview recent-signals panel (both consumers of this helper)
// showed nothing despite live signals flowing.
async function janusRecentSignals(event: RequestEvent): Promise<
  {
    symbol?: string;
    signal_type?: string;
    confidence?: number;
    timestamp?: string;
    metadata?: Record<string, string>;
  }[]
> {
  const j = await janusJson(event, JANUS_URL, "/api/signals/latest");
  const arr = Array.isArray(j) ? j : Array.isArray(j?.signals) ? j.signals : [];
  return arr.map((s: Record<string, unknown>) => ({
    symbol: s.symbol as string | undefined,
    signal_type: s.signal_type as string | undefined,
    confidence: s.confidence as number | undefined,
    timestamp: s.timestamp as string | undefined,
    metadata: s.metadata as Record<string, string> | undefined,
  }));
}

// /api/health → reshape janus /health into the StatusBar's flat {redis,janus,feed}.
// janus /health: { status, forward_service, components: Record<string,{status}> }.
// Two consumers share /api/health: the bottom StatusBar wants a flat
// {redis,janus,feed}; the /settings "System Info" panel wants {status,components,
// version,uptime}. We return a superset so both render (and the settings panel
// no longer hits `healthData.status` undefined).
async function janusHealth(event: RequestEvent): Promise<Response> {
  const j = await janusJson(event, JANUS_URL, "/health");
  return json(reshapeHealth(j));
}

// /api/janus/state → the /janus-ai "Janus State" panel's JanusStateResponse:
//   { janus: { status }, redis: { regime, affinity, signals_recent } }.
// `janus.status` is the trading brain's health (forward /api/v1/brain/health),
// falling back to the api service /health. `signals_recent` reuses the dashboard
// signals feed. regime/affinity have no janus feed wired here yet → empty (the
// panel renders a clean "no data" state rather than stale Ruby shapes).
async function janusState(event: RequestEvent): Promise<Response> {
  const [brain, health, sigs] = await Promise.all([
    janusJson(event, JANUS_FORWARD_URL, "/api/v1/brain/health"),
    janusJson(event, JANUS_URL, "/health"),
    janusRecentSignals(event),
  ]);
  const rawStatus =
    typeof brain?.healthy === "boolean"
      ? brain.healthy
        ? "ok"
        : "down"
      : String(brain?.state ?? brain?.status ?? health?.status ?? "down");
  // The panel greens on 'UP'/'ok'; normalise any healthy-ish word to 'ok'.
  const status = /^(ok|up|healthy|running|connected|active)$/i.test(rawStatus)
    ? "ok"
    : rawStatus.toUpperCase();
  return json({
    janus: { status },
    redis: {
      regime: {},
      affinity: {},
      signals_recent: sigs.map((s) => ({
        symbol: s.symbol,
        direction: s.signal_type,
        confidence: s.confidence,
        timestamp: s.timestamp,
      })),
    },
  });
}

// /api/janus/affinity → the /janus-ai "Strategy Affinity" matrix:
//   { status, weights: Record<strategy, Record<asset, number>> }.
// Sourced from forward /api/v1/brain/affinity; if janus returns a different
// shape we degrade to an empty matrix (panel shows "no affinity data").
async function janusAffinity(event: RequestEvent): Promise<Response> {
  const a = await janusJson(event, JANUS_FORWARD_URL, "/api/v1/brain/affinity");
  const weights = a && typeof a.weights === "object" && a.weights ? a.weights : {};
  return json({ status: String(a?.status ?? "ok"), weights });
}

// /api/performance → the /performance metrics grid (Performance shape).
// Merges forward /api/v1/risk/performance (preferred) with /api/dashboard/
// performance, mapping fields defensively. Empty in the paper demo (no closed
// trades through janus) → every card shows "—"; populates once trades flow.
async function janusPerformance(event: RequestEvent): Promise<Response> {
  const [risk, dash] = await Promise.all([
    janusJson(event, JANUS_FORWARD_URL, "/api/v1/risk/performance"),
    janusJson(event, JANUS_URL, "/api/dashboard/performance"),
  ]);
  return json(reshapePerformance(risk, dash));
}

// ── /monitoring: Prometheus proxy ───────────────────────────────────────────
// The /monitoring page calls /api/metrics/* (these used to be served by Ruby's
// data service, which queried Prometheus and reshaped). We reprise that role:
// query/query_range/targets are a straight pass-through (identical shapes), and
// alerts/layout get a light reshape.

// /api/metrics/alerts → reshape Prometheus /api/v1/alerts ({data:{alerts:[…]}})
// into the page's { data: Alert[] } with an age_str derived from activeAt.
async function promAlerts(event: RequestEvent): Promise<Response> {
  const j = await janusJson(event, PROMETHEUS_URL, "/api/v1/alerts");
  const list: any[] = Array.isArray(j?.data?.alerts) ? j.data.alerts : [];
  return json({
    data: list.map((a) => ({
      labels: a?.labels ?? {},
      age_str: humanizeSince(a?.activeAt),
      severity_color: "",
    })),
  });
}

// /api/metrics/layout — Ruby served a configurable dashboard layout; there's no
// janus/Prometheus equivalent, so we ship a small default built only from
// synthetic metrics Prometheus always generates (up, scrape_duration_seconds),
// plus the live alert-feed/targets panels. Node/redis KPIs depend on exporters.
const METRICS_LAYOUT = {
  panels: [
    { id: "targets_up", type: "stat", title: "Targets Up", query: "sum(up)" },
    { id: "targets_total", type: "stat", title: "Targets Total", query: "count(up)" },
    {
      id: "scrape_p95",
      type: "sparkline",
      title: "Scrape Duration (1h, max)",
      query: "max(scrape_duration_seconds)",
      color: "var(--cyan)",
    },
    { id: "alerts", type: "alert-feed", title: "Active Alerts" },
    { id: "targets", type: "targets", title: "Scrape Targets" },
  ],
};

// ── /charts: historical OHLC + indicators from QuestDB ──────────────────────
// Candles come from QuestDB's `candles_crypto` (timestamp µs — the designated
// timestamp column, symbol, exchange,
// interval, o/h/l/c/v) via the HTTP /exec query API. The page strips the quote
// currency (BTC/USD → BTC), so we match the symbol loosely (exact, or
// `SYM/…`/`SYM-…`). Live updates are client-side (crypto: Kraken/Binance WS) or
// /sse/bars (futures, still stubbed); this is the history backbone.

// Query candles_crypto → ascending rows { tsMs, o,h,l,c,v }. Shared by the
// candles endpoint and the indicators endpoint.
// One QuestDB candles_crypto query. `sym`/`iv` are already sanitized (they go
// into the SQL string literal). Returns ascending OHLCV rows ([] on any failure).
async function queryCandles(
  sym: string,
  iv: string,
  days: number,
  lim: number,
  beforeIso?: string,
): Promise<CandleRow[]> {
  // With `beforeIso` (history pagination) the days window anchors to that
  // cutoff instead of now(), so scrolling far back keeps returning rows.
  const timeCond = beforeIso
    ? `timestamp < '${beforeIso}' AND timestamp >= dateadd('d', -${days}, cast('${beforeIso}' as timestamp))`
    : `timestamp >= dateadd('d', -${days}, now())`;
  const sql =
    `SELECT cast(timestamp as long) t, open, high, low, close, volume FROM candles_crypto ` +
    `WHERE (symbol = '${sym}' OR symbol LIKE '${sym}/%' OR symbol LIKE '${sym}-%') ` +
    `AND interval = '${iv}' AND ${timeCond} ` +
    `ORDER BY timestamp DESC LIMIT ${lim}`;
  try {
    const r = await fetch(`${QUESTDB_URL}/exec?query=${encodeURIComponent(sql)}`, {
      headers: { accept: "application/json" },
    });
    const j: any = await r.json();
    return mapCandleRows(j?.dataset);
  } catch {
    return [];
  }
}

async function fetchCandles(event: RequestEvent, symbolRaw: string): Promise<CandleRow[]> {
  // Strip anything that isn't a symbol char — these go straight into a SQL string
  // literal, so this is also the injection guard.
  const sym = sanitizeSymbol(symbolRaw, 32);
  if (!sym) return [];
  const p = event.url.searchParams;
  const iv = sanitizeInterval(p.get("interval"));
  const days = Math.min(365, Math.max(1, parseInt(p.get("days_back") ?? "5", 10) || 5));
  const lim = Math.min(5000, Math.max(1, parseInt(p.get("limit") ?? "1000", 10) || 1000));
  // Optional history pagination: only bars strictly older than `before` (ms
  // epoch). Numeric parse → Date → ISO keeps the SQL literal injection-safe.
  // Upper bound = max representable Date (8.64e15 ms): beyond it toISOString
  // throws, which a crafted ?before= must degrade from, not 500.
  const beforeMs = parseInt(p.get("before") ?? "", 10);
  const beforeIso =
    Number.isFinite(beforeMs) && beforeMs > 0 && beforeMs <= 8.64e15
      ? new Date(beforeMs).toISOString()
      : undefined;

  let rows = await queryCandles(sym, iv, days, lim, beforeIso);

  // B3: if nothing is stored natively at this interval, synthesize it by
  // resampling 1m bars. Only fires when the direct query came back empty, so it
  // can only improve on the "no data" case — it never changes a populated chart.
  const sec = intervalToSeconds(iv);
  if (rows.length === 0 && iv !== "1m" && sec !== null && sec % 60 === 0) {
    const oneMin = await queryCandles(
      sym,
      "1m",
      days,
      Math.min(5000, Math.ceil((sec / 60) * lim)),
      beforeIso,
    );
    if (oneMin.length > 0) rows = resampleCandles(oneMin, sec);
  }
  return rows;
}

// GET /bars/:symbol/candles → { candles: [{ timestamp /*ms*/, o,h,l,c,v }] }.
async function questdbCandles(event: RequestEvent, symbolRaw: string): Promise<Response> {
  const rows = await fetchCandles(event, symbolRaw);
  return json({
    candles: rows.map((r) => ({
      timestamp: r.tsMs,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    })),
  });
}

// GET /api/chart/:symbol/indicators?interval=&indicators=rsi,macd,bbands,atr,… →
// { indicators: { <key>: [{ time /*sec*/, value }] } } computed from the candles.
// Keys match what the chart expects (bb_upper/bb_middle/bb_lower, rsi, atr,
// macd_line/macd_signal/macd_hist, ema9/sma20/vwap, …).
async function chartIndicators(event: RequestEvent, symbolRaw: string): Promise<Response> {
  const rows = await fetchCandles(event, symbolRaw);
  const candles: Candle[] = rows.map((r) => ({
    time: Math.floor(r.tsMs / 1000), // ms → s, matching the chart's candle time
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
  const names = (event.url.searchParams.get("indicators") ?? "").split(",");
  return json({ indicators: computeIndicators(candles, names) });
}

// Run a QuestDB /exec query and return its dataset rows ([] on any failure).
async function questdbRows(sql: string): Promise<any[]> {
  try {
    const r = await fetch(`${QUESTDB_URL}/exec?query=${encodeURIComponent(sql)}`, {
      headers: { accept: "application/json" },
    });
    const j: any = await r.json();
    return Array.isArray(j?.dataset) ? j.dataset : [];
  } catch {
    return [];
  }
}

// GET /api/assets/search?q= → the chart's symbol picker. Real symbols straight
// from QuestDB `candles_crypto` (so you can only pick symbols that have data).
async function symbolSearch(event: RequestEvent): Promise<Response> {
  // Sanitised + uppercased — goes into a SQL literal (injection guard).
  const q = sanitizeSymbol(event.url.searchParams.get("q"), 24).toUpperCase();
  if (!q) return json({ results: [] });
  const rows = await questdbRows(
    `SELECT DISTINCT symbol, exchange FROM candles_crypto ` +
      `WHERE upper(symbol) LIKE '%${q}%' ORDER BY symbol LIMIT 30`,
  );
  return json({
    results: rows.map((row) => ({
      symbol: String(row[0]),
      name: String(row[0]),
      type: "crypto",
      exchange: row[1] != null ? String(row[1]) : undefined,
    })),
  });
}

// GET /api/assets/:short → the chart's asset-routing lookup (AssetInfo). We map
// the stored exchange to `source`/`source_chain` so the page picks the right
// live-data path; unknown symbols → {} (page falls back to its slash heuristic).
async function assetInfo(event: RequestEvent, shortRaw: string): Promise<Response> {
  const sym = sanitizeSymbol(shortRaw, 24).toUpperCase();
  if (!sym) return json({});
  const rows = await questdbRows(
    `SELECT exchange FROM candles_crypto ` +
      `WHERE upper(symbol) = '${sym}' OR upper(symbol) LIKE '${sym}/%' ` +
      `OR upper(symbol) LIKE '${sym}-%' LIMIT 1`,
  );
  const ex = rows[0]?.[0] != null ? String(rows[0][0]) : "";
  if (!ex) return json({});
  return json({ type: "crypto", source: ex, source_chain: [ex] });
}

// /settings risk panel ↔ janus forward /api/v1/risk/config (rustrade
// PortfolioRiskConfig: max_daily_loss ≤ 0, max_concurrent_positions,
// max_gross_exposure). The UI works in positive USD for the daily-loss limit; we
// flip the sign on write. The save is honest now (a real PUT) — no fake "Saved".
async function riskConfigGet(event: RequestEvent): Promise<Response> {
  const c = await janusJson(event, JANUS_FORWARD_URL, "/api/v1/risk/config");
  return json(reshapeRiskConfig(c));
}

async function riskConfigPost(event: RequestEvent): Promise<Response> {
  let body: any = {};
  try {
    body = await event.request.json();
  } catch {
    /* empty / non-JSON body */
  }
  const payload = toRiskConfigPayload(body);
  try {
    const headers = upstreamHeaders(event.request.headers);
    headers.set("content-type", "application/json");
    const r = await fetch(`${JANUS_FORWARD_URL}/api/v1/risk/config`, {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
    });
    if (!r.ok) return json({ ok: false, message: `risk update rejected (${r.status})` }, 502);
    return json({ ok: true });
  } catch {
    return json({ ok: false, message: "risk service unreachable" }, 502);
  }
}

// ── /settings exchange API keys → the spawner's secret store (Postgres ruby_db).
// SECURITY: the browser only ever SUBMITS credentials here; they are never read
// back. The spawner persists them server-side behind X-Internal-Token; the
// status endpoint reports only WHICH exchanges are configured (never the keys).
// Default operation is keyless/public — keys only unlock the authenticated path.
// Exchange ids are free-form server-side (the spawner stores them as strings);
// constrain to a sane slug so arbitrary UI input can't smuggle odd characters.
function sanitizeExchangeId(raw: unknown): string {
  const s = (typeof raw === "string" ? raw : "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(s) ? s : "";
}

// `exchange` comes from the legacy per-venue routes; the generic
// POST /api/settings/exchange-keys route reads it from the body instead.
async function exchangeKeysPost(event: RequestEvent, exchange?: string): Promise<Response> {
  let body: any = {};
  try {
    body = await event.request.json();
  } catch {
    /* empty / non-JSON body */
  }
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const exch = exchange ?? sanitizeExchangeId(body?.exchange);
  if (!exch) {
    return json({ ok: false, message: "A valid exchange id is required (a-z, 0-9, -, _)" }, 400);
  }
  const api_key = str(body?.api_key);
  const api_secret = str(body?.api_secret);
  const passphrase = str(body?.api_passphrase);
  if (!api_key || !api_secret) {
    return json({ ok: false, message: "API key and secret are required" }, 400);
  }
  const payload: Record<string, string> = { exchange: exch, api_key, api_secret };
  if (passphrase) payload.api_passphrase = passphrase;
  try {
    const headers = upstreamHeaders(event.request.headers);
    headers.set("content-type", "application/json");
    const r = await fetch(`${SPAWNER_URL}/secrets`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (r.status === 503) {
      return json({ ok: false, message: "Secret storage (spawner DB) is not configured" }, 503);
    }
    if (!r.ok) return json({ ok: false, message: `Save rejected by spawner (${r.status})` }, 502);
    return json({ ok: true, exchange: exch });
  } catch {
    return json({ ok: false, message: "Secret storage service unreachable" }, 502);
  }
}

// GET → whether the given exchange has stored credentials (never the secrets).
async function exchangeKeysStatus(event: RequestEvent, exchange: string): Promise<Response> {
  try {
    const headers = upstreamHeaders(event.request.headers);
    const r = await fetch(`${SPAWNER_URL}/secrets/status`, { headers });
    if (!r.ok) return json({ configured: false, db_enabled: false });
    const j: any = await r.json();
    const list: any[] = Array.isArray(j?.exchanges) ? j.exchanges : [];
    const match = list.find((e) => String(e?.exchange ?? "").toLowerCase() === exchange);
    return json({
      configured: !!match,
      updated_at: match?.updated_at,
      db_enabled: j?.db_enabled !== false,
    });
  } catch {
    return json({ configured: false, db_enabled: false });
  }
}

// GET /api/settings/exchange-keys/status → every stored credential (ids +
// updated_at only — never the secrets), for the dynamic /settings list.
async function exchangeKeysStatusAll(event: RequestEvent): Promise<Response> {
  try {
    const headers = upstreamHeaders(event.request.headers);
    const r = await fetch(`${SPAWNER_URL}/secrets/status`, { headers });
    if (!r.ok) return json({ db_enabled: false, exchanges: [] });
    const j: any = await r.json();
    const list: any[] = Array.isArray(j?.exchanges) ? j.exchanges : [];
    return json({
      db_enabled: j?.db_enabled !== false,
      exchanges: list.map((e) => ({
        exchange: String(e?.exchange ?? "").toLowerCase(),
        updated_at: e?.updated_at,
      })),
    });
  } catch {
    return json({ db_enabled: false, exchanges: [] });
  }
}

// DELETE /api/settings/exchange-keys/:exchange → spawner DELETE /secrets/:exchange.
// ok:false + 200 when no row existed (idempotent from the UI's perspective).
async function exchangeKeysDelete(event: RequestEvent, exchangeRaw: string): Promise<Response> {
  const exch = sanitizeExchangeId(decodeURIComponent(exchangeRaw));
  if (!exch) {
    return json({ ok: false, message: "A valid exchange id is required (a-z, 0-9, -, _)" }, 400);
  }
  try {
    const headers = upstreamHeaders(event.request.headers);
    const r = await fetch(`${SPAWNER_URL}/secrets/${exch}`, { method: "DELETE", headers });
    if (!r.ok) return json({ ok: false, message: `Delete rejected by spawner (${r.status})` }, 502);
    const j: any = await r.json().catch(() => ({}));
    return json({ ok: j?.ok === true, exchange: exch, db_enabled: j?.db_enabled !== false });
  } catch {
    return json({ ok: false, message: "Secret storage service unreachable" }, 502);
  }
}

// ── /settings notification channels → the spawner's notification store.
// SECURITY: the browser only ever SUBMITS a channel here; the webhook URL is
// never read back. The spawner persists it server-side (encrypted at rest)
// behind X-Internal-Token; the list endpoint reports only name/kind/events
// (never the URL). Mirrors the exchange-keys adapter above.
//
// BOUNDARY: this is the management adapter — plus a Test route (below) that
// asks the spawner to fire a channel's webhook once (fks #181). Actually SENDING
// on real events (spawn/stop/live-flip → Discord) is still a spawner-side
// (consumer) follow-up, not wired in either repo yet.
function sanitizeChannelName(raw: unknown): string {
  const s = (typeof raw === "string" ? raw : "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(s) ? s : "";
}

// GET /api/settings/notifications → every stored channel (name/kind/events +
// updated_at only — never the URL), for the /settings Notifications section.
async function notificationsList(event: RequestEvent): Promise<Response> {
  try {
    const headers = upstreamHeaders(event.request.headers);
    const r = await fetch(`${SPAWNER_URL}/notifications`, { headers });
    if (!r.ok) return json({ db_enabled: false, channels: [] });
    const j: any = await r.json();
    const list: any[] = Array.isArray(j?.channels) ? j.channels : [];
    return json({
      db_enabled: j?.db_enabled !== false,
      channels: list.map((c) => ({
        name: String(c?.name ?? ""),
        kind: String(c?.kind ?? "discord_webhook"),
        events: Array.isArray(c?.events) ? c.events.map((e: unknown) => String(e)) : [],
        updated_at: c?.updated_at,
      })),
    });
  } catch {
    return json({ db_enabled: false, channels: [] });
  }
}

// POST /api/settings/notifications → spawner POST /notifications. The browser
// submits { name, url, events?, kind? } and forgets it (the URL is never
// returned). Empty/absent events = catch-all ("send everything").
async function notificationsPost(event: RequestEvent): Promise<Response> {
  let body: any = {};
  try {
    body = await event.request.json();
  } catch {
    /* empty / non-JSON body */
  }
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const name = sanitizeChannelName(body?.name);
  if (!name) {
    return json(
      { ok: false, message: "A valid channel name is required (letters, digits, space . _ -)" },
      400,
    );
  }
  const url = str(body?.url);
  if (!url || !/^https?:\/\//.test(url)) {
    return json({ ok: false, message: "A valid http(s) webhook URL is required" }, 400);
  }
  const kind = str(body?.kind) || "discord_webhook";
  const events = Array.isArray(body?.events)
    ? Array.from(
        new Set(
          body.events.map((e: unknown) => str(e)).filter((e: string) => e.length > 0),
        ),
      )
    : [];
  const payload = { name, kind, url, events };
  try {
    const headers = upstreamHeaders(event.request.headers);
    headers.set("content-type", "application/json");
    const r = await fetch(`${SPAWNER_URL}/notifications`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (r.status === 503) {
      return json(
        { ok: false, message: "Notification storage (spawner DB) is not configured" },
        503,
      );
    }
    if (!r.ok) return json({ ok: false, message: `Save rejected by spawner (${r.status})` }, 502);
    return json({ ok: true, name, kind });
  } catch {
    return json({ ok: false, message: "Notification storage service unreachable" }, 502);
  }
}

// DELETE /api/settings/notifications/:name → spawner DELETE /notifications/:name.
// ok:false + 200 when no row existed (idempotent from the UI's perspective).
async function notificationsDelete(event: RequestEvent, nameRaw: string): Promise<Response> {
  const name = sanitizeChannelName(decodeURIComponent(nameRaw));
  if (!name) {
    return json({ ok: false, message: "A valid channel name is required" }, 400);
  }
  try {
    const headers = upstreamHeaders(event.request.headers);
    const r = await fetch(`${SPAWNER_URL}/notifications/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers,
    });
    if (!r.ok) return json({ ok: false, message: `Delete rejected by spawner (${r.status})` }, 502);
    const j: any = await r.json().catch(() => ({}));
    return json({ ok: j?.ok === true, name, db_enabled: j?.db_enabled !== false });
  } catch {
    return json({ ok: false, message: "Notification storage service unreachable" }, 502);
  }
}

// POST /api/settings/notifications/:name/test → spawner POST
// /notifications/:name/test. Fires the channel's stored webhook with a synthetic
// event so the operator can confirm delivery without spawning a bot. The webhook
// URL never touches the browser — the spawner decrypts it, sends, and reports
// only the outcome. Spawner contract: 200 {ok:true} (2xx from Discord), 200
// {ok:false,status} (webhook rejected), 404 (no such channel), 503
// {db_enabled:false} (no DB). Reshaped here to the {ok,message} the /settings
// feedback line renders — mirrors the venue-ping Test.
async function notificationsTest(event: RequestEvent, nameRaw: string): Promise<Response> {
  const name = sanitizeChannelName(decodeURIComponent(nameRaw));
  if (!name) {
    return json({ ok: false, message: "A valid channel name is required" }, 400);
  }
  // Every definitive outcome comes back HTTP 200 with {ok,message} so the
  // /settings feedback line can render it (the api client throws on non-2xx and
  // would swallow the message) — same shape the venue-ping Test returns.
  try {
    const headers = upstreamHeaders(event.request.headers);
    const r = await fetch(`${SPAWNER_URL}/notifications/${encodeURIComponent(name)}/test`, {
      method: "POST",
      headers,
    });
    if (r.status === 503) {
      return json({ ok: false, message: "Notification storage (spawner DB) is not configured" });
    }
    if (r.status === 404) {
      return json({ ok: false, message: `No such channel '${name}'` });
    }
    const j: any = await r.json().catch(() => ({}));
    if (r.ok && j?.ok === true) {
      return json({ ok: true, name, message: "Test message sent" });
    }
    // Webhook reached but non-2xx (spawner returns 200 {ok:false,status}).
    const status = j?.status;
    return json({
      ok: false,
      name,
      message: status != null ? `Webhook rejected the test (HTTP ${status})` : "Test send failed",
    });
  } catch {
    return json({ ok: false, message: "Notification service unreachable" });
  }
}

// ── Venue connectivity test (/settings Test buttons) ────────────────────────
// GET /api/exchanges/:venue/ping — server-side reachability check against the
// venue's cheapest PUBLIC endpoint. This deliberately does NOT validate the
// stored credentials (secrets are never read back to the webui; signed
// test-calls would have to run in the spawner — noted follow-up). It replaces
// the old kraken-only Test, which hit the unmapped /kraken/health route and
// reported "Connected" for any 200-empty-JSON — i.e. it tested nothing.
// Rithmic is deliberately absent: R|API is a proprietary gateway protocol with
// no public HTTP ping, so the /settings page shows no Test button for it.
const VENUE_PING: Record<string, { url: string; ok: (j: any) => boolean; label: string }> = {
  kraken: {
    url: "https://api.kraken.com/0/public/SystemStatus",
    ok: (j) => j?.result?.status === "online",
    label: "Kraken system online",
  },
  kucoin: {
    url: "https://api.kucoin.com/api/v1/timestamp",
    ok: (j) => j?.code === "200000",
    label: "KuCoin reachable",
  },
  "kucoin-futures": {
    url: "https://api-futures.kucoin.com/api/v1/timestamp",
    ok: (j) => j?.code === "200000",
    label: "KuCoin Futures reachable",
  },
  cryptocom: {
    url: "https://api.crypto.com/exchange/v1/public/get-tickers?instrument_name=BTC_USDT",
    ok: (j) => j?.code === 0,
    label: "Crypto.com reachable",
  },
  binance: {
    url: "https://api.binance.com/api/v3/ping",
    ok: (j) => typeof j === "object" && j !== null,
    label: "Binance reachable",
  },
};

async function venuePing(venue: string): Promise<Response> {
  const spec = VENUE_PING[venue];
  if (!spec) {
    return json({ ok: false, message: `No connectivity test for '${venue}'` }, 404);
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(spec.url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(timer);
    const j: any = await r.json().catch(() => null);
    if (r.ok && spec.ok(j)) {
      return json({ ok: true, venue, message: spec.label });
    }
    return json({ ok: false, venue, message: `Venue responded abnormally (HTTP ${r.status})` });
  } catch {
    return json({ ok: false, venue, message: "Venue unreachable (network/timeout)" });
  }
}

async function proxyBackend(event: RequestEvent): Promise<Response> {
  const { pathname, search } = event.url;

  // ── Spawner — a real, working backend (the /bots page) ──────────────────────
  // /api/spawner/<rest> → spawner /<rest>  (mirrors the old vite/nginx rewrite)
  if (pathname === "/api/spawner" || pathname.startsWith("/api/spawner/")) {
    const rest = pathname.replace(/^\/api\/spawner/, "") || "/";
    return forward(event, SPAWNER_URL, rest + search);
  }

  // ── janus mappings (Phase 2) ────────────────────────────────────────────────
  // Status-bar health: reshape janus /health → {redis,janus,feed}.
  if (pathname === "/api/health") {
    return janusHealth(event);
  }

  // Overview "recent signals" panel → janus signals reshaped to RecentSignal[]
  // ({ symbol, direction, confidence, timestamp }).
  if (pathname === "/api/db/redis/get/fks:memories:new") {
    const sigs = await janusRecentSignals(event);
    return json(
      sigs.map((s) => ({
        symbol: s.symbol,
        direction: s.signal_type,
        confidence: s.confidence,
        timestamp: s.timestamp,
      })),
    );
  }

  // Signals page list → janus signals reshaped to { signals: Signal[] }.
  // Per-signal status is derived from the execution-gate / risk verdicts in
  // the signal's metadata (signalStatus: approved / rejected / staging), and
  // the page's ?status= filter (staging / approved / "" = all) is honored
  // against that derived status. (The approve/reject actions stay no-ops —
  // janus has no staging workflow to write back to.)
  if (pathname === "/api/signals") {
    const sigs = await janusRecentSignals(event);
    const wanted = event.url.searchParams.get("status") ?? "";
    const signals = sigs.map((s, i) => ({
      id: `${s.symbol ?? "sig"}-${s.timestamp ?? i}`,
      symbol: s.symbol ?? "—",
      type: "entry",
      side: s.signal_type,
      status: signalStatus(s.metadata),
      timestamp: s.timestamp,
      message: s.signal_type,
    }));
    return json({ signals: wanted ? signals.filter((s) => s.status === wanted) : signals });
  }

  // /exchanges page → the crypto bots' /status documents (spot portfolio +
  // futures funding paper). Each side degrades to null independently so the
  // page renders whatever is reachable (e.g. only the spot bot running).
  if (pathname === "/api/exchanges/status") {
    const [spot, funding] = await Promise.all([
      janusJson(event, CRYPTO_SPOT_URL, "/status"),
      janusJson(event, CRYPTO_FUNDING_URL, "/status"),
    ]);
    return json({
      spot: spot && typeof spot === "object" && "bot" in spot ? spot : null,
      funding: funding && typeof funding === "object" && "bot" in funding ? funding : null,
    });
  }

  // Experience Map (UMAP view): recent decision vectors + payload from the
  // backward service. Graceful empty when the endpoint isn't up yet.
  if (pathname === "/api/janus/experiences/sample") {
    try {
      const r = await fetch(`${BACKWARD_URL}/api/v1/experiences/sample${search}`, {
        headers: { accept: "application/json" },
      });
      if (r.ok) {
        return new Response(r.body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    } catch {
      /* fall through to empty */
    }
    return json({ points: [], total: 0 });
  }

  // janus-ai "Janus State" panel → brain health + recent signals.
  if (pathname === "/api/janus/state") {
    return janusState(event);
  }

  // janus-ai "Strategy Affinity" matrix → forward brain affinity.
  if (pathname === "/api/janus/affinity") {
    return janusAffinity(event);
  }

  // /settings "Janus Optimizer" panel ↔ janus-api /api/config. GET returns the
  // effective config (env defaults ⊕ Redis overrides) in exactly the page's
  // JanusConfigResponse shape (plus requires_restart); PUT validates + stores
  // the overrides. Shapes match 1:1 (both sides were defined together), so
  // forward straight through — janus self-degrades (GET → env_defaults with
  // redis_available:false; PUT → honest 503) when Redis is down.
  if (pathname === "/api/janus/config") {
    return forward(event, JANUS_URL, "/api/config");
  }

  // /performance metrics grid → forward risk/performance (+ dashboard).
  if (pathname === "/api/performance") {
    return janusPerformance(event);
  }

  // /settings risk panel — load (GET) / save (POST→PUT) janus risk config.
  if (pathname === "/api/settings/risk") {
    return event.request.method === "POST" ? riskConfigPost(event) : riskConfigGet(event);
  }

  // /settings exchange API keys → spawner secret store (browser submits only;
  // status reports only WHICH exchanges are configured, never the secrets).
  // Dynamic list endpoints (any exchange id) — used by the /settings page:
  if (pathname === "/api/settings/exchange-keys/status") {
    return exchangeKeysStatusAll(event);
  }
  if (pathname === "/api/settings/exchange-keys" && event.request.method === "POST") {
    return exchangeKeysPost(event);
  }
  const exchangeKeyDeleteMatch = /^\/api\/settings\/exchange-keys\/([^/]+)$/.exec(pathname);
  if (exchangeKeyDeleteMatch && event.request.method === "DELETE") {
    return exchangeKeysDelete(event, exchangeKeyDeleteMatch[1]);
  }
  // /settings notification channels → spawner notification store (browser
  // submits only; list reports name/kind/events, never the webhook URL).
  if (pathname === "/api/settings/notifications") {
    return event.request.method === "POST" ? notificationsPost(event) : notificationsList(event);
  }
  const notificationTestMatch = /^\/api\/settings\/notifications\/(.+)\/test$/.exec(pathname);
  if (notificationTestMatch && event.request.method === "POST") {
    return notificationsTest(event, notificationTestMatch[1]);
  }
  const notificationDeleteMatch = /^\/api\/settings\/notifications\/(.+)$/.exec(pathname);
  if (notificationDeleteMatch && event.request.method === "DELETE") {
    return notificationsDelete(event, notificationDeleteMatch[1]);
  }
  // Venue reachability test for the /settings credential rows.
  const venuePingMatch = /^\/api\/exchanges\/([a-z0-9_-]+)\/ping$/.exec(pathname);
  if (venuePingMatch) {
    return venuePing(venuePingMatch[1]);
  }
  // Legacy fixed-venue routes (kept for compatibility with older clients).
  const exchangeKeysMatch = /^\/api\/settings\/(kraken|kucoin|cryptocom)-(keys|status)$/.exec(
    pathname,
  );
  if (exchangeKeysMatch) {
    const [, exch, kind] = exchangeKeysMatch;
    return kind === "keys" ? exchangeKeysPost(event, exch) : exchangeKeysStatus(event, exch);
  }
  // /performance trade history — janus has no closed-trade ledger here; the
  // demo bot keeps fills on its MockExchange. Honest empty until that's exposed.
  if (pathname === "/api/trades") {
    return json({ trades: [] });
  }

  // ── PHASE 2: front-page panels janus now serves natively ────────────────────
  // janus PRs #107/#111 added these in the exact shapes the overview parses
  // (`{assets}` / `{trades}` / factory status). Forward straight through —
  // janus self-degrades to empty-but-valid, so a backend hiccup never errors the
  // page. Replaces the previous gracefulEmpty fall-through for these paths.
  if (pathname === "/api/pipeline/scores/json") {
    return forward(event, JANUS_URL, "/api/pipeline/scores/json");
  }
  if (pathname === "/api/trades/open") {
    return forward(event, JANUS_URL, "/api/trades/open");
  }
  if (pathname === "/factory/status") {
    return forward(event, JANUS_URL, "/factory/status");
  }

  // ── /monitoring → Prometheus (fks_prometheus:9090) ──────────────────────────
  // Instant/range queries + targets are identical in shape → straight proxy.
  if (pathname === "/api/metrics/query") {
    return forward(event, PROMETHEUS_URL, "/api/v1/query" + search);
  }
  if (pathname === "/api/metrics/query_range") {
    return forward(event, PROMETHEUS_URL, "/api/v1/query_range" + search);
  }
  if (pathname === "/api/metrics/targets") {
    return forward(event, PROMETHEUS_URL, "/api/v1/targets" + search);
  }
  if (pathname === "/api/metrics/alerts") {
    return promAlerts(event);
  }
  if (pathname === "/api/metrics/layout") {
    return json(METRICS_LAYOUT);
  }

  // ── /charts historical candles → QuestDB candles_crypto (OHLCV) ─────────────
  const barsMatch = /^\/bars\/([^/]+)\/candles$/.exec(pathname);
  if (barsMatch) {
    let sym = barsMatch[1];
    try {
      sym = decodeURIComponent(sym);
    } catch {
      /* malformed %-encoding — fall back to the raw segment */
    }
    return questdbCandles(event, sym);
  }

  // Indicator catalog (metadata for the chart's picker UI).
  if (pathname === "/api/indicators/catalog") {
    return json(INDICATOR_CATALOG);
  }

  // ── Rust indicators-ta catalog + compute (janus) ────────────────────────────
  // The chart merges janus's Rust indicator catalog into its Indicators dropdown
  // so indicators newly added to the indicators-ta crate auto-appear. Catalog
  // degrades to an empty list when janus is unreachable → the chart keeps its
  // existing TS indicator set (no regression). janus contract:
  //   GET /api/indicators/catalog → { count, indicators:[{id,display_name,
  //     category,params:[{name,kind,default,min,max}]}] }
  //   GET /api/indicators/compute?symbol=&indicator=&interval=&<params> →
  //     { symbol, interval, indicator, series:{ <key>:[{time,value}] }, count }
  if (pathname === "/api/janus/indicators/catalog") {
    const j = await janusJson(event, JANUS_URL, "/api/indicators/catalog");
    const indicators = Array.isArray(j?.indicators) ? j.indicators : [];
    return json({ count: indicators.length, indicators });
  }
  if (pathname === "/api/janus/indicators/compute") {
    // Forward the query verbatim (symbol/indicator/interval + tunable params).
    // A 4xx/502 on failure is surfaced to the caller, which renders "no data"
    // for that one pane — the rest of the chart is unaffected.
    return forward(event, JANUS_URL, `/api/indicators/compute${search}`);
  }

  // ── /charts indicators → computed in-adapter from QuestDB candles ───────────
  const indMatch = /^\/api\/chart\/([^/]+)\/indicators$/.exec(pathname);
  if (indMatch) {
    let sym = indMatch[1];
    try {
      sym = decodeURIComponent(sym);
    } catch {
      /* malformed %-encoding — fall back to the raw segment */
    }
    return chartIndicators(event, sym);
  }

  // ── /charts symbol catalog → QuestDB candles_crypto ─────────────────────────
  if (pathname === "/api/assets/search") {
    return symbolSearch(event);
  }
  const assetMatch = /^\/api\/assets\/([^/]+)$/.exec(pathname);
  if (assetMatch) {
    let sym = assetMatch[1];
    try {
      sym = decodeURIComponent(sym);
    } catch {
      /* malformed %-encoding — fall back to the raw segment */
    }
    return assetInfo(event, sym);
  }

  // More janus panels (overview aggregate / performance) land here next —
  // see docs/architecture/WEBUI_JANUS_REPOINT.md for the per-panel mapping.

  // ── /sse/bars/:sym → futures live bars (D1) ─────────────────────────────────
  // Crypto charts get live ticks client-side (Kraken/Binance WS, reconnect +
  // backoff). Futures have no client WS, so the chart reads this SSE bridge.
  // Until janus exposes a bars stream it stays the graceful idle stub below;
  // once it does, set JANUS_BARS_SSE_URL and the upstream is piped straight
  // through (text/event-stream, `event: bar` frames).
  const barsSseMatch = /^\/sse\/bars\/([^/]+)$/.exec(pathname);
  if (barsSseMatch && JANUS_BARS_SSE_URL) {
    return forward(event, JANUS_BARS_SSE_URL, `/${barsSseMatch[1]}${search}`);
  }

  // ── Everything else under a backend prefix → degrade quietly ────────────────
  return gracefulEmpty(pathname);
}

// ════════════════════════════════════════════════════════════════════════════
// Auth — pages only; backend (/api, /sse, …) calls are proxied above, never
// auth-redirected. The routing + auth decision lives in `$lib/server/adapter`
// (pure + unit-tested); this hook reads env/cookies and runs the side effects.
// ════════════════════════════════════════════════════════════════════════════

export const handle: Handle = async ({ event, resolve }) => {
  const route = routeRequest(
    event.url.pathname,
    event.url.search,
    env.WEBUI_SESSION_SECRET ?? "",
    event.cookies.get("fks_session") ?? "",
  );

  // Backend (/api, /sse, …) calls are proxied — never auth-redirected (a 302
  // would corrupt a JSON/SSE consumer).
  if (route.kind === "backend") return proxyBackend(event);

  // Invalid/missing session — bounce to login, preserving the intended URL.
  if (route.kind === "redirect") {
    return new Response(null, { status: 302, headers: { Location: route.location } });
  }

  // "pass": public page, dev bypass (no secret), or a valid session.
  return resolve(event);
};
