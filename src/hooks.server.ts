import type { Handle, RequestEvent } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { computeIndicators, INDICATOR_CATALOG, type Candle } from "$lib/server/indicators";
import {
  type CandleRow,
  type FetchStatus,
  humanizeSince,
  intervalToSeconds,
  mapCandleRows,
  reshapeHealth,
  resampleCandles,
  candleSymbolCondition,
  pickStoredInstrument,
  pickStoredSymbol,
  resolveCandleTable,
  sanitizeInterval,
  sanitizeSymbol,
  wantsArrayResponse,
} from "$lib/server/reshape";
import {
  type AuthState,
  isBackend,
  originAllowed,
  outageRoute,
  routeRequest,
  upstreamHeaders,
  isGetLike,
  movedPage,
  roleRank,
  spawnerWriteNeedsAdmin,
  isHypothesisRegistration,
  withRegisteredBy,
} from "$lib/server/adapter";
import {
  AuthStoreUnavailable,
  getAuthService,
  resolveAuthState,
  trustForwardedFor,
} from "$lib/server/auth";
import { clientIp } from "$lib/server/auth/http";
import type { RequestCtx } from "$lib/server/auth/service";
import { invitesDispatch, usersDispatch } from "$lib/server/users";
import {
  coerceNotificationHistory,
  validateNotificationEvents,
} from "$lib/types/notifications";
import { alertAckPost, alertInboxGet } from "$lib/server/alertAck";
import { getAlertAckStore } from "$lib/server/alertAck/store";
// Shared with the browser half on purpose — one definition of the
// session-expiry marker, so a rename cannot silently disable the banner. The
// module imports only `svelte/store` (isomorphic); nothing here touches the
// store itself.
import { SESSION_HEADER, SESSION_REQUIRED } from "$stores/session";

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
// Mapped today: /api/spawner/* (spawner: bots, recorders, templates, keys,
// accounts, edges); /api/health (janus); /api/settings/* (spawner key and
// notification stores); /api/metrics/* and the alert inbox (Prometheus);
// /bars + /charts candles and indicators (QuestDB, janus); /sse/bars (janus live
// tail when JANUS_BARS_SSE_URL is set). Unmapped backend reads → graceful
// empty; unmapped writes → 501. The futures co-pilot, Rithmic, signals,
// janus-ai and paper-trade routes were removed with their pages (2026-10-26).
//
// Upstreams use in-container Docker-network addresses (overridable via env).
// NB: from inside the webui container, janus is fks_janus:8080 (api) /
//     fks_janus:8180 (forward) — NOT the host-published :7000/:7001.
const SPAWNER_URL = env.SPAWNER_INTERNAL_URL ?? "http://fks_bot_spawner:8090";
const JANUS_URL = env.JANUS_INTERNAL_URL ?? "http://fks_janus:8080"; // janus-api
const JANUS_FORWARD_URL = env.JANUS_FORWARD_INTERNAL_URL ?? "http://fks_janus:8180"; // forward (brain/risk)
// Bearer token janus now requires on every mutating (non-GET) route of both
// its surfaces (janus-auth). The SvelteKit server attaches it to its janus
// proxy calls so the /settings risk-config PUT (→ forward) and the "Janus
// Optimizer" /api/config PUT (→ janus-api) keep working once the token is set.
// Empty default = no header attached, which matches janus's own fail-closed
// posture (mutations 503 until BOTH janus and the webui carry the token).
// Server-side only — never exposed to the browser. See fks docker-compose.yml.
const JANUS_API_TOKEN = env.JANUS_API_TOKEN ?? "";
function isJanusBase(base: string): boolean {
  return base === JANUS_URL || base === JANUS_FORWARD_URL;
}
/** Attach the janus bearer to a janus-bound request's headers (no-op when the
 *  token is unset or the base isn't janus). Overrides any inbound Authorization
 *  so a browser can't smuggle its own. */
function withJanusAuth(base: string, headers: Headers): Headers {
  if (JANUS_API_TOKEN && isJanusBase(base)) {
    headers.set("authorization", `Bearer ${JANUS_API_TOKEN}`);
  }
  return headers;
}
// Service-identity token for the token-enforcing internal upstream (the
// spawner fail-closes on it). The adapter is now the injector (design §4.1a):
// `upstreamHeaders` strips any client-supplied `x-internal-token` at the seam,
// and this re-stamps the trusted value on the outbound request only — so the
// token means "passed the session-checked adapter", not merely "reached nginx".
// Compose passthrough: INTERNAL_TOKEN=${NGINX_INTERNAL_TOKEN}. Never sent to
// janus (janus authenticates via its own Bearer, above) and never to the browser.
const INTERNAL_TOKEN = env.INTERNAL_TOKEN ?? env.NGINX_INTERNAL_TOKEN ?? "";
// Scoped to the spawner base ONLY (L3): the spawner is the sole upstream that
// enforces the token, so Prometheus/QuestDB/janus-bars never receive it — the
// token's exposure surface is exactly the one service that checks it. Every
// direct `fetch(${SPAWNER_URL}…)` helper (secrets + notifications + capabilities)
// MUST route its headers through here, or #47's strip-set leaves it token-less
// against an enforcing spawner (auth-chain H5).

/**
 * The stored spawn config a respawn would run, for the R2b admin check; null
 * when the spawner can't show it, which the check treats as needing an admin.
 */
