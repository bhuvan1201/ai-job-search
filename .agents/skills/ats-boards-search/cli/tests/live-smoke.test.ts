import { describe, expect, test } from "bun:test";
import { parseJSON, runCLI } from "./helpers";

// Live smoke test against the real ATS APIs. Skipped by default: CI and the
// development sandbox have no network path to the portals. Run locally with
//   LIVE_PORTAL_TESTS=1 bun test tests/live-smoke.test.ts
// Keep volume modest: each search fetches every configured board once.

describe.skipIf(!process.env.LIVE_PORTAL_TESTS)("live ATS boards", () => {
  test("boards --check reaches at least one configured board", async () => {
    const r = await runCLI(["boards", "--check"]);
    const out = parseJSON<{ meta: { reachable: number }; boards: Array<{ name: string; status: string }> }>(r);
    expect(out.meta.reachable).toBeGreaterThan(0);
  }, 120000);

  test("search returns results with non-null id/title/url and detail resolves one", async () => {
    const r = await runCLI(["search", "-q", "engineer", "--limit", "5"]);
    const out = parseJSON<{ results: Array<{ id: string; title: string; url: string }> }>(r);
    expect(out.results.length).toBeGreaterThan(0);
    for (const row of out.results) {
      expect(row.id).toBeTruthy();
      expect(row.title).toBeTruthy();
      expect(row.url).toMatch(/^https:\/\//);
    }
    const d = await runCLI(["detail", out.results[0].id]);
    const job = parseJSON<{ description: string | null; isActive: boolean }>(d);
    expect(job.isActive).toBe(true);
    expect(job.description).toBeTruthy();
  }, 120000);
});
