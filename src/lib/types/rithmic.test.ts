import { describe, expect, it } from "vitest";
import {
  STAGE_META,
  validateRithmicAccount,
  mainToDemote,
  type RithmicAccount,
} from "./rithmic";

/**
 * These cases MIRROR the CHECK constraints and partial unique index in
 * `src/sql/spawner/016_rithmic_accounts.sql` (fks repo). The database remains
 * the enforcer — this layer exists so the operator gets a sentence instead of a
 * Postgres error code. If a constraint changes there, a case here must change
 * with it, or the UI starts cheerfully accepting rows the DB will reject.
 */

function acct(over: Partial<RithmicAccount> = {}): RithmicAccount {
  return {
    id: "tpt-150k",
    label: "TPT 150K",
    kind: "trading",
    enabled: true,
    role: "main",
    stage: "pro",
    system_name: null,
    fcm_id: null,
    ib_id: null,
    account_id: null,
    starting_balance: null,
    profit_target: null,
    min_account_balance: null,
    max_contracts: null,
    has_credentials: true,
    ...over,
  };
}

describe("validateRithmicAccount", () => {
  it("accepts a well-formed trading account", () => {
    expect(validateRithmicAccount(acct())).toEqual([]);
  });

  it("accepts a well-formed data account", () => {
    expect(
      validateRithmicAccount(
        acct({ id: "data-feed", kind: "data", role: null, stage: null }),
      ),
    ).toEqual([]);
  });

  // ── mirrors rithmic_accounts_data_has_no_trading_fields ──────────────────
  it("rejects a data login carrying trading fields", () => {
    const errs = validateRithmicAccount(
      acct({ kind: "data", role: "main", stage: "pro" }),
    );
    expect(errs.some((e) => /data login has no trading role/.test(e))).toBe(true);
    expect(errs.some((e) => /data login has no prop-firm stage/.test(e))).toBe(true);
  });

  // ── mirrors rithmic_accounts_trading_has_role ────────────────────────────
  it("rejects a trading login with no role", () => {
    const errs = validateRithmicAccount(acct({ role: null }));
    expect(errs.some((e) => /must be main or copytrade/.test(e))).toBe(true);
  });

  // ── the partial unique index rithmic_accounts_one_enabled_main ──────────
  // Promoting a second main is NOT a validation error: the store demotes the
  // incumbent in the same transaction, so this is a consequence to disclose,
  // not an input to reject. `mainToDemote` is what the form confirms against.
  it("does not reject a second enabled main — the store handles the swap", () => {
    const existing = acct({ id: "tpt-a", label: "TPT A" });
    expect(validateRithmicAccount(acct({ id: "tpt-b", label: "TPT B" }), [existing])).toEqual([]);
  });

  it("names the account that promoting would demote", () => {
    const existing = acct({ id: "tpt-a", label: "TPT A" });
    const victim = mainToDemote(acct({ id: "tpt-b", label: "TPT B" }), [existing]);
    expect(victim?.label).toBe("TPT A");
  });

  it("reports no demotion when there is no incumbent, or the row is itself", () => {
    expect(mainToDemote(acct({ id: "tpt-b" }), [])).toBeNull();
    const self = acct({ id: "tpt-a" });
    expect(mainToDemote(self, [self])).toBeNull();
  });

  it("reports no demotion for a DISABLED promotion or a copytrade row", () => {
    const existing = acct({ id: "tpt-a", label: "TPT A" });
    expect(mainToDemote(acct({ id: "tpt-b", enabled: false }), [existing])).toBeNull();
    expect(mainToDemote(acct({ id: "c1", role: "copytrade" }), [existing])).toBeNull();
  });

  it("allows many enabled copytrade accounts", () => {
    const mainAcct = acct({ id: "tpt-a" });
    const c1 = acct({ id: "c1", role: "copytrade" });
    expect(validateRithmicAccount(acct({ id: "c2", role: "copytrade" }), [mainAcct, c1])).toEqual([]);
  });

  // ── id doubles as the exchange_secrets key suffix (`rithmic:<id>`) ───────
  it("rejects ids that would make an unusable credential key", () => {
    for (const bad of ["", "Has Caps", "with space", "-leading", "under_score", "colon:in"]) {
      expect(
        validateRithmicAccount(acct({ id: bad })).length,
        `expected "${bad}" to be rejected`,
      ).toBeGreaterThan(0);
    }
  });

  it("rejects a non-positive contract cap", () => {
    expect(validateRithmicAccount(acct({ max_contracts: 0 })).some((e) => /greater than zero/.test(e))).toBe(true);
    expect(validateRithmicAccount(acct({ max_contracts: 5 }))).toEqual([]);
  });
});

describe("STAGE_META", () => {
  /**
   * The splits are TakeProfit Trader's published figures (PRO 80%, PRO+ 90%).
   * Pinned because a payout panel that invents a split is worse than one that
   * shows nothing — the operator would plan withdrawals against a number the
   * firm never agreed to.
   */
  it("carries the real payout splits, and none for an evaluation account", () => {
    expect(STAGE_META.pro.payoutSplit).toBe(0.8);
    expect(STAGE_META.pro_plus.payoutSplit).toBe(0.9);
    expect(STAGE_META.test.payoutSplit).toBeNull();
  });

  it("covers every stage the type allows", () => {
    expect(Object.keys(STAGE_META).sort()).toEqual(["pro", "pro_plus", "test"]);
    for (const m of Object.values(STAGE_META)) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.note.length).toBeGreaterThan(0);
    }
  });
});