async function storedSpawnerConfig(name: string): Promise<unknown> {
  try {
    const res = await fetch(`${SPAWNER_URL}/configs`, {
      headers: withInternalToken(SPAWNER_URL, new Headers()),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { configs?: unknown };
    if (!Array.isArray(body.configs)) return null;
    return (
      body.configs.find(
        (c): c is { name: string } =>
          typeof c === "object" && c !== null && (c as { name?: unknown }).name === name,
      ) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * The template an instance would be made from, for the R2b admin check; null
 * when the spawner can't show it, which the check treats as needing an admin.
 */
async function spawnerTemplate(id: string): Promise<unknown> {
  try {
    const res = await fetch(`${SPAWNER_URL}/templates/${encodeURIComponent(id)}`, {
      headers: withInternalToken(SPAWNER_URL, new Headers()),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function withInternalToken(base: string, headers: Headers): Headers {
  // The spawner is the only upstream that authenticates with the
  // service-identity token.
  if (INTERNAL_TOKEN && base === SPAWNER_URL) {
    headers.set("x-internal-token", INTERNAL_TOKEN);
  }
  return headers;
}
const PROMETHEUS_URL = env.PROMETHEUS_INTERNAL_URL ?? "http://fks_prometheus:9090"; // /monitoring
const QUESTDB_URL = env.QUESTDB_INTERNAL_URL ?? "http://fks_questdb:9000"; // /charts OHLC (HTTP query API)
// Futures live-bars SSE bridge (D1). Empty by default → /sse/bars/:sym serves the
// graceful idle stub (unchanged). Set to a janus SSE base (the symbol is appended
// as "/<sym>", emitting `event: bar` frames) to pipe futures bars to the chart.
const JANUS_BARS_SSE_URL = env.JANUS_BARS_SSE_URL ?? "";

// Forward a request to `base + path`, streaming the response straight back.
async function forward(
  event: RequestEvent,
  base: string,
  path: string,
  /** Sent instead of the request's own body (the adapter rewrote it). */
  body?: string,
): Promise<Response> {
  const method = event.request.method;
  const init: RequestInit & { duplex?: "half" } = {
    method,
    // janus-bound mutating calls (e.g. /api/config PUT) need the bearer; a no-op
    // for GETs, non-janus bases, or when the token is unset. Non-janus internal
    // upstreams (the spawner) get the service-identity token, minted here — a
    // client-supplied copy was already stripped by `upstreamHeaders`.
    headers: withInternalToken(base, withJanusAuth(base, upstreamHeaders(event.request.headers))),
  };
  // Bound the request so a hung upstream can't wedge the proxy — EXCEPT for SSE
  // (EventSource sends `accept: text/event-stream`), which is a long-lived
  // stream that a timeout would sever mid-flight. AbortSignal.timeout throws a
  // TimeoutError caught below → 502, same as any other upstream failure.
  const wantsStream =
    event.request.headers.get("accept")?.includes("text/event-stream") ?? false;
  if (!wantsStream) init.signal = AbortSignal.timeout(15_000);
  if (method !== "GET" && method !== "HEAD") {
    // content-length is a hop header (`upstreamHeaders` drops it), so a
    // rewritten body gets its own length from fetch.
    init.body = body ?? (await event.request.arrayBuffer());
    init.duplex = "half";
  }
  try {
    const res = await fetch(base + path, init);
    const headers = upstreamHeaders(res.headers);
    // The session-expiry marker means "the ADAPTER refused you" and must be
    // unforgeable. `upstreamHeaders`' strip set lives in adapter.ts and does not
    // cover it, so drop any upstream-supplied copy here — otherwise a
    // misconfigured or compromised upstream could echo it back on a proxied 401
    // and raise a false "sign in again" banner, which is exactly the
    // false-positive class the header exists to prevent.
    headers.delete(SESSION_HEADER);
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

/**
 * What the fetch layer actually observed: "up" (2xx, body parsed), "down"
 * (a CONFIRMED failure — non-2xx response, or connection-refused: something
 * on the wire told us "no"), or "unknown" (an AMBIGUOUS failure — timeout,
 * DNS hiccup, any other network error: we genuinely don't know).
 *
 * MONEY SAFETY. The old `janusJson` swallowed every failure into the same
 * `{}`, and two consumers (`janusHealth`/`janusState`) then defaulted the
 * missing status to the literal string "down" — so an 8s read-timeout on a
 * merely-slow janus rendered identically to a confirmed outage: a red DOWN
 * badge on the /janus-ai page and a red StatusBar dot. Distinguishing the two
 * here lets those callers render a neutral "unknown" instead of fabricating
 * an outage from a timeout.
 */
async function janusJsonStatus(
  event: RequestEvent,
  base: string,
  path: string,
): Promise<{ data: any; status: FetchStatus }> {
  let r: Response;
  try {
    r = await fetch(base + path, {
      headers: upstreamHeaders(event.request.headers),
      // Bound the read so a hung janus can't wedge the panel that awaits it.
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err: any) {
    // undici tags a refused connection with cause.code === "ECONNREFUSED" —
    // that's a confirmed "nothing is listening", not an ambiguous blip.
    // AbortSignal.timeout firing (name "TimeoutError"/"AbortError") and any
    // other network error (DNS, reset, …) are ambiguous: we didn't get an
    // answer either way.
    const refused = err?.cause?.code === "ECONNREFUSED";
    return { data: {}, status: refused ? "down" : "unknown" };
  }
  if (!r.ok) {
    // The service answered — with an error. That's confirmed, not ambiguous.
    return { data: {}, status: "down" };
  }
  try {
    return { data: await r.json(), status: "up" };
  } catch {
    // 2xx but an unparsable body is a body bug, not an outage — don't let it
    // masquerade as "down" either.
    return { data: {}, status: "unknown" };
  }
}

// Read a janus JSON endpoint, tolerating failure (returns {} on any error).
// Thin wrapper over janusJsonStatus for the call sites that only need the
// payload, not the failure classification.
async function janusJson(event: RequestEvent, base: string, path: string): Promise<any> {
  return (await janusJsonStatus(event, base, path)).data;
}

// /api/health → reshape janus /health into the StatusBar's flat {redis,janus,feed}.
// janus /health: { status, forward_service, components: Record<string,{status}> }.
// Two consumers share /api/health: the bottom StatusBar wants a flat
// {redis,janus,feed}; the /settings "System Info" panel wants {status,components,
// version,uptime}. We return a superset so both render (and the settings panel
// no longer hits `healthData.status` undefined).
async function janusHealth(event: RequestEvent): Promise<Response> {
  const { data: j, status } = await janusJsonStatus(event, JANUS_URL, "/health");
  return json(reshapeHealth(j, status));
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
// plus the live targets panel. Node/redis KPIs depend on exporters.
//
// Gap 20 (audit 2026-07-31): this used to also carry an `alerts` /
// `alert-feed` panel backed by `promAlerts` above. `promAlerts` calls
// `janusJson`, which — BY DESIGN, so a Prometheus hiccup can't wedge a panel —
// catches ANY fetch failure and returns `{}`, which `promAlerts` then turns
// into `{ data: [] }`: a perfectly well-formed, 200-OK EMPTY alert list. The
// `alert-feed` panel read that as "genuinely zero firing alerts" and rendered
// a reassuring green "✓ No active alerts" at the TOP of /monitoring — with no
// way to distinguish "Prometheus says nothing is firing" from "Prometheus is
// unreachable and we have no idea". Worse, Prometheus being down also means
// Alertmanager is receiving nothing, so out-of-band paging is dead at the
// exact moment this line claimed everything was fine — while the honest
// `AlertInbox` component further down the SAME page correctly showed
// "Prometheus unreachable" for the identical failure. Deleting this entry
// removes the fabricated-looking summary entirely; `AlertInbox` (which keys
// off `prom_available`, not an empty list — see its own header comment) is
// now the page's ONLY alert surface. Verified nothing else consumes
// `/api/metrics/alerts` (the route handler is left in place, just unused from
// the client, in case a future dedicated caller wants the raw reshape).
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
// into the SQL string literal).
//
// R7: returns `CandleRow[]` on a genuine result (possibly zero rows — a real
// symbol/interval can legitimately have no data) or `null` if the query
// itself failed — network error, timeout, or a non-2xx from QuestDB. Before
// this the two cases were both `[]`, so an outage rendered identically to
// "this symbol has no candles" with zero error signal; `fetchCandles` below
// turns a `null` into the `degraded` flag the client branches on.
/** A single stored book: one symbol on one venue. `exchange: null` means the
 *  table has no venue split for this row (the futures path, already tagged). */
type ResolvedInstrument = { symbol: string; exchange: string | null };

/** Cached so the extra lookup is paid once per symbol, not per chart poll.
 *
 *  POSITIVE RESULTS ONLY. A book that exists keeps existing, so caching it is
 *  safe. Caching absence is not: ingestion adds symbols over time, so a symbol
 *  that has no rows now may have them in ten minutes, and a cached `null`
 *  would keep that chart permanently blank until the process restarted. The
 *  degraded-flag tests caught exactly this — a negative cached by one case
 *  silently short-circuited every later one. */
const instrumentCache = new Map<string, ResolvedInstrument>();

/**
 * Which single stored book should a chart symbol draw?
 *
 * Returns the instrument, `null` when the table holds nothing matching, or
 * `"failed"` when the lookup itself could not be completed — the same
 * three-way distinction `queryCandles` makes, so a QuestDB outage stays
 * distinguishable from an empty result.
 */
async function resolveInstrument(
  sym: string,
  table: "candles_crypto" | "candles_futures",
  exact: boolean,
): Promise<ResolvedInstrument | null | "failed"> {
  // Futures symbols are already venue-tagged (`rithmic:GC`), so the symbol
  // alone identifies the book and no lookup is needed.
  if (exact) return { symbol: sym, exchange: null };

  const key = `${table}:${sym}`;
  const hit = instrumentCache.get(key);
  if (hit !== undefined) return hit;

  const sql =
    `SELECT DISTINCT symbol, exchange FROM ${table} ` +
    `WHERE ${candleSymbolCondition(sym, false)}`;
  try {
    const r = await fetch(`${QUESTDB_URL}/exec?query=${encodeURIComponent(sql)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return "failed";
    const j: any = await r.json();
    const rows: Array<[string, string]> = Array.isArray(j?.dataset)
      ? j.dataset
          .map((row: unknown[]) => [String(row?.[0] ?? ""), String(row?.[1] ?? "")])
          .filter(([sy]: string[]) => sy.length > 0)
      : [];
    const picked = pickStoredInstrument(sym, rows);
    if (picked !== null) instrumentCache.set(key, picked);
    return picked;
  } catch {
    // Not cached: a network blip must not pin this symbol to a wrong answer.
    return "failed";
  }
}

async function queryCandles(
  resolved: ResolvedInstrument,
  iv: string,
  days: number,
  lim: number,
  beforeIso?: string,
  table: "candles_crypto" | "candles_futures" = "candles_crypto",
): Promise<CandleRow[] | null> {
  // With `beforeIso` (history pagination) the days window anchors to that
  // cutoff instead of now(), so scrolling far back keeps returning rows.
  const timeCond = beforeIso
    ? `timestamp < '${beforeIso}' AND timestamp >= dateadd('d', -${days}, cast('${beforeIso}' as timestamp))`
    : `timestamp >= dateadd('d', -${days}, now())`;
  // EXACT predicates on a RESOLVED instrument, applied before LIMIT.
  //
  // The previous shape queried permissively and picked one spelling from the
  // rows that came back. That still merged venues — the table dedups on
  // (timestamp, symbol, exchange, interval), so two venues storing BTCUSDT are
  // different books that the symbol alone cannot separate — and it had a
  // subtler fault: filtering AFTER `LIMIT 5000` means the limit is spent on
  // rows that are then discarded, so the chosen book comes back short and the
  // series can change between windows. External review (Sol, 2026-09-04, R6).
  //
  // Resolving first costs one cheap cached query and makes the predicate
  // exact, so the limit applies to the series actually being drawn.
  const symCond = resolved.exchange === null
    ? `symbol = '${resolved.symbol}'`
    : `symbol = '${resolved.symbol}' AND exchange = '${resolved.exchange}'`;
  const sql =
    `SELECT cast(timestamp as long) t, open, high, low, close, volume FROM ${table} ` +
    `WHERE ${symCond} ` +
    `AND interval = '${iv}' AND ${timeCond} ` +
    `ORDER BY timestamp DESC LIMIT ${lim}`;
  try {
    const r = await fetch(`${QUESTDB_URL}/exec?query=${encodeURIComponent(sql)}`, {
      headers: { accept: "application/json" },
      // Bound the request so a HUNG QuestDB can't wedge the SvelteKit handler
      // (adapter-node has no default per-request timeout). Matches proxyBackend.
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    return mapCandleRows(j?.dataset);
  } catch {
    return null;
  }
}

// R7: `degraded: true` means at least one of the QuestDB queries behind this
// response failed (vs. genuinely returning zero rows) — see `queryCandles`
// above. The B3 1m-resample fallback only runs when the primary query came
// back empty (including the degraded-empty case), so a failure there also
// marks the response degraded even if it never manages to populate `rows`.
async function fetchCandles(
  event: RequestEvent,
  symbolRaw: string,
): Promise<{ rows: CandleRow[]; degraded: boolean }> {
  // Route venue-tagged symbols (rithmic:MESU6) to candles_futures; both paths
  // sanitize into the SQL literal, so this is also the injection guard.
  const { table, sym, exact } = resolveCandleTable(symbolRaw);
  if (!sym) return { rows: [], degraded: false };
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

  // Resolve the book ONCE, then query it exactly. A failed lookup is degraded;
  // "no such instrument" is a genuine empty, not an outage.
  const resolved = await resolveInstrument(sym, table, exact);
  if (resolved === "failed") return { rows: [], degraded: true };
  if (resolved === null) return { rows: [], degraded: false };

  const primary = await queryCandles(resolved, iv, days, lim, beforeIso, table);
  let degraded = primary === null;
  let rows: CandleRow[] = primary ?? [];

  // B3: if nothing is stored natively at this interval, synthesize it by
  // resampling 1m bars. Only fires when the direct query came back empty, so it
  // can only improve on the "no data" case — it never changes a populated chart.
  const sec = intervalToSeconds(iv);
  if (rows.length === 0 && iv !== "1m" && sec !== null && sec % 60 === 0) {
    const oneMin = await queryCandles(
      resolved,
      "1m",
      days,
      Math.min(5000, Math.ceil((sec / 60) * lim)),
      beforeIso,
      table,
    );
    if (oneMin === null) {
      degraded = true;
    } else if (oneMin.length > 0) {
      rows = resampleCandles(oneMin, sec);
    }
  }
  return { rows, degraded };
}

// GET /bars/:symbol/candles →
//   { candles: [{ timestamp /*ms*/, o,h,l,c,v }], degraded: boolean }.
// R7: `degraded: true` at HTTP 200 (not a 502) — chosen because three
// separate client call sites (`charts/+page.svelte`, `MiniChart.svelte`,
// `trading/+page.svelte`) already `await res.json()` unconditionally without
// checking `res.ok`; a 200-with-a-flag reaches all three without touching
// their fetch/error-handling shape, where a 502 would require re-plumbing
// each one's `try`/`catch` to look at the response status at all.
async function questdbCandles(event: RequestEvent, symbolRaw: string): Promise<Response> {
  const { rows, degraded } = await fetchCandles(event, symbolRaw);
  return json({
    candles: rows.map((r) => ({
      timestamp: r.tsMs,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    })),
    degraded,
  });
}

// GET /api/chart/:symbol/indicators?interval=&indicators=rsi,macd,bbands,atr,… →
// { indicators: { <key>: [{ time /*sec*/, value }] } } computed from the candles.
// Keys match what the chart expects (bb_upper/bb_middle/bb_lower, rsi, atr,
// macd_line/macd_signal/macd_hist, ema9/sma20/vwap, …).
async function chartIndicators(event: RequestEvent, symbolRaw: string): Promise<Response> {
  const { rows } = await fetchCandles(event, symbolRaw);
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
      // Bound the request so a HUNG QuestDB can't wedge the SvelteKit handler
      // (adapter-node has no default per-request timeout). Matches proxyBackend.
      signal: AbortSignal.timeout(15_000),
    });
    const j: any = await r.json();
    return Array.isArray(j?.dataset) ? j.dataset : [];
  } catch {
    return [];
  }
}

/**
 * GET /api/market/coverage → what janus has recorded in `candles_crypto`, per
 * symbol and interval: bar count, first and last bar. The Data page's market
 * data table and the Home page's freshness line read it.
 *
 * Unlike `questdbRows`, a failure is reported as `ok:false` rather than an
 * empty list: "QuestDB did not answer" must not read as "nothing recorded".
 */
async function marketCoverage(): Promise<Response> {
  const sql =
    "SELECT symbol, interval, count() AS bars, min(timestamp) AS first, max(timestamp) AS last " +
    "FROM candles_crypto GROUP BY symbol, interval ORDER BY symbol, interval";
  try {
    const r = await fetch(`${QUESTDB_URL}/exec?query=${encodeURIComponent(sql)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      return json({ ok: false, error: `QuestDB answered ${r.status}`, rows: [] });
    }
    const j: any = await r.json();
    const rows = Array.isArray(j?.dataset)
      ? j.dataset.map((row: unknown[]) => ({
          symbol: String(row[0] ?? ""),
          interval: String(row[1] ?? ""),
          bars: Number(row[2] ?? 0),
          first: row[3] ?? null,
          last: row[4] ?? null,
        }))
      : [];
    return json({ ok: true, table: "candles_crypto", rows });
  } catch {
    return json({ ok: false, error: "QuestDB is unreachable", rows: [] });
  }
}

// GET /api/assets/search?q= → the chart's symbol picker. Real symbols straight
// from QuestDB, so you can only pick symbols that actually have data.
//
// BOTH tables, because searching only `candles_crypto` made every futures
// contract UNREACHABLE from /charts: GC/NQ/ES live in `candles_futures` and
// never appeared, even though `resolveCandleTable` has always known how to
// route them once a symbol is chosen.
//
// Futures results carry their VENUE-TAGGED symbol (`rithmic:GC`) as `symbol`,
// not the bare ticker. That tag is exactly what `resolveCandleTable` keys on to
// pick candles_futures — hand the chart a bare "GC" and it queries
// candles_crypto and finds nothing. The bare ticker goes in `name` so the
// dropdown still reads cleanly.
//
// Two queries rather than one UNION: the tables have different columns
// (candles_futures has no `exchange`), so a UNION needs padding that makes the
// mapping harder to read for no gain at 30 rows.
async function symbolSearch(event: RequestEvent): Promise<Response> {
  // Sanitised + uppercased — goes into a SQL literal (injection guard).
  const q = sanitizeSymbol(event.url.searchParams.get("q"), 24).toUpperCase();
  if (!q) return json({ results: [] });

  const [cryptoRows, futuresRows] = await Promise.all([
    questdbRows(
      `SELECT DISTINCT symbol, exchange FROM candles_crypto ` +
        `WHERE upper(symbol) LIKE '%${q}%' ORDER BY symbol LIMIT 30`,
    ),
    questdbRows(
      `SELECT DISTINCT symbol FROM candles_futures ` +
        `WHERE upper(symbol) LIKE '%${q}%' ORDER BY symbol LIMIT 30`,
    ),
  ]);

  const futures = futuresRows.map((row) => {
    const tagged = String(row[0]); // e.g. "rithmic:GC"
    const idx = tagged.indexOf(":");
    const venue = idx > 0 ? tagged.slice(0, idx) : "";
    const ticker = idx > 0 ? tagged.slice(idx + 1) : tagged;
    return {
      symbol: tagged,
      name: ticker,
      type: "futures",
      exchange: venue || undefined,
    };
  });
  const crypto = cryptoRows.map((row) => ({
    symbol: String(row[0]),
    name: String(row[0]),
    type: "crypto",
    exchange: row[1] != null ? String(row[1]) : undefined,
  }));

  // Futures first: they are the operator's live decision instrument, and a
  // search for "ES" must not bury ES futures under crypto pairs that merely
  // contain those letters.
  return json({ results: [...futures, ...crypto].slice(0, 30) });
}

// GET /api/assets/:short → the chart's asset-routing lookup (AssetInfo). We map
// the stored exchange to `source`/`source_chain` so the page picks the right
// live-data path; unknown symbols → {} (page falls back to its slash heuristic).
async function assetInfo(event: RequestEvent, shortRaw: string): Promise<Response> {
  const sym = sanitizeSymbol(shortRaw, 24).toUpperCase();
  if (!sym) return json({});

  // FUTURES FIRST, and matched on the venue tag. A venue-tagged symbol is
  // unambiguous — nothing in candles_crypto carries a `venue:` prefix — so this
  // cannot shadow a crypto pair. Answering futures with `{}` (the old
  // behaviour) dropped the page onto its slash heuristic, which classifies a
  // tagged futures symbol as crypto and points the live path at the wrong feed.
  const futuresRows = await questdbRows(
    `SELECT symbol FROM candles_futures WHERE upper(symbol) = '${sym}' LIMIT 1`,
  );
  if (futuresRows[0]?.[0] != null) {
    const tagged = String(futuresRows[0][0]);
    const idx = tagged.indexOf(":");
    const venue = idx > 0 ? tagged.slice(0, idx) : "rithmic";
    return json({ type: "futures", source: venue, source_chain: [venue] });
  }

  const rows = await questdbRows(
    `SELECT exchange FROM candles_crypto ` +
      `WHERE upper(symbol) = '${sym}' OR upper(symbol) LIKE '${sym}/%' ` +
      `OR upper(symbol) LIKE '${sym}-%' LIMIT 1`,
  );
  const ex = rows[0]?.[0] != null ? String(rows[0][0]) : "";
  if (!ex) return json({});
  return json({ type: "crypto", source: ex, source_chain: [ex] });
}

// ── /settings exchange API keys → the spawner's secret store (Postgres fks_db).
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
    const headers = withInternalToken(SPAWNER_URL, upstreamHeaders(event.request.headers));
    headers.set("content-type", "application/json");
    const r = await fetch(`${SPAWNER_URL}/secrets`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
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
    const headers = withInternalToken(SPAWNER_URL, upstreamHeaders(event.request.headers));
    const r = await fetch(`${SPAWNER_URL}/secrets/status`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
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
    const headers = withInternalToken(SPAWNER_URL, upstreamHeaders(event.request.headers));
    const r = await fetch(`${SPAWNER_URL}/secrets/status`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
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
    const headers = withInternalToken(SPAWNER_URL, upstreamHeaders(event.request.headers));
    const r = await fetch(`${SPAWNER_URL}/secrets/${exch}`, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
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
// asks the spawner to fire a channel's webhook once (fks #181). Dispatch on real
// events IS live in the spawner for the five lifecycle kinds (bot_spawned /
// _stopped / _removed / _error / _crashed — notifications.rs); this adapter
// validates a channel's `events[]` against that wire contract on POST
// (`$lib/types/notifications`) so a scoped channel can't silently store an id
// the spawner never emits.
function sanitizeChannelName(raw: unknown): string {
  const s = (typeof raw === "string" ? raw : "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(s) ? s : "";
}

// GET /api/settings/notifications → every stored channel (name/kind/events +
// updated_at only — never the URL), for the /settings Notifications section.
async function notificationsList(event: RequestEvent): Promise<Response> {
  try {
    const headers = withInternalToken(SPAWNER_URL, upstreamHeaders(event.request.headers));
    const r = await fetch(`${SPAWNER_URL}/notifications`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
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

// GET /api/settings/notifications/history → spawner GET /notifications/history,
// the delivery ledger (one row per webhook send ATTEMPT — real fires + test
// probes) so the operator can answer "did the 3am crash page actually send?".
// R4 read at the seam: viewer-visible, contains NO secrets (the ledger detail
// is URL-free by the spawner contract — the table doesn't hold the webhook URL).
// Passes `?limit=` + `?event=` through and DEFENSIVELY reshapes: any non-2xx,
// bad JSON, or malformed row degrades to {db_enabled:false, entries:[]} rather
// than surfacing garbage — same contract as the sibling mappers above.
async function notificationsHistory(event: RequestEvent): Promise<Response> {
  const src = new URL(event.request.url).searchParams;
  const qs = new URLSearchParams();
  const limit = src.get("limit");
  if (limit) qs.set("limit", limit);
  const evt = src.get("event");
  if (evt) qs.set("event", evt);
  const query = qs.toString();
  const url = `${SPAWNER_URL}/notifications/history${query ? `?${query}` : ""}`;
  try {
    const headers = withInternalToken(SPAWNER_URL, upstreamHeaders(event.request.headers));
    const r = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return json({ db_enabled: false, entries: [] });
    const j: unknown = await r.json().catch(() => null);
    return json(coerceNotificationHistory(j));
  } catch {
    return json({ db_enabled: false, entries: [] });
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
  // Validate the scope against the spawner's wire contract
  // ($lib/types/notifications, the single source of truth the UI also reads):
  // reject an unknown id by name so a typo/legacy scope can't be stored as a
  // filter that silently matches nothing. Forward-compatible — a new Phase-C
  // kind is accepted the moment it's added to NOTIFY_EVENT_KINDS.
  const scope = validateNotificationEvents(body?.events);
  if (!scope.ok) {
    return json(
      {
        ok: false,
        message: `Unknown notification event '${scope.bad}' — not a spawner event kind`,
      },
      400,
    );
  }
  const events = scope.events;
  const payload = { name, kind, url, events };
  try {
    const headers = withInternalToken(SPAWNER_URL, upstreamHeaders(event.request.headers));
    headers.set("content-type", "application/json");
    const r = await fetch(`${SPAWNER_URL}/notifications`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
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
    const headers = withInternalToken(SPAWNER_URL, upstreamHeaders(event.request.headers));
    const r = await fetch(`${SPAWNER_URL}/notifications/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(15_000),
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
    const headers = withInternalToken(SPAWNER_URL, upstreamHeaders(event.request.headers));
    const r = await fetch(`${SPAWNER_URL}/notifications/${encodeURIComponent(name)}/test`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(15_000),
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

/** Operator identity for the kill sentinel's audit `reason` — the session's
 *  username when auth is enabled; explicit markers otherwise (never blank). */
function operatorName(auth?: AuthState): string {
  if (!auth) return "unknown";
  if (auth.mode === "disabled") return "auth-disabled";
  if (auth.mode === "bootstrap") return "bootstrap";
  return auth.session?.username ?? "unknown";
}

/** Audit IP + UA context for a request (same anchoring the login/setup actions
 *  use — the unspoofable socket peer unless a trusted proxy is configured). */
function requestCtx(event: RequestEvent): RequestCtx {
  return {
    ip: clientIp(event.request, event.getClientAddress(), trustForwardedFor()),
    userAgent: event.request.headers.get("user-agent") ?? "",
  };
}

// Exported for the internal-token regression test (auth-chain H5): it drives the
// direct spawner helpers below through this dispatcher to assert each mints the
// service token. Not a SvelteKit hook export — SvelteKit only reads `handle`.
export async function proxyBackend(event: RequestEvent, auth?: AuthState): Promise<Response> {
  const { pathname, search } = event.url;

  // ══════════════════════════════════════════════════════════════════════════
  // ── Alert-ack inbox (M3 Phase B) ────────────────────────────────────────────
  // Paths are unique, so the position within proxyBackend is immaterial.
  //   GET  /api/alerts/inbox → live Prometheus alerts LEFT-JOINed to acks.
  //   POST /api/alerts/ack   → record an ack (irrevocable audit row).
  // Both are behind the #47 session seam. The ack is additionally in
  // AUTH_DISABLED_BLOCKED_MUTATIONS (adapter.ts) so the WEBUI_AUTH=disabled dev
  // bypass can NEVER let an unauthenticated tailnet curl silence the pager.
  if (pathname === "/api/alerts/inbox") {
    return alertInboxGet(PROMETHEUS_URL, getAlertAckStore());
  }
  if (pathname === "/api/alerts/ack" && event.request.method === "POST") {
    // Defense-in-depth: proxyBackend is also invoked on the auth-store outage
    // path WITHOUT an `auth` arg (handle → outageRoute open-backend). An ack
    // silences an armed-path page, so require a real session here too — a
    // missing/disabled auth context must never write an ack. (routeRequest +
    // AUTH_DISABLED_BLOCKED_MUTATIONS already gate this; this is belt-and-braces,
    // mirroring the /api/users philosophy.)
    if (!(auth?.mode === "enabled" && auth.session)) {
      return sessionRequired();
    }
    return alertAckPost(event.request, getAlertAckStore(), auth.session.username);
  }
  // ══════════════════════════════════════════════════════════════════════════

  // ── User management (Phase B) — dispatched ABOVE the spawner match ──────────
  // GET list / POST create + per-user disable|enable|role|reset-password|
  // revoke-sessions. routeRequest (R1) already 403s non-admins for ANY method;
  // usersDispatch re-checks admin as defense in depth (the outage path calls
  // proxyBackend WITHOUT auth, and WEBUI_AUTH=disabled must refuse here). The
  // service is resolved only after the guard passes so an unauthenticated
  // outage curl never forces a DB connect.
  if (pathname === "/api/users" || pathname.startsWith("/api/users/")) {
    return usersDispatch(
      event.request,
      pathname,
      auth,
      requestCtx(event),
      getAuthService,
    );
  }

  // ── Invites (Phase C) — mint / list / revoke one-time signup links ──────────
  // Admin-only at the seam (R1 covers /api/invites for ANY method); invitesDispatch
  // re-checks admin as defense in depth (same outage/disabled reasoning as users).
  if (pathname === "/api/invites" || pathname.startsWith("/api/invites/")) {
    return invitesDispatch(
      event.request,
      pathname,
      auth,
      requestCtx(event),
      getAuthService,
    );
  }

  // ── Spawner — a real, working backend (the /bots page) ──────────────────────
  // /api/spawner/<rest> → spawner /<rest>  (mirrors the old vite/nginx rewrite)
  if (pathname === "/api/spawner" || pathname.startsWith("/api/spawner/")) {
    // R2b (adapter.ts `spawnerWriteNeedsAdmin`): a spawn, saved config or
    // respawn that could trade real money needs an admin, whatever routed it
    // here. The body is read from a clone, so `forward` still has it.
    const isAdmin =
      auth?.mode === "enabled" &&
      auth.session !== null &&
      roleRank(auth.session.role) >= roleRank("admin");
    if (
      !isAdmin &&
      (await spawnerWriteNeedsAdmin(
        pathname,
        event.request.method,
        () => event.request.clone().text(),
        storedSpawnerConfig,
        spawnerTemplate,
      ))
    ) {
      return jsonError(403, {
        error: "forbidden",
        reason: "role_denied",
        detail:
          "Going live needs an admin: a bot in live mode or with exchange keys, or an edge deployment promoted to live.",
      });
    }
    const rest = pathname.replace(/^\/api\/spawner/, "") || "/";
    // A hypothesis records who registered it: the session's user, never
    // what the browser claims (adapter.ts `withRegisteredBy`).
    if (isHypothesisRegistration(pathname, event.request.method)) {
      const stamped = withRegisteredBy(await event.request.clone().text(), operatorName(auth));
      if (stamped !== null) return forward(event, SPAWNER_URL, rest + search, stamped);
    }
    return forward(event, SPAWNER_URL, rest + search);
  }

  // ── janus mappings (Phase 2) ────────────────────────────────────────────────
  // Status-bar health: reshape janus /health → {redis,janus,feed}.
  if (pathname === "/api/health") {
    return janusHealth(event);
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
  // Delivery-ledger read surface (Phase E). Registered BEFORE the generic
  // `/notifications/(.+)` DELETE matcher below so intent is obvious — it is
  // GET-only, so the DELETE matcher can never shadow it regardless of order.
  if (
    pathname === "/api/settings/notifications/history" &&
    event.request.method === "GET"
  ) {
    return notificationsHistory(event);
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

  // ── Market-data coverage → QuestDB candles_crypto (Data page, Home) ─────────
  if (pathname === "/api/market/coverage") {
    return marketCoverage();
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
  // ...but ONLY for reads. Degrading a MUTATION to an empty 200 is a fake
  // success: the UI awaits the call, sees no error, and tells the operator the
  // action worked when nothing was wired at all (2026-07-26 review — the
  // /trading order ticket reported "BUY order submitted" against a stub, and
  // trade-close / signal approve-reject / janus-ai session start-stop were
  // silent no-ops by the same route). An unimplemented write must SAY so.
  if (!isGetLike(event.request.method)) {
    return json(
      {
        error: "not_implemented",
        detail: `No backend is wired for ${event.request.method} ${pathname}. ` +
          `This action did NOT happen — it is not implemented, not failed-silently.`,
      },
      501,
    );
  }
  return gracefulEmpty(pathname);
}

// ════════════════════════════════════════════════════════════════════════════
// Auth — the single enforcement seam (design §4.0-4.1). Every request resolves
// an AuthState from the DB-backed session store, then the pure `routeRequest`
// decides: backend proxy, page pass, login redirect, 401 (backend, no session),
// or 403 (mustChange). FAIL CLOSED: a missing store or unresolved session denies
// — mutations never reach an upstream without a valid session. The routing +
// decision logic lives in `$lib/server/adapter` (pure + unit-tested); this hook
// performs the I/O and side effects.
// ════════════════════════════════════════════════════════════════════════════

function jsonError(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The adapter's OWN session denial — 401 plus the `x-fks-auth: session-required`
 * marker the browser keys its "Session expired — sign in again" banner off
 * ($lib/stores/session).
 *
 * Use this ONLY where THIS process decided the caller has no valid webui
 * session. It must never be used for a status that merely came back as 401 from
 * an upstream: `forward` proxies upstream statuses verbatim, so a spawner
 * `X-Internal-Token` mismatch (a deploy fault that signing in cannot fix) also
 * reaches the browser as a 401. Marking that one would train the operator to
 * ignore the banner that means their session really did expire — which is the
 * whole point of the header. `forward` correspondingly DELETES any
 * upstream-supplied copy of the header, so the signal is unforgeable and always
 * means "the adapter itself refused this request".
 */
function sessionRequired(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      [SESSION_HEADER]: SESSION_REQUIRED,
    },
  });
}

export const handle: Handle = async ({ event, resolve }) => {
  const { pathname, search } = event.url;
  const method = event.request.method;
  const backend = isBackend(pathname);

  // Old page URLs (bookmarks, the PWA's history) land on their new home.
  // Before auth on purpose: it reveals nothing, and the target page then goes
  // through the normal gate. 302, not 308, so browsers do not cache it.
  if (!backend && isGetLike(method)) {
    const to = movedPage(pathname);
    if (to) return new Response(null, { status: 302, headers: { location: to } });
  }

  // Default identity — no leak. Overwritten once auth resolves; stays null on
  // the outage open-page branch (login/logout render with no user). See A3.
  event.locals.user = null;
  event.locals.authDisabled = false;

  // Resolve auth posture; fail CLOSED if the store is unreachable (never open).
  let auth: AuthState;
  try {
    auth = await resolveAuthState(event.cookies.get("fks_session") ?? "");
  } catch (e) {
    if (e instanceof AuthStoreUnavailable) {
      // Fail closed for anything needing auth, but keep health probes working
      // (monitoring) and the login/logout PAGES renderable (a persistent outage
      // or a least-privilege deploy that can't self-migrate must not brick the
      // whole browser path with a bare 503 — the login action still fails closed
      // while the store is down). See adapter.outageRoute.
      switch (outageRoute(pathname)) {
        case "open-backend":
          return proxyBackend(event);
        case "open-page":
          return resolve(event);
        case "deny-backend":
          return jsonError(503, { error: "auth_store_unavailable" });
        case "deny-page":
          return new Response(
            "Authentication store unavailable — the dashboard is failing " +
              "closed. Retry once the database is reachable, or open /login.",
            { status: 503, headers: { "content-type": "text/plain" } },
          );
      }
    }
    throw e;
  }

  // Expose the resolved identity to page loads (A3). Only a full, real session
  // yields a user; `disabled` mode is null-but-badged so the strip can say
  // "auth off". No `mustChange`/bootstrap gating here — that's the seam's job;
  // this is display-only. Pages read it via +layout.server.ts → $page.data.user.
  event.locals.user =
    auth.mode === "enabled" && auth.session
      ? {
          username: auth.session.username,
          role: auth.session.role,
          mustChange: auth.session.mustChange,
        }
      : null;
  event.locals.authDisabled = auth.mode === "disabled";

  // CSRF: a state-changing backend call must not carry a cross-site Origin.
  if (
    backend &&
    !originAllowed(
      method,
      event.request.headers.get("origin"),
      event.request.headers.get("host"),
    )
  ) {
    return jsonError(403, { error: "bad_origin" });
  }

  const route = routeRequest(pathname, search, method, auth);

  switch (route.kind) {
    case "backend":
      return proxyBackend(event, auth);
    case "unauthorized":
      // Only stamp the session-expired marker for a genuine session denial.
      // A BOOTSTRAP refusal (empty users table) has no session to expire, and
      // the banner would send the operator to /login where no account exists.
      // Route them to the truth instead.
      if (route.reason === "bootstrap") {
        return jsonError(401, {
          error: "setup_required",
          detail:
            "No administrator account exists yet — complete first-run setup at /setup before making changes.",
        });
      }
      return sessionRequired();
    case "forbidden":
      return jsonError(403, {
        error: "forbidden",
        reason: route.reason ?? "credential_change_required",
      });
    case "redirect":
      return new Response(null, {
        status: 302,
        headers: { Location: route.location },
      });
    case "pass":
      return resolve(event);
  }
};
