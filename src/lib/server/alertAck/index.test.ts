import { describe, expect, it } from "vitest";
import { alertAckPost, alertInboxGet } from "./index";
import { MemoryAlertAckStore } from "./store";
import { alertKey } from "./logic";
import type { AlertInbox } from "$lib/types/alertInbox";

const PROM = "http://prom.test";

function promResponse(alerts: unknown[]): Response {
  return new Response(JSON.stringify({ data: { alerts } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const firing = [
  {
    labels: { alertname: "LiveSessionHalted", severity: "critical", symbol: "BTC" },
    activeAt: "2026-07-21T10:00:00Z",
    state: "firing",
  },
];

function ackBody() {
  return { key: alertKey(firing[0].labels, firing[0].activeAt), labels: firing[0].labels, activeAt: firing[0].activeAt };
}
function ackRequest(body: unknown): Request {
  return new Request("http://x/api/alerts/ack", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("GET /api/alerts/inbox", () => {
  it("Prometheus unreachable → prom_available:false, never an empty-green inbox", async () => {
    const store = new MemoryAlertAckStore();
    const r = await alertInboxGet(PROM, store, async () => {
      throw new Error("ECONNREFUSED");
    });
    const j = (await r.json()) as AlertInbox;
    expect(j.prom_available).toBe(false);
    expect(j.configured).toBe(true); // store is fine; only Prometheus is down
    expect(j.alerts).toEqual([]);
    expect(j.unacked_count).toBe(0);
  });

  it("ack store down → configured:false but the live alerts STILL render read-only", async () => {
    const brokenStore = {
      async configured() {
        throw new Error("db down");
      },
      async acksFor() {
        throw new Error("db down");
      },
      async insertAck() {
        throw new Error("db down");
      },
    };
    const r = await alertInboxGet(PROM, brokenStore, async () => promResponse(firing));
    const j = (await r.json()) as AlertInbox;
    expect(j.prom_available).toBe(true);
    expect(j.configured).toBe(false);
    expect(j.alerts).toHaveLength(1); // alert NOT hidden by the store outage
    expect(j.alerts[0].acked).toBeNull();
    expect(j.unacked_count).toBe(1);
  });

  it("no store configured (null) → configured:false, alerts still read-only", async () => {
    const r = await alertInboxGet(PROM, null, async () => promResponse(firing));
    const j = (await r.json()) as AlertInbox;
    expect(j.configured).toBe(false);
    expect(j.prom_available).toBe(true);
    expect(j.alerts).toHaveLength(1);
  });

  it("fully wired → an acked alert shows its ack and drops from unacked_count", async () => {
    const store = new MemoryAlertAckStore();
    await store.insertAck({
      alert_key: alertKey(firing[0].labels, firing[0].activeAt),
      alertname: "LiveSessionHalted",
      labels: firing[0].labels,
      active_at: firing[0].activeAt,
      acked_by: "jordan",
      note: "known",
    });
    const r = await alertInboxGet(PROM, store, async () => promResponse(firing));
    const j = (await r.json()) as AlertInbox;
    expect(j.configured).toBe(true);
    expect(j.alerts[0].acked?.by).toBe("jordan");
    expect(j.unacked_count).toBe(0);
  });
});

describe("POST /api/alerts/ack", () => {
  it("recomputes the key and 400s on mismatch (no acking an unseen blob)", async () => {
    const store = new MemoryAlertAckStore();
    const bad = { ...ackBody(), key: "deadbeef" }; // client-supplied key lies
    const r = await alertAckPost(ackRequest(bad), store, "jordan");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("key_mismatch");
  });

  it("400s on a body missing labels/activeAt", async () => {
    const store = new MemoryAlertAckStore();
    const r = await alertAckPost(ackRequest({ key: "x" }), store, "jordan");
    expect(r.status).toBe(400);
  });

  it("records an ack with acked_by = operator", async () => {
    const store = new MemoryAlertAckStore();
    const r = await alertAckPost(ackRequest(ackBody()), store, "jordan");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.acked.by).toBe("jordan");
  });

  it("idempotent double-ack → 200 returning the FIRST acker's row", async () => {
    const store = new MemoryAlertAckStore();
    const first = await (await alertAckPost(ackRequest(ackBody()), store, "jordan")).json();
    const second = await alertAckPost(ackRequest(ackBody()), store, "someone-else");
    expect(second.status).toBe(200);
    const j = await second.json();
    expect(j.ok).toBe(true);
    expect(j.acked.by).toBe("jordan"); // first ack wins (irrevocable row)
    expect(j.acked.at).toBe(first.acked.at);
  });

  it("store not configured → 503 (never a silent success)", async () => {
    const r = await alertAckPost(ackRequest(ackBody()), null, "jordan");
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("not_configured");
  });

  it("malformed JSON → 400", async () => {
    const store = new MemoryAlertAckStore();
    const req = new Request("http://x/api/alerts/ack", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    const r = await alertAckPost(req, store, "jordan");
    expect(r.status).toBe(400);
  });
});
