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
| Unrealized ret% (paper only) | the paper twin's `/status` via the existing `/api/exchanges/status` proxy | the live twin's status server is not proxied yet (deferred) |

## Honest-empty rules

- Cockpit DB not configured / funding tables absent → `configured:false` with
  a reason; panels show the outage — **never** empty-but-green.
- Prometheus unreachable → "telemetry outage" (error state).
- Prometheus reachable but zero live series → "no live bot / awaiting arm"
  (the `:9092` exporter is scraped only for `mode="live"` bots; while the bot
  is paper this is the CORRECT state, and rendering zeros would be the
  fake-success anti-pattern).
- A store error on any read → HTTP 502, not an empty 200.

## The kill path (the money-critical control)

`POST /api/cockpit/kill` (and `POST /api/cockpit/rearm`):

1. **Session-gated** at the hooks seam (#47): `routeRequest` denies every
   backend call — reads and mutations — without a valid, fully-rotated
   session; fail-closed on an auth-store outage; CSRF origin check runs
   before dispatch. Pinned by `src/lib/server/cockpitAuth.test.ts`.
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
   back as not-killed), never a row delete.
4. **Instance isolation**: the sentinel is `FR_INSTANCE`-keyed; killing
   `paper` can never halt `live` and vice versa. The paper dialog additionally
   warns that killing paper halts the Gate-A measurement twin.
5. **Honest effect reporting**: the response (and the UI) states that the
   sentinel makes the bot refuse entries + flatten reduce-only **on its next
   live bar** (60m cadence) and stay halted across respawns — it is NOT an
   instant venue flatten; that is `live-flatten`'s venue-direct half
   (`fks-state/docs/KILL_SWITCH_DRILL_RUNBOOK.md` §0).

## Deploy configuration

- `WEBUI_FR_DATABASE_URL` — connection string for the funding bot's state
  Postgres (the value of the bot's `FR_DATABASE_URL`, through a webui-scoped
  role). Falls back to `WEBUI_DATABASE_URL` (the auth-session DB — same
  `fks_postgres`/`ruby_db` on the deployed compose). Unset → the cockpit is
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

## Deferred (scope discipline)

- Alert acknowledgement inbox (`/monitoring` stays read-only).
- Live twin `/status` proxy (unrealized PnL for the live instance).
- Spawner respawn button + live-spawn friction (tracked separately in the
  fks-web survey recs).
