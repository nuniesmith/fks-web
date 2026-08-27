/**
 * Rithmic connector types — mirror of the read-only `/positions` surface
 * exposed by `crates/rithmic-connector` (fks #183) and adapted by
 * `/api/rithmic/positions` in hooks.server.ts.
 *
 * READ-ONLY by construction: the connector never opens the order plant. These
 * types describe *observed* positions/PnL, never an order.
 */

/** One open futures position as last reported by Rithmic. */
export interface RithmicPosition {
  symbol: string;
  exchange: string;
  product_code: string;
  /** Signed net quantity (>0 long, <0 short). */
  net_quantity: number;
  /** `long` / `short` / `flat`. */
  direction: string;
  avg_open_price: number;
  open_pnl: number;
  day_pnl: number;
  buy_qty: number;
  sell_qty: number;
  open_quantity: number;
  account_id: string;
}

/** Account-level P&L summary, when the connector has received one. */
export interface RithmicAccountSummary {
  account_id: string;
  net_quantity: number;
  open_pnl: number;
  day_pnl: number;
  account_balance: number;
}

/** The `/api/rithmic/positions` adapter response. */
export interface RithmicPositionsView {
  /** Whether the connector's `/positions` surface responded. */
  connected: boolean;
  account: string;
  count: number;
  positions: RithmicPosition[];
  account_summary: RithmicAccountSummary | null;
}

// ============================================================================
// Rithmic ACCOUNT MANAGEMENT (fks #278/#279 — `rithmic_accounts`)
// ============================================================================
// Metadata for the several Rithmic logins the operator holds. NO SECRETS EVER
// APPEAR HERE: username/password live in `exchange_secrets` under the key
// `rithmic:<id>`, submit-only and never returned, exactly like the exchange API
// keys on /settings. Anything in this file is safe to render.

/** What a login is FOR. A data feed and a funded prop account are different
 *  jobs with different risk; conflating them is how a streaming reconnect ends
 *  up contending with the session that holds real positions. */
export type RithmicAccountKind = "data" | "trading";

/** `main` is the ONE account traded by hand. `copytrade` mirrors it — modelled
 *  now, INERT until the order plant is opened (the connector holds
 *  `read_only`/`order_plant_open` as constants with no order path at all). */
export type RithmicAccountRole = "main" | "copytrade";

/** Prop-firm lifecycle stage. Not cosmetic — it selects the payout split and
 *  the rule set that a progress panel must display. */
export type RithmicAccountStage = "test" | "pro" | "pro_plus";

/** Per-stage facts, from TakeProfit Trader's published rules. Kept beside the
 *  type so a panel cannot invent a split. */
export const STAGE_META: Record<
  RithmicAccountStage,
  { label: string; payoutSplit: number | null; note: string }
> = {
  test: {
    label: "Test",
    payoutSplit: null, // evaluation — nothing to pay out yet
    note: "Evaluation. Pass the profit target without touching the minimum balance.",
  },
  pro: {
    label: "PRO",
    payoutSplit: 0.8,
    note: "80% split. Minimum Account Balance trails and liquidates on UNREALISED loss.",
  },
  pro_plus: {
    label: "PRO+",
    payoutSplit: 0.9,
    note: "90% split, no buffer-zone requirement.",
  },
};

/** One stored login. Mirrors `rithmic_accounts` minus the timestamps a form
 *  does not edit. */
export interface RithmicAccount {
  id: string;
  label: string;
  kind: RithmicAccountKind;
  enabled: boolean;
  role: RithmicAccountRole | null;
  stage: RithmicAccountStage | null;
  system_name: string | null;
  fcm_id: string | null;
  ib_id: string | null;
  account_id: string | null;
  starting_balance: number | null;
  profit_target: number | null;
  min_account_balance: number | null;
  max_contracts: number | null;
  /** Whether a credential is stored for this account. NEVER the credential. */
  has_credentials: boolean;
  updated_at?: string;
}

/** The `/api/rithmic/accounts` response. `configured:false` means the
 *  `rithmic_accounts` table is absent — the migration has not been applied —
 *  which is a DIFFERENT state from "no accounts yet" and must not render as an
 *  empty list, or the operator adds a login into a void. */
