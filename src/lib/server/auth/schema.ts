// Canonical Phase-1 auth DDL (design §4.1). Additive + idempotent
// (CREATE … IF NOT EXISTS) so it applies safely on every startup and can be
// baked verbatim into fks/src/sql/spawner/010_webui_auth.sql for the fresh-host
// initdb path. A byte-identical copy lives at ./schema.sql for that DBA path.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS webui_users (
    id            BIGSERIAL PRIMARY KEY,
    username      TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'admin'
                  CHECK (role IN ('admin','operator','viewer')),
    must_change_credentials BOOLEAN NOT NULL DEFAULT FALSE,
    disabled      BOOLEAN NOT NULL DEFAULT FALSE,
    failed_logins INT NOT NULL DEFAULT 0,
    locked_until  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS webui_users_username_idx
    ON webui_users (lower(username));

CREATE TABLE IF NOT EXISTS webui_sessions (
    id              BIGSERIAL PRIMARY KEY,
    token_hash      TEXT NOT NULL UNIQUE,
    user_id         BIGINT NOT NULL REFERENCES webui_users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    idle_expires_at TIMESTAMPTZ NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    ip              TEXT NOT NULL DEFAULT '',
    user_agent      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS webui_sessions_user_idx ON webui_sessions (user_id);

CREATE TABLE IF NOT EXISTS webui_auth_audit (
    id       BIGSERIAL PRIMARY KEY,
    at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    username TEXT NOT NULL,
    action   TEXT NOT NULL,
    ip       TEXT NOT NULL DEFAULT '',
    detail   TEXT NOT NULL DEFAULT ''
);
`;
