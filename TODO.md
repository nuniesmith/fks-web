# fks-web — TODO

> **Repo:** `github.com/nuniesmith/fks-web` (standalone — split out of `fks/src/web/`)
> **Last synced:** 2026-07-29
>
> **This file holds only micro-items.** The forward roadmap lives in
> `~/github/FKS_WEB_ROADMAP_2026-07-27.md` (stages M4–M10 plus an explicit
> **NOT DOING** list), with the robustness/integration backlog in
> `~/github/FKS_WEB_ROBUSTNESS_PLAN_2026-07-29.md`. If an item here and a
> roadmap stage disagree, the roadmap wins — put new planning there, not here.
>
> **2026-07-29 fossil sweep.** Everything below was re-checked against the
> tree. Removed: SVK-20 (`/accounts`) and SVK-21 (`/modules`), which depended
> on ACCT-*/MOD-* in **fks-ruby — a backend that no longer exists**; SVK-22,
> which planned to split `src/routes/analysis/+page.svelte` — **there is no
> `src/routes/analysis/`**; the "replace iframes" item for DOM / Positions /
> Paper Trading, whose routes were removed in the janus migration. If you are
> looking for one of those, it is gone on purpose — do not resurrect it from
> this file's history without checking the backend still exists.

---

## P0 — Codebase health

- [x] **29 pre-existing `npm run check` type errors** were closed by the
      "ci: add web + python CI workflows; fix all web type errors"
      commit. The two warnings that remained — a layout `setContext`
      "state_referenced_locally" gripe and a `<button>`-inside-`<button>`
      hydration warning on the tasks page — were closed by wrapping the
      context value in `untrack(() => …)` and refactoring the task row
      to a `role="button"` div with keyboard handlers. `npm run check`
      now reports 0 errors, 0 warnings across 270 files. *(That file count is
      the 2026-07 figure; the tree has grown since. The standing gate is
      "0 errors / 0 warnings", not a particular file count — read the live
      number off `npm run check`, and never weaken the gate to keep it.)*

---

## P0 — Visual QA (WEBUI-B)

Pruned 2026-07-29: the four `/dom` · `/posint` · `/paper-trading` · `/trainer`
redirect + standalone checks are **deleted, not deferred** — those fks_ruby-era
routes no longer exist. The primary viewport is now the **phone** (390×844),
not the desktop sizes this list was written for.

- [ ] Test all workspaces at 390×844 (the installed PWA target) — desktop
      1920×1080 / 1440×900 second
- [ ] Verify strip cells update independently
- [ ] Verify SSE reconnect + toast notifications
- [ ] Verify the responsive collapse at the **640px** breakpoint — the only one
      that exists (`StatusBar.svelte` health-dot aggregate + `Strip.svelte`).
      There is no 1024px breakpoint in `src/`; the old item named a
      breakpoint that was never implemented.
- [ ] End-to-end browser test — dashboard loads, API responds, SSE streams,
      `/cockpit` renders its sentinel + armed-path alerts

---

## P1 — New Workspaces

### SVK-18: Futures Workspace — `/futures`
> **PARTIALLY SHIPPED (differently than designed below).** `/futures` is live
> as a trading-types page: a **Rithmic capability gate**, `candles_futures`
> charting, and a **read-only Rithmic positions panel** (#33/#34 — via
> `/api/rithmic/positions`; degrades to `connected:false` while the
> `rithmic` compose profile is down / creds are unpaid). The worker-cards /
> CNN-risk / Grok-reports design below was **not** built — the backends it
> assumed (Ruby workers API, CNN scorer) are gone; keep or drop as future
> ideas against janus equivalents.
> ~~Depends on FMERGE-A/B/C (Ruby + nginx side done first)~~

- [ ] **SVK-18a:** Left pane — worker cards panel (5s poll): `GET /api/workers/status`, state badge, action buttons (Start/Stop/Restart)
- [ ] **SVK-18b:** Left pane — live signals feed (3s poll): `GET /api/signals/recent`, direction badge, CNN risk score color-coded
- [ ] **SVK-18c:** Right pane — PnL summary (10s poll): `GET /api/pnl/summary`, StatCard grid, per-asset breakdown, CSV export
- [ ] **SVK-18d:** Right pane — CNN risk status (15s poll): `GET /api/cnn/status`, risk gauge arc (0–1), per-asset signal cards
- [ ] **SVK-18e:** Right pane — trade history (30s poll): `GET /api/trades/history`, color-coded P&L, fee breakdown on expand
- [ ] **SVK-18f:** Grok AI reports tab: day/week/month tabs, `GET /api/reports/{period}`, regenerate button with spinner
- [ ] Add `/futures` to TabBar under **Trading** group

### SVK-19: Bot Manager — `/bots`

> **SHIPPED (differently than designed below).** `/bots` is live as a
> **spawner**-backed control page — spawn form with preset images + per-exchange
> secrets-injection checkboxes, saved-config templates (save/restore incl. the
> `secrets` list), per-bot CPU/mem + uptime, an SSE log viewer, run history, and
> a durable per-bot net-worth history chart (#39 — `NetWorthHistoryPanel`, one
> lightweight-charts line per bot from the spawner's db-gated `/net-worth`
> endpoint via `/api/spawner/net-worth`) —
> talking to the spawner's `/api/spawner/*` + `/api/bots/*`, not the
> `/api/bots/{id}/metrics` wizard sketched below. The 5-step-wizard /
> module-pipeline / sim→live-promotion design (SVK-19b/e/f) was **not** built;
> keep or drop those as future ideas. The core manager is done.
> Depends on SPAWN-A/B/C in fks repo

