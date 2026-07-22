-- Phase-1 webui user management schema (design §4.1).
-- Additive + idempotent — safe to run on every startup, and safe to bake into
-- fks/src/sql/spawner/010_webui_auth.sql for the fresh-host initdb path.
-- Keep byte-identical to the SCHEMA_SQL constant in ./schema.ts.
--
-- For the baked-initdb path, also create the scoped LOGIN role (009 pattern).
-- The authoritative, runnable version of this is fks/src/sql/spawner/
-- 010_webui_auth.sql — prefer applying THAT (existence-guarded, idempotent).
-- This recipe must stay in sync with it:
--   CREATE ROLE fks_webui LOGIN PASSWORD :'WEBUI_DB_PASSWORD';
--   GRANT CONNECT ON DATABASE fks_db TO fks_webui;
--   GRANT USAGE ON SCHEMA public TO fks_webui;
--   GRANT SELECT,INSERT,UPDATE,DELETE ON webui_users, webui_sessions,
--         webui_auth_audit TO fks_webui;
--   -- Sequence USAGE scoped to the three webui BIGSERIAL id sequences BY NAME
--   -- (auth-chain L2). NEVER "ALL SEQUENCES IN SCHEMA public" — fks_db is
--   -- shared with the spawner, so that would sweep in every spawner-owned
--   -- sequence (exchange_secrets, transfers, bot_configs …), letting the webui
--   -- role read last_value / burn ids on them.
--   GRANT USAGE,SELECT ON SEQUENCE webui_users_id_seq      TO fks_webui;
--   GRANT USAGE,SELECT ON SEQUENCE webui_sessions_id_seq   TO fks_webui;
--   GRANT USAGE,SELECT ON SEQUENCE webui_auth_audit_id_seq TO fks_webui;
-- Deliberately NOT granted: exchange_secrets, transfers, accounts, bot_configs,
-- and everything else in fks_db. Empty WEBUI_DB_PASSWORD → role cannot log in
-- (fail closed), identical to 009_backtest_role.sql.

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
