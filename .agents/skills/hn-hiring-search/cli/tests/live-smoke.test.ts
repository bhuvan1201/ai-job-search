import { describe, expect, test } from "bun:test";
import { parseJSON, runCLI } from "./helpers";

// Live smoke test against the real HN APIs. Skipped by default: CI and the
// development sandbox have no network path to the portals. Run locally with
//   LIVE_PORTAL_TESTS=1 bun test tests/live-smoke.test.ts

describe.skipIf(!process.env.LIVE_PORTAL_TESTS)("live HN who-is-hiring", () => {
  test("search finds the current thread and returns results with non-null id/title/url; detail resolves one", async () => {
    const r = await runCLI(["search", "-q", "engineer", "--limit", "5"]);
    const out = parseJSON<{ meta: { threads: Array<{ id: string; title: string }> }; results: Array<{ id: string; title: string; url: string }> }>(r);
    expect(out.meta.threads.length).toBe(1);
    expect(out.meta.threads[0].title).toMatch(/^Ask HN: Who is hiring\?/);
    expect(out.results.length).toBeGreaterThan(0);
    for (const row of out.results) {
      expect(row.id).toMatch(/^\d+$/);
      expect(row.title).toBeTruthy();
      expect(row.url).toMatch(/^https:\/\/news\.ycombinator\.com\/item\?id=\d+$/);
    }
    const d = await runCLI(["detail", out.results[0].id]);
    const job = parseJSON<{ description: string | null; isActive: boolean }>(d);
    expect(job.isActive).toBe(true);
    expect(job.description).toBeTruthy();
  }, 120000);
});
