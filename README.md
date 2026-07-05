# fks-web

**SvelteKit terminal-themed trading dashboard — source code only.**

This repo contains the FKS WebUI: a 19-workspace SvelteKit 5 application with a terminal aesthetic, real-time SSE data feeds, TradingView Lightweight Charts, and a complete trading cockpit. Infrastructure (Docker, compose, CI/CD) lives in [fks](https://github.com/nuniesmith/fks).

---

## What's here

```
src/
├── routes/              # workspace pages (SvelteKit file-based routing) — janus-wired
│   ├── +page.svelte     # Overview — market table, signals, P&L strip
│   ├── trading/         # Manual trading — chart, order entry, risk calc, signals
│   ├── charts/          # Full charting (candles_crypto via /bars + /sse/data) + charts/grid
│   ├── signals/         # Live janus signals feed (/api/signals/latest)
│   ├── exchanges/       # Crypto-bot balances + net worth (+ exchanges/[exchange] per-venue detail)
│   ├── bots/            # Spawner control — spawn form (+ secrets checkboxes), saved configs, SSE logs, run history
│   ├── performance/     # PnL / performance metrics
│   ├── journal/         # Trade log, analytics, daily notes
│   ├── monitoring/      # Prometheus proxy, alert feed, PromQL runner
│   ├── settings/        # Risk controls + Kraken / KuCoin / Crypto.com API-key entry
│   ├── janus-ai/        # Brain state, strategy affinity, live signals
│   ├── db/              # Redis/Postgres/QuestDB/Janus explorer
│   ├── docs/            # Docs viewer
│   └── login/, logout/  # Auth handoff (nginx + Tailscale)
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
npm run dev          # Dev server on :5173 with API proxy to fks_ruby:8000
npm run build        # Production build
npm run preview      # Preview production build
npm run test:e2e     # Playwright E2E tests (~55 tests)
```

**API proxy** (configured in `vite.config.ts`): `/api`, `/sse`, `/bars`, `/factory`, `/kraken`, `/health` → `fks_ruby:8000`.

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

Login gate via SvelteKit `hooks.server.ts` — SHA-256 hashed password stored as `WEBUI_PASSWORD_HASH` in `.env`. Sessions are HTTP-only 7-day cookies. Dev mode bypasses auth when env vars are unset.

## Deployment

Deployed via [fks](https://github.com/nuniesmith/fks). The Dockerfile clones this repo at build time and runs `npm run build`. No Docker config lives here.

## Stats

- ~14 workspace routes, all janus / Prometheus / QuestDB-wired (the pre-split
  fks_ruby-era routes were removed; dashboard is served via `hooks.server.ts`)
- `npm run check` clean (0/0); vitest unit tests + Playwright E2E
