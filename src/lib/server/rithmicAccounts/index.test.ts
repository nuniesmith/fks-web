import { describe, expect, it } from "vitest";
import {
  rithmicAccountsDelete,
  rithmicAccountsGet,
  rithmicAccountsPost,
} from "./index";
import type { RithmicAccountStore, RithmicAccountUpsert } from "./store";
import type { RithmicAccount } from "$lib/types/rithmic";

/** In-memory store so every branch runs with no Postgres. It reproduces the
 *  ONE behaviour of the real store that the handlers depend on: the atomic
 *  demote-then-promote of a new main. */
class MemStore implements RithmicAccountStore {
  rows = new Map<string, RithmicAccountUpsert>();
  present = true;
  throwOnList = false;
  throwOnWrite = false;

  async configured() {
    return this.present;
  }
  async list(): Promise<RithmicAccount[]> {
    if (this.throwOnList) throw new Error("connection refused");
    return [...this.rows.values()].map((r) => ({ ...r, has_credentials: false }));
  }
  async upsert(row: RithmicAccountUpsert) {
    if (this.throwOnWrite) throw new Error("constraint violation");
    if (row.enabled && row.role === "main") {
      for (const [k, v] of this.rows) {
        if (k !== row.id && v.role === "main" && v.enabled) {
          this.rows.set(k, { ...v, enabled: false });
        }
      }
    }
    this.rows.set(row.id, row);
  }
  async remove(id: string) {
    if (this.throwOnWrite) throw new Error("nope");
    this.rows.delete(id);
  }
}

const body = (over: Record<string, unknown> = {}) => ({
  id: "tpt-150k",
  label: "TPT 150K",
  kind: "trading",
  enabled: true,
  role: "main",
  stage: "pro",
  ...over,
});

describe("GET /api/rithmic/accounts", () => {
  /**
   * "The migration is not applied" and "you have no accounts" lead to OPPOSITE
   * next actions — apply a migration, versus add a login. Rendering the first
   * as the second sends the operator to type credentials into a form that
   * cannot store them.
   */
  it("reports configured:false WITH a reason when the table is absent", async () => {
    const s = new MemStore();
    s.present = false;
    const v = await (await rithmicAccountsGet(s)).json();
    expect(v.configured).toBe(false);
    expect(v.reason).toMatch(/migration 016/);
    expect(v.accounts).toEqual([]);
  });

  it("reports configured:false when there is no database at all", async () => {
    const v = await (await rithmicAccountsGet(null)).json();
    expect(v.configured).toBe(false);
    expect(v.reason).toMatch(/no database/);
  });

  /** A read that FAILED is not an empty account list. */
  it("does not render a store outage as zero accounts", async () => {
    const s = new MemStore();
    s.throwOnList = true;
    const r = await rithmicAccountsGet(s);
    expect(r.status).toBe(502);
    const v = await r.json();
    expect(v.configured).toBe(false);
    expect(v.reason).toMatch(/unreachable/);
  });

  it("lists accounts when configured", async () => {
    const s = new MemStore();
    await rithmicAccountsPost(s, body());
    const v = await (await rithmicAccountsGet(s)).json();
    expect(v.configured).toBe(true);
    expect(v.accounts).toHaveLength(1);
    expect(v.accounts[0].label).toBe("TPT 150K");
  });

  /** The list must never carry a credential, whatever the store returns. */
  it("never emits a secret-shaped field", async () => {
    const s = new MemStore();
    await rithmicAccountsPost(s, body());
    const raw = await (await rithmicAccountsGet(s)).text();
    for (const bad of ["password", "api_secret", "secret", "passphrase"]) {
      expect(raw.toLowerCase()).not.toContain(bad);
    }
    expect(raw).toContain("has_credentials");
  });
});

describe("POST /api/rithmic/accounts", () => {
  /** A write against a missing table must FAIL, not silently succeed. */
  it("503s rather than accepting a create that would go nowhere", async () => {
    const s = new MemStore();
    s.present = false;
    const r = await rithmicAccountsPost(s, body());
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("not_configured");
  });

  it("rejects an invalid draft with per-field errors", async () => {
    const s = new MemStore();
    const r = await rithmicAccountsPost(s, body({ kind: "data", role: "main" }));
    expect(r.status).toBe(400);
    const v = await r.json();
    expect(v.error).toBe("invalid");
    expect(v.errors.some((e: string) => /data login has no trading role/.test(e))).toBe(true);
  });

  /**
   * THE OPERATOR'S RULE: only one account may be hand-traded. Promoting a new
   * main must DEMOTE the incumbent atomically rather than erroring — a raw
   * constraint violation would tell them to go and disable the other account by
   * hand, which is exactly the two-step the store's transaction exists to
   * remove.
   */
  it("promoting a new main demotes the incumbent instead of erroring", async () => {
    const s = new MemStore();
    await rithmicAccountsPost(s, body({ id: "tpt-a", label: "TPT A" }));
    const r = await rithmicAccountsPost(s, body({ id: "tpt-b", label: "TPT B" }));
    expect(r.status).toBe(200);

    const v = await (await rithmicAccountsGet(s)).json();
    const enabledMains = v.accounts.filter(
      (a: RithmicAccount) => a.role === "main" && a.enabled,
    );
    expect(enabledMains).toHaveLength(1);
    expect(enabledMains[0].id).toBe("tpt-b");
    // The incumbent keeps its ROLE — only `enabled` changes, so switching back
    // is one click and the history of which accounts are mains survives.
    const old = v.accounts.find((a: RithmicAccount) => a.id === "tpt-a");
    expect(old.role).toBe("main");
    expect(old.enabled).toBe(false);
  });

  /** An outage must not be reported as the operator's input being wrong. */
  it("reports a read failure as an outage, not a validation error", async () => {
    const s = new MemStore();
    s.throwOnList = true;
    const r = await rithmicAccountsPost(s, body());
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe("store_unreachable");
  });

  it("surfaces a constraint violation rather than swallowing it", async () => {
    const s = new MemStore();
    s.throwOnWrite = true;
    const r = await rithmicAccountsPost(s, body());
    expect(r.status).toBe(500);
    expect((await r.json()).error).toBe("write_failed");
  });

  it("normalises the id, which keys the stored credential", async () => {
    const s = new MemStore();
    const r = await rithmicAccountsPost(s, body({ id: "  TPT-150K  " }));
    expect(r.status).toBe(200);
    expect((await r.json()).id).toBe("tpt-150k");
  });

  it("rejects a non-numeric balance instead of storing NaN", async () => {
    const s = new MemStore();
    await rithmicAccountsPost(s, body({ min_account_balance: "not a number" }));
    const v = await (await rithmicAccountsGet(s)).json();
    expect(v.accounts[0].min_account_balance).toBeNull();
  });
});

describe("DELETE /api/rithmic/accounts/:id", () => {
  it("503s when the table is absent", async () => {
    const s = new MemStore();
    s.present = false;
    expect((await rithmicAccountsDelete(s, "x")).status).toBe(503);
  });

  /** Deleting metadata must not be mistaken for destroying the credential. */
  it("says the stored credential was left untouched", async () => {
    const s = new MemStore();
    await rithmicAccountsPost(s, body());
    const v = await (await rithmicAccountsDelete(s, "tpt-150k")).json();
    expect(v.ok).toBe(true);
    expect(v.note).toMatch(/left untouched/);
    expect((await s.list())).toHaveLength(0);
  });
});
