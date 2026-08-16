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
- **Styling:** dark theme via CSS variables (`var(--bg1)`, `var(--t1)`, `var(--cyan)`, `var(--accent)`, `var(--green-dim)`, …) defined in **`src/styles/tokens.css`** — `app.css` only `@import`s it and then adds utility classes + the two page archetypes. Use the existing palette before introducing new colours.

## Common workflows

### Add a new route
1. Create `src/routes/<feature>/+page.svelte`.
2. **Give the page root exactly ONE scroll story.** The shell (`+layout.svelte .workspace`) hands you an exact-height `overflow:hidden` box — the document itself never scrolls, so a page with no scroll region silently clips everything below the fold. Pick one archetype (both defined in `src/app.css`):
   - **`.page-scroll`** — *document pages* (cockpit, futures, exchanges, treasury, edges, settings-style): the page scrolls; every `Panel` is rigid and grows with its content. This is the default; reach for it unless you have side-by-side exact-height panes.
   - **`.page-fixed`** — *terminal-split pages* (charts, trading, journal, workspace): exact-height panes; put exactly ONE `fill` `Panel` per pane and let its body own the inner scroll. Never put a page scrollbar under a chart.
3. **`Panel` is rigid by default; `fill` is the opt-in.** A plain `<Panel>` grows with its content and pushes its pane/page to scroll (its body does *not* scroll internally). Add `fill` only to the ONE panel per pane that should be height-constrained and own an inner scroll region (sticky in-body `thead`s pin to it for free). Do not stack multiple `fill` panels in a single scroll column, and don't wrap a table in its own `overflow:auto` inside a `fill` panel body — that recreates the nested-scroll "weird scrolling". Charts/canvases (`lightweight-charts`) need a real height (a `min-height` floor when flexed) — they render blank at 0 height.
4. Reach for `Panel`, `Badge`, `Skeleton`, `StatCard` from `$components/ui/`.
5. If it needs an API client, add `src/lib/api/<feature>.ts` (typed wrapper) + `src/lib/types/<feature>.ts` (mirror of backend types).
6. Add the tab to `src/lib/components/shell/TabBar.svelte` in the right group (Markets / Trading / Analysis / System / per-workspace).
7. If it talks to a new backend, add the mapping to the `hooks.server.ts` adapter (`src/lib/server/adapter.ts` routing + an `*_INTERNAL_URL` env override) — there is deliberately no vite proxy; the hook is the seam in both dev and prod. nginx config lives in the fks repo.

### Add a new SSE-driven feature
Pattern: `routes/bots/+page.svelte` log viewer. `EventSource` opened lazily, `bind:this` on the container, `$effect` triggers scroll-to-tail when followed, `onscroll` handler flips follow state, optional "Jump to latest" button when paused.

### Add a chart
Use `lightweight-charts`. Pattern: `routes/charts/+page.svelte`. History bars come from QuestDB via the hook's `/bars/{symbol}` mapping (REST); live updates arrive on `/sse/bars/{symbol}` (janus tail when `JANUS_BARS_SSE_URL` is set — a graceful idle stub otherwise).

## Gotchas

