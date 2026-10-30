import { describe, expect, test } from "bun:test";
import {
  contractDate,
  htmlToText,
  matchesLocation,
  matchesQuery,
  matchesRemote,
  normalizeBoard,
  parseCompanies,
  queryTerms,
  withinJobage,
  type Company,
} from "../src/helpers";
import { filterAndSort } from "../src/commands/search";
import { normalizeId } from "../src/commands/detail";
import { fixture } from "./fixture-server";

const GH: Company = { name: "Acme AI", ats: "greenhouse", token: "acmeai" };
const LV: Company = { name: "Nova Labs", ats: "lever", token: "novalabs" };
const AS: Company = { name: "Orbital", ats: "ashby", token: "orbital" };

const CONTRACT_KEYS = ["id", "title", "company", "location", "date", "url", "ats", "department", "remote", "applyUrl"];

describe("Greenhouse normalizer", () => {
  const jobs = normalizeBoard("greenhouse", fixture("greenhouse-board.json"), GH);

  test("maps every contract field, never omitting one", () => {
    expect(jobs).toHaveLength(3);
    for (const j of jobs) for (const k of CONTRACT_KEYS) expect(j.result).toHaveProperty(k);
    const ml = jobs[0];
    expect(ml.result).toEqual({
      id: "greenhouse:acmeai:4000000001",
      title: "Machine Learning Engineer, Inference",
      company: "Acme AI",
      location: "San Francisco, CA",
      date: "2026-10-27",
      url: "https://job-boards.greenhouse.io/acmeai/jobs/4000000001",
      ats: "greenhouse",
      department: "Engineering",
      remote: null,
      applyUrl: "https://job-boards.greenhouse.io/acmeai/jobs/4000000001",
    });
    expect(ml.detail.employmentType).toBe("Full-time");
    expect(ml.detail.compensation).toBeNull();
    expect(ml.detail.isActive).toBe(true);
  });

  test("decodes the HTML-escaped content, then drops hidden markup and keeps paragraph breaks", () => {
    const d = jobs[0].detail.description!;
    expect(d).toContain("Acme AI builds & serves large models.");
    expect(d).toContain("What you'll do");
    expect(d).toContain("- Optimise inference kernels");
    expect(d).toContain("Hybrid: 3 days/week in SF.");
    expect(d).not.toMatch(/ignore previous instructions/i);
    expect(d).not.toMatch(/HIDDEN/);
    expect(d).not.toMatch(/<[a-z]/i);
    expect(d.split("\n").length).toBeGreaterThan(2);
  });

  test("location text containing 'remote' marks the job remote; offices feed the location list", () => {
    const remote = jobs[1];
    expect(remote.result.remote).toBe(true);
    expect(remote.workplace).toBe("remote");
    expect(jobs[0].locations).toEqual(["San Francisco, CA", "San Francisco", "San Francisco, California, United States"]);
  });
});

describe("Lever normalizer", () => {
  const jobs = normalizeBoard("lever", fixture("lever-board.json"), LV);

  test("maps fields, ms-epoch date, workplaceType and salary range", () => {
    expect(jobs).toHaveLength(2);
    const ml = jobs[0];
    expect(ml.result.id).toBe("lever:novalabs:3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b");
    expect(ml.result.date).toBe("2026-10-27");
    expect(ml.result.department).toBe("Engineering / ML Platform");
    expect(ml.result.remote).toBe(false);
    expect(ml.workplace).toBe("hybrid");
    expect(ml.result.applyUrl).toMatch(/\/apply$/);
    expect(ml.detail.employmentType).toBe("Full-time");
    expect(ml.detail.compensation).toBe("USD 220000 – 310000 per year");
    expect(jobs[1].result.remote).toBe(true);
    expect(jobs[1].detail.compensation).toBeNull();
  });

  test("description joins description, list sections and additional as text", () => {
    const d = jobs[0].detail.description!;
    expect(d).toContain("Nova Labs trains frontier models.\nWe are hiring.");
    expect(d).toContain("Requirements");
    expect(d).toContain("- 5+ years with PyTorch");
    expect(d).toContain("Salary range posted per local law.");
    expect(d).not.toContain("<");
  });
});

