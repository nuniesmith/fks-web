# /cockpit — armed-futures co-pilot (M2)

The live-futures dashboard + kill switch for the funding-reversion bot
(`fks-state bots/crypto-futures`). Read panels + **two** mutating controls:
the durable kill sentinel (`POST /api/cockpit/kill` · `/rearm`) and the
armed-path **alert acknowledgement** (`POST /api/alerts/ack`, via the mounted
`AlertInbox` — M3 Phase B). No order entry, no strategy config — by design.

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
| Armed-path alerts (+ inline Ack) | Prometheus `/api/v1/alerts` via `GET /api/alerts/inbox`, LEFT-JOINed to the Postgres `webui_alert_acks` table | shared with `/monitoring` + the StatusBar chip (one poll, three surfaces). Which alerts render is the **three-clause** `isArmedAlert` filter — see "Which alerts reach this panel" below. Missing table/grants ⇒ `configured:false`: the inbox still shows live alerts, read-only, never fake-quiet |
| Feed age (M4) | the cockpit state poll's own `updatedAt` | a `Freshness` indicator beside the sentinel badge; amber past `STATE_STALE_AFTER_MS` (15s). It is the age of the **successful** fetch, so a dead poll counts up instead of freezing — the panels below it are only as true as this number |

## Which alerts reach this panel

`isArmedAlert` (`src/routes/cockpit/+page.svelte`) renders an alert if **ANY**
of three clauses matches. All three are load-bearing; do not collapse them.


1. `labels.mode === 'live'` — the rule explicitly stamps the live twin.
2. `labels.channel === 'money'` — **do not remove.** Several money-path rules
   aggregate the `mode` label away and can never match clause 1:
   `BotAllVenuesStale` is `count by (bot_id) (…)`, and
   `NetWorthSamplingPausedTooLong` is `increase(…_stale_skipped_total[30m])`.
   With only clauses 1+3, the CRITICAL `BotAllVenuesStale` ("ALL real-money
   venues stale — bot is blind") was filtered **out** of the cockpit while its
   per-venue WARNING sibling was shown. This clause also catches
   `BotVenueStale` on a **`dry-run`** venue — dry-run is REAL money (real
   balances, no orders), and the venue rules select `{mode!="paper"}`. It
   self-maintains: all four rules in the `bot-venue-freshness` group of
   `fks/infrastructure/config/prometheus/alerts/bot-alerts.yml` stamp
   `channel: money`, so new ones arrive here with no webui edit.
3. `ARMED_ALERTNAMES.has(labels.alertname)` — a hand-maintained allowlist
   mirroring `armed-path.yml` + `crash-supervision.yml`, for live rules that
   stamp neither label. Keep it in sync when those files change.

**Blast radius of an Ack, stated accurately:** there is **no Alertmanager
integration in `src/`**. An ack silences the webui inbox + the StatusBar chip
only; Alertmanager keeps firing and out-of-band paging is unaffected, and the
alert re-surfaces here under a new `activeAt` (incident identity is
`sha256(labels + activeAt)`, pinned by `alertAck/logic.test.ts`). Acks are
irrevocable rows — there is no un-ack.

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
   before dispatch. **`WEBUI_AUTH=disabled` refuses a named list of NINE
   paths** (403 `live_mutation_requires_auth`) — the cockpit's kill and
   re-arm are on it, which is why this page stays safe under the bypass.
   It is NOT a blanket money-path block: every other backend mutation still
   proxies, including `/api/spawner/spawn` and `DELETE
   /api/spawner/container/{id}` (which can force-remove the LIVE spot bot).
   Pinned by `adapter.test.ts` ("keeps unrelated backend mutations proxying
   in disabled mode"). The CSRF check passes for requests with no `Origin`
   header, so a bare `curl` reaches everything outside those nine.
   The blocked set is **not** just kill/re-arm — it also covers
   `/api/alerts/ack` (silencing an armed-path page), `/api/settings/risk`,
   `/api/settings/exchange-keys` (+ its per-exchange DELETE and the three
   legacy `{kraken,kucoin,cryptocom}-keys` routes) and
   `/api/settings/notifications` (+ its channel DELETE/test). **The
   authoritative list is `AUTH_DISABLED_BLOCKED_MUTATIONS` in
   `src/lib/server/adapter.ts` — read it before concluding a 403 in disabled
   mode is a bug.** It is the guard working; removing it to "fix" a dev 403
   deletes a live-money wall. Cockpit reads still work in disabled mode.
   Pinned by `src/lib/server/cockpitAuth.test.ts`.
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
  -- Alert-ack inbox (M3 Phase B). NO UPDATE/DELETE by design — acks are
  -- irrevocable audit rows. The sequence grant is required: without it the
  -- INSERT fails on the serial id even though the table grant is present.
  GRANT SELECT, INSERT ON webui_alert_acks TO fks_webui;
  GRANT USAGE, SELECT ON SEQUENCE webui_alert_acks_id_seq TO fks_webui;
  ```

- **Migration `011_webui_alert_acks.sql` creates that table.** It is baked into
  the postgres image as `/docker-entrypoint-initdb.d/34-webui-alert-acks.sql`,
  so a **fresh volume** gets it automatically — but initdb scripts do not run
  on an existing volume, so an already-deployed host needs it applied **once,
  by hand**. It is existence-guarded, so a re-run is a no-op. Run from the
  **`fks` repo root**; copied verbatim from 011's own header (note
  `-d postgres`, **not** the `-d fks_db` that `AUTH_PHASE2.md` uses for 012:
  this script does `\getenv fks_db RUBY_DB` then `\connect :fks_db` itself,
  which needs `RUBY_DB` present in the `fks_postgres` container env — it is,
  on the deployed compose):

  ```
  docker exec -i fks_postgres \
    sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres' \
    < src/sql/spawner/011_webui_alert_acks.sql
  ```

  Until it is applied, the failure mode is **honest degradation, never a
  lie**: the webui probes `to_regclass('public.webui_alert_acks')` and reports
  `configured:false`, so the armed-path panel still renders every live
  Prometheus alert — read-only, with Ack unavailable. It never fake-quiets and
  never runs the DDL itself (the scoped `fks_webui` role has no CREATE).
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
(M3 Phase A, above), the alert-acknowledgement inbox (M3 Phase B) — mounted on
BOTH `/monitoring` and `/cockpit`, which is why the header above says two
mutating controls, not one — and the M4 feed-age indicator.)
