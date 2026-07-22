/**
 * Alert-ack store — the persistence half (Postgres in prod, in-memory for
 * tests + UI-first work). The table (`webui_alert_acks`, fks_db) is created by
 * the privileged initdb path (fks 011); the webui's scoped `fks_webui` role has
 * SELECT+INSERT only, so this store NEVER runs DDL — it PROBES `to_regclass`
 * and reports `configured:false` when the table is missing (cockpit.ts idiom),
 * so an ack-store outage degrades the inbox to read-only rather than crashing.
 *
 * Acks are IRREVOCABLE audit rows: insert is `ON CONFLICT (alert_key) DO
 * NOTHING` + a re-select, so a double-ack returns the FIRST acker's row (there
 * is no UPDATE grant and no un-ack).
 */

import { env } from "$env/dynamic/private";
import postgres from "postgres";
import type { InboxAck } from "$lib/types/alertInbox";

/** A row to insert (the server has already recomputed + validated the key). */
export interface AlertAckInsert {
  alert_key: string;
  alertname: string;
  labels: Record<string, string>;
  /** ISO-8601 activeAt (TIMESTAMPTZ). */
  active_at: string;
  acked_by: string;
  note: string;
}

export interface AlertAckStore {
  /** Whether `webui_alert_acks` exists in the connected DB. */
  configured(): Promise<boolean>;
  /** Acks for the given incident keys, keyed by alert_key (LEFT-JOIN source). */
  acksFor(keys: string[]): Promise<Map<string, InboxAck>>;
  /** Idempotent insert; returns the stored ack (the existing one on conflict). */
  insertAck(row: AlertAckInsert): Promise<InboxAck>;
}

type Sql = ReturnType<typeof postgres>;

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : new Date().toISOString();
}

export class PgAlertAckStore implements AlertAckStore {
  private sql: Sql;
  /** Positive probe cached forever (tables don't un-exist); negative retried. */
  private known = false;

  constructor(connectionString: string) {
    this.sql = postgres(connectionString, {
      max: 2,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => {},
    });
  }

  async configured(): Promise<boolean> {
    if (this.known) return true;
    const rows = await this.sql<{ present: boolean }[]>`
      SELECT to_regclass('public.webui_alert_acks') IS NOT NULL AS present`;
    this.known = rows[0]?.present === true;
    return this.known;
  }

  async acksFor(keys: string[]): Promise<Map<string, InboxAck>> {
    const map = new Map<string, InboxAck>();
    if (keys.length === 0) return map;
    const rows = await this.sql<
      { alert_key: string; acked_by: string; acked_at: unknown; note: string }[]
    >`
      SELECT alert_key, acked_by, acked_at, note
      FROM webui_alert_acks
      WHERE alert_key = ANY(${keys})`;
    for (const r of rows) {
      map.set(r.alert_key, { by: r.acked_by, at: toIso(r.acked_at), note: r.note });
    }
    return map;
  }

  async insertAck(row: AlertAckInsert): Promise<InboxAck> {
    // Irrevocable audit row: DO NOTHING on conflict (no UPDATE grant), then
    // re-select so a double-ack returns the FIRST acker's row idempotently.
    await this.sql`
      INSERT INTO webui_alert_acks (alert_key, alertname, labels, active_at, acked_by, note)
      VALUES (${row.alert_key}, ${row.alertname}, ${this.sql.json(row.labels as never)},
              ${row.active_at}, ${row.acked_by}, ${row.note})
      ON CONFLICT (alert_key) DO NOTHING`;
    const rows = await this.sql<{ acked_by: string; acked_at: unknown; note: string }[]>`
      SELECT acked_by, acked_at, note FROM webui_alert_acks WHERE alert_key = ${row.alert_key}`;
    const r = rows[0];
    return { by: r?.acked_by ?? row.acked_by, at: toIso(r?.acked_at), note: r?.note ?? row.note };
  }
}

/** In-memory store — `configured()` is always true; used in tests + UI dev. */
export class MemoryAlertAckStore implements AlertAckStore {
  private rows = new Map<string, InboxAck>();

  async configured(): Promise<boolean> {
    return true;
  }

  async acksFor(keys: string[]): Promise<Map<string, InboxAck>> {
    const map = new Map<string, InboxAck>();
    for (const k of keys) {
      const a = this.rows.get(k);
      if (a) map.set(k, a);
    }
    return map;
  }

  async insertAck(row: AlertAckInsert): Promise<InboxAck> {
    const existing = this.rows.get(row.alert_key);
    if (existing) return existing; // idempotent — first ack wins
    const ack: InboxAck = { by: row.acked_by, at: new Date().toISOString(), note: row.note };
    this.rows.set(row.alert_key, ack);
    return ack;
  }
}

let storeSingleton: PgAlertAckStore | null = null;

/**
 * The ack-store connection: `WEBUI_DATABASE_URL` (the scoped fks_webui role on
 * fks_db, where the table + grants live). Empty = not configured → the inbox
 * reports `configured:false` and degrades to read-only (honest-empty).
 */
export function getAlertAckStore(): AlertAckStore | null {
  const url = (env.WEBUI_DATABASE_URL ?? "").trim();
  if (!url) return null;
  if (!storeSingleton) storeSingleton = new PgAlertAckStore(url);
  return storeSingleton;
}
