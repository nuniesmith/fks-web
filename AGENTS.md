# AGENTS.md — fks-web

SvelteKit 5 frontend for the FKS platform: a terminal-themed single-page UI (Home → Data → Edges → Tasks → Money → System) with SSE feeds and TradingView Lightweight Charts. Source code only — infrastructure (Docker, compose, CI/CD) lives in the `fks` repo, which git-clones this repo at image build time, pinned via `WEB_COMMIT`.

## Start here

- **`CLAUDE.md` in this repo is the detailed, canonical instruction file** — layout, the `hooks.server.ts` backend seam, build/test commands, component map. Read it first; this file only adds cross-cutting rules.
- Shared context: `soul.md` and `memory.md` (especially §5) in the [agents repo](https://github.com/nuniesmith/agents).

## Rules

- All backend calls are same-origin through `hooks.server.ts` — the single backend seam. `vite.config.ts` is deliberately proxy-free; don't add proxies.
- The layout follows the edge process. Edges on the ladder are research records with verdicts — the UI must never present an unproven edge as tradeable. The ladder's edges are **do not paste** into live trading without Jordan's explicit go.
- Verify with `npm run check` (svelte-check) plus the unit/E2E suites from CLAUDE.md before calling anything done; a PR is ready only when its own CI is green on its own head.
- No secrets in the client bundle: runtime config comes through `PUBLIC_*` env vars only, and nothing sensitive may be among them.
