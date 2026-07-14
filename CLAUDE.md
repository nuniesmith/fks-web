# fks-web — Claude Code Project Instructions

> **Repo:** `github.com/nuniesmith/fks-web` (standalone — split out of
> `fks/src/web/`). Deployed as `nuniesmith/fks:webui` by the **fks** repo's
> Node Dockerfile, which git-clones this repo at build time (pinned via
> `WEB_COMMIT`); infra (compose, nginx, CI/CD) stays in fks.

## What this is

SvelteKit 5 frontend for the FKS platform. Single-page terminal UI with:
top status strip, multi-group tab bar, route-per-feature workspace pane,
bottom status bar. All backend calls are same-origin and flow through the
`hooks.server.ts` adapter — the single backend seam — which maps them to
janus (`/api/*`, `/sse/*`), the spawner (`/api/spawner/*`, `/api/bots/*`),
Prometheus (`/api/metrics/*`), and QuestDB (`/bars`, chart candles).

## Stack

| | |
|--|--|
| Framework | SvelteKit 5 (runes syntax: `$state`, `$derived`, `$effect`, `$props`, `$snippet`) |
| Build | Vite 6 + `@sveltejs/adapter-node` |
| Language | TypeScript (strict) |
| Charts | `lightweight-charts` |
| Tests | Vitest (unit) · Playwright (E2E) |
| Lint | `svelte-check` |

## Build & test

```bash
# from the repo root

# Dev server (hot reload)
npm run dev                # http://localhost:5173

# Type-check
npm run check
npm run check:watch

# Unit tests (Vitest) — pure-TS modules, e.g. the indicator engine
npm run test:unit

# E2E tests (Playwright)
npm run test:e2e
npm run test:e2e:ui

# Production build
npm run build              # → build/ via adapter-node
npm run preview            # serve the production bundle locally
```

## Repository layout

```
fks-web/
├── package.json
├── svelte.config.js
├── vite.config.ts            # deliberately proxy-free — hooks.server.ts is the seam
├── playwright.config.ts
├── src/
│   ├── app.html
│   ├── app.css
│   ├── app.d.ts
│   ├── hooks.server.ts       # backend adapter: janus / spawner / Prometheus / QuestDB
│   ├── lib/
│   │   ├── api/              # typed fetch wrappers (client.ts, spawner.ts, …)
│   │   ├── types/            # shared TS types per domain (spawner.ts, charts, …)
│   │   ├── stores/           # createPoll, createSSE, focusSymbol, strip
│   │   ├── components/
│   │   │   ├── shell/        # Strip, TabBar, StatusBar (the terminal chrome)
│   │   │   └── ui/           # Panel, Badge, Skeleton, ProgressBar, FilterChips, …
│   │   ├── utils/format.ts   # fmtPrice, fmtPct, fmtDollar, fmtTime, scoreColor, …
│   │   ├── config.ts         # PUBLIC_* env-var-driven runtime config
│   │   └── workspaces.ts     # registered workspace nav groups
│   ├── styles/
│   └── routes/               # one folder per feature (charts, bots, signals, …)
└── tests/                    # Playwright E2E
```

## Code conventions

- **Svelte 5 runes only.** No `let count = 0` reactive statements. Always:
  ```svelte
  let count = $state(0);
  let doubled = $derived(count * 2);
  $effect(() => { console.log(count); });
  let { foo, bar } = $props();
  ```
- **Snippets, not slots.** Components that need a header pass-through use `{#snippet header()}` (Svelte 5), not `<div slot="header">` (Svelte 4 — fails silently here).
- **Types live in `$lib/types/`.** Never redeclare a shared type inline in a component.
- **API calls go through `$lib/api/*`.** The `api` export from `$lib/api/client.ts` is an *object* with `.get / .post / .put / .delete` methods — **not a callable function**. Calling `api(url, opts)` is a common mistake.
- **Polls live in `$stores/poll.ts`.** Don't reinvent `setInterval` in components.
- **SSE lives in `$stores/sse.ts`** (or open `EventSource` directly when you need per-row control like the `/bots` log viewer does).
- **Styling:** dark theme via CSS variables (`var(--bg1)`, `var(--t1)`, `var(--cyan)`, `var(--accent)`, `var(--green-dim)`, …) defined in `app.css`. Use the existing palette before introducing new colours.

