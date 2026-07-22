# /cockpit — armed-futures co-pilot (M2)

The live-futures dashboard + kill switch for the funding-reversion bot
(`fks-state bots/crypto-futures`). Read panels + exactly ONE mutating control
(the durable kill sentinel). No order entry, no strategy config — by design.

## Data sources (per panel)

| Panel | Source | Detail |
|---|---|---|
| Kill sentinel state | Postgres `funding_kill_switch` | one row per instance (`paper` / `live`); non-null `record` = KILLED (bot semantics: presence means killed; re-arm stores JSON `null`, never a DELETE) |
| Open positions | Postgres `funding_open_trades` | key `SYM` = paper, `live:SYM` = live (durable `FR_INSTANCE` keying); the JSONB state carries `entry_t`, `dir`, `entry_px`, and the pending-close `closing` blob |
| Risk gates (session halt / breaker) | Postgres `framework_risk_state` | keys `kucoin-futures/risk/<SYM>` (paper) / `kucoin-futures-live/risk/<SYM>` (live); halt rendered rollover-aware, breaker rendered against the 3600s cooldown — same logic as the bot's own exporter |
| Session PnL (UTC day) | Postgres `funding_paper_records` | shared ledger, discriminated by the `mode` key (`live` rows → live instance, everything else → paper); close actions `exit` / `stop_exit` / `kill_exit` (mirrors `is_close_action`); closes without `net_pnl_usdt` are FLAGGED, never imputed |
| Armed-path telemetry (halt / breaker / resting-stop divergence / order errors / open notional) | Prometheus (`fks_prometheus:9090`) | the #18 `:9092` exporter series (`fks_bot_session_halt_active`, `fks_bot_circuit_breaker_tripped`, `fks_bot_resting_stop_present/expected`, `fks_bot_order_errors_total`, `fks_bot_open_positions`, `fks_bot_open_notional_usd`, `fks_bot_open_position_entry_unix`), all selected `{mode="live"}` — the scrape job (`fks-bots-risk`) only targets live funding bots |
| Unrealized ret% (paper) | the paper twin's `/status` via the existing `/api/exchanges/status` proxy | per-symbol `ret_pct` on open paper positions |
| Unrealized ret% + mark px (live) | the live twin's `/status` via `/api/cockpit/live-status` (M3 Phase A) | three-state honest feed — see "Live-twin /status feed" below; `configured:false` until the live funding bot is spawned (Gate-A ~Aug 1) |

## Honest-empty rules

- Cockpit DB not configured / funding tables absent → `configured:false` with
  a reason; panels show the outage — **never** empty-but-green.
- Prometheus unreachable → "telemetry outage" (error state).
- Prometheus reachable but zero live series → "no live bot / awaiting arm"
  (the `:9092` exporter is scraped only for `mode="live"` bots; while the bot
  is paper this is the CORRECT state, and rendering zeros would be the
  fake-success anti-pattern).
- A store error on any read → HTTP 502, not an empty 200.
- A SINGLE failed telemetry query (per-query timeout / Prometheus
  `status:"error"`) is surfaced per-query (`failed[]` in the telemetry
  payload) and rendered as an explicit "unobserved" error — never collapsed
  into the benign empty. A failed order-errors query is NOT "zero errors";
  a failed stop-expected query is NOT "no stop expected" (which would let an
  unprotected live position read benign).
- On the LIVE tab with no live bot detected, the session stat row is
  suppressed (a green `+0.00 / 0 / 0` fold of an empty ledger reads like a
  running, flat bot).

## The kill path (the money-critical control)

`POST /api/cockpit/kill` (and `POST /api/cockpit/rearm`):

1. **Session-gated** at the hooks seam (#47): `routeRequest` denies every
   backend call — reads and mutations — without a valid, fully-rotated
   session; fail-closed on an auth-store outage; CSRF origin check runs
   before dispatch. **Even `WEBUI_AUTH=disabled` refuses these two
   mutations** (403 `live_mutation_requires_auth`): the dev bypass is
   app-wide, but it must never leave a live-money kill/re-arm reachable by
   any unauthenticated tailnet client (the CSRF check passes for requests
   with no `Origin` header, so a bare `curl` would otherwise get through).
   Cockpit reads still work in disabled mode. Pinned by
   `src/lib/server/cockpitAuth.test.ts`.
2. **Typed confirmation**: the body must carry `confirm: "KILL"` (re-arm:
   `"REARM"`) exactly — case-sensitive, untrimmed — and an **explicit**
   `instance: "paper" | "live"` (no default target). Validation runs strictly
   BEFORE any store access.
3. **The write**: an upsert into the bot's own sentinel table, byte-identical
   convention to `state_store.rs`:

   ```sql
   INSERT INTO funding_kill_switch (instance, record, updated_at)
   VALUES ($instance, $record, now())
   ON CONFLICT (instance) DO UPDATE SET record = EXCLUDED.record, updated_at = now()
   ```

   with `record = {"killed": true, "reason": "webui kill by <user>[: note]", "t": <ms>}`
   (the bot's `kill::kill_record` shape). Re-arm upserts JSON `null` (read
   back as not-killed), never a row delete. **Encoding caveat**: the re-arm
   SQL inlines the literal `'null'::jsonb` — postgres.js `sql.json(null)`
   binds a wire-level SQL NULL (Bind short-circuits JS `null` before the
   jsonb serializer runs), which violates the column's `JSONB NOT NULL` and
   would make every re-arm fail with 23502. The literal is the same wire
   value the bot's own ClearKill writes (tokio-postgres,
   `serde_json::Value::Null`). Pinned by
   `src/lib/server/cockpitPgStore.test.ts`.
