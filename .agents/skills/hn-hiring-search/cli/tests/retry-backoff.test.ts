import { afterEach, describe, expect, test } from "bun:test";
import { jsonFetch, mapLimit } from "../src/helpers";

// The portal contract requires backoff on 429/5xx and a null on 404. A stubbed
// fetch counts attempts and a stubbed setTimeout fires immediately so the
// exhaustion case does not sleep through the real 500ms -> 8s schedule.

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

function instantTimers() {
  globalThis.setTimeout = ((fn: () => void) => originalSetTimeout(fn, 0)) as unknown as typeof setTimeout;
}

function stubFetch(responses: Array<() => Response>): { calls: number; headers: Headers[] } {
  const state = { calls: 0, headers: [] as Headers[] };
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const i = Math.min(state.calls, responses.length - 1);
    state.calls++;
    state.headers.push(new Headers(init?.headers));
    return responses[i]();
  }) as unknown as typeof fetch;
  return state;
}

describe("jsonFetch retry/backoff", () => {
  test("retries a 429 and succeeds on the next attempt", async () => {
    instantTimers();
    const state = stubFetch([
      () => new Response("", { status: 429 }),
      () => new Response('{"hits":[]}', { status: 200 }),
    ]);
    const body = await jsonFetch<{ hits: unknown[] }>("https://x/y");
    expect(body).toEqual({ hits: [] });
    expect(state.calls).toBe(2);
  });

  test("returns null on 404 without retrying", async () => {
    const state = stubFetch([() => new Response("", { status: 404 })]);
    expect(await jsonFetch("https://x/y")).toBeNull();
    expect(state.calls).toBe(1);
  });

  test("gives up after the initial attempt plus six retries on persistent 5xx", async () => {
    instantTimers();
    const state = stubFetch([() => new Response("", { status: 503 })]);
    await expect(jsonFetch("https://x/y")).rejects.toThrow(/503/);
    expect(state.calls).toBe(7);
  });

  test("a non-retryable 4xx throws at once; an unparseable 200 body throws", async () => {
    let state = stubFetch([() => new Response("", { status: 403 })]);
    await expect(jsonFetch("https://x/y")).rejects.toThrow(/403/);
    expect(state.calls).toBe(1);
    state = stubFetch([() => new Response("<html>", { status: 200 })]);
    await expect(jsonFetch("https://x/y")).rejects.toThrow(/unparseable/);
  });

  test("a literal null body (Firebase's answer for an unknown id) is null, not an error", async () => {
    stubFetch([() => new Response("null", { status: 200 })]);
    expect(await jsonFetch("https://x/y")).toBeNull();
  });

  test("sends the honest tool User-Agent", async () => {
    const state = stubFetch([() => new Response("[]", { status: 200 })]);
    await jsonFetch("https://x/y");
    expect(state.headers[0].get("User-Agent")).toBe("Mozilla/5.0 (compatible; hn-hiring-search-cli/1.0)");
  });
});

describe("mapLimit", () => {
  test("never runs more than the limit concurrently and keeps input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 6, 7, 8], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => originalSetTimeout(r, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 60, 70, 80]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});
