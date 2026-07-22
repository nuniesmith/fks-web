-- WebUI alert-ack inbox schema (webui plan 04 Phase B).
-- Additive + idempotent — safe to run on every startup, and safe to bake into
-- fks/src/sql/spawner/011_webui_alert_acks.sql for the fresh-host initdb path.
-- Keep the CREATE TABLE / CREATE INDEX block byte-identical to the SCHEMA_SQL
-- constant in ./schema.ts AND to the block in fks 011_webui_alert_acks.sql.
--
-- The webui does NOT run this DDL with its scoped fks_webui role (SELECT+INSERT
-- only — no CREATE). It PROBES `to_regclass('public.webui_alert_acks')` and
-- reports `configured:false` when the table is missing (cockpit.ts idiom) — an
-- ack-store outage must never hide a live alert or crash the inbox.
--
-- The authoritative, runnable version (with role grants) is
-- fks/src/sql/spawner/011_webui_alert_acks.sql — prefer applying THAT. The
-- fks-side grants that must stay in sync (SELECT+INSERT only; irrevocable audit
-- rows — no UPDATE/DELETE; sequence grant BY NAME per the auth-chain L2 rule):
--   GRANT SELECT, INSERT ON webui_alert_acks TO fks_webui;
--   GRANT USAGE, SELECT ON SEQUENCE webui_alert_acks_id_seq TO fks_webui;

CREATE TABLE IF NOT EXISTS webui_alert_acks (
    id          BIGSERIAL PRIMARY KEY,
    alert_key   TEXT NOT NULL UNIQUE,      -- sha256(canonical labels + "|" + activeAt)
    alertname   TEXT NOT NULL,             -- denormalized for the audit view
    labels      JSONB NOT NULL,
    active_at   TIMESTAMPTZ NOT NULL,
    acked_by    TEXT NOT NULL,             -- session username (operatorName idiom)
    acked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    note        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS webui_alert_acks_alertname_idx
    ON webui_alert_acks (alertname);