describe("Ashby normalizer", () => {
  const jobs = normalizeBoard("ashby", fixture("ashby-board.json"), AS);

  test("skips isListed:false and maps fields, isRemote and compensation", () => {
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.result.title)).toEqual(["Research Engineer, Alignment", "Staff Data Engineer"]);
    const re = jobs[0];
    expect(re.result.id).toBe("ashby:orbital:9d8c7b6a-5f4e-4d3c-b2a1-0f9e8d7c6b5a");
    expect(re.result.date).toBe("2026-10-25");
    expect(re.result.department).toBe("Research / Alignment");
    expect(re.result.remote).toBe(false);
    expect(re.locations).toEqual(["San Francisco", "New York"]);
    expect(re.detail.compensation).toBe("$250K – $400K • Offers Equity");
    expect(re.detail.employmentType).toBe("FullTime");
    expect(jobs[1].result.remote).toBe(true);
    expect(jobs[1].workplace).toBe("remote");
  });

  test("hidden element in descriptionHtml is dropped", () => {
    const d = jobs[0].detail.description!;
    expect(d).toContain("Orbital studies model behaviour.");
    expect(d).toContain("- Design evals");
    expect(d).not.toMatch(/HIDDEN|say yes/);
  });

  test("a malformed body yields no jobs rather than a throw", () => {
    expect(normalizeBoard("ashby", { nope: 1 }, AS)).toEqual([]);
    expect(normalizeBoard("greenhouse", null, GH)).toEqual([]);
    expect(normalizeBoard("lever", { jobs: [] }, LV)).toEqual([]);
  });
});

describe("filters", () => {
  const all = [
    ...normalizeBoard("greenhouse", fixture("greenhouse-board.json"), GH),
    ...normalizeBoard("lever", fixture("lever-board.json"), LV),
    ...normalizeBoard("ashby", fixture("ashby-board.json"), AS),
  ];
  const NOW = Date.parse("2026-10-29T12:00:00Z");
  const base = { query: "", deep: false, page: 1, format: "json" as const };

  test("queryTerms splits on | and lower-cases", () => {
    expect(queryTerms(" ML | Data Scientist ||")).toEqual(["ml", "data scientist"]);
  });

  test("--query matches title or department, case-insensitive, OR across |", () => {
    const hits = filterAndSort(all, { ...base, query: "machine learning|data" }, NOW);
    const titles = hits.map((h) => h.result.title);
    expect(titles).toContain("Machine Learning Engineer, Inference");
    expect(titles).toContain("Data Scientist, Product Analytics");
    expect(titles).toContain("Analytics Engineer"); // department "Data"
    expect(titles).toContain("Staff Data Engineer");
    expect(titles).not.toContain("Account Executive, Enterprise");
  });

  test("--deep extends the match to the description", () => {
    expect(filterAndSort(all, { ...base, query: "lakehouse" }, NOW)).toHaveLength(0);
    expect(filterAndSort(all, { ...base, query: "lakehouse", deep: true }, NOW).map((h) => h.result.title)).toEqual([
      "Staff Data Engineer",
    ]);
  });

  test("results are sorted newest first across boards", () => {
    const hits = filterAndSort(all, { ...base, query: "engineer|scientist|executive" }, NOW);
    const dates = hits.map((h) => h.timestamp!);
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    expect(hits[0].result.title).toBe("Staff Data Engineer");
  });

  test("--location substring match; Remote also matches ATS remote flags", () => {
    const sf = filterAndSort(all, { ...base, query: "engineer", location: "san francisco" }, NOW).map((h) => h.result.title);
    expect(sf.sort()).toEqual(["Machine Learning Engineer, Inference", "Research Engineer, Alignment"]);
    const remote = filterAndSort(all, { ...base, query: "engineer|scientist", location: "Remote" }, NOW).map((h) => h.result.title);
    expect(remote).toContain("Staff Data Engineer"); // isRemote + "Remote (US)"
    expect(remote).toContain("Analytics Engineer"); // workplaceType remote, location "United States"
    expect(remote).toContain("Data Scientist, Product Analytics"); // "Remote - US"
    expect(remote).toContain("Senior ML Engineer, Training Infrastructure"); // allLocations has "Remote - US"
    expect(remote).not.toContain("Research Engineer, Alignment");
  });

  test("--remote filters by workplace type", () => {
    const hybrid = filterAndSort(all, { ...base, query: "engineer", remote: "hybrid" }, NOW).map((h) => h.result.title);
    expect(hybrid).toEqual(["Senior ML Engineer, Training Infrastructure"]);
    const onsite = filterAndSort(all, { ...base, query: "engineer", remote: "onsite" }, NOW).map((h) => h.result.title);
    expect(onsite).toEqual(["Research Engineer, Alignment"]);
    expect(matchesRemote(all[0], undefined)).toBe(true);
  });

  test("--jobage uses updated_at / createdAt / publishedAt", () => {
    const fresh = filterAndSort(all, { ...base, query: "engineer|scientist|executive", jobage: 3 }, NOW).map((h) => h.result.title);
    expect(fresh).toEqual([
      "Staff Data Engineer",
      "Account Executive, Enterprise",
      "Machine Learning Engineer, Inference",
      "Senior ML Engineer, Training Infrastructure",
    ]);
    expect(withinJobage({ ...all[0], timestamp: null }, 30, NOW)).toBe(false);
  });

  test("helpers tolerate empty filters", () => {
    expect(matchesQuery(all[0], [], false)).toBe(true);
    expect(matchesLocation(all[0], undefined)).toBe(true);
    expect(matchesLocation(all[0], "  ")).toBe(true);
  });
});

