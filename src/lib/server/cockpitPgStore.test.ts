// Sentinel wire-encoding regression tests for PgCockpitStore — the RE-ARM
// path in particular.
//
// Why this exists: postgres.js `sql.json(null)` does NOT encode a JSONB
// `null`. It pushes a JS null into the params array, and the Bind step
// short-circuits `x === null` into a wire-level SQL NULL BEFORE the jsonb
// serializer runs. The bot's `funding_kill_switch.record` column is
// `JSONB NOT NULL`, so that bind raises 23502 (not_null_violation) — meaning a
// re-arm that uses `sql.json(null)` fails 100% of the time against the real
// schema: KILL works, RE-ARM 502s, and a live bot killed from the couch can
// only be re-armed by SSHing to the box. The bot's own ClearKill
// (tokio-postgres + serde_json::Value::Null) sends the JSONB value `null`, a
// PRESENT value that satisfies NOT NULL and reads back as "not killed".
//
// The fix inlines the literal `'null'::jsonb` into the re-arm SQL. These
// tests pin, at the query-construction level (mocked postgres module capturing
// the exact SQL text + bind params), that:
//   - clearKill's SQL carries `'null'::jsonb` as a LITERAL and binds ONLY the
//     instance — never a null parameter, never sql.json(null);
//   - setKill still binds the full record through sql.json (the object path
//     encodes correctly).
// If anyone "simplifies" clearKill back to a `sql.json(null)` bind, these
// fail.

import { beforeEach, describe, expect, it, vi } from "vitest";

interface RecordedQuery {
  /** The raw template text with `$n` markers where params are bound. */
  text: string;
  params: unknown[];
}

const recorded: RecordedQuery[] = [];
const jsonCalls: unknown[] = [];

vi.mock("postgres", () => {
  const factory = (_url: string, _opts?: unknown) => {
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      recorded.push({
        text: strings.raw.map((s, i) => (i === 0 ? s : `$${i}${s}`)).join(""),
        params: values,
      });
      return Promise.resolve([]);
    };
    sql.json = (v: unknown) => {
      jsonCalls.push(v);
      return { __pgJsonParameter: v };
    };
    return sql;
  };
  return { default: factory };
});

import { PgCockpitStore } from "./cockpit";

beforeEach(() => {
  recorded.length = 0;
  jsonCalls.length = 0;
});

describe("PgCockpitStore.clearKill — re-arm must write JSONB null, never SQL NULL", () => {
  it("inlines 'null'::jsonb as a literal and binds only the instance", async () => {
    const store = new PgCockpitStore("postgres://cockpit-test");
    await store.clearKill("live");

    expect(recorded).toHaveLength(1);
    const q = recorded[0];
    // The JSONB null is a SQL LITERAL, not a bind — the only way postgres.js
    // sends the same wire value as the bot's ClearKill.
    expect(q.text).toContain("'null'::jsonb");
    expect(q.text).toContain("INSERT INTO funding_kill_switch");
    expect(q.text).toContain("ON CONFLICT (instance) DO UPDATE");
    // Exactly one bound param: the instance. NOTHING null goes over the wire.
    expect(q.params).toEqual(["live"]);
  });

  it("never routes the re-arm value through sql.json(null) (encodes SQL NULL → 23502 on the NOT NULL record column)", async () => {
    const store = new PgCockpitStore("postgres://cockpit-test");
    await store.clearKill("paper");

    expect(jsonCalls).not.toContain(null);
    // Belt and braces: no bound parameter is null/undefined, and no json
    // wrapper carrying null sneaks in under a different shape.
    for (const q of recorded) {
      for (const p of q.params) {
        expect(p).not.toBeNull();
        expect(p).not.toBeUndefined();
        if (typeof p === "object" && p !== null && "__pgJsonParameter" in p) {
          expect((p as { __pgJsonParameter: unknown }).__pgJsonParameter).not.toBeNull();
        }
      }
    }
  });
});

describe("PgCockpitStore.setKill — the kill record still binds through sql.json", () => {
  it("binds the {killed, reason, t} record as a jsonb parameter for the named instance", async () => {
    const store = new PgCockpitStore("postgres://cockpit-test");
    const record = { killed: true, reason: "webui kill by jordan: drill", t: 123 };
    await store.setKill("live", record);

    expect(recorded).toHaveLength(1);
    const q = recorded[0];
    expect(q.text).toContain("INSERT INTO funding_kill_switch");
    // Two binds: instance + the json-wrapped record (non-null objects encode
    // correctly through sql.json — only the null case is the trap).
    expect(q.params).toHaveLength(2);
    expect(q.params[0]).toBe("live");
    expect(jsonCalls).toEqual([record]);
    expect(q.params[1]).toEqual({ __pgJsonParameter: record });
  });
});
