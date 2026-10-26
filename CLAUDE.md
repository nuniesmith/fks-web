# fks-web — Claude Code Project Instructions

> **Repo:** `github.com/nuniesmith/fks-web` (standalone — split out of
> `fks/src/web/`). Deployed as `nuniesmith/fks:webui` by the **fks** repo's
> Node Dockerfile, which git-clones this repo at build time (pinned via
> `WEB_COMMIT`); infra (compose, nginx, CI/CD) stays in fks.

## What this is

SvelteKit 5 frontend for the FKS platform. Single-page terminal UI: a tab
bar (top), one route per section, a status bar (bottom, with the signed-in
user and logout). All backend calls are same-origin and flow through the
`hooks.server.ts` adapter — the single backend seam — which maps them to the
spawner (`/api/spawner/*`), Prometheus (`/api/metrics/*`, the alert inbox),
QuestDB (`/bars`, chart candles, `/api/market/coverage`) and janus
(`/api/health`, indicators).

**The layout follows the edge process (2026-10-26):** Home (the accounts you
have set up, what runs, alerts about money) → **Data** (capture: recorders
from a form, coverage and gaps, janus candles, charts) → **Edges** (the
ladder) → **Tasks** (everything spawned from a template; New task is the
template's form) → **Money** (holdings per account + the treasury) →
System (Settings, Monitoring, Docs, Users). The futures co-pilot, Rithmic,
trading, signals, janus-ai, journal, workspace, performance, exchanges and DB
pages were removed with their backends; their old URLs redirect
(`movedPage` in `adapter.ts`).

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
│   │   ├── stores/           # createPoll, createSSE, alertInbox, session
│   │   ├── components/
│   │   │   ├── shell/        # TabBar, StatusBar (the terminal chrome)
│   │   │   ├── accounts/     # AccountCard (Home, Money)
│   │   │   ├── data/         # RecorderCard (live status + coverage calendar)
│   │   │   ├── tasks/        # LogViewer (SSE container logs)
│   │   │   └── ui/           # Panel, Badge, Skeleton, ConfirmButton, Freshness, …
│   │   ├── accounts.ts       # keys + configs + leases + containers → accounts
│   │   ├── tasks.ts          # instances + configs + containers → task rows
│   │   ├── coverage.ts       # recorder files scan → 30-day calendar verdicts
│   │   ├── market.ts         # janus candle coverage per coin
│   │   ├── templateForm.ts   # template JSON-Schema ↔ form state
│   │   ├── utils/format.ts   # fmtPrice, fmtPct, fmtDollar, fmtTime, fmtRelative, …
│   │   └── config.ts         # PUBLIC_* env-var-driven runtime config
│   ├── styles/
│   └── routes/               # /, data, edges, tasks (+new, +advanced), money, charts, settings, monitoring, …
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
- **SSE lives in `$stores/sse.ts`** (or open `EventSource` directly when you need per-row control like `LogViewer` does).
- **Styling:** dark theme via CSS variables (`var(--bg1)`, `var(--t1)`, `var(--cyan)`, `var(--accent)`, `var(--green-dim)`, …) defined in **`src/styles/tokens.css`** — `app.css` only `@import`s it and then adds utility classes + the two page archetypes. Use the existing palette before introducing new colours.

## Common workflows

### Add a new route
1. Create `src/routes/<feature>/+page.svelte`.
2. **Give the page root exactly ONE scroll story.** The shell (`+layout.svelte .workspace`) hands you an exact-height `overflow:hidden` box — the document itself never scrolls, so a page with no scroll region silently clips everything below the fold. Pick one archetype (both defined in `src/app.css`):
   - **`.page-scroll`** — *document pages* (Home, Data, Tasks, Money, Edges, settings-style): the page scrolls; every `Panel` is rigid and grows with its content. This is the default; reach for it unless you have side-by-side exact-height panes.
   - **`.page-fixed`** — *terminal-split pages* (charts): exact-height panes; put exactly ONE `fill` `Panel` per pane and let its body own the inner scroll. Never put a page scrollbar under a chart.
3. **`Panel` is rigid by default; `fill` is the opt-in.** A plain `<Panel>` grows with its content and pushes its pane/page to scroll (its body does *not* scroll internally). Add `fill` only to the ONE panel per pane that should be height-constrained and own an inner scroll region (sticky in-body `thead`s pin to it for free). Do not stack multiple `fill` panels in a single scroll column, and don't wrap a table in its own `overflow:auto` inside a `fill` panel body — that recreates the nested-scroll "weird scrolling". Charts/canvases (`lightweight-charts`) need a real height (a `min-height` floor when flexed) — they render blank at 0 height.
4. Reach for `Panel`, `Badge`, `Skeleton`, `StatCard` from `$components/ui/`.
5. If it needs an API client, add `src/lib/api/<feature>.ts` (typed wrapper) + `src/lib/types/<feature>.ts` (mirror of backend types).
6. Add the tab to `src/lib/components/shell/TabBar.svelte` in the right group (FKS / System) — or, better, make it a sub-page of an existing section: the nav is deliberately six sections.
7. If it talks to a new backend, add the mapping to the `hooks.server.ts` adapter (`src/lib/server/adapter.ts` routing + an `*_INTERNAL_URL` env override) — there is deliberately no vite proxy; the hook is the seam in both dev and prod. nginx config lives in the fks repo.
8. **Start polls in `onMount`, never at script top level.** A `createPoll(...).start()` at init runs during SSR too and fetches a relative URL on the server (`Cannot call fetch eagerly during server-side rendering`).

### Add a new SSE-driven feature
Pattern: `$components/tasks/LogViewer.svelte` (used by `/tasks`). `EventSource` opened lazily, `bind:this` on the container, `$effect` triggers scroll-to-tail when followed, `onscroll` handler flips follow state, optional "Jump to latest" button when paused.

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
    - **R2 `ADMIN_ONLY_MUTATION_RULES`** (non-GET only) — config/credential surfaces: the `*-keys` routes, `/api/settings/notifications`, and the same spawner stores through the passthrough (`/api/spawner/secrets`, `/api/spawner/notifications`).
    - **R2b `spawnerWriteNeedsAdmin`** — anything that could START trading real money is admin-only, decided by what would run: a spawn or saved config (`mode:"live"` or any `secrets`), a respawn or an instance start (the STORED config decides), and an instance create (`instanceNeedsAdmin`: live mode, or a template whose `secrets_allowed` is non-empty — the template decides, fetched from the spawner). It reads the body, so it runs in `proxyBackend`'s spawner branch, not in `routeRequest`, and it fails closed (bad JSON, an unknown config or an unreadable template → admin).
    - **R3** — every OTHER backend mutation is operator+ (viewer denied): stopping, restarting or deleting a task, acking an alert. Stopping is the SAFE direction, so an operator can stop a bot without admin (a live bot's Stop is still a two-step `ConfirmButton`).
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
  into a spawned bot's env via the `secrets` checkboxes on `/tasks/advanced`
  (spawner decrypts at spawn time; fks #162). **Config env is redacted on
  read** (fks-spawner #64): `GET /configs` shows credential-looking values as
  `<redacted>` and lists them in `env_redacted`; saving a config back restores
  them server-side, and a raw spawn carrying the placeholder is refused.
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
    platform publishes both (a bot's venue `updated` is SECONDS in its
    `/status`; `poll.updatedAt` and a recorder's `*_ms` stamps are
    MILLISECONDS). Mixing them does not throw — it renders an age wrong by
    1000×. Default `unit="auto"`; pass an explicit unit only when you know.
  - **Wiring + thresholds:** `AccountCard.svelte` (Home, Money) shows two
    ages — the bot-status poll (`STATUS_STALE_MS = 95_000`, three missed 30 s
    polls) and the venue's own stamp (`VENUE_STALE_MS = 540_000`). The
    underlying **300s venue cadence is
    measured, not guessed** (the live spot bot refreshes each venue every
    300s — 12 intervals across three venues, all 299–301s, 2026-07-28). The
    540s threshold (1.8× that period) **tracks the `BotVenueStale` Prometheus
    rule** rather than being fixed on its own: it was 900s (3×) to match that
    rule's original `> 900` threshold, but `fks` #244 lowered the rule to
    `> 540` — aligning it with the spawner sampler's own 600s refusal point
    (2× its 300s sample interval) — and PR #103 (2026-08-15) moved this
    constant to match, after a window where the sampler had stopped
    recording a venue and the pager had fired while the old `/exchanges` page
    still rendered it green. **This is a coupling, not an independent value:
    any future change to `BotVenueStale`'s threshold must move
    `VENUE_STALE_MS` with it**, or the screen and the pager drift out of sync
    again. An earlier 90s estimate would have cried wolf every
    cycle — pinned by `src/lib/utils/freshness.test.ts`.
  - **A bot that marks its book on TRADE EVENTS (the old paper funding bot)
    has a venue stamp that is hours old while healthy and idle — never flag
    it.** If such a bot comes back as a template, key its freshness off the
    status poll's `updatedAt`, never off the venue `updated` stamp.
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
- **Pages (six sections, 2026-10-26):**
  - **Home `/`** — one `AccountCard` per account you have set up
    (`$lib/accounts.ts`: stored keys + bot configs with an `account` + leases
    + containers), what is running, data capture, the edge ladder counts, and
    the alert inbox filtered to money/critical.
  - **Data `/data`** — recorders (`RecorderCard`: live per-stream rates from
    the recorder's `/status`, connections, a 30-day coverage calendar from the
    files scan, stop/start/delete-keeps-data) and janus candle coverage per
    coin (`/api/market/coverage`, QuestDB).
  - **Edges `/edges`** — the edge registry and backtest runs (unchanged for
    now; the ladder over `edge_experiments` / `edge_deployments` is next).
  - **Tasks `/tasks`** — every instance, saved config and stray container as
    one list (`$lib/tasks.ts`) with logs, stop/start/delete (live bots behind
    `ConfirmButton`). **`/tasks/new`** renders any template's JSON-Schema
    params as a form (`$lib/templateForm.ts`, ordered by `x-order`): Check =
    `POST /instances/validate`, Create = `POST /instances`, enabled only for
    the values just checked. **`/tasks/advanced`** is the old `/bots` console
    (raw spawn, saved configs, run history, net-worth chart).
  - **Money `/money`** — `AccountCard`s with holdings, then the treasury (the
    old `/treasury`: net worth, profit vs deposits, transfers).
  - Charts (`/charts`, `/charts/grid`; crypto quick picks), Settings (keys,
    notifications, system info), Monitoring, Docs, Users.
- **E2E suite (`tests/e2e/`, Playwright).** Hermetic: every page's backend
  reads are route-mocked (`fixtures/home.ts` mirrors oryx on 2026-10-26: one
  Kraken key, the live crypto-regime bot holding `kraken:spot:default`, the
  `btc` recorder; `fixtures/data.ts` adds the recorder's status, files scan
  and template), so the suite runs with no spawner, QuestDB or janus. Matchers
  are pathname predicates, never `**/api/**` globs (Vite serves
  `/src/lib/api/*` modules by path). The viewport spec anchors "page owns the
  only scroll / last node reachable" to Home with a TALL fixture, so the guard
  cannot pass vacuously. Run locally on Ubuntu 26.04 with
  `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64` and a private
  `WEB_E2E_PORT`.
- **No-fake-success seam (#69).** Unmapped backend **mutations** now return
  `501 not_implemented` instead of falling through to an empty `200`. This
  closed the old `/trading` order ticket reporting "BUY order submitted"
  against a stub (and trade-close, signal approve/reject, janus-ai session
  start/stop — pages since removed), which were silent no-ops by the same
  route. Unmapped **reads**
  still degrade quietly — see the "Truth & freshness" gotcha above.
- **M4 — truth primitives (#71).** `poll.updatedAt` (last *successful*
  fetch), `$lib/utils/freshness.ts` (s-vs-ms auto-detect,
  fresh/stale/unknown), and `Freshness.svelte` (own 1s ticker so the age
  counts up between fetches). Wired on `AccountCard` (status poll 95 s, venue
  stamp 540 s — tracks the `BotVenueStale` Prometheus rule, pinned to a
  **measured** 300 s venue cadence), the data page's market read, and the
  status bar's health.
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
  The coarse-pointer sweep is COMPLETE for the money path: the alert-inbox
  ack cluster (#84/#86, `AlertInbox.svelte` — 44px floor AND a 12px moat,
  because a bigger flush target is a bigger overlap with its neighbour), and
  every two-step confirm via `ConfirmButton` (#95). `/tasks/advanced` (the old
  `/bots`) Stop / Restart / force-remove all route through `ConfirmButton`,
  and a money bot (mode `live`/`dry-run`, or the legacy names) gets a named
  confirm phrase (#98); on `/tasks`, a live bot's Stop and Start are
  `ConfirmButton`s too. **Do not re-open any of these** — re-adding a bare
  `onclick` here re-creates the unconfirmed-tap failure mode this sweep
  exists to close.
- Phase-by-phase buildout detail lives in the **fks** repo at
  `docs/architecture/WEBUI_BUILDOUT_PLAN.md`. Forward roadmap (M4–M10 + an
  explicit NOT DOING list) lives at `~/github/FKS_WEB_ROADMAP_2026-07-27.md`.