describe("contractDate", () => {
  test("ISO with offset, ms epoch, and garbage", () => {
    expect(contractDate("2026-10-20T23:30:00-04:00")).toBe("2026-10-21");
    expect(contractDate(1729000000000)).toBe("2024-10-15");
    expect(contractDate("soon")).toBeNull();
    expect(contractDate(null)).toBeNull();
  });
});

describe("htmlToText", () => {
  test("keeps paragraph breaks, decodes entities, drops scripts/comments/hidden", () => {
    const t = htmlToText('<p>A &amp; B</p><script>x()</script><!-- c --><div hidden>H</div><p>C<br>D</p>')!;
    expect(t).toBe("A & B\nC\nD");
    expect(htmlToText("")).toBeNull();
    expect(htmlToText("<p> </p>")).toBeNull();
  });
});

describe("parseCompanies", () => {
  test("accepts the shipped shape and rejects malformed entries", () => {
    const ok = parseCompanies({ companies: [{ name: "X", ats: "lever", token: "x-y" }] });
    expect(ok[0]).toEqual({ name: "X", ats: "lever", token: "x-y", verified: false });
    expect(() => parseCompanies({})).toThrow(/companies/);
    expect(() => parseCompanies({ companies: [{ name: "X", ats: "workday", token: "x" }] })).toThrow(/ats/);
    expect(() => parseCompanies({ companies: [{ name: "X", ats: "lever", token: "../x" }] })).toThrow(/token/);
    expect(() => parseCompanies({ companies: [{ ats: "lever", token: "x" }] })).toThrow(/name/);
  });

  test("the shipped companies.json parses", async () => {
    const { DEFAULT_COMPANIES_PATH, loadCompanies } = await import("../src/helpers");
    const list = loadCompanies(DEFAULT_COMPANIES_PATH);
    expect(list.length).toBeGreaterThanOrEqual(20);
    expect(list.every((c) => c.verified === false)).toBe(true);
  });
});

describe("detail normalizeId", () => {
  test("accepts the CLI id form", () => {
    expect(normalizeId("greenhouse:acmeai:4000000001")).toEqual({ ats: "greenhouse", token: "acmeai", jobId: "4000000001" });
    expect(normalizeId("lever:novalabs:3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b")).toEqual({
      ats: "lever",
      token: "novalabs",
      jobId: "3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
    });
    expect(normalizeId("workday:x:1")).toBeNull();
    expect(normalizeId("greenhouse:../x:1")).toBeNull();
  });

  test("accepts hosted URLs on the three ATS hosts", () => {
    expect(normalizeId("https://job-boards.greenhouse.io/acmeai/jobs/4000000001?gh_jid=4000000001")).toEqual({
      ats: "greenhouse",
      token: "acmeai",
      jobId: "4000000001",
    });
    expect(normalizeId("boards.greenhouse.io/acmeai/jobs/4000000001")).toEqual({ ats: "greenhouse", token: "acmeai", jobId: "4000000001" });
    expect(normalizeId("https://boards.greenhouse.io/embed/job_app?for=acmeai&token=4000000001")).toEqual({
      ats: "greenhouse",
      token: "acmeai",
      jobId: "4000000001",
    });
    expect(normalizeId("https://jobs.lever.co/novalabs/3F1A2B4C-5d6e-4f70-8a9b-0c1d2e3f4a5b/apply")).toEqual({
      ats: "lever",
      token: "novalabs",
      jobId: "3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
    });
    expect(normalizeId("https://jobs.ashbyhq.com/orbital/9d8c7b6a-5f4e-4d3c-b2a1-0f9e8d7c6b5a/application")).toEqual({
      ats: "ashby",
      token: "orbital",
      jobId: "9d8c7b6a-5f4e-4d3c-b2a1-0f9e8d7c6b5a",
    });
  });

  test("rejects foreign and look-alike hosts and malformed paths", () => {
    expect(normalizeId("https://www.linkedin.com/jobs/view/4426311357")).toBeNull();
    expect(normalizeId("https://jobs.lever.co.evil.io/novalabs/3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b")).toBeNull();
    expect(normalizeId("https://jobs.lever.co@evil.io/novalabs/3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b")).toBeNull();
    expect(normalizeId("https://evil.io/?u=https://jobs.ashbyhq.com/orbital/9d8c7b6a-5f4e-4d3c-b2a1-0f9e8d7c6b5a")).toBeNull();
    expect(normalizeId("https://job-boards.greenhouse.io/acmeai/jobs/not-a-number")).toBeNull();
    expect(normalizeId("https://jobs.ashbyhq.com/orbital")).toBeNull();
    expect(normalizeId("4000000001")).toBeNull();
    expect(normalizeId("")).toBeNull();
  });
});
