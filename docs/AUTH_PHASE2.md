# fks-web Auth — Phase 2: multi-user, roles, invites

Phase 2 of `research-2026-07-17/design-user-management.md`. Builds directly on
[`AUTH_PHASE1.md`](./AUTH_PHASE1.md) (bootstrap admin, scrypt, DB-backed
revocable sessions, fail-closed seam) — **nothing here changes bootstrap**. It
adds: role enforcement at the single decision seam, an admin `/users` console
(create / disable / role / reset / revoke-sessions), one-time `/invite/[token]`
signup links, and the "Recent auth events" audit viewer.

This document is the **single authoritative copy** of the permission model. If
the rule table below and any other doc (or a code comment) ever disagree, **this
file wins** — update it here and nowhere else.

---

## 1. Permission model

Ordering: `viewer < operator < admin`. Unknown/garbage role string ⇒ treated as
`viewer` (**fail closed**). `mustChange` confinement and bootstrap/disabled modes
are **unchanged** and always win **before** role rules. The
`AUTH_DISABLED_BLOCKED_MUTATIONS` list is untouched.

### 1.1 Rule table (evaluated top-down inside `routeRequest`, only for `mode:"enabled"` with a full session)

| # | Rule | Paths (as dispatched in `hooks.server.ts` `proxyBackend`) | Roles |
|---|---|---|---|
| R1 | Admin-only backend, **any method** (user management is admin's alone; even GET leaks the user list) | `/api/users`, `/api/users/*`, `/api/invites`, `/api/invites/*` | admin |
| R2 | Admin-only **mutations** (non-GET) — config/credential/live-arming surfaces | `/api/cockpit/rearm` · `/api/settings/exchange-keys` + `/api/settings/exchange-keys/*` + legacy `/api/settings/{kraken,kucoin,cryptocom}-keys` · `/api/settings/notifications` + subpaths incl. `/test` · `/api/settings/risk` · `/api/janus/config` | admin |
| R3 | Operator+ **mutations** (non-GET) — trade/operate | everything else non-GET under a backend prefix, notably: `/api/cockpit/kill` (halt is the safe direction — an operator must be able to hit the panic button) · all `/api/spawner/*` writes (spawn, container stop/restart/remove, configs + `/configs/{name}/respawn`, net-worth, transfers, accounts, edges, backtests, ui/layouts) · `/api/janus/memories/bootstrap/push` · `/api/signals/*/approve\|reject`, `/api/trades*`, `/api/journal/notes`, `/api/janus-ai/sessions*`, `/api/db/*/query` | operator, admin |
| R4 | Reads — GET/HEAD backend (incl. SSE) + all non-admin pages | everything | viewer, operator, admin |
| R5 | Admin-only **pages** | `/users` → non-admin gets `{kind:"redirect", location:"/"}` (pages redirect, they don't 403 — matches existing page semantics) | admin |

Viewer = R4 only: any non-GET backend request → `{kind:"forbidden", reason:"role_denied"}`.

### 1.2 Documented caveats (these are traps)

- **Live-spawn is body-dependent.** `POST /api/spawner/spawn` with `mode:"live"`
  (the `/bots` form option) is indistinguishable from a paper spawn at the path
  level. The pure rule table cannot catch it; if live-spawn is to be admin-only,
  that check must live in the spawner-forward branch of `proxyBackend`, reading
  the body. **Decision D3: deferred** to the M2 live-friction work (design §4.3)
  — operators can live-spawn in Phase 2. If unacceptable, add a body-sniffing
  admin gate in the spawner-forward branch (one Phase-B-sized task).
- **Role-change propagation latency.** `resolveSession` caches for 60 s per
  process; a demotion/disable is authoritative on the next DB hit, but a cached
  session keeps its old role ≤60 s. Phase B sweeps the in-process cache by
  userId on every admin mutation (disable/role/reset/revoke), so the acting
  worker is immediate; **other replicas** still hold ≤60 s. The multi-replica
  escape hatch is `WEBUI_SESSION_CACHE_TTL_MS=0` (set it whenever the webui runs
  more than one replica so demotions are DB-authoritative on every worker).
- **Open-source-safe.** Nothing in Phase 2 changes bootstrap. A fresh clone still
  creates exactly one admin with a CSPRNG log-printed password. Multi-user only
  exists after that admin explicitly creates users/invites. **No new required
  env vars.**

---

## 2. What Phase B/C shipped (semantics to preserve)

### User management (`/users`, `/api/users`)

- **Last-admin guards (server-side, the UI only mirrors them):** an admin cannot
  disable their own account, cannot disable the **last enabled admin**, and
  cannot demote the last enabled admin. Self-demotion is allowed only while
  another enabled admin exists. These live in the service, not the page — the
  page merely renders the blocked affordances as disabled.
- **One-time temp passwords.** `create` and `reset-password` return a CSPRNG temp
  password **exactly once**, with `must_change_credentials=TRUE` (reusing the
  bootstrap machinery). It is never persisted in plaintext, never logged, and
  never written to the audit trail — the response is the only place it appears.
  The console shows a copy-once callout and says so.
- **Irrevocable-by-design flows.** There is **no hard DELETE** — disable is the
  removal story (keeps the audit trail + FK integrity intact; a disabled user can
  be re-enabled). Disabling and reset revoke the target's sessions immediately;
  `revoke-sessions` forces re-login without other changes.

### Invites (`/invite/[token]`, `/api/invites`)

- **Single-use, atomic.** Redemption is a conditional `UPDATE … WHERE
  redeemed_at IS NULL AND revoked_at IS NULL RETURNING id`; exactly one
  concurrent claim wins. The invitee sets their own username + password in the
  claim (no forced-change hop).
- **48-hour TTL**, set by the service at mint time.
- **No admin-by-invite.** Invites grant `operator` or `viewer` only (the table
  `CHECK` enforces it too); admin creation stays a deliberate `/users` act or a
  psql edit.
- **Token `sha256` at rest.** The raw token exists only in the URL, surfaced
  once; the DB stores `sha256(token)` (same discipline as session tokens). The
  mint endpoint returns a **relative** `/invite/<token>` URL — the admin's own
  browser origin completes it; the server never guesses its public host.

### Audit viewer (`/api/users/audit`, Phase D)

- `GET /api/users/audit?limit=100` (admin-only, re-checked in `usersDispatch` as
  defense in depth), newest first, `limit` clamped to `[1, 500]` (non-numeric →
  default 100). Rows are the existing `webui_auth_audit` shape
  (`at`/`username`/`action`/`ip`/`detail`) — **no migration** (`action` is free
  TEXT). Every Phase B/C action already writes a row; the panel only reads them
  back. The "Recent auth events" panel colour-codes the action badge by class:
  auth successes, failures, admin mutations, and invite events.

---

## 3. PSQL recovery — role mistakes

Loopback + SSH is always the recovery channel (as in Phase 1). Run `psql`
against the live **`fks_db`** database (renamed from `ruby_db` 2026-07-21 — the
env **var name** `RUBY_DB` is unchanged). No password literals below; the
container's `POSTGRES_USER` is a peer/trusted superuser inside the exec.

**Demoted or disabled the last admin (locked out of `/users`):** re-promote and
re-enable a known account directly.

```
docker exec -i fks_postgres \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d fks_db <<'SQL'
UPDATE webui_users
   SET role = 'admin', disabled = FALSE
 WHERE username = '<your-username>';
SQL
```

**Totally locked out (forgot the only admin password):** reuse the Phase-1
truncate-and-rebootstrap path — clear the users table and let startup re-create
the bootstrap admin, then grab the new password from the log:

```
docker exec -i fks_postgres \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d fks_db <<'SQL'
TRUNCATE webui_sessions;
DELETE FROM webui_users;   -- next startup re-bootstraps + logs a fresh password
SQL
docker restart fks_webui
curl -s -o /dev/null http://localhost:3001/     # trigger the lazy bootstrap
docker logs fks_webui 2>&1 | grep -A6 "FIRST-RUN BOOTSTRAP"
```

**Stuck invites** (revoke everything outstanding without touching the UI):

```
docker exec -i fks_postgres \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d fks_db <<'SQL'
UPDATE webui_invites SET revoked_at = now()
 WHERE redeemed_at IS NULL AND revoked_at IS NULL;
SQL
```

---

## 4. Deploy runbook — users + invites go-live

Ordered, copy-paste executable top to bottom. The invites table **must exist
before** the webui shipping invite code connects (the scoped `fks_webui` role
has DML only, not CREATE — it cannot make the table itself), so the migration
lands **first**.

### (a) Apply the invites migration to live `fks_db`, by hand, once

`fks/src/sql/spawner/012_webui_invites.sql` is existence-guarded (a re-run is a
no-op) and adds `webui_invites` + its grants. On a **fresh** volume initdb runs
it automatically; on the **existing** live volume, apply it once. Run from the
`fks` repo root. `fks_db` is the DB name (the `RUBY_DB` env var name is
unchanged from the rename):

```
docker exec -i fks_postgres \
  sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d fks_db' \
  < src/sql/spawner/012_webui_invites.sql
```

### (b) Repin `WEB_COMMIT` + rebuild `fks:webui`

Repin `WEB_COMMIT` to this Phase-D tip and rebuild. **Cache-bust gotcha:**
`run.sh` pins the clone via `ls-remote` — an unpinned git-clone build can ship
stale code silently, so confirm the built image carries the intended commit.

### (c) Recreate the webui + check a clean start

```
docker logs fks_webui 2>&1 | tail -40   # expect a clean start, no migration 500s
```

The startup migration probes the **newest** table (`webui_invites`) — on a
Phase-1 DB that already has `webui_users`, this is what makes the additive DDL
run instead of being skipped. If step (a) was done, startup finds the table and
does nothing.

### (d) Curl verify matrix

Run against the **real access path** (the tailnet hostname over nginx). With an
admin session cookie and a freshly-minted **operator** session cookie:

| Request | admin | operator |
|---|---|---|
| `GET /api/users` | **200** | **403** `role_denied` |
| `GET /api/users/audit?limit=50` | **200** | **403** |
| `POST /api/invites {role:"viewer"}` → `{ ok, url }` | **200** | **403** |
| open the minted `/invite/<token>` in a private window → set creds → land authenticated as the invited role | round-trip works | — |
| reuse the same `/invite/<token>` | "already used" | — |

(No cookie at all → 401 from `routeRequest`, before the dispatch runs.)

### (e) Environment

**No new env vars.** Everything from Phase 1 carries forward unchanged.

### Multi-replica note

If the webui ever runs **more than one replica**, set
`WEBUI_SESSION_CACHE_TTL_MS=0` so a demotion / disable / revoke is
DB-authoritative on every worker immediately instead of surviving up to the
60 s resolve-cache TTL per process (see §1.2).