## Common workflows

### Add a new route
1. Create `src/routes/<feature>/+page.svelte`.
2. Reach for `Panel`, `Badge`, `Skeleton`, `StatCard` from `$components/ui/`.
3. If it needs an API client, add `src/lib/api/<feature>.ts` (typed wrapper) + `src/lib/types/<feature>.ts` (mirror of backend types).
4. Add the tab to `src/lib/components/shell/TabBar.svelte` in the right group (Markets / Trading / Analysis / System / per-workspace).
5. If it talks to a new backend, add the mapping to the `hooks.server.ts` adapter (`src/lib/server/adapter.ts` routing + an `*_INTERNAL_URL` env override) — there is deliberately no vite proxy; the hook is the seam in both dev and prod. nginx config lives in the fks repo.

### Add a new SSE-driven feature
Pattern: `routes/bots/+page.svelte` log viewer. `EventSource` opened lazily, `bind:this` on the container, `$effect` triggers scroll-to-tail when followed, `onscroll` handler flips follow state, optional "Jump to latest" button when paused.

### Add a chart
Use `lightweight-charts`. Pattern: `routes/charts/+page.svelte`. History bars come from QuestDB via the hook's `/bars/{symbol}` mapping (REST); live updates arrive on `/sse/bars/{symbol}` (janus tail when `JANUS_BARS_SSE_URL` is set — a graceful idle stub otherwise).

## Gotchas

