import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseJSON, runCLI } from "./helpers";
import { startFixtureServer, type FixtureServer } from "./fixture-server";

// The documented CLI in a fresh process, against a loopback stand-in for the
// Algolia and Firebase HN APIs. Every path from argv to rendered output runs.

interface SearchOut {
  meta: { count: number; page: number; pageSize: number; total: number; threads: Array<{ id: string; title: string; comments: number }> };
  results: Array<Record<string, unknown>>;
}

let fx: FixtureServer;
beforeAll(() => {
  fx = startFixtureServer();
});
afterAll(() => fx.stop());

const cli = (args: string[]) => runCLI(args, fx.env);

describe("search", () => {
  test("latest thread only by default: filtered threads, top-level comments, newest first, contract fields", async () => {
    const r = await cli(["search", "-q", "engineer|scientist|analyst|tools"]);
    const out = parseJSON<SearchOut>(r);
    expect(out.meta).toMatchObject({ count: 7, page: 1, pageSize: 20, total: 7 });
    expect(out.meta.threads).toEqual([{ id: "41709301", title: "Ask HN: Who is hiring? (October 2026)", comments: 7 }]);
    expect(out.results.map((x) => x.id)).toEqual(["41710000", "41709950", "41709900", "41709700", "41709650", "41709600", "41709555"]);
    for (const row of out.results) {
      for (const k of [
        "id", "title", "company", "location", "date", "url", "remote", "workplace", "salary", "employmentType", "author", "threadId", "threadTitle", "snippet",
      ]) {
        expect(row).toHaveProperty(k);
        expect(row[k]).not.toBeUndefined();
      }
      expect(row).not.toHaveProperty("description");
      expect(String(row.date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(String(row.url)).toBe(`https://news.ycombinator.com/item?id=${row.id}`);
      expect(String(row.title).length).toBeGreaterThan(0);
    }
    // Two requests: find threads, fetch the thread. No Firebase.
    expect(fx.requests.some((p) => p.startsWith("/api/v1/search_by_date"))).toBe(true);
    expect(fx.requests.some((p) => p === "/api/v1/items/41709301")).toBe(true);
    expect(fx.requests.some((p) => p.startsWith("/v0/item/"))).toBe(false);
  });

  test("--query is an OR of case-insensitive phrases over header + body", async () => {
    let out = parseJSON<SearchOut>(await cli(["search", "-q", "VLLM"]));
    expect(out.results.map((x) => x.id)).toEqual(["41709950"]);
    out = parseJSON<SearchOut>(await cli(["search", "-q", "product analytics|vision models"]));
    expect(out.results.map((x) => x.id)).toEqual(["41709650", "41709600"]);
    out = parseJSON<SearchOut>(await cli(["search", "-q", "cobol"]));
    expect(out.meta.total).toBe(0);
    expect(out.results).toEqual([]);
  });

  test("--location matches the location field and the header loosely; Remote matches the tag", async () => {
    let out = parseJSON<SearchOut>(await cli(["search", "-q", "engineer", "-l", "San Francisco"]));
    expect(out.results.map((x) => x.id)).toEqual(["41709555"]);
    // 41709700 is the no-pipe prose ad that says "remote-friendly" in its header line.
    out = parseJSON<SearchOut>(await cli(["search", "-q", "engineer|scientist", "-l", "Remote"]));
    expect(out.results.map((x) => x.id)).toEqual(["41709950", "41709700", "41709600"]);
    out = parseJSON<SearchOut>(await cli(["search", "-q", "engineer|scientist|analyst", "-l", ", CA"]));
    expect(out.results.map((x) => x.id).sort()).toEqual(["41709555", "41709650"]);
    out = parseJSON<SearchOut>(await cli(["search", "-q", "engineer", "-l", "Austin"]));
    expect(out.results.map((x) => x.id)).toEqual(["41709950"]);
  });

  test("--remote filters on the header tags", async () => {
    const q = ["search", "-q", "engineer|scientist|analyst"];
    let out = parseJSON<SearchOut>(await cli([...q, "--remote", "remote"]));
    expect(out.results.map((x) => x.id)).toEqual(["41709950", "41709700", "41709600"]);
    out = parseJSON<SearchOut>(await cli([...q, "--remote", "hybrid"]));
    expect(out.results.map((x) => x.id)).toEqual(["41710000", "41709555"]);
    out = parseJSON<SearchOut>(await cli([...q, "--remote", "onsite"]));
    expect(out.results.map((x) => x.id)).toEqual(["41709900", "41709650"]);
  });

  test("--jobage applies to the comment date", async () => {
    // Fixture comments are dated 2026-10-01..04; a huge window keeps all, a tiny one none.
    let out = parseJSON<SearchOut>(await cli(["search", "-q", "engineer|scientist|analyst|tools", "--jobage", "100000"]));
    expect(out.meta.total).toBe(7);
    out = parseJSON<SearchOut>(await cli(["search", "-q", "engineer", "--jobage", "1"]));
    expect(out.meta.total).toBe(0);
  });

  test("--months 2 merges two threads; --thread targets one", async () => {
    let out = parseJSON<SearchOut>(await cli(["search", "-q", "machine learning engineer", "--months", "2"]));
    expect(out.meta.threads.map((t) => t.id)).toEqual(["41709301", "41500001"]);
    expect(out.results.map((x) => x.id)).toEqual(["41709950", "41500777"]);
    expect(out.results[1].threadTitle).toBe("Ask HN: Who is hiring? (September 2026)");

    out = parseJSON<SearchOut>(await cli(["search", "-q", "engineer", "--thread", "41500001"]));
    expect(out.meta.threads).toEqual([{ id: "41500001", title: "Ask HN: Who is hiring? (September 2026)", comments: 1 }]);
    expect(out.results.map((x) => x.id)).toEqual(["41500777"]);
  });

  test("--thread on a non-hiring story is SEARCH_FAILED", async () => {
    const r = await cli(["search", "-q", "sf", "--thread", "42000000"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr).code).toBe("SEARCH_FAILED");
    expect(r.stdout).toBe("");
  });

  test("--page and --limit are client-side over the sorted list", async () => {
    const q = ["search", "-q", "engineer|scientist|analyst|tools"];
    let out = parseJSON<SearchOut>(await cli([...q, "--limit", "2"]));
    expect(out.meta).toMatchObject({ count: 2, total: 7, page: 1 });
    expect(out.results.map((x) => x.id)).toEqual(["41710000", "41709950"]);
    out = parseJSON<SearchOut>(await cli([...q, "--page", "2"]));
    expect(out.meta).toMatchObject({ count: 0, total: 7, page: 2 });
  });

  test("table and plain formats render, and json is parseable with nothing else on stdout", async () => {
    const t = await cli(["search", "-q", "engineer", "--format", "table"]);
    expect(t.exitCode).toBe(0);
    expect(t.stdout.split("\n")[0]).toMatch(/^ID\s+TITLE\s+COMPANY\s+LOCATION\s+WORKPLACE\s+DATE$/);
    expect(t.stdout).toContain("Acme AI");
    const p = await cli(["search", "-q", "engineer", "--format", "plain"]);
    expect(p.stdout).toContain("Senior ML Engineer\n  Acme AI · San Francisco, CA · HYBRID · 2026-10-01\n  $200k-$260k + equity\n  id: 41709555");
    const j = await cli(["search", "-q", "engineer"]);
    expect(() => JSON.parse(j.stdout)).not.toThrow();
  });
});

describe("detail", () => {
  test("by id: header fields + full description with paragraph breaks, isActive true", async () => {
    const job = parseJSON<Record<string, unknown>>(await cli(["detail", "41709555"]));
    expect(job).toMatchObject({
      id: "41709555",
      title: "Senior ML Engineer",
      company: "Acme AI",
      location: "San Francisco, CA",
      date: "2026-10-01",
      url: "https://news.ycombinator.com/item?id=41709555",
      remote: false,
      workplace: "HYBRID",
      salary: "$200k-$260k + equity",
      employmentType: "Full-time",
      author: "acmeai_hr",
      threadId: "41709301",
      threadTitle: "Ask HN: Who is hiring? (October 2026)",
      isActive: true,
    });
    expect(String(job.description).split("\n")).toHaveLength(3);
    expect(String(job.description)).toContain("Apply: https://acme.ai/careers");
  });

  test("by news.ycombinator.com URL, plain format", async () => {
    const r = await cli(["detail", "https://news.ycombinator.com/item?id=41709950", "--format", "plain"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Machine Learning Engineer, LLM Applications");
    expect(r.stdout).toContain("Quill & Co");
    expect(r.stdout).toContain("Salary: USD 170k/yr");
    expect(r.stdout).toContain('"small but mighty"');
  });

  test("a comment in a 'Who wants to be hired?' thread is NOT_A_HIRING_POST", async () => {
    const r = await cli(["detail", "42000001"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr).code).toBe("NOT_A_HIRING_POST");
    expect(r.stdout).toBe("");
  });

  test("a story (not a comment) and a nested reply are NOT_A_HIRING_POST", async () => {
    let r = await cli(["detail", "41709301"]);
    expect(JSON.parse(r.stderr).code).toBe("NOT_A_HIRING_POST");
    r = await cli(["detail", "41709800"]);
    expect(JSON.parse(r.stderr).code).toBe("NOT_A_HIRING_POST");
  });

  test("an unknown id is NOT_FOUND", async () => {
    const r = await cli(["detail", "99999999"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr).code).toBe("NOT_FOUND");
  });

  test("a deleted comment is NOT_FOUND", async () => {
    const r = await cli(["detail", "41709750"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr).code).toBe("NOT_FOUND");
  });
});

describe("Firebase fallback", () => {
  test("when the Algolia items endpoint has no answer, the thread is read from Firebase one comment at a time", async () => {
    // A 404 exercises the same fallback branch as a 5xx-after-retries without
    // the ~25s of backoff the retry test covers separately.
    const fb = startFixtureServer((path) => (path.startsWith("/api/v1/items/") ? new Response("Not Found", { status: 404 }) : null));
    try {
      const r = await runCLI(["search", "-q", "engineer|scientist|analyst|tools"], fb.env);
      const out = parseJSON<SearchOut>(r);
      expect(out.meta.total).toBe(7);
      expect(out.meta.threads[0]).toEqual({ id: "41709301", title: "Ask HN: Who is hiring? (October 2026)", comments: 7 });
      expect(out.results.find((x) => x.id === "41709555")).toMatchObject({ title: "Senior ML Engineer", company: "Acme AI", date: "2026-10-01" });
      expect(fb.requests.filter((p) => p === "/v0/item/41709301.json").length).toBe(1);
      expect(fb.requests.filter((p) => /^\/v0\/item\/\d+\.json$/.test(p)).length).toBe(9); // story + 8 kids

      const d = await runCLI(["detail", "41709600"], fb.env);
      const job = parseJSON<Record<string, unknown>>(d);
      expect(job).toMatchObject({ id: "41709600", company: "Nova Labs", remote: true, threadId: "41709301", isActive: true });
    } finally {
      fb.stop();
    }
  }, 60000);
});