export interface RithmicAccountsView {
  configured: boolean;
  reason?: string;
  accounts: RithmicAccount[];
}

/**
 * Validate a draft before it reaches Postgres.
 *
 * This MIRRORS the table's CHECK constraints and partial unique index — it does
 * not replace them. The database is the enforcer, because the UI is not the
 * only writer: an API call or a hand-run UPDATE bypasses anything here. The
 * point of duplicating the rules is a readable message instead of a raw
 * constraint-violation string.
 *
 * `others` is the rest of the stored set, needed only for the one-enabled-main
 * rule, which is inherently about the collection rather than the row.
 */
export function validateRithmicAccount(
  draft: Partial<RithmicAccount>,
  others: RithmicAccount[] = [],
): string[] {
  const errs: string[] = [];

  const id = (draft.id ?? "").trim();
  if (!id) errs.push("id is required");
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(id))
    errs.push("id must be lowercase letters, digits and hyphens (it keys the stored credential)");

  if (!(draft.label ?? "").trim()) errs.push("label is required");

  if (draft.kind !== "data" && draft.kind !== "trading") {
    errs.push("kind must be data or trading");
    return errs; // the rest below is kind-dependent
  }

  if (draft.kind === "data") {
    // Mirrors rithmic_accounts_data_has_no_trading_fields.
    if (draft.role) errs.push("a data login has no trading role");
    if (draft.stage) errs.push("a data login has no prop-firm stage");
  } else {
    // Mirrors rithmic_accounts_trading_has_role.
    if (draft.role !== "main" && draft.role !== "copytrade")
      errs.push("a trading login must be main or copytrade");
  }

  if (draft.max_contracts != null && draft.max_contracts <= 0)
    errs.push("max contracts must be greater than zero");

  // NOTE: a second enabled `main` is deliberately NOT an error here.
  //
  // The invariant "at most one enabled main" is held by the table's partial
  // unique index, and the store UPHOLDS it by demoting the incumbent inside the
  // same transaction as the promotion. Rejecting here would force the operator
  // to disable the old account, save, then enable the new one — a two-step for
  // what is one decision, with a window in between where NO account is the
  // hand-traded one.
  //
  // The operator still needs to know it is about to happen. That is
  // `mainToDemote` below, which the form calls to confirm rather than to block.

  return errs;
}

/**
 * Which account promoting `draft` would DEMOTE, or null.
 *
 * Separate from validation on purpose: this is not an error, it is a
 * consequence. The form uses it to say "this will make X your hand-traded
 * account and disable Y" BEFORE saving — because silently flipping which
 * account is live is exactly the kind of change an operator must not discover
 * afterwards.
 */
/**
 * Which of the Rithmic connection identifiers are still missing.
 *
 * The connector's `positions_ready()` requires account_id, fcm_id AND ib_id to
 * be non-blank, and skips the read-only PnL/positions reader otherwise —
 * SILENTLY, by design, so that market data keeps flowing when they are unset.
 *
 * That silence is what this exists to break. Two of three configured looks
 * exactly like zero of three from the outside: /futures shows no positions
 * while the feed is plainly healthy, and nothing anywhere says why. Returning
 * the NAMES rather than a boolean means the UI can say which one to go and find.
 *
 * Whitespace counts as missing, because the connector trims before testing —
 * a value of " " would read as configured here and be rejected there.
 */
export const RITHMIC_TRIPLE = ['account_id', 'fcm_id', 'ib_id'] as const;

export type RithmicTripleField = (typeof RITHMIC_TRIPLE)[number];

export function missingTriple(
  account: Partial<Pick<RithmicAccount, RithmicTripleField | 'kind'>> | null | undefined,
): RithmicTripleField[] {
  // Only trading logins subscribe to positions; a data feed has nothing to
  // report, so reporting it as incomplete would be noise.
  if (!account || account.kind !== 'trading') return [];
  return RITHMIC_TRIPLE.filter((k) => !String(account[k] ?? '').trim());
}

export function mainToDemote(
  draft: Partial<RithmicAccount>,
  others: RithmicAccount[],
): RithmicAccount | null {
  if (!draft.enabled || draft.role !== "main") return null;
  const id = (draft.id ?? "").trim();
  return others.find((a) => a.id !== id && a.enabled && a.role === "main") ?? null;
}
