import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseJSON, runCLI } from "./helpers";
import { startFixtureServer, type FixtureServer } from "./fixture-server";

// The documented CLI in a fresh process, against a loopback stand-in for the
// three ATS APIs. Every path from argv to rendered output runs for real.

interface SearchOut {
  meta: { count: number; page: number; pageSize: number; total: number; boards: number; boardsFailed: number; errors: Array<{ company: string; error: string }> };
  results: Array<Record<string, unknown>>;
}

let fx: FixtureServer;
beforeAll(() => {
  fx = startFixtureServer();
});
afterAll(() => fx.stop());

const cli = (args: string[]) => runCLI([...args, "--companies", fx.companiesPath], fx.env);

describe("search", () => {
  test("merges all three boards, sorts newest first, carries the contract fields", async () => {
    const r = await cli(["search", "-q", "engineer|scientist|executive"]);
    const out = parseJSON<SearchOut>(r);
    expect(out.meta).toMatchObject({ count: 7, page: 1, pageSize: 20, total: 7, boards: 3, boardsFailed: 0, errors: [] });
    expect(out.results.map((x) => x.title)).toEqual([
      "Staff Data Engineer",
      "Account Executive, Enterprise",
      "Machine Learning Engineer, Inference",
      "Senior ML Engineer, Training Infrastructure",
      "Research Engineer, Alignment",
      "Analytics Engineer",
      "Data Scientist, Product Analytics",
    ]);
    for (const row of out.results) {
      for (const k of ["id", "title", "company", "location", "date", "url", "ats", "department", "remote", "applyUrl"]) {
        expect(row).toHaveProperty(k);
        expect(row[k]).not.toBeUndefined();
      }
      expect(row).not.toHaveProperty("description");
      expect(String(row.date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // One fetch per board, no more.
    expect(fx.requests.filter((p) => p.startsWith("/v1/boards/")).length).toBeGreaterThanOrEqual(1);
  });

  test("--location, --remote, --jobage and --company narrow the merged list", async () => {
    let out = parseJSON<SearchOut>(await cli(["search", "-q", "engineer", "-l", "Remote"]));
    expect(out.results.map((x) => x.title).sort()).toEqual(["Analytics Engineer", "Senior ML Engineer, Training Infrastructure", "Staff Data Engineer"]);

    out = parseJSON<SearchOut>(await cli(["search", "-q", "engineer", "--remote", "hybrid"]));
    expect(out.results.map((x) => x.title)).toEqual(["Senior ML Engineer, Training Infrastructure"]);

    out = parseJSON<SearchOut>(await cli(["search", "-q", "engineer", "--company", "Orbital"]));
    expect(out.meta.boards).toBe(1);
    expect(out.results.every((x) => x.ats === "ashby")).toBe(true);

    out = parseJSON<SearchOut>(await cli(["search", "-q", "engineer", "--company", "novalabs", "--jobage", "100000"]));
    expect(out.results).toHaveLength(2);
  });

  test("--page and --limit paginate client-side; an empty page is count 0 with total intact", async () => {
    const p1 = parseJSON<SearchOut>(await cli(["search", "-q", "engineer|scientist|executive", "--limit", "2"]));
    expect(p1.meta.count).toBe(2);
    expect(p1.meta.total).toBe(7);
    const p2 = parseJSON<SearchOut>(await cli(["search", "-q", "engineer|scientist|executive", "--page", "2"]));
    expect(p2.meta).toMatchObject({ count: 0, page: 2, total: 7 });
    expect(p2.results).toEqual([]);
  });

  test("unknown --company exits 1 with NO_COMPANIES", async () => {
    const r = await cli(["search", "-q", "engineer", "--company", "nobody"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr).code).toBe("NO_COMPANIES");
  });

  test("table and plain formats render and keep stdout free of JSON errors", async () => {
    const t = await cli(["search", "-q", "data", "--format", "table"]);
    expect(t.exitCode).toBe(0);
    expect(t.stdout).toContain("ID");
    expect(t.stdout).toContain("Staff Data Engineer");
    const p = await cli(["search", "-q", "data", "--format", "plain"]);
    expect(p.exitCode).toBe(0);
    expect(p.stdout).toContain("id: ashby:orbital:");
    const none = await cli(["search", "-q", "zzzz-no-such-role", "--format", "table"]);
    expect(none.exitCode).toBe(0);
    expect(none.stdout).toBe("No results.");
  });
});

describe("search tolerates per-board failures", () => {
  test("a 404 board and a 500 board are recorded in meta.errors while the rest return", async () => {
    const broken = startFixtureServer((path) => {
      if (path.startsWith("/v0/postings/novalabs")) return new Response("boom", { status: 500 });
      if (path.startsWith("/posting-api/job-board/orbital")) return new Response("nope", { status: 404 });
      return null;
    });
    try {
      // Instant timers are not available across the process boundary, so the
      // 500 board exhausts its backoff here (~16s) - within the 30s test timeout.
      const r = await runCLI(["search", "-q", "engineer|scientist", "--companies", broken.companiesPath], broken.env);
      const out = parseJSON<SearchOut>(r);
      expect(out.meta.boards).toBe(3);
      expect(out.meta.boardsFailed).toBe(2);
      expect(out.meta.errors.map((e) => e.company).sort()).toEqual(["Nova Labs", "Orbital"]);
      expect(out.meta.errors.find((e) => e.company === "Orbital")!.error).toContain("404");
      expect(out.results.every((x) => x.ats === "greenhouse")).toBe(true);
      expect(out.results.length).toBe(2);
    } finally {
      broken.stop();
    }
  }, 60000);

  test("every board failing exits 1 with SEARCH_FAILED", async () => {
    const dead = startFixtureServer(() => new Response("nope", { status: 404 }));
    try {
      const r = await runCLI(["search", "-q", "engineer", "--companies", dead.companiesPath], dead.env);
      expect(r.exitCode).toBe(1);
      const err = JSON.parse(r.stderr);
      expect(err.code).toBe("SEARCH_FAILED");
      expect(err.error).toContain("every configured board failed");
      expect(r.stdout).toBe("");
    } finally {
      dead.stop();
    }
  });
});

describe("detail", () => {
  test("greenhouse by id: single-job endpoint, decoded + cleaned description", async () => {
    const r = await cli(["detail", "greenhouse:acmeai:4000000001"]);
    const job = parseJSON<Record<string, unknown>>(r);
    expect(job).toMatchObject({
      id: "greenhouse:acmeai:4000000001",
      title: "Machine Learning Engineer, Inference",
      company: "Acme AI",
      location: "San Francisco, CA",
      date: "2026-10-27",
      ats: "greenhouse",
      employmentType: "Full-time",
      compensation: null,
      isActive: true,
    });
    expect(String(job.description)).toContain("Optimise inference kernels");
    expect(String(job.description)).not.toMatch(/ignore previous/i);
    expect(fx.requests.some((p) => p === "/v1/boards/acmeai/jobs/4000000001")).toBe(true);
  });

  test("lever by hosted URL; ashby by hosted URL re-fetches the board", async () => {
    let job = parseJSON<Record<string, unknown>>(await cli(["detail", "https://jobs.lever.co/novalabs/3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b/apply"]));
    expect(job.ats).toBe("lever");
    expect(job.compensation).toBe("USD 220000 – 310000 per year");
    expect(job.employmentType).toBe("Full-time");

    job = parseJSON<Record<string, unknown>>(await cli(["detail", "https://jobs.ashbyhq.com/orbital/9d8c7b6a-5f4e-4d3c-b2a1-0f9e8d7c6b5a"]));
    expect(job.ats).toBe("ashby");
    expect(job.compensation).toBe("$250K – $400K • Offers Equity");
    expect(job.company).toBe("Orbital");
    expect(String(job.description)).not.toContain("HIDDEN");
  });

  test("an unlisted ashby job reports isActive false; an unknown id is NOT_FOUND", async () => {
    const job = parseJSON<Record<string, unknown>>(await cli(["detail", "ashby:orbital:ffffffff-0000-4000-8000-000000000001"]));
    expect(job.isActive).toBe(false);
    for (const id of ["greenhouse:acmeai:4000009999", "lever:novalabs:00000000-0000-4000-8000-000000000000", "ashby:orbital:00000000-0000-4000-8000-000000000000", "greenhouse:unknownco:1"]) {
      const r = await cli(["detail", id]);
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stderr).code).toBe("NOT_FOUND");
    }
  });

  test("a token not in companies.json still resolves (company falls back to the token)", async () => {
    const job = parseJSON<Record<string, unknown>>(
      await runCLI(["detail", "greenhouse:acmeai:4000000002", "--companies", "/nonexistent.json"], fx.env),
    );
    expect(job.company).toBe("acmeai");
  });

  test("plain format", async () => {
    const r = await cli(["detail", "lever:novalabs:7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d", "--format", "plain"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Analytics Engineer");
    expect(r.stdout).toContain("Remote: yes");
    expect(r.stdout).toContain("Status: ACTIVE");
    expect(r.stdout).toContain("Model our warehouse in dbt.");
  });
});

describe("boards", () => {
  test("lists configured boards without fetching", async () => {
    const before = fx.requests.length;
    const r = await cli(["boards"]);
    const out = parseJSON<{ meta: { count: number; checked: boolean }; boards: Array<Record<string, unknown>> }>(r);
    expect(out.meta).toMatchObject({ count: 3, checked: false });
    expect(out.boards.every((b) => b.status === "unchecked")).toBe(true);
    expect(fx.requests.length).toBe(before);
  });

  test("--check fetches each board and reports reachable / not_found with totals", async () => {
    const mixed = startFixtureServer(() => null, {
      companies: [
        { name: "Acme AI", ats: "greenhouse", token: "acmeai" },
        { name: "Ghost", ats: "lever", token: "ghost" },
      ],
    });
    try {
      const r = await runCLI(["boards", "--check", "--companies", mixed.companiesPath], mixed.env);
      const out = parseJSON<{ meta: Record<string, number | boolean>; boards: Array<Record<string, unknown>> }>(r);
      expect(out.meta).toMatchObject({ count: 2, checked: true, reachable: 1, notFound: 1, errors: 0 });
      expect(out.boards[0]).toMatchObject({ name: "Acme AI", status: "reachable", totalJobs: 3 });
      expect(out.boards[1]).toMatchObject({ name: "Ghost", status: "not_found", totalJobs: null });
      const t = await runCLI(["boards", "--check", "--format", "table", "--companies", mixed.companiesPath], mixed.env);
      expect(t.stdout).toContain("not_found");
    } finally {
      mixed.stop();
    }
  });

  test("the shipped companies.json lists without a network call", async () => {
    const r = await runCLI(["boards", "--format", "table"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("anthropic");
    expect(r.stdout).toContain("ashby");
  });
});