- **No vite dev proxies — the `hooks.server.ts` adapter is the seam in both dev and prod.** Upstream defaults are in-container Docker-network hostnames (`fks_janus`, `fks_bot_spawner`, `fks_prometheus`, `fks_questdb`); override each via its `*_INTERNAL_URL` env var for dev outside Docker. Adding a `server.proxy` to `vite.config.ts` would shadow the hook and break that path.
- **Auth.** Two layers. (1) Pages: a server-side login gate in `hooks.server.ts` / `routes/login` (`WEBUI_PASSWORD_HASH` + `WEBUI_SESSION_SECRET`, HTTP-only `fks_session` cookie; dev bypass when unset) — backend `/api`/`/sse` calls are proxied, never auth-redirected. (2) Upstreams: nginx injects `X-Internal-Token` on every proxied request and the adapter preserves it (while stripping the browser `cookie` at the trust boundary). Don't add browser-side credential handling — Tailscale + the shared internal token is the policy.
- **Exchange API keys are submit-only (server-side storage).** The `/settings`
  form covers Kraken, KuCoin (+ passphrase), and Crypto.com; each card POSTs
  `{api_key, api_secret[, api_passphrase]}` to the generic
  `/api/settings/{exchange}-keys` route; the adapter forwards to the spawner's
  `POST /secrets`, which persists them in Postgres (`ruby_db.exchange_secrets`)
  behind `X-Internal-Token` — **encrypted at rest** (spawner-side
  ChaCha20-Poly1305 via `SPAWNER_SECRETS_KEY`; fks #161). The secret is **never
  returned** to the browser — `/api/settings/{exchange}-status` only reports
  whether keys are configured. This is compatible with the "no
  browser-credential handling" policy because the browser submits and forgets
  (inputs are cleared on save). Default operation stays keyless/public; keys
  only unlock the authenticated `exchange-apiws` order path, which remains
  behind the execution gate. The `/bots` spawn form can inject stored keys
  into a spawned bot's env via the `secrets` checkboxes (spawner decrypts at
  spawn time; fks #162).
- **Notification channels are submit-only too.** The `/settings`
  "Notifications" section manages Discord webhooks: each channel POSTs
  `{name, kind, url, events}` to `/api/settings/notifications`; the adapter
  forwards to the spawner's `POST /notifications`, which stores it in Postgres
  (`ruby_db.notification_channels`) with the **webhook URL encrypted at rest**
  (same cipher as exchange keys — a webhook URL is a bearer capability). The
  URL is **never returned**: `GET /api/settings/notifications` lists only
  name/kind/events. `events: []` = catch-all. Each channel row has a **Test**
  button that POSTs `/api/settings/notifications/:name/test`; the adapter
  forwards to the spawner's `POST /notifications/:name/test` (fks #181), which
  decrypts the stored webhook, sends a synthetic event, and reports only the
  outcome ({ok:true} sent · {ok:false,status} webhook non-2xx · 404 no channel ·
  503 no DB) — the URL never returns to the browser. Actually SENDING on real
  events (spawn/stop/live-flip → Discord) is still a spawner-side follow-up;
  this repo only manages + test-fires the channels.
- **`npm run check` is clean (0 errors / 0 warnings).** The de-navved Ruby
  routes that held the original type errors were deleted; the dashboard is now
  janus / Prometheus / QuestDB-backed via `hooks.server.ts`. Keep it at 0 — the
  web CI gates on `svelte-check` + `vitest` (`npm run test:unit`) + `vite build`.

## Status

The dashboard is fully repointed to janus / Prometheus / QuestDB via the
`hooks.server.ts` adapter (the old Python "Ruby" backend is gone). Current state:

- **Green gates:** `npm run check` is 0/0, `npm run build` succeeds, and
  `npm run test:unit` (vitest) passes — all three run in the web CI.
- **Unit tests** cover the pure logic + plumbing: the indicator engine, the
  adapter reshapers + QuestDB input sanitizers, the formatters, and the
  poll / SSE stores + the api client.
- **Pages wired:** charts (full indicator set + presets/persistence, crosshair
  readout, log scale), `/bots` (spawn presets + secrets-injection checkboxes,
  saved configs, per-bot CPU/mem + uptime, SSE log viewer, run history, durable
  per-bot net-worth history chart from the spawner's `/net-worth`),
  signals (live janus feed via `/api/signals/latest`), performance, janus-ai,
  settings (risk controls + Kraken/KuCoin/Crypto.com API-key entry),
  monitoring, `/exchanges` + `/exchanges/[exchange]` (crypto-bot balances, net
  worth, holdings vs targets, recent rebalance trades — reads the bots'
  `/status` servers via `CRYPTO_SPOT/FUNDING_INTERNAL_URL`) — all with
  consistent `EmptyState` empty/error states.
- **`/treasury`** (#41/#43/#44): the money home page — real net worth
  (carry-forward TOTAL + account-class grouping), profit vs deposits, and a
  phone-friendly record-a-transfer form over the spawner's `/transfers` /
  `/accounts` / `/profit`; stale carry-forward accounts (newest snapshot older
  than `ACCOUNT_STALE_SECONDS` = 6h) get an amber "includes … from N stale
  accounts" annotation on the headline (never silently reduced).
- **`/edges`** (#42): edge-factory UI — the edge portfolio (registry), backtest
  runs + results views over the spawner's `/edges` endpoints.
- **`/workspace`** (#35/#36): dockable/snappable panel layouts (dockview-core)
  with real panels (no placeholders); named layouts persist locally and
  server-side (spawner `ui_layouts` via `/api/spawner/ui/layouts`) so they
  follow the operator across devices.
- **`/futures`** (#33/#34): trading-types page with a Rithmic capability gate,
  `candles_futures` charting, and a read-only Rithmic positions panel via
  `/api/rithmic/positions` (degrades to `connected:false` when the connector
  profile is down).
- Phase-by-phase buildout detail lives in the **fks** repo at
  `docs/architecture/WEBUI_BUILDOUT_PLAN.md`.