- [ ] **SVK-19a:** Header + sidebar — bot list (10s poll), accent border on selected
- [ ] **SVK-19b:** New Bot modal wizard — 5-step form: Identity → Assets → Accounts → Modules → Resources
- [ ] **SVK-19c:** Detail pane — metrics panel (5s poll): `GET /api/bots/{id}/metrics`, 6 StatCard grid
- [ ] **SVK-19d:** Detail pane — live log stream: SSE `EventSource` to `/api/bots/{id}/logs/stream`, log level filter chips
- [ ] **SVK-19e:** Detail pane — module pipeline visualizer: horizontal flow diagram, latency badges
- [ ] **SVK-19f:** Detail pane — sim→live promotion (only when SIM bot ≥7 days runtime)
- [ ] **SVK-19g:** Bot actions toolbar: Start/Stop/Restart/Delete/Clone
- [ ] Add `/bots` to TabBar under **Trading** group

*(SVK-20 `/accounts` and SVK-21 `/modules` deleted 2026-07-29 — both were
gated on ACCT-*/MOD-* work in **fks-ruby**, which is deleted. The account
registry that did survive is the spawner's, already surfaced on `/treasury`.)*

---

## P1 — Charting Enhancements

- [ ] **SVK-15b:** Binance WS integration — `@kline_1m` streams (public, no auth) — Kraken downtime fallback
- [ ] **SVK-15c:** Bybit WS integration — `kline.1.{symbol}` for Bybit-listed assets
- [x] **SVK-15d:** Multi-chart grid layout — **SHIPPED**: `/charts/grid`
      offers configurable 1×1 / 1×2 / 2×2 via `ChartGrid.svelte`
- [x] **SVK-15e:** Drawing tools — **SHIPPED**: `DrawingTools.svelte` is
      mounted in `src/routes/charts/+page.svelte`, not merely present
- [ ] Quick-pick configurable from registry categories (currently hardcoded buttons)

---

## P1 — Trading Workspace Enhancements

- [ ] Display Janus guidance in Trading workspace: take-profit/stop-adjust suggestions (JFLOW-C from fks-janus)
- [ ] Impeccable UI audit: `/audit dashboard` on Overview + Trading pages

---

## P2 — Misc Remaining

- [ ] Tab group collapse/expand for small screens
- [ ] SVK-4d remaining: symbol selector disabled-while-connected UX polish
- [ ] `/factory/status/json` endpoint audit — if only HTML variant exists, add JSON version
- [ ] Audit remaining endpoint JSON responses needed for any workspace
- [ ] Journal replay — trade replay with entry/exit chart markers
- [ ] OSS-C: Impeccable — run `/harden checkout` on the Trading order-entry form; `/normalize` on the Charts page

*(Deleted 2026-07-29: "DOM / Positions / Paper Trading: native Svelte rebuild
(replace iframes)" — all three routes were removed in the janus migration, as
the strikethroughs in the P0 list already recorded. There are no iframes left
to replace. The `/normalize` target "Analysis page" is dropped for the same
reason: `src/routes/analysis/` does not exist.)*

---

## Completed (reference)

- ✅ `/treasury` money home page (#41/#43): real net worth with carry-forward
  TOTAL + account-class grouping, profit vs deposits (`/profit`), and the
  phone-friendly record-a-transfer form over the spawner treasury endpoints
- ✅ Treasury stale-account guard (#44): carry-forward accounts whose newest
  snapshot exceeds `ACCOUNT_STALE_SECONDS` (6h) flag the headline with an
  amber "includes … from N stale accounts" annotation (never silently reduced)
- ✅ `/edges` edge-factory UI (#42): edge portfolio, backtest runs, results view
- ✅ `/workspace` dockable panel layouts (dockview-core) — last placeholder dock
  panels extracted into real ones (#35)
- ✅ Server-side saved layouts (#36): named dock layouts persist in the
  spawner's `ui_layouts` (via `/api/spawner/ui/layouts`) and follow the
  operator across devices
- ✅ Adapter hardening: request timeouts on proxy fetches, SSE-aware (#37);
  browser cookie stripped at the trust boundary (#38)
- ✅ SVK-1 through SVK-17 (all 19 workspaces, all components, all stores)
- ✅ Panel.svelte refactor (header snippet, badge, noPad, fill) + full migration across 14 pages
- ✅ All 20 pages with per-page `<title>` tags
- ✅ Playwright E2E rebuilt — 55 tests across 6 describe blocks *(count as of
  that commit; the suite has grown well past it — `npx playwright test --list`
  is the live number, and no doc should quote a fixed one)*
- ✅ News: Live SSE push (SVK-4d partial — raw EventSource, connection dot, flash animation)
- ✅ DB Explorer: Janus tab + lazy tab loading
- ✅ StatusBar reactive dots, clock, error boundary, EmbedPage component
- ✅ DRY refactor: shared types, format utils, Panel usage
