/**
 * Rithmic account store — metadata for the operator's several Rithmic logins.
 *
 * NO SECRETS PASS THROUGH HERE. Usernames and passwords live in
 * `exchange_secrets` under the key `rithmic:<id>`, submit-only via the spawner
 * and never returned. This store reads and writes only the metadata in
 * `rithmic_accounts`, so a bug here cannot leak a credential.
 *
 * The table is created by the privileged initdb path (fks 016) and the scoped
 * `fks_webui` role has CRUD on it but no DDL — so this store PROBES
 * `to_regclass` and reports `configured:false` when the table is absent (the
 * `alertAck`/`cockpit` idiom). The migration is applied by hand out-of-band, so
 * "not applied yet" is a real, expected state and must render as itself rather
 * than as an empty list: an empty list invites the operator to add a login into
 * a void.
 */

import { env } from "$env/dynamic/private";
import postgres from "postgres";
import type { RithmicAccount } from "$lib/types/rithmic";

type Sql = ReturnType<typeof postgres>;

/** The writable shape — `has_credentials` is derived, never stored here. */
export type RithmicAccountUpsert = Omit<RithmicAccount, "has_credentials" | "updated_at">;

export interface RithmicAccountStore {
  configured(): Promise<boolean>;
  list(): Promise<RithmicAccount[]>;
  upsert(row: RithmicAccountUpsert): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Postgres NUMERIC arrives as a string (it is arbitrary-precision, so the
 *  driver refuses to silently lose digits). Money must not reach the UI as
 *  "146703.50" where a comparison would be lexicographic. */
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIso(v: unknown): string | undefined {
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : undefined;
}

export class PgRithmicAccountStore implements RithmicAccountStore {
  private sql: Sql;
  /** Positive probe cached forever (tables do not un-exist); negative retried,
   *  because the migration may be applied while the process is running. */
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
      SELECT to_regclass('public.rithmic_accounts') IS NOT NULL AS present`;
    this.known = rows[0]?.present === true;
    return this.known;
  }

  async list(): Promise<RithmicAccount[]> {
    // LEFT JOIN on exchange_secrets to report WHETHER a credential is stored.
    // `EXISTS`, never the columns — the secret must not enter this query's
    // result set even transiently. If the webui role cannot see that table the
    // join yields false, which reads as "no credential", the safe direction.
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT a.*,
             EXISTS (
               SELECT 1 FROM exchange_secrets s
               WHERE s.exchange = 'rithmic:' || a.id
             ) AS has_credentials
      FROM rithmic_accounts a
      ORDER BY a.kind, a.enabled DESC, a.label`;
    return rows.map((r) => ({
      id: String(r.id),
      label: String(r.label),
      kind: r.kind as RithmicAccount["kind"],
      enabled: r.enabled === true,
      role: (r.role ?? null) as RithmicAccount["role"],
      stage: (r.stage ?? null) as RithmicAccount["stage"],
      system_name: (r.system_name ?? null) as string | null,
      fcm_id: (r.fcm_id ?? null) as string | null,
      ib_id: (r.ib_id ?? null) as string | null,
      account_id: (r.account_id ?? null) as string | null,
      starting_balance: num(r.starting_balance),
      profit_target: num(r.profit_target),
      min_account_balance: num(r.min_account_balance),
      max_contracts: r.max_contracts == null ? null : Number(r.max_contracts),
      has_credentials: r.has_credentials === true,
      updated_at: toIso(r.updated_at),
    }));
  }

  /**
   * Create or update one account.
   *
   * WRAPPED IN A TRANSACTION because promoting a new hand-traded account is
   * inherently two writes. The table carries a partial unique index allowing
   * only ONE row with `role='main' AND enabled`, so enabling a new main while
   * the old one is still enabled is a constraint violation — the operator would
   * see a raw 23505 and be told to go and disable the other one by hand.
   * Demoting the incumbent in the SAME transaction makes the swap atomic: it
   * either happens completely or not at all, and there is never an instant with
   * two enabled mains or, worse, none.
   *
   * The demotion clears `enabled` only. It does NOT change the other account's
   * role, so the operator's history of which accounts are mains is preserved
   * and switching back is one click.
   */
  async upsert(row: RithmicAccountUpsert): Promise<void> {
    await this.sql.begin(async (tx) => {
      if (row.enabled && row.role === "main") {
        await tx`
          UPDATE rithmic_accounts
          SET enabled = FALSE
          WHERE role = 'main' AND enabled AND id <> ${row.id}`;
      }
      await tx`
        INSERT INTO rithmic_accounts (
          id, label, kind, enabled, role, stage,
          system_name, fcm_id, ib_id, account_id,
          starting_balance, profit_target, min_account_balance, max_contracts
        ) VALUES (
          ${row.id}, ${row.label}, ${row.kind}, ${row.enabled}, ${row.role}, ${row.stage},
          ${row.system_name}, ${row.fcm_id}, ${row.ib_id}, ${row.account_id},
          ${row.starting_balance}, ${row.profit_target}, ${row.min_account_balance}, ${row.max_contracts}
        )
        ON CONFLICT (id) DO UPDATE SET
          label = EXCLUDED.label,
          kind = EXCLUDED.kind,
          enabled = EXCLUDED.enabled,
          role = EXCLUDED.role,
          stage = EXCLUDED.stage,
          system_name = EXCLUDED.system_name,
          fcm_id = EXCLUDED.fcm_id,
          ib_id = EXCLUDED.ib_id,
          account_id = EXCLUDED.account_id,
          starting_balance = EXCLUDED.starting_balance,
          profit_target = EXCLUDED.profit_target,
          min_account_balance = EXCLUDED.min_account_balance,
          max_contracts = EXCLUDED.max_contracts`;
    });
  }

  /** Removes the metadata row only. The stored credential under
   *  `rithmic:<id>` is NOT touched — this role has no grant on
   *  `exchange_secrets`, and silently destroying a credential from a metadata
   *  delete would be a surprising amount of damage for one button. */
  async remove(id: string): Promise<void> {
    await this.sql`DELETE FROM rithmic_accounts WHERE id = ${id}`;
  }
}

let storeSingleton: PgRithmicAccountStore | null = null;

/**
 * The account-store connection: `WEBUI_DATABASE_URL` (the scoped fks_webui role
 * on fks_db, where the table + grants live — fks 016/#279). Empty = not
 * configured → the settings panel reports `configured:false` with a reason and
 * renders read-only, rather than an empty list that looks like "no accounts".
 */
export function getRithmicAccountStore(): RithmicAccountStore | null {
  const url = (env.WEBUI_DATABASE_URL ?? "").trim();
  if (!url) return null;
  if (!storeSingleton) storeSingleton = new PgRithmicAccountStore(url);
  return storeSingleton;
}