- **No vite dev proxies — the `hooks.server.ts` adapter is the seam in both dev and prod.** Upstream defaults are in-container Docker-network hostnames (`fks_janus`, `fks_bot_spawner`, `fks_prometheus`, `fks_questdb`); override each via its `*_INTERNAL_URL` env var for dev outside Docker. Adding a `server.proxy` to `vite.config.ts` would shadow the hook and break that path.
- **Auth (Phase 1 sessions + Phase 2A RBAC — design `research-2026-07-17/design-user-management.md`, plan 01).** Three layers, three jobs, no replacement relationship:
  - **L0 tailnet/loopback** — *can you reach the socket?* Unchanged outer wall; the webui must never leave loopback/tailnet for the public internet.
  - **L1 webui sessions (this layer)** — *which human is acting?* On first startup, if `webui_users` is empty, one `admin` is created with a **CSPRNG bootstrap password printed once to the container log** (`docker logs fks_webui`) and `must_change_credentials=TRUE`. There is **NO static/shipped default credential** — a fresh clone cannot be logged into by anyone without the log line. First login forces a username+password change at `/setup` before the app or any mutation is reachable. Passwords are **scrypt** (`node:crypto`, PHC strings, per-user salt) — never a fast/unsalted hash, never logged. Sessions are opaque 32-byte tokens in the HTTP-only `fks_session` cookie; the server stores only `sha256(token)`, so sessions are **revocable** (logout / change) and expiring (7d idle / 30d absolute). Login is rate-limited (per-IP token bucket) + per-user lockout (10 fails → 15 min, doubling).
  - **L2 `X-Internal-Token` / janus Bearer** — *did the request come through the front door?* The **adapter** now mints `X-Internal-Token` on the outbound proxy call (`hooks.server.ts` `withInternalToken`) and **strips any client-supplied copy** at the seam (`adapter.ts` HOP set) — the token means "passed the session-checked adapter", not "reached nginx". Spawner still fail-closes on it; janus still uses its own Bearer.
  - **FAIL CLOSED:** `routeRequest` (pure, unit-tested in `adapter.ts`) is the single decision core — missing config is **bootstrap-then-enforce, never an open door**. The ONLY bypass is an explicit `WEBUI_AUTH=disabled`. Backend/mutating routes require a valid session (401 without; 403 while `mustChange`); pages redirect to `/login`. If the auth store (Postgres via `WEBUI_DATABASE_URL`) is unreachable, requests 503 (health probes excepted) — they never fail open. **DO add browser-side credential handling — that is now the policy** (this bullet supersedes the old "Tailscale + shared token is the policy" line, which predated the roadmap's pre-mobile-mutation tripwire).
  - **Phase 2A — RBAC ENFORCED at the `routeRequest` seam** (roles are live, not just modelled). Rank order `viewer < operator < admin` (`roleRank` in `adapter.ts`, fail-closed: any unknown/garbage role → viewer rank 0). The §1.1 rule table is a set of exported prefix constants evaluated top-down in `roleDenies` (backend, 403 `role_denied`) + `routeRequest` (pages redirect home, never 403):
    - **R1 `ADMIN_ONLY_BACKEND_PREFIXES`** (`/api/users`, `/api/invites`) — admin-only for ANY method incl. GET (the list itself leaks). Both surfaces now EXIST (Phase B/C/D below) and ride this rule.
    - **R2 `ADMIN_ONLY_MUTATION_RULES`** (non-GET only) — config/credential/live-arming surfaces: `/api/cockpit/rearm`, the `*-keys` routes, `/api/settings/notifications`, `/api/settings/risk`, `/api/janus/config`. Re-arming a halted live bot is the DANGEROUS direction → admin-only.
    - **R3** — every OTHER backend mutation is operator+ (viewer denied). The **kill** button (`/api/cockpit/kill`) is deliberately here, NOT R2: halt is the SAFE direction, so an operator can panic-stop without admin.
    - **R5 `ADMIN_ONLY_PAGE_PREFIXES`** (`/users`) — non-admins get a redirect to `/`.
    - **Solo-admin default is unchanged:** with zero non-admin users every session is admin, so nothing here alters single-operator behaviour. Pinned by `adapter.test.ts` + `roleGating` tests.
  - **Phase B/C/D — user management is LIVE** (plan 01 complete): `/users` (admin console: create/disable/role/reset/revoke with last-admin + self-disable guards, one-time temp passwords never persisted/logged/audited) + `/invite/[token]` (one-time signup URLs: single-use atomic redeem, 48h, operator/viewer only — no admin-by-invite, token sha256 at rest, per-IP rate-limited claim) + the "Recent auth events" audit panel (`GET /api/users/audit`, admin-only, clamped). Multi-user is opt-in; bootstrap unchanged. **The authoritative permission table + role-mistake recovery + deploy runbook is `docs/AUTH_PHASE2.md`.**
- **Exchange API keys are submit-only (server-side storage).** The `/settings`
  form covers Kraken, KuCoin (+ passphrase), and Crypto.com; each card POSTs
  `{api_key, api_secret[, api_passphrase]}` to the generic
  `/api/settings/{exchange}-keys` route; the adapter forwards to the spawner's
  `POST /secrets`, which persists them in Postgres (`fks_db.exchange_secrets`)
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
  (`fks_db.notification_channels`) with the **webhook URL encrypted at rest**
  (same cipher as exchange keys — a webhook URL is a bearer capability). The
  URL is **never returned**: `GET /api/settings/notifications` lists only
  name/kind/events. `events: []` = catch-all. Each channel row has a **Test**
  button that POSTs `/api/settings/notifications/:name/test`; the adapter
  forwards to the spawner's `POST /notifications/:name/test` (fks #181), which
  decrypts the stored webhook, sends a synthetic event, and reports only the
  outcome ({ok:true} sent · {ok:false,status} webhook non-2xx · 404 no channel ·
  503 no DB) — the URL never returns to the browser. **Dispatch on real events
  is LIVE** in the spawner for the full `ALL_EVENT_KINDS` wire vocabulary
  (`fks-spawner` `crates/spawner/src/notifications.rs`) — the five lifecycle
  kinds `bot_spawned`/`bot_stopped`/`bot_removed`/`bot_error`/`bot_crashed` plus
  the plan-03 Phase-C/D kinds `bot_restarted`, `live_flip`, `key_rotation`,
  `net_worth_milestone`, `risk_halt`, `edge_decay`. `bot_crashed`,
  `bot_restarted`, `live_flip`, and `risk_halt` are **always-delivered** (bypass
  the `events[]` filter — page-worthy), so their `/settings` checkboxes render
  checked+disabled. Those wire ids are the single source of truth in
  `$lib/types/notifications.ts`, which both the `/settings` checkboxes and the
  adapter's POST validation read — the adapter 400s any submitted `events[]` id
  that isn't a real wire kind, so a scoped channel can't store a filter (e.g. the
  old `spawn`/`stop`/`pnl_digest`) that silently matches nothing. This id-parity
  between the UI checkboxes and the real `ALL_EVENT_KINDS` wire enum was the
  **webui M0 fix** (the old list offered phantom kinds that matched nothing).
  Adding a new wire kind is a one-line edit there.
- **Notification delivery history (plan-03 Phase E).** A "Notification history"
  panel under the Notifications section reads the spawner's delivery ledger via
  `GET /api/settings/notifications/history?limit=&event=` → `notificationsHistory`
  in `hooks.server.ts` → spawner `GET /notifications/history` (`notification_log`,
  fks 013). One row per webhook send ATTEMPT (real fires + `test` probes) with a
  green/red outcome dot, so "did the 3am crash page actually send?" is answerable
  without `docker logs`. The adapter DEFENSIVELY reshapes via the pure
  `coerceNotificationHistory` (bad JSON / non-2xx / malformed rows →
  `{db_enabled:false, entries:[]}`); the panel is honest about
  `db_enabled:false` (amber "013 not applied" line, NOT a fake-empty list),
  loading (skeleton), and genuinely-empty (EmptyState). Refreshes on a 30s
  `createPoll`; the ledger detail is URL-free by the spawner contract. Badge
  variant + outcome-ok mapping are pure exported helpers
  (`kindBadgeVariant`/`outcomeIsOk`) in `$lib/types/notifications.ts`.
- **Installable PWA, but NO service worker (webui M1).** The app ships a web
  app manifest (`static/manifest.webmanifest`) + icon set (`static/icon-192`,
  `icon-512`, the two `icon-maskable-*`, `apple-touch-icon.png`, `favicon.svg`)
  and iOS `<meta>`/safe-area wiring, so it installs to an iPhone home screen as
  a standalone app. There is **deliberately NO service worker / offline cache
  yet** — that is scoped to M7. Do not add one incidentally (it would cache the
  authenticated shell and fight the fail-closed session seam). The manifest +
  its icon filenames are on the adapter's **explicit static-asset allowlist**
  (`adapter.ts` — filenames, NOT an `/icons/*` wildcard), so they load
  pre-login; adding a new top-level static asset that must be reachable before
  auth means adding its exact name to that allowlist.
- **Truth & freshness (M4) — the rules that keep "looks fine" from being a
  lie.**
  - **Unmapped READS degrade; unmapped MUTATIONS do not.** A backend-prefixed
    path with no dispatch falls to `gracefulEmpty` → `200 {}`/`[]`/an idle SSE
    stub, but only for GET/HEAD. Any other method returns **501
    `not_implemented`** with "This action did NOT happen"
    (`hooks.server.ts`, the `if (!isGetLike(...))` branch just above the
    `gracefulEmpty` fall-through). Degrading a write to an empty 200 is a
    **fake success** — the UI awaits it, sees no error, and tells the operator
    the order/close/approve landed against nothing. Do **not** "restore
    graceful degradation" on writes.
  - **`updatedAt` is the last SUCCESSFUL fetch, never the last attempt**
    (`src/lib/stores/poll.ts`). A backend that has been failing for ten
    minutes still produces attempts every interval, so keying a freshness
    indicator off attempts renders a dead feed as perfectly current.
  - **`$lib/utils/freshness.ts` auto-detects epoch-s vs epoch-ms.** The
    platform publishes both (`/exchanges` `v.updated` is SECONDS from the
    bots' `/status`; the cockpit's `generated_at` and `poll.updatedAt` are
    MILLISECONDS). Mixing them does not throw — it renders an age wrong by
    1000×. Default `unit="auto"`; pass an explicit unit only when you know.
  - **Wiring + thresholds:** `Freshness.svelte` sits beside the cockpit
    sentinel badge (`STATE_STALE_AFTER_MS = 15_000`) and on `/exchanges` +
    `/exchanges/[exchange]` at two levels — page poll
    `PAGE_STALE_AFTER_MS = 30_000` and per-venue
    `VENUE_STALE_AFTER_MS = 540_000`. The underlying **300s venue cadence is
    measured, not guessed** (the live spot bot refreshes each venue every
    300s — 12 intervals across three venues, all 299–301s, 2026-07-28). The
    540s threshold (1.8× that period) **tracks the `BotVenueStale` Prometheus
    rule** rather than being fixed on its own: it was 900s (3×) to match that
    rule's original `> 900` threshold, but `fks` #244 lowered the rule to
    `> 540` — aligning it with the spawner sampler's own 600s refusal point
    (2× its 300s sample interval) — and PR #103 (2026-08-15) moved this
    constant to match, after a window where the sampler had stopped
    recording a venue and the pager had fired while `/exchanges` still
    rendered it green. **This is a coupling, not an independent value: any
    future change to `BotVenueStale`'s threshold must move
    `VENUE_STALE_AFTER_MS` with it**, or the screen and the pager drift out
    of sync again. An earlier 90s estimate would have cried wolf every
    cycle — pinned by `src/lib/utils/freshness.test.ts`.
  - **The paper funding bot marks its book on TRADE EVENTS, so a 15+ hour
    venue stamp is HEALTHY IDLE — never flag it.** It is already gated out in
    code (`isFuturesVenue` in `src/routes/exchanges/[exchange]/+page.svelte`
    skips the per-venue `Freshness`; `/futures` renders the same stamp as
    neutral dim text) and pinned by the "funding bot would be permanently
    stale under ANY of these" test. Any future Freshness sweep must key off
    the **page poll's `updatedAt`**, never off `v.updated`, on those surfaces.
  - **Three honest states, not two.** `Freshness.svelte` renders fresh /
    stale / **unknown**, and unknown is GREY, not amber — "we have no stamp"
    is not the same claim as "this data is old".
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
- **`/cockpit`** (M2 + M3) — the armed-futures co-pilot for the live
  funding-reversion bot: read panels + the ONE money-critical mutation (the
  durable kill sentinel). Full detail in `docs/COCKPIT.md`. M3 additions now
  live:
  - **Live-twin `/status` feed (M3 Phase A):** `GET /api/cockpit/live-status`
    is a **three-state honest payload** — `{configured:false}` (env unset) /
    `{configured:true, reachable:false, reason}` (armed-but-down = amber
    outage, never `n/a`) / `{…, mode_mismatch:true}` (pointed at the PAPER
    container → red flag, PnL suppressed) / live `BotStatus` (real `ret_pct` +
    mark px). The **mode-mismatch guard** (`isLiveMode`) exists so a
    mis-pointed `CRYPTO_FUNDING_LIVE_INTERNAL_URL` can never render paper as
    live. Live unrealized PnL **is now wired** (was previously paper-only).
  - **Alert-ack inbox (M3 Phase B):** `/monitoring` is **no longer read-only**
    — it carries an acknowledgement mutation. Incident identity is
    `sha256(labels + activeAt)` (`src/lib/server/alertAck/`); the store PROBES
    `to_regclass` and degrades to `configured:false` (honest, read-only) when
    the `webui_alert_acks` table / grants are absent. The ack route is
    operator+ (R3), so a viewer can never silence an armed-path page. An ack
    silences the **webui** inbox + StatusBar chip only — there is no
    Alertmanager integration in `src/`, so out-of-band paging is unaffected
    and a re-fired alert returns under a new `activeAt`
    (`src/lib/server/alertAck/logic.test.ts` "RE-FIRE = new activeAt").
  - **The cockpit's armed-path filter is THREE clauses, and every one is
    load-bearing (#75).** `isArmedAlert` in `src/routes/cockpit/+page.svelte`
    renders an alert if **ANY** of:
    1. `labels.mode === 'live'` — the rule explicitly stamps the live twin.
    2. `labels.channel === 'money'` — **do not remove this clause.** Several
       money-path rules AGGREGATE the `mode` label away and so can *never*
       satisfy clause 1: `BotAllVenuesStale` is `count by (bot_id) (…)` and
       `NetWorthSamplingPausedTooLong` is `increase(…_stale_skipped_total[30m])`
       (`fks/infrastructure/config/prometheus/alerts/bot-alerts.yml`). Under
       the old two-clause filter the CRITICAL `BotAllVenuesStale` — *"ALL
       real-money venues stale — bot is blind … any position it holds is
       unmanaged"* — was filtered **OUT** of the cockpit while its per-venue
       WARNING sibling was shown: the exact inversion this panel exists to
       prevent, and the shape a repeat of the 2026-07-22 DNS blackout would
       take on the phone. It is also the only clause that catches
       `BotVenueStale` on a **`dry-run`** venue — dry-run is REAL money (real
       balances, no orders), and those rules select `{mode!="paper"}`, so
       clause 1 alone would miss it. And it **self-maintains**: all four rules
       in the `bot-venue-freshness` group stamp `channel: money`, so a new one
       reaches the cockpit with no webui edit.
    3. `ARMED_ALERTNAMES.has(labels.alertname)` — a hand-maintained allowlist
       mirroring `armed-path.yml` + `crash-supervision.yml`, covering live
       rules that stamp neither label. Keep it in sync when those files change.

    **Never "restore" the two-clause form.** Narrowing this filter cannot fail
    loudly: it silently hides a CRITICAL money alert on the one screen the
    operator looks at during an incident.
- **E2E suite (`tests/e2e/`, Playwright).** Hermetic: `cockpit.spec.ts` mocks
  the three cockpit polls + the kill route via `page.route`, so every
  honest-empty / kill-guard branch runs with **no DB or Prometheus**. The
  **kill-flow guards** assert the KILLED badge + KILL→RE-ARM button swap and
  that `WEBUI_AUTH=disabled` still 403s the kill/re-arm mutations. The
  viewport spec anchors "last node reachable / page owns the only scroll" to a
  **structural `.cockpit-page > :last-child`** locator (not a named panel), so
  it keeps testing "whatever is genuinely last" as panels are added (the
  Armed-path alerts panel is last since M3).
- **No-fake-success seam (#69).** Unmapped backend **mutations** now return
  `501 not_implemented` instead of falling through to an empty `200`. This
  closed the `/trading` order ticket reporting "BUY order submitted" against a
  stub, plus trade-close, signal approve/reject and janus-ai session
  start/stop, which were silent no-ops by the same route. Unmapped **reads**
  still degrade quietly — see the "Truth & freshness" gotcha above.
- **M4 — truth primitives (#71) + wiring (#73 cockpit, #74 `/exchanges`).**
  `poll.updatedAt` (last *successful* fetch), `$lib/utils/freshness.ts`
  (s-vs-ms auto-detect, fresh/stale/unknown), and `Freshness.svelte` (own 1s
  ticker so the age counts up between fetches). Wired beside the cockpit
  sentinel badge at 15s, and on `/exchanges` + `/exchanges/[exchange]` at 30s
  page-level / 540s per-venue (#103, 2026-08-15 — tracks the `BotVenueStale`
  Prometheus rule threshold, was 900s) — the latter pinned to a **measured**
  300s venue cadence. The funding bot's trade-event stamp is deliberately
  excluded.
- **M5 — phone frame (#72).** Three measured fixes: (1) the auth gate could
  hide its own submit button at 320×380 (button at bottom=453px with nothing
  scrollable) — `/login`, `/setup` and `/invite/[token]` are now the page's
  single scroll region; (2) logout was a **16px** touch target against a 44px
  minimum — the status bar grows under `(pointer: coarse)`; (3) the bar had no
  `@media` rule at all, so below 640px the three health items collapse into one
  **worst-wins** aggregate dot whose `aria-label` still NAMES the failing
  services. Two design-review claims (logout clipped off-screen, gate cards
  overflowing at 320px) did **not** reproduce against the real DOM and are
  deliberately unguarded — do not re-add specs for them without re-measuring.
  The coarse-pointer sweep is COMPLETE for the money path: cockpit instance
  tabs (#83, `cockpit/+page.svelte:864-887` — 44px floor AND a 12px moat,
  because a bigger flush segment is a bigger overlap with its neighbour), the
  alert-inbox ack cluster (#84/#86, `AlertInbox.svelte:376-400`), and every
  two-step confirm via `ConfirmButton` (#95, `:224-236`). `/bots` Stop /
  Restart / force-remove was the one surface that missed this sweep — it has
  since been closed too: all three now route through `ConfirmButton`, and
  money-bot names (`crypto-spot`, `crypto-funding`) get a named confirm
  phrase (#98, `routes/bots/+page.svelte:825-854`). **Do not re-open any of
  these** — re-adding a bare `onclick` here re-creates the unconfirmed-tap
  failure mode this sweep exists to close.
- Phase-by-phase buildout detail lives in the **fks** repo at
  `docs/architecture/WEBUI_BUILDOUT_PLAN.md`. Forward roadmap (M4–M10 + an
  explicit NOT DOING list) lives at `~/github/FKS_WEB_ROADMAP_2026-07-27.md`.
