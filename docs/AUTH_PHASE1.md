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
| `WEBUI_DATABASE_URL` | **yes** (unless `WEBUI_AUTH=disabled`) | `postgres://fks_webui:${WEBUI_DB_PASSWORD}@fks_postgres:5432/ruby_db` |
| `INTERNAL_TOKEN` | recommended | service-identity token minted to the spawner. Set `INTERNAL_TOKEN=${NGINX_INTERNAL_TOKEN}` (falls back to `NGINX_INTERNAL_TOKEN` if unset) |
| `WEBUI_BOOTSTRAP_PASSWORD` | optional | if set, the bootstrap admin uses it (NOT printed). If unset, a CSPRNG password is generated and **printed once** to the log |
| `WEBUI_AUTH` | optional | set to `disabled` for the explicit, loud dev bypass **only**. Anything else = enforce |
| `WEBUI_TRUST_FORWARDED_FOR` | optional | `1`/`true` to key the login rate-limiter + audit IP off `X-Real-IP`/`X-Forwarded-For`. **Default off** — the socket peer (`getClientAddress()`) is the unspoofable anchor. Enable ONLY when the webui is reachable **exclusively** through a proxy that overwrites those headers (prefer adapter-node `ADDRESS_HEADER`). On a direct `:3001` path these headers are attacker-set |
| `WEBUI_SESSION_CACHE_TTL_MS` | optional | resolve-cache TTL (default `60000`). Set `0` on **multi-replica / clustered** deploys so a logout / disable / forced-change is DB-authoritative immediately on every worker instead of surviving up to the TTL per process |

Removed from use: `WEBUI_PASSWORD_HASH`, `WEBUI_SESSION_SECRET` (the old
unsalted-SHA-256 / cookie==secret gate is deleted — no dual path).

## Deploy steps (operator does the first-login flow post-deploy)

1. **DB role + schema.** Apply `src/lib/server/auth/schema.sql` to `ruby_db`
   (idempotent `CREATE … IF NOT EXISTS`) — copy it to
   `fks/src/sql/spawner/010_webui_auth.sql` and create the scoped `fks_webui`
   LOGIN role per the header comment (009_backtest_role.sql pattern; empty
   `WEBUI_DB_PASSWORD` → role can't log in = fail closed).

   > **This manual step is REQUIRED for the least-privilege deploy — it is NOT
   > optional.** The scoped `fks_webui` role is granted DML only, **not** CREATE
   > on schema `public`, so it *cannot* create the tables itself. The app's
   > startup migration therefore runs the DDL **only when the tables are absent**
   > and otherwise skips it (so a properly pre-migrated DB just works); but if you
   > point the scoped role at a DB where the tables were never created, startup
   > has no way to create them and the UI fails closed. Either pre-create the
   > tables here (recommended), or run the migration once as a role that *does*
   > hold CREATE.
2. **Compose env.** Add `WEBUI_DATABASE_URL` and `INTERNAL_TOKEN=${NGINX_INTERNAL_TOKEN}`
   to the `fks_webui` service; add `WEBUI_DB_PASSWORD` to `fks/.env`.
3. **Redeploy the webui** (repin `WEB_COMMIT`, rebuild). Nothing else in the stack
   restarts.
4. **Grab the bootstrap password ONCE:**
   ```
   docker logs fks_webui 2>&1 | grep -A6 "FIRST-RUN BOOTSTRAP"
   ```
5. **First login** at the webui with `admin` + that password → you are forced to
   `/setup` to choose your own username + a ≥12-char password. The bootstrap
   credential is retired the moment you save (all other sessions revoked).

## `fks`-repo companion changes (§4.1a — not in this repo)

- **Retire nginx's direct `/api/spawner/` location** so it routes to the webui
  backend like everything else. The adapter already maps `/api/spawner/*`; this
  makes the session-checked adapter the single seam (closes F2). `/ws/`→janus can
  stay until janus gets its own bearer.
- nginx's blanket `X-Internal-Token` injection becomes redundant for webui-bound
  locations (the adapter now injects it) and can be removed location-by-location;
  harmless in the interim because the adapter strips the inbound copy and re-mints
  its own.

## Layer coexistence (token vs session)

- `X-Internal-Token` = **service identity** ("came through the session-checked
  adapter / front door"). The spawner keeps fail-closing on it.
- `fks_session` = **human identity** ("which authenticated user is acting").
- Tailscale/loopback = **reachability** (unchanged outer wall).
These are independent; none replaces another.

## Solo-operator recovery (locked out / forgot password)

Loopback + SSH is always the recovery channel. Reset via `psql` to `ruby_db`:

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
files. Run `schema.sql` by hand against a staging `ruby_db` before the first
production deploy to confirm the scoped-role grants.
