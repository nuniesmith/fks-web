# fks-web Auth — Phase 1 deploy runbook

Implements Phase 1 of `research-2026-07-17/design-user-management.md`: default-admin
bootstrap, forced first-login credential change, scrypt hashing, DB-backed
revocable sessions, login rate-limit/lockout, and a **fail-closed** auth seam.
Single-user by default; **open-source-safe** — a fresh clone ships **no usable
known credential**.

## What changed in this repo (fks-web)

- `src/lib/server/auth/*` — the auth module (hash, tokens, policy, store, service,
  pg/memory stores, rate-limit, wiring). Pure logic is unit-tested against an
  in-memory store; `PgStore` is the production store.
- `src/lib/server/adapter.ts` — `routeRequest` now takes `(pathname, search,
  method, AuthState)` and returns `unauthorized`/`forbidden` in addition to
  `backend`/`pass`/`redirect`. Added `originAllowed` (CSRF) and put
  `x-internal-token` + `authorization` in the strip set.
- `src/hooks.server.ts` — resolves the session, enforces the decision, injects the
  service `X-Internal-Token` on outbound proxy calls, and **fails closed** if the
  auth store is unreachable (health probes excepted).
- `src/routes/login`, `src/routes/logout`, **`src/routes/setup`** — real
  username+password login, server-side session revoke, forced-change screen.

## New environment (webui service)

| Var | Required? | Meaning |
|---|---|---|
| `WEBUI_DATABASE_URL` | **yes** (unless `WEBUI_AUTH=disabled`) | `postgres://fks_webui:${WEBUI_DB_PASSWORD}@fks_postgres:5432/fks_db` (the platform DB, **renamed from `ruby_db` 2026-07-21**; the fks-side env var name stays `RUBY_DB` for now) |
| `INTERNAL_TOKEN` | recommended | service-identity token minted to the spawner. Set `INTERNAL_TOKEN=${NGINX_INTERNAL_TOKEN}` (falls back to `NGINX_INTERNAL_TOKEN` if unset). **Must be non-empty for the /settings key-rotation + notification surfaces**: post-#47 the adapter mints this on every spawner call (secrets/notifications/capabilities + the /bots page); an empty token = spawner 401 (auth-chain H5) |
| `HOST_HEADER` | **yes, behind nginx** | `host` — adapter-node takes the app-origin host from nginx's forwarded `Host` ($host = the tailnet hostname), not the internal container name, so SvelteKit's form-CSRF origin check accepts the login POST from the real tailnet hostname |
| `PROTOCOL_HEADER` | **leave UNSET behind nginx** | **Do NOT set it.** nginx is HTTP-only behind tailscale (`listen 80`; health reports `"ssl":"off"`) and stamps `X-Forwarded-Proto $scheme` = `http` on every webui location, so `PROTOCOL_HEADER=x-forwarded-proto` would feed `http` into `get_origin()` → app origin `http://<host>` ≠ the browser's `https://<host>` → **login POST 403s as cross-site** (auth-chain M1/M7 — the earlier `x-forwarded-proto` wiring re-created this). Unset, `get_origin()` defaults the scheme to `https` (the true external scheme, since tailscale always terminates TLS). Do NOT set `ORIGIN` either — it overrides `HOST_HEADER` and a static `ORIGIN=http://localhost:3001` re-403s the login. Guard: `fks/scripts/testing/verify_webui_csrf_origin.py` |
| `ADDRESS_HEADER` | recommended, behind nginx | `X-Real-IP` — makes `getClientAddress()` the true client IP so the per-IP login limiter + audit log don't collapse to one global bucket at the nginx container IP (auth-chain M8). Preferred over `WEBUI_TRUST_FORWARDED_FOR` |
| `WEBUI_BOOTSTRAP_PASSWORD` | optional | if set, the bootstrap admin uses it (NOT printed). If unset, a CSPRNG password is generated and **printed once** to the log |
| `WEBUI_AUTH` | optional | set to `disabled` for the explicit, loud dev bypass **only**. Anything else = enforce |
| `WEBUI_TRUST_FORWARDED_FOR` | optional | `1`/`true` to key the login rate-limiter + audit IP off `X-Real-IP`/`X-Forwarded-For`. **Default off** — the socket peer (`getClientAddress()`) is the unspoofable anchor. Enable ONLY when the webui is reachable **exclusively** through a proxy that overwrites those headers (prefer adapter-node `ADDRESS_HEADER`). On a direct `:3001` path these headers are attacker-set |
| `WEBUI_SESSION_CACHE_TTL_MS` | optional | resolve-cache TTL (default `60000`). Set `0` on **multi-replica / clustered** deploys so a logout / disable / forced-change is DB-authoritative immediately on every worker instead of surviving up to the TTL per process |

Removed from use: `WEBUI_PASSWORD_HASH`, `WEBUI_SESSION_SECRET` (the old
unsalted-SHA-256 / cookie==secret gate is deleted — no dual path).

