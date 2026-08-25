/**
 * Rithmic account management — route handlers (the I/O seam), dispatched from
 * `proxyBackend` in hooks.server.ts BEHIND the auth seam.
 *
 *   GET    /api/rithmic/accounts       → list (no secrets, ever)
 *   POST   /api/rithmic/accounts       → create or update one
 *   DELETE /api/rithmic/accounts/:id   → remove the metadata row
 *
 * HONEST-EMPTY: when `rithmic_accounts` is absent (the migration is applied
 * out-of-band) this reports `configured:false` WITH a reason, never an empty
 * list. An empty list says "you have no accounts"; the truth is "this platform
 * cannot store accounts yet", and those lead to opposite next actions.
 *
 * MUTATIONS FAIL LOUDLY. A write against a missing table returns 503 rather
 * than degrading — silently accepting a create that goes nowhere is the
 * fake-success shape the adapter's 501 rule exists to prevent.
 */

import {
  validateRithmicAccount,
  type RithmicAccount,
  type RithmicAccountsView,
} from "$lib/types/rithmic";
import type { RithmicAccountStore, RithmicAccountUpsert } from "./store";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const NOT_APPLIED =
  "the rithmic_accounts table is not present — migration 016 has not been applied to this database";

/** Present + reachable + has the table. Never throws: a probe failure is
 *  "not configured", which the UI renders as its own state. */
async function safeConfigured(store: RithmicAccountStore | null): Promise<boolean> {
  if (!store) return false;
  try {
    return await store.configured();
  } catch {
    return false;
  }
}

export async function rithmicAccountsGet(
  store: RithmicAccountStore | null,
): Promise<Response> {
  if (!(await safeConfigured(store))) {
    const view: RithmicAccountsView = {
      configured: false,
      reason: store ? NOT_APPLIED : "no database configured for the webui",
      accounts: [],
    };
    return json(view);
  }
  try {
    const accounts = await store!.list();
    return json({ configured: true, accounts } satisfies RithmicAccountsView);
  } catch (e) {
    // A read that FAILED is not an empty account list. Say so.
    return json(
      {
        configured: false,
        reason: `account store unreachable: ${e instanceof Error ? e.message : String(e)}`,
        accounts: [],
      } satisfies RithmicAccountsView,
      502,
    );
  }
}

/** Coerce one JSON body field to a finite number, or null. Rejects NaN so a
 *  typo'd balance cannot land in a column that is compared against a
 *  liquidation threshold. */
function optNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function optStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export async function rithmicAccountsPost(
  store: RithmicAccountStore | null,
  body: unknown,
): Promise<Response> {
  if (!(await safeConfigured(store))) {
    return json({ error: "not_configured", message: NOT_APPLIED }, 503);
  }
  if (typeof body !== "object" || body === null) {
    return json({ error: "bad_request", message: "expected a JSON object" }, 400);
  }
  const b = body as Record<string, unknown>;

  const draft: Partial<RithmicAccount> = {
    id: typeof b.id === "string" ? b.id.trim().toLowerCase() : "",
    label: typeof b.label === "string" ? b.label.trim() : "",
    kind: b.kind as RithmicAccount["kind"],
    enabled: b.enabled === true,
    role: (optStr(b.role) ?? null) as RithmicAccount["role"],
    stage: (optStr(b.stage) ?? null) as RithmicAccount["stage"],
    max_contracts: optNum(b.max_contracts),
  };

  // Validate against the CURRENT set so the one-enabled-main rule can name the
  // incumbent. A read failure here must not be reported as a validation error —
  // it is an outage, and blaming the operator's input for it would send them
  // fixing a form that was already correct.
  let existing: RithmicAccount[];
  try {
    existing = await store!.list();
  } catch (e) {
    return json(
      {
        error: "store_unreachable",
        message: `could not read existing accounts: ${e instanceof Error ? e.message : String(e)}`,
      },
      502,
    );
  }

  const errors = validateRithmicAccount(draft, existing);
  if (errors.length > 0) {
    return json({ error: "invalid", errors }, 400);
  }

  const row: RithmicAccountUpsert = {
    id: draft.id!,
    label: draft.label!,
    kind: draft.kind!,
    enabled: draft.enabled === true,
    role: draft.role ?? null,
    stage: draft.stage ?? null,
    system_name: optStr(b.system_name),
    fcm_id: optStr(b.fcm_id),
    ib_id: optStr(b.ib_id),
    account_id: optStr(b.account_id),
    starting_balance: optNum(b.starting_balance),
    profit_target: optNum(b.profit_target),
    min_account_balance: optNum(b.min_account_balance),
    max_contracts: draft.max_contracts ?? null,
  };

  try {
    await store!.upsert(row);
  } catch (e) {
    // The DB constraints are the real enforcer; a violation reaching here means
    // validation and schema disagree. Surface it rather than swallowing it —
    // that disagreement is a bug worth seeing.
    return json(
      { error: "write_failed", message: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
  return json({ ok: true, id: row.id });
}

export async function rithmicAccountsDelete(
  store: RithmicAccountStore | null,
  id: string,
): Promise<Response> {
  if (!(await safeConfigured(store))) {
    return json({ error: "not_configured", message: NOT_APPLIED }, 503);
  }
  const clean = id.trim().toLowerCase();
  if (!clean) return json({ error: "bad_request", message: "id required" }, 400);
  try {
    await store!.remove(clean);
  } catch (e) {
    return json(
      { error: "write_failed", message: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
  // The stored credential under `rithmic:<id>` is deliberately left in place —
  // say so, rather than letting the operator assume a delete was total.
  return json({
    ok: true,
    id: clean,
    note: "metadata removed; any stored credential under rithmic:" + clean + " was left untouched",
  });
}
