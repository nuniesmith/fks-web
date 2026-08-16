import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawner } from "./spawner";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function res(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: new Headers(),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

// P2 — the respawn client call. The only real branching here is the optional
// body override (config's own bot_id vs. an explicit override), and URL
// encoding of the config name — both worth pinning directly, since a wrong
// body shape here is the difference between "respawns the intended bot" and
// a 400 `bot_id required (config has none)` from the spawner.
describe("spawner.respawn", () => {
  it("posts an empty body when no bot_id override is given (config's own bot_id is used)", async () => {
    mockFetch.mockResolvedValue(
      res({
        bot_id: "crypto-spot",
        old_container_id: "abc123",
        new_container_id: "def456",
        status: "respawned",
        image: "fks-bot-crypto-spot:latest",
      }),
    );
    await spawner.respawn("crypto-spot-live");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/spawner/configs/crypto-spot-live/respawn");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({});
  });

  it("posts { bot_id } when an override is passed", async () => {
    mockFetch.mockResolvedValue(
      res({
        bot_id: "crypto-spot",
        old_container_id: null,
        new_container_id: "def456",
        status: "respawned",
        image: "fks-bot-crypto-spot:latest",
      }),
    );
    await spawner.respawn("crypto-spot-live", "crypto-spot");
    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ bot_id: "crypto-spot" });
  });

  it("URL-encodes the config name", async () => {
    mockFetch.mockResolvedValue(res({ ok: false, error: "not found" }, { ok: false, status: 404 }));
    await expect(spawner.respawn("weird name/with slash")).rejects.toBeTruthy();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/spawner/configs/weird%20name%2Fwith%20slash/respawn");
  });

  it("resolves with the echoed old/new container ids on success", async () => {
    mockFetch.mockResolvedValue(
      res({
        bot_id: "crypto-spot",
        old_container_id: "abc123",
        new_container_id: "def456",
        status: "respawned",
        image: "fks-bot-crypto-spot:latest",
      }),
    );
    const out = await spawner.respawn("crypto-spot-live");
    expect(out.old_container_id).toBe("abc123");
    expect(out.new_container_id).toBe("def456");
  });
});