## Deploy steps (operator does the first-login flow post-deploy)

1. **DB role + schema.** The companion `fks` PR now ships this as a **baked
   initdb script** — `fks/src/sql/spawner/010_webui_auth.sql` (copied into the
   postgres image as `33-webui-auth.sql`, 009_backtest_role.sql pattern). It
   creates the three `webui_*` tables **and** the scoped `fks_webui` LOGIN role
   (empty `WEBUI_DB_PASSWORD` → role can't log in = fail closed). The sequence
   grant is scoped to the three `webui_*_id_seq` sequences by name (not `ALL
   SEQUENCES` — auth-chain L2).
   - **Fresh host / volume loss:** nothing to do — initdb runs `010` automatically.
   - **Existing live volume** (initdb only runs on an EMPTY volume): apply it by
     hand ONCE, with the password in the exec env:
     ```
     docker exec -i -e WEBUI_DB_PASSWORD="$WEBUI_DB_PASSWORD" \
       fks_postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres' \
       < src/sql/spawner/010_webui_auth.sql
     ```

   > **The tables must exist before the scoped role connects.** `fks_webui` is
   > granted DML only, **not** CREATE on schema `public`, so it *cannot* create
   > the tables itself. The app's startup migration runs the DDL **only when the
   > tables are absent** and otherwise skips it (so a pre-migrated DB just works);
   > but if you point the scoped role at a DB where the tables were never created,
   > startup has no way to create them and the UI fails closed. `010` (baked or
   > hand-applied) is what guarantees they exist.
2. **Compose env.** The companion `fks` PR already wires the `fks_webui` service:
   `WEBUI_DATABASE_URL`, `INTERNAL_TOKEN=${NGINX_INTERNAL_TOKEN}`,
   `HOST_HEADER=host` with `PROTOCOL_HEADER` and `ORIGIN` deliberately UNSET
   (M1/M7 — so `get_origin()` resolves `https://<tailnet-host>`, not the
   nginx-`$scheme`-poisoned `http://…`), `ADDRESS_HEADER=X-Real-IP` (M8); and
   passes `WEBUI_DB_PASSWORD`
   through to the postgres service for `010`. **Operator action:** set
   `WEBUI_DB_PASSWORD` and `NGINX_INTERNAL_TOKEN` in `fks/.env` (both must be
   non-empty, or the webui fails closed / spawner calls 401 respectively).
3. **Redeploy the webui** (repin `WEB_COMMIT` to the #47-or-later tip, rebuild).
   Nothing else in the stack restarts.
4. **Grab the bootstrap password ONCE** (the banner prints lazily on the FIRST
   request that resolves auth, not at container start — hit the site once first):
   ```
   curl -s -o /dev/null http://localhost:3001/     # trigger the lazy bootstrap
   docker logs fks_webui 2>&1 | grep -A6 "FIRST-RUN BOOTSTRAP"
   ```
5. **First login through the REAL access path** (the tailnet hostname over nginx,
   **not** `localhost:3001` — the CSRF origin check depends on it): `admin` + the
   bootstrap password → forced `/setup` → choose your own username + a ≥12-char
   password (bootstrap credential retired on save, all other sessions revoked).

   > **M1/M7 gate — do this BEFORE trusting the deploy.** A localhost login masks
   > the CSRF-origin bug (it only bites when the browser `Origin` is `https://` and
   > the app origin computes `http://`). Reproduce the *browser's* login POST from
   > the box, with the real tailnet Host and an `https` Origin, and confirm it is
   > **not** 403'd as cross-site:
   > ```
   > TS_HOST=oryx.tailfef10.ts.net   # the real tailnet hostname
   > curl -s -o /dev/null -w '%{http_code}\n' -X POST \
   >   -H "Host: $TS_HOST" \
   >   -H "Origin: https://$TS_HOST" \
   >   -H 'Content-Type: application/x-www-form-urlencoded' \
   >   --data 'username=__probe__&password=__probe__' \
   >   http://127.0.0.1:80/login
   > ```
   > **403 = M1/M7 still broken** (app origin ≠ browser origin — check that the
   > webui has `PROTOCOL_HEADER`/`ORIGIN` UNSET and `HOST_HEADER=host`). Any other
   > status (400/401/429 — the action ran and rejected the bogus creds) = the
   > origin check PASSED and login works on the tailnet HTTPS path. The static
   > config invariant is also guarded offline by
   > `fks/scripts/testing/verify_webui_csrf_origin.py`.
6. **Verify the seams before calling the deploy done** (the runbook previously had
   no verification step): key-status page loads → **one exchange-key save
   round-trip** (exercises H5 — the spawner call now carries the minted token) →
   `/bots` page renders → one janus risk-config save (clears the M12 interim 401).

## `fks`-repo companion changes (§4.1a — shipped in the companion `fks` PR)

- **Schema + role + compose env**: `010_webui_auth.sql` (baked initdb) and the
  `fks_webui` service env (steps 1–2 above). These are the H7 companion wiring.
- **Retire nginx's direct `/api/spawner/` location (auth-chain H6)** — done in the
  companion PR, in a **separate commit** to be applied **AFTER** the webui #47
  deploy verifies (step 6). Before retirement, `/api/spawner/*` proxied straight
  to `fks_bot_spawner:8090` with an nginx-stamped token and **zero human auth**
  (tailnet-only, drive-by-CSRF-able). After: every spawner call falls through to
  `location /api/` → the webui → the session-checked adapter → `forward()`'s
  re-minted token — the single seam (closes F2).
  - **SSE carve-out kept**: a regex `location ~ ^/api/spawner/container/[^/]+/logs$`
    → the webui adapter (`fks_webui:3000`), unbuffered + 3600s, because the
    `/api/` catch-all's default buffering + 120s read timeout would stall/sever
    the bot-log stream. The adapter's `forward()` is already SSE-aware (no
    timeout when `accept: text/event-stream`), so the stream stays open through
    the session-checked path. **Verify bot log streaming still works after
    retiring the block.**
  - **✅ dev.conf — the ACTIVE vhost — now completed (H6 fully closed)**:
    `infrastructure/config/nginx/conf.d/dev.conf` is `listen 80 default_server`
    with a catch-all `server_name _`, so the tailnet Host (which matches no
    explicit `server_name`) is served by THIS vhost — **not**
    `fkstrading.xyz.conf`, whose HTTPS block never binds without local certs.
    #217 fixed H6 on the **inactive** `fkstrading.xyz.conf`; the companion `fks`
    PR *"complete H6 on the active vhost (dev.conf)"* mirrors it here. dev.conf
    carried **two** direct bypasses — `location /api/bots/` **and**
    `location /api/spawner/` (each → `fks_bot_spawner:8090` with an nginx-stamped
    token and zero human auth) — **both retired**, along with the now-orphaned
    `@spawner_unavailable` fallback, and the same SSE carve-out regex
    (`location ~ ^/api/spawner/container/[^/]+/logs$` → `fks_webui:3000`,
    unbuffered + 3600s) added. Both `/api/spawner/*` and `/api/bots/*` now fall
    through to `location /api/` → the session-checked webui adapter.
  - **Pre-check that gated the dev.conf retirement**: the webui adapter proxies
    `/api/spawner/*` as a **real passthrough** (`hooks.server.ts` `routeBackend`
    → `forward(SPAWNER_URL)`, which re-mints the service token) — verified at
    `hooks.server.ts:962-966` — and the `/bots` page + `BotsPanel` call
    `/api/spawner/*` **exclusively** (`src/lib/api/spawner.ts` `BASE =
    "/api/spawner"`), **never** `/api/bots/*`. The adapter does **not** proxy
    `/api/bots/*` (it falls to `gracefulEmpty` → an empty stub), but nothing in
    the webui calls it, so retiring the `/api/bots/` bypass closes a **dead**
    unauthenticated hole and breaks nothing. Same **DEPLOY ORDER**: apply the
    dev.conf change only **AFTER** the webui #47 deploy verifies.
- nginx's blanket `X-Internal-Token` injection becomes redundant for webui-bound
  locations (the adapter strips the inbound copy and re-mints its own) and can be
  removed location-by-location later; harmless in the interim.

## Layer coexistence (token vs session)

- `X-Internal-Token` = **service identity** ("came through the session-checked
  adapter / front door"). The spawner keeps fail-closing on it.
- `fks_session` = **human identity** ("which authenticated user is acting").
- Tailscale/loopback = **reachability** (unchanged outer wall).
These are independent; none replaces another.

## Solo-operator recovery (locked out / forgot password)

Loopback + SSH is always the recovery channel. Reset via `psql` to `fks_db`:

```sql
-- Wipe sessions and re-arm a forced-change bootstrap on the admin.
-- Then restart fks_webui: with the users table now "empty of usable creds"
-- you can instead simply TRUNCATE webui_users and let startup re-bootstrap,
-- grabbing the new password from the log:
TRUNCATE webui_sessions;
DELETE FROM webui_users;          -- next startup re-bootstraps + logs a new pw
```

(Or keep the row and set `must_change_credentials=TRUE` + a known scrypt hash you
generate out-of-band — but the truncate-and-rebootstrap path reuses the audited
bootstrap machinery and needs no hand-rolled hash.)

## Known limitation

`PgStore` is exercised via typecheck + a MemoryStore mirror in the test suite; it
was not run against a live Postgres in this change's CI (no DB in the build
sandbox). The SQL is standard idempotent DDL matching the sibling `spawner/00x`
files. Run `schema.sql` by hand against a staging `fks_db` before the first
production deploy to confirm the scoped-role grants.
