// Canonical alert-ack inbox DDL (webui plan 04 Phase B). Additive + idempotent
// (CREATE … IF NOT EXISTS) so it applies safely on every startup and is baked
// verbatim into fks/src/sql/spawner/011_webui_alert_acks.sql for the fresh-host
// initdb path. A byte-identical copy lives at ./schema.sql for that DBA path.
//
// The CREATE TABLE block is kept BYTE-IDENTICAL to the fks 011 block: the webui
// probes `to_regclass('public.webui_alert_acks')` (see store.ts) and reports
// `configured:false` when the table is missing — it never runs this DDL with
// the scoped fks_webui role (SELECT+INSERT only). Grants live in the fks copy.
export const SCHEMA_SQL = `
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
`;
