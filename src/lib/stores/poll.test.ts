import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get as readStore } from "svelte/store";
import { api } from "$api/client";
import { createPoll } from "./poll";

// The poll store's only I/O is `api.get`; mock it and drive the timers.
vi.mock("$api/client", () => ({ api: { get: vi.fn() } }));
const apiGet = vi.mocked(api.get);

beforeEach(() => {
  vi.useFakeTimers();
  apiGet.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createPoll", () => {
  it("fetches immediately on start and stores the result", async () => {
    apiGet.mockResolvedValue({ value: 1 });
    const poll = createPoll<{ value: number }>("/api/x", 1000);
    poll.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(apiGet).toHaveBeenCalledWith("/api/x");
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(readStore(poll)).toEqual({ value: 1 });
    poll.stop();
  });

  it("re-fetches on each interval tick", async () => {
    apiGet.mockResolvedValue({ value: 1 });
    const poll = createPoll("/api/x", 1000);
    poll.start();
    await vi.advanceTimersByTimeAsync(0); // immediate
    expect(apiGet).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(apiGet).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(apiGet).toHaveBeenCalledTimes(3);
    poll.stop();
  });

  it("stops fetching after stop()", async () => {
    apiGet.mockResolvedValue({ value: 1 });
    const poll = createPoll("/api/x", 1000);
    poll.start();
    await vi.advanceTimersByTimeAsync(0);
    poll.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(apiGet).toHaveBeenCalledTimes(1); // only the immediate fetch
  });

  it("skips the immediate fetch when immediate:false", async () => {
    apiGet.mockResolvedValue({ value: 1 });
    const poll = createPoll("/api/x", 1000, { immediate: false });
    poll.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(apiGet).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(apiGet).toHaveBeenCalledTimes(1);
    poll.stop();
  });

  it("ignores a second start() (no duplicate intervals)", async () => {
    apiGet.mockResolvedValue({ value: 1 });
    const poll = createPoll("/api/x", 1000);
    poll.start();
    poll.start(); // guarded by the `active` flag
    await vi.advanceTimersByTimeAsync(0);
    expect(apiGet).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(apiGet).toHaveBeenCalledTimes(2); // not 4
    poll.stop();
  });

  it("captures errors without crashing and leaves data null", async () => {
    apiGet.mockRejectedValue(new Error("boom"));
    const poll = createPoll("/api/x", 1000);
    poll.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(readStore(poll)).toBeNull();
    expect(readStore(poll.error)).toBe("boom");
    expect(readStore(poll.loading)).toBe(false);
    poll.stop();
  });

  it("applies the transform before storing", async () => {
    apiGet.mockResolvedValue({ n: 21 });
    const poll = createPoll<number>("/api/x", 1000, {
      transform: (raw: any) => raw.n * 2,
    });
    poll.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(readStore(poll)).toBe(42);
    poll.stop();
  });

  it("refresh() fetches once, independent of the interval", async () => {
    apiGet.mockResolvedValue({ value: 1 });
    const poll = createPoll("/api/x", 1000, { immediate: false });
    await poll.refresh();
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(readStore(poll)).toEqual({ value: 1 });
  });
});

