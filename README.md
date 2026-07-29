# fks-web

**SvelteKit terminal-themed trading dashboard — source code only.**

This repo contains the FKS WebUI: a 17-workspace SvelteKit 5 application with a terminal aesthetic, real-time SSE data feeds, TradingView Lightweight Charts, and a complete trading cockpit. Infrastructure (Docker, compose, CI/CD) lives in [fks](https://github.com/nuniesmith/fks).

---

## What's here

```
src/
├── routes/              # workspace pages (SvelteKit file-based routing) — janus-wired
│   ├── +page.svelte     # Overview — market table, signals, P&L strip
│   ├── trading/         # Manual trading — chart, order entry, risk calc, signals
│   ├── charts/          # Full charting (candles via /bars + /sse/bars) + charts/grid
│   ├── signals/         # Live janus signals feed (/api/signals/latest)
│   ├── exchanges/       # Crypto-bot balances + net worth (+ exchanges/[exchange] per-venue detail)
│   ├── treasury/        # Money home — net worth (carry-forward + stale-account flag), profit vs deposits, transfer entry
│   ├── futures/         # Trading types — Rithmic capability gate, candles_futures charts, read-only positions
│   ├── cockpit/         # Armed-futures co-pilot — kill sentinel + armed-path alert ack (docs/COCKPIT.md)
│   ├── edges/           # Edge factory — edge portfolio, backtest runs, results view
│   ├── workspace/       # Dockable panel layouts (dockview-core) + named layouts saved server-side
│   ├── bots/            # Spawner control — spawn form (+ secrets checkboxes), saved configs, SSE logs, run history, net-worth history
│   ├── performance/     # PnL / performance metrics
│   ├── monitoring/      # Prometheus proxy, alert feed + alert-ack inbox, PromQL runner
│   ├── settings/        # Risk controls + Kraken / KuCoin / Crypto.com API-key entry
│   ├── janus-ai/        # Brain state, strategy affinity, live signals
│   ├── users/           # Admin console (R1/R5 admin-only) — create/disable/role/reset/revoke + auth audit
│   ├── db/              # Redis/Postgres/QuestDB/Janus explorer (not in TabBar)
│   ├── journal/         # Trade log, analytics, daily notes (not in TabBar)
│   ├── docs/            # Docs viewer
│   └── login/, logout/, setup/, invite/[token]/  # DB-backed auth — login, session revoke, forced first-login change, one-time signup
├── lib/
│   ├── components/
│   │   ├── shell/       # TabBar, Strip (SSE), StatusBar
│   │   └── ui/          # Panel, Badge, Table, Modal, StatCard, MiniChart, DrawingTools, ...
│   ├── stores/          # poll.ts, sse.ts, strip.ts, focusSymbol.ts
│   ├── api/             # Typed fetch wrapper (api.get/post/put/delete)
│   ├── types/           # Shared TypeScript interfaces
│   └── utils/           # format.ts (fmtPrice, fmtPct, fmtDollar, scoreColor, ...)
└── styles/
    └── tokens.css       # Full terminal design token system
```

## Stack

- **SvelteKit 2** + **Svelte 5** (runes) + **TypeScript** + **Vite 6**
- **adapter-node** for Docker deployment
- **lightweight-charts v4** (TradingView) — imported directly, no iframe
- **Playwright** for E2E tests

## Design system

Terminal-themed: dark background, monospace fonts, cyan/green accent palette. All design tokens in `src/styles/tokens.css`. Component library: `Panel`, `Badge`, `Table`, `StatCard`, `Modal`, `FilterChips`, `InnerTabs`, `EmbedPage`, `MiniChart`, `DrawingTools`, `ProgressBar`, `Skeleton`.

## Development

```bash
npm install
npm run dev          # Dev server on :5173 (backend calls go through hooks.server.ts)
npm run build        # Production build
npm run preview      # Preview production build
npm run test:e2e     # Playwright E2E tests
```

**Backend adapter** (`src/hooks.server.ts` — no vite proxies, the hook is the seam in dev and prod): `/api`, `/sse`, `/bars`, `/factory` map to janus / the spawner / Prometheus / QuestDB (override upstreams via `*_INTERNAL_URL` env vars for dev outside Docker). Unmapped **reads** return an empty `200` (`gracefulEmpty`); unmapped **mutations** return **`501 not_implemented`** — degrading a write to an empty 200 is a fake success, so it is refused loudly. `/kraken` and `/fapi` are dead prefixes: they are still in `BACKEND_PREFIXES` (so they are auth-gated) but no dispatch exists for either, so they always fall through — the `/fapi` FastAPI was removed in the janus migration.

## Key patterns

**SSE store:**
```ts
import { createSSE } from '$lib/stores/sse'
const strip = createSSE<StripData>('/sse/strip')
```

**Poll store:**
```ts
import { createPoll } from '$lib/stores/poll'
const scores = createPoll<ScoreData[]>('/api/pipeline/scores/json', 30_000)
```

**API client:**
```ts
import { api } from '$lib/api/client'
const result = await api.post('/api/trades', payload)
```

## Auth

DB-backed sessions with a fail-closed seam at `hooks.server.ts` (Phase 1) plus
role-based access control enforced at the `routeRequest` decision core
(Phase 2A — `viewer < operator < admin`). On first startup a single `admin` is
bootstrapped with a CSPRNG password **printed once** to the container log and a
forced first-login credential change; passwords are **scrypt** (`node:crypto`,
per-user salt), sessions are opaque tokens stored as `sha256(token)` in the
HTTP-only `fks_session` cookie (revocable, 7d idle / 30d absolute). The old
unsalted-`WEBUI_PASSWORD_HASH` gate is gone. Explicit `WEBUI_AUTH=disabled` is
the only (loud, dev-only) bypass. It refuses a **named list of nine paths**,
not just kill/re-arm: alert-ack, risk config, exchange keys (incl. the legacy
per-venue `*-keys` routes) and notification channels are 403'd too.
It is **not** a blanket money-path block — every other backend mutation still
proxies in disabled mode, including the spawner lifecycle routes
(`/api/spawner/spawn`, `container/{id}/stop|restart`, `DELETE container/{id}`)
and the treasury writes (`/api/spawner/transfers`, `/net-worth`). That is pinned
by `adapter.test.ts` ("keeps unrelated backend mutations proxying in disabled
mode"). Treat `WEBUI_AUTH=disabled` as *unauthenticated for everything except
those nine*, and never run it where a live bot is reachable. `AUTH_DISABLED_BLOCKED_MUTATIONS` in `src/lib/server/adapter.ts` is the
authoritative list — read it before concluding a 403 in disabled mode is a bug.
**A 403 there is the guard working, not a defect to remove.** Full runbook in
`docs/AUTH_PHASE1.md`; the permission model + role recovery is
`docs/AUTH_PHASE2.md`.

## Deployment

Deployed via [fks](https://github.com/nuniesmith/fks). The Dockerfile clones this repo at build time and runs `npm run build`. No Docker config lives here.

## Stats

- 17 workspace routes (TabBar nav destinations — the tree above also lists
  non-nav routes like `db/` and `journal/`), all janus / Prometheus / QuestDB /
  spawner-wired (the pre-split fks_ruby-era routes were removed; the backend
  seam is `hooks.server.ts`)
- `npm run check` clean (0/0); vitest unit tests + Playwright E2E