4. **Instance isolation**: the sentinel is `FR_INSTANCE`-keyed; killing
   `paper` can never halt `live` and vice versa. The paper dialog additionally
   warns that killing paper halts the Gate-A measurement twin.
   **FR_INSTANCE coupling (unenforced by the bot)**: the cockpit writes the
   LITERAL keys `paper`/`live`, while the bot reads its sentinel under its raw
   `FR_INSTANCE` env value (default `paper`). The deploy convention
   `FR_INSTANCE=live` for the armed twin MUST hold — a live bot deployed
   under any other value (e.g. `kucoin-live`) would never read the cockpit's
   `live` sentinel row, making KILL a silent no-op against it. The state
   endpoint surfaces sentinel rows under unexpected instance keys
   (`other_sentinel_instances`) and the UI flags them next to the kill
   switch, so such a deployment is visible rather than silently
   un-killable.
5. **Honest effect reporting**: the response (and the UI) states that the
   sentinel makes the bot refuse entries + flatten reduce-only **on its next
   live bar** (60m cadence) and stay halted across respawns — it is NOT an
   instant venue flatten; that is `live-flatten`'s venue-direct half
   (`fks-state/docs/KILL_SWITCH_DRILL_RUNBOOK.md` §0).

## Deploy configuration

- `WEBUI_FR_DATABASE_URL` — connection string for the funding bot's state
  Postgres (the value of the bot's `FR_DATABASE_URL`, through a webui-scoped
  role). Falls back to `WEBUI_DATABASE_URL` (the auth-session DB — same
  `fks_postgres`/`fks_db` on the deployed compose). Unset → the cockpit is
  honestly "not configured" and the kill routes refuse.
- The connecting role needs (grant explicitly; the default `fks_webui` role
  from AUTH_PHASE1 does NOT have these):

  ```sql
  GRANT SELECT ON funding_open_trades, funding_paper_records, framework_risk_state TO fks_webui;
  GRANT SELECT, INSERT, UPDATE ON funding_kill_switch TO fks_webui;
  ```

- If `funding_kill_switch` is absent in the connected DB (wrong database /
  bot never ran there) the cockpit reports not-configured and REFUSES to
  write a sentinel — it will not create tables or write into the wrong DB.
- Prometheus is reached via the existing `PROMETHEUS_INTERNAL_URL` seam.
- `CRYPTO_FUNDING_LIVE_INTERNAL_URL` — the LIVE funding twin's status server
  base (the live counterpart of `CRYPTO_FUNDING_INTERNAL_URL`). **EMPTY by
  default = "not configured"**, and deliberately so: it is NOT defaulted to a
  container DNS name. A wrong default that resolved to the PAPER twin
  (`fks-bot-crypto-funding:9091`) would silently render paper PnL as live —
  the exact bug this feed exists to prevent (the FR_INSTANCE parallel: the
  sentinel is instance-keyed for the same reason). Set the fks compose
  passthrough
  `CRYPTO_FUNDING_LIVE_INTERNAL_URL=${CRYPTO_FUNDING_LIVE_INTERNAL_URL:-}`
  (a separate one-line fks PR) ONLY once the live funding bot is spawned
  (Gate-A ~Aug 1), pointing at the live container (e.g.
  `http://fks-bot-crypto-funding-live:9091`).

## Live-twin /status feed (M3 Phase A)

`GET /api/cockpit/live-status` proxies the live funding twin's own `/status`
`BotStatus` document (the live counterpart of the paper `/api/exchanges/status`
feed) so the LIVE tab's Open-positions "Unrealized" column shows REAL ret% +
mark px once the bot is armed. It is **born honest** — a three-state payload
that stays distinguishable (errors are never collapsed to `{}`):

| State | Payload | Cockpit render |
|---|---|---|
| env unset | `{configured:false}` | honest `n/a`; tooltip names `CRYPTO_FUNDING_LIVE_INTERNAL_URL` to set |
| set-but-unreachable / timeout / non-`BotStatus` reply | `{configured:true, reachable:false, reason}` | amber **"status feed down"** — an armed bot whose status server died is an OUTAGE, never `n/a` |
| pointed at a PAPER document (`mode` not live-ish) | `{configured:true, reachable:true, status, mode_mismatch:true}` | red panel flag; PnL suppressed (paper-as-live trap) |
| live `BotStatus` | `{configured:true, reachable:true, status, mode_mismatch:false}` | per-symbol `ret_pct` (mark px in the title) |

Validation mirrors `/api/exchanges/status`: the reply must be a `BotStatus`
(`"bot" in j`); anything else is `reachable:false` with a reason. The
mode-mismatch guard asserts `status.mode` is live-ish (`isLiveMode`) — pointing
the env at the paper container is flagged, not rendered as live PnL. A symbol
present in `funding_open_trades` (state of record) but absent from the live
`/status` positions renders "not in /status feed" — the DB row is the source of
existence, `/status` only enriches. No fake USD sum is derived (`/status`
carries no per-position notional).

## Deferred (scope discipline)

- Spawner respawn button + live-spawn friction (tracked separately in the
  fks-web survey recs).

(Shipped since this list was first written: the live-twin `/status` feed
(M3 Phase A, above) and the alert-acknowledgement inbox (M3 Phase B) — the
`/monitoring` page is no longer read-only, it carries the ack mutation.)