describe("createPoll shared/deduped pollers", () => {
  it("shares one interval + fetch across subscribers to the same (url, interval)", async () => {
    apiGet.mockResolvedValue({ value: 1 });
    const a = createPoll("/api/shared", 1000);
    const b = createPoll("/api/shared", 1000);
    a.start();
    b.start();
    await vi.advanceTimersByTimeAsync(0);
    // Only ONE immediate fetch is issued, even with two subscribers.
    expect(apiGet).toHaveBeenCalledTimes(1);
    // Both handles observe the shared value.
    expect(readStore(a)).toEqual({ value: 1 });
    expect(readStore(b)).toEqual({ value: 1 });
    // One fetch per tick, not two.
    await vi.advanceTimersByTimeAsync(1000);
    expect(apiGet).toHaveBeenCalledTimes(2);
    a.stop();
    b.stop();
  });

  it("keeps polling until the LAST subscriber stops (ref-count teardown)", async () => {
    apiGet.mockResolvedValue({ value: 1 });
    const a = createPoll("/api/rc", 1000);
    const b = createPoll("/api/rc", 1000);
    a.start();
    b.start();
    await vi.advanceTimersByTimeAsync(0); // immediate → 1
    await vi.advanceTimersByTimeAsync(1000); // tick → 2
    expect(apiGet).toHaveBeenCalledTimes(2);

    a.stop(); // one subscriber left — timer must survive
    await vi.advanceTimersByTimeAsync(1000); // tick → 3
    expect(apiGet).toHaveBeenCalledTimes(3);

    b.stop(); // last subscriber — timer torn down
    await vi.advanceTimersByTimeAsync(5000);
    expect(apiGet).toHaveBeenCalledTimes(3); // no further fetches
  });

  it("de-dupes only the immediate fetch too (second start() piggybacks)", async () => {
    apiGet.mockResolvedValue({ value: 1 });
    const a = createPoll("/api/imm", 1000);
    const b = createPoll("/api/imm", 1000);
    a.start(); // refCount 0→1 → immediate fetch
    b.start(); // refCount 1→2 → NO extra immediate fetch
    await vi.advanceTimersByTimeAsync(0);
    expect(apiGet).toHaveBeenCalledTimes(1);
    a.stop();
    b.stop();
  });

  it("does NOT share across different urls", async () => {
    apiGet.mockResolvedValue({ value: 1 });
    const a = createPoll("/api/u1", 1000);
    const b = createPoll("/api/u2", 1000);
    a.start();
    b.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(apiGet).toHaveBeenCalledTimes(2); // one per distinct url
    expect(apiGet).toHaveBeenCalledWith("/api/u1");
    expect(apiGet).toHaveBeenCalledWith("/api/u2");
    a.stop();
    b.stop();
  });

  it("does NOT share across different intervals for the same url", async () => {
    apiGet.mockResolvedValue({ value: 1 });
    const a = createPoll("/api/int", 1000);
    const b = createPoll("/api/int", 2000);
    a.start();
    b.start();
    await vi.advanceTimersByTimeAsync(0);
    // Two independent engines ⇒ two immediate fetches.
    expect(apiGet).toHaveBeenCalledTimes(2);
    a.stop();
    b.stop();
  });

  it("re-uses a fresh engine after full teardown (last stop evicts)", async () => {
    apiGet.mockResolvedValue({ value: 1 });
    const a = createPoll("/api/reuse", 1000);
    a.start();
    await vi.advanceTimersByTimeAsync(0);
    a.stop(); // evicts the engine from the registry
    await vi.advanceTimersByTimeAsync(3000);
    expect(apiGet).toHaveBeenCalledTimes(1); // stayed torn down

    const b = createPoll("/api/reuse", 1000);
    b.start(); // brand-new engine, fresh timer
    await vi.advanceTimersByTimeAsync(0);
    expect(apiGet).toHaveBeenCalledTimes(2);
    b.stop();
  });

  it("each subscriber applies its OWN transform to the shared fetch", async () => {
    apiGet.mockResolvedValue({ n: 10 });
    const raw = createPoll<{ n: number }>("/api/tf", 1000);
    const doubled = createPoll<number>("/api/tf", 1000, {
      transform: (r: any) => r.n * 2,
    });
    raw.start();
    doubled.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(apiGet).toHaveBeenCalledTimes(1); // shared fetch
    expect(readStore(raw)).toEqual({ n: 10 });
    expect(readStore(doubled)).toBe(20);
    raw.stop();
    doubled.stop();
  });

  it("a repeated start()/stop() on one handle ref-counts correctly", async () => {
    apiGet.mockResolvedValue({ value: 1 });
    const a = createPoll("/api/guard", 1000);
    const b = createPoll("/api/guard", 1000);
    a.start();
    a.start(); // guarded no-op — must not add a second ref
    b.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(apiGet).toHaveBeenCalledTimes(1);
    a.stop(); // a's single ref released; b still active
    a.stop(); // guarded no-op
    await vi.advanceTimersByTimeAsync(1000);
    expect(apiGet).toHaveBeenCalledTimes(2); // still polling for b
    b.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(apiGet).toHaveBeenCalledTimes(2); // fully torn down
  });
});

describe("updatedAt — freshness must track TRUTH, not attempts", () => {
  it("advances on a successful fetch", async () => {
    apiGet.mockResolvedValue({ v: 1 });
    const poll = createPoll<{ v: number }>("/api/fresh-ok", 10_000);
    expect(readStore(poll.updatedAt)).toBeNull();

    poll.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(readStore(poll.updatedAt)).toBeTypeOf("number");
    poll.stop();
  });

  it("does NOT advance on a failed fetch — a dead feed must not look current", async () => {
    apiGet.mockResolvedValueOnce({ v: 1 });
    const poll = createPoll<{ v: number }>("/api/fresh-fail", 10_000);
    poll.start();
    await vi.advanceTimersByTimeAsync(0);

    const afterSuccess = readStore(poll.updatedAt);
    expect(afterSuccess).toBeTypeOf("number");

    // The backend dies. Attempts keep happening on every tick; TRUTH must not
    // advance, or a dead feed renders as perfectly current.
    apiGet.mockRejectedValue(new Error("upstream down"));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(readStore(poll.error)).toBe("upstream down");
    expect(
      readStore(poll.updatedAt),
      "a failing poll must leave updatedAt at the last GOOD fetch",
    ).toBe(afterSuccess);
    poll.stop();
  });

  it("recovers: a later success advances it again", async () => {
    apiGet.mockRejectedValueOnce(new Error("down"));
    const poll = createPoll<{ v: number }>("/api/fresh-recover", 10_000);
    poll.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(readStore(poll.updatedAt)).toBeNull(); // never succeeded yet

    apiGet.mockResolvedValue({ v: 2 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(readStore(poll.updatedAt)).toBeTypeOf("number");
    poll.stop();
  });

  it("is shared across handles on the same (url, interval) key", async () => {
    apiGet.mockResolvedValue({ v: 1 });
    const a = createPoll<{ v: number }>("/api/fresh-shared", 10_000);
    const b = createPoll<{ v: number }>("/api/fresh-shared", 10_000);

    a.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(readStore(b.updatedAt)).toBe(readStore(a.updatedAt));
    expect(readStore(b.updatedAt)).toBeTypeOf("number");
    a.stop();
  });
});
