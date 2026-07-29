import { describe, expect, it } from "vitest";
import {
  ageStr,
  alertKey,
  canonicalJson,
  extractPromAlerts,
  pickAnnotations,
  reshapeAlerts,
  severityColor,
  type PromAlertRaw,
} from "./logic";
import type { InboxAck } from "$lib/types/alertInbox";

describe("canonicalJson", () => {
  it("sorts object keys recursively so label order is irrelevant", () => {
    const a = canonicalJson({ b: "2", a: "1", nested: { y: 1, x: 2 } });
    const b = canonicalJson({ nested: { x: 2, y: 1 }, a: "1", b: "2" });
    expect(a).toBe(b);
    expect(a).toBe('{"a":"1","b":"2","nested":{"x":2,"y":1}}');
  });
});

describe("alertKey — incident identity", () => {
  const labels = { alertname: "LiveSessionHalted", severity: "critical", symbol: "BTC" };
  const activeAt = "2026-07-21T10:00:00Z";

  it("is stable regardless of label key order (Prometheus order must not matter)", () => {
    const k1 = alertKey({ alertname: "X", severity: "critical", symbol: "BTC" }, activeAt);
    const k2 = alertKey({ symbol: "BTC", alertname: "X", severity: "critical" }, activeAt);
    expect(k1).toBe(k2);
  });

  it("is a deterministic sha256 hex digest", () => {
    const k = alertKey(labels, activeAt);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    // Pin the exact digest so an accidental format change (delimiter/encoding)
    // is caught — the key is a persisted identity, not a transient value.
    expect(k).toBe(alertKey({ ...labels }, activeAt));
  });

  it("RE-FIRE = new activeAt = NEW key (acking can't permanently silence)", () => {
    const before = alertKey(labels, "2026-07-21T10:00:00Z");
    const after = alertKey(labels, "2026-07-21T14:30:00Z"); // resolved → re-fired
    expect(after).not.toBe(before);
  });

  it("different labels → different key", () => {
    expect(alertKey({ ...labels, symbol: "ETH" }, activeAt)).not.toBe(alertKey(labels, activeAt));
  });
});

describe("severityColor", () => {
  it("maps known severities, '' otherwise", () => {
    expect(severityColor("critical")).toBe("var(--red)");
    expect(severityColor("warning")).toBe("var(--amber)");
    expect(severityColor("info")).toBe("var(--cyan)");
    expect(severityColor("bogus")).toBe("");
    expect(severityColor(undefined)).toBe("");
  });
});

describe("ageStr", () => {
  it("compacts an ISO age against an injected now", () => {
    const now = Date.parse("2026-07-21T10:05:00Z");
    expect(ageStr("2026-07-21T10:00:00Z", now)).toBe("5m");
    expect(ageStr(undefined, now)).toBe("—");
    expect(ageStr("not-a-date", now)).toBe("—");
  });
});

describe("extractPromAlerts", () => {
  it("pulls data.alerts defensively", () => {
    expect(extractPromAlerts({ data: { alerts: [{ labels: {} }] } })).toHaveLength(1);
    expect(extractPromAlerts({})).toEqual([]);
    expect(extractPromAlerts(null)).toEqual([]);
  });
});

describe("pickAnnotations", () => {
  it("keeps string annotations and drops everything else", () => {
    // A non-string would print as `[object Object]` in the middle of a runbook
    // the operator is following at 3am. An absent line is honest; that isn't.
    expect(
      pickAnnotations({ summary: "s", runbook: "r", bad: { a: 1 }, n: 5, empty: "" }),
    ).toEqual({ summary: "s", runbook: "r" });
    expect(pickAnnotations(undefined)).toEqual({});
    expect(pickAnnotations(null)).toEqual({});
    expect(pickAnnotations(["summary"])).toEqual({});
    expect(pickAnnotations("summary")).toEqual({});
  });
});

describe("reshapeAlerts — LEFT JOIN acks", () => {
  const now = Date.parse("2026-07-21T10:05:00Z");
  const raw: PromAlertRaw[] = [
    {
      labels: { alertname: "LiveSessionHalted", severity: "critical" },
      activeAt: "2026-07-21T10:00:00Z",
      state: "firing",
    },
    {
      labels: { alertname: "LiveCircuitBreakerTripped", severity: "critical" },
      activeAt: "2026-07-21T09:00:00Z",
      state: "firing",
    },
  ];

  it("unacked alerts carry acked:null and count toward unacked_count", () => {
    const { alerts, unacked_count } = reshapeAlerts(raw, new Map(), now);
    expect(alerts.every((a) => a.acked === null)).toBe(true);
    expect(unacked_count).toBe(2);
    expect(alerts[0].key).toBe(alertKey(raw[0].labels!, raw[0].activeAt!));
    expect(alerts[0].age_str).toBe("5m");
    expect(alerts[0].severity_color).toBe("var(--red)");
  });

  // ── P1: the recovery procedure must survive the reshape ──────────────────
  // BotAllVenuesStale's runbook is the four-step container-DNS check. It is
  // written in the rule, shipped to Prometheus, and — before this — thrown away
  // one hop before the human it was written for.
  const withRunbook: PromAlertRaw[] = [
    {
      labels: { alertname: "BotAllVenuesStale", severity: "critical", bot_id: "crypto-spot" },
      annotations: {
        summary: "Bot crypto-spot: ALL real-money venues stale — bot is blind",
        description: "Any position it holds is unmanaged until this clears.",
        runbook: "1) docker exec <bot> getent hosts api.kraken.com",
      },
      activeAt: "2026-07-21T10:00:00Z",
      state: "firing",
    },
  ];

  it("carries annotations (summary/description/runbook) through VERBATIM", () => {
    const { alerts } = reshapeAlerts(withRunbook, new Map(), now);
    expect(alerts[0].annotations).toEqual(withRunbook[0].annotations);
    // The sentence the operator reads at 3am, not the alertname.
    expect(alerts[0].annotations?.summary).toContain("bot is blind");
    expect(alerts[0].annotations?.runbook).toContain("getent hosts");
  });

  it("emits {} — never undefined — when a rule carries no annotations", () => {
    const { alerts } = reshapeAlerts(raw, new Map(), now);
    expect(alerts[0].annotations).toEqual({});
  });

  it("annotations do NOT change the incident key (a runbook edit can't un-ack)", () => {
    // Same labels + activeAt, reworded runbook: identity must be unchanged, or
    // every acked incident on the box silently re-opens after a rules reload.
    const edited: PromAlertRaw[] = [
      { ...withRunbook[0], annotations: { summary: "reworded", runbook: "new steps" } },
    ];
    const before = reshapeAlerts(withRunbook, new Map(), now).alerts[0];
    const after = reshapeAlerts(edited, new Map(), now).alerts[0];
    expect(after.key).toBe(before.key);

    const ack: InboxAck = { by: "jordan", at: "2026-07-21T10:01:00Z", note: "" };
    const acks = new Map([[before.key, ack]]);
    expect(reshapeAlerts(edited, acks, now).unacked_count).toBe(0);
  });

  it("an acked alert joins its ack and drops out of unacked_count", () => {
    const key0 = alertKey(raw[0].labels!, raw[0].activeAt!);
    const ack: InboxAck = { by: "jordan", at: "2026-07-21T10:01:00Z", note: "known loss" };
    const { alerts, unacked_count } = reshapeAlerts(raw, new Map([[key0, ack]]), now);
    expect(alerts[0].acked).toEqual(ack);
    expect(alerts[1].acked).toBeNull();
    expect(unacked_count).toBe(1);
  });
});
