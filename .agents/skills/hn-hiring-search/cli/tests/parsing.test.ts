import { describe, expect, test } from "bun:test";
import {
  htmlToText,
  parseHeader,
  parseJobComment,
  parseThreadItem,
  selectHiringThreads,
  splitHeader,
  type AlgoliaItem,
  type AlgoliaSearch,
} from "../src/helpers";
import { normalizeId } from "../src/commands/detail";
import { fixture } from "./fixture-server";

// The pure functions, over the fixtures: no process, no network.

const THREAD = { id: "41709301", title: "Ask HN: Who is hiring? (October 2026)", createdAt: "2026-10-01T15:00:33Z" };

describe("selectHiringThreads", () => {
  const search = fixture<AlgoliaSearch>("algolia-search.json");

  test("keeps only 'Who is hiring?' stories, newest first, capped at months", () => {
    const one = selectHiringThreads(search, 1);
    expect(one).toEqual([{ id: "41709301", title: "Ask HN: Who is hiring? (October 2026)", createdAt: "2026-10-01T15:00:33Z" }]);
    const two = selectHiringThreads(search, 2);
    expect(two.map((t) => t.id)).toEqual(["41709301", "41500001"]);
    expect(selectHiringThreads(search, 6)).toHaveLength(2);
  });

  test("the 'wants to be hired' and 'freelancer' threads are excluded", () => {
    const ids = selectHiringThreads(search, 6).map((t) => t.id);
    expect(ids).not.toContain("41709302");
    expect(ids).not.toContain("41709303");
  });

  test("tolerates a null or malformed body", () => {
    expect(selectHiringThreads(null, 1)).toEqual([]);
    expect(selectHiringThreads({ hits: [{ objectID: "x", title: "Ask HN: Who is hiring?" }] } as AlgoliaSearch, 1)).toEqual([]);
  });
});

describe("htmlToText", () => {
  test("paragraph breaks kept, HN entities decoded, inline tags dropped", () => {
    const out = htmlToText(
      "<p>Acme | Eng | SF</p><p>You&#x27;ll like our &quot;team&quot;: <a href=\"https:&#x2F;&#x2F;x.y\">https:&#x2F;&#x2F;x.y</a>.</p>",
    );
    expect(out).toBe('Acme | Eng | SF\nYou\'ll like our "team": https://x.y.');
  });

  test("hidden markup is dropped before tags are stripped", () => {
    const out = htmlToText('<p>Visible.<span style="display:none">HIDDEN</span> Also visible.</p><!-- HIDDEN comment --><p hidden>HIDDEN p</p>');
    expect(out).toBe("Visible. Also visible.");
  });

  test("null and empty give null", () => {
    expect(htmlToText(null)).toBeNull();
    expect(htmlToText("<p></p>")).toBeNull();
  });
});

describe("splitHeader / parseHeader", () => {
  test("splits on pipes, fullwidth pipes, or dashes only without pipes", () => {
    expect(splitHeader("A | B |C")).toEqual(["A", "B", "C"]);
    expect(splitHeader("A ｜ B")).toEqual(["A", "B"]);
    expect(splitHeader("A - B – C")).toEqual(["A", "B", "C"]);
    expect(splitHeader("A - B | C - D")).toEqual(["A - B", "C - D"]);
  });

  test("standard header: company, title, location, HYBRID, employment, salary", () => {
    const h = parseHeader("Acme AI | Senior ML Engineer | San Francisco, CA | HYBRID | Full-time | $200k-$260k + equity");
    expect(h).toEqual({
      company: "Acme AI",
      title: "Senior ML Engineer",
      location: "San Francisco, CA",
      workplace: "HYBRID",
      remote: false,
      salary: "$200k-$260k + equity",
      employmentType: "Full-time",
    });
  });

  test("REMOTE (US): location is the remote field, remote true", () => {
    const h = parseHeader("Nova Labs | Data Scientist, Product Analytics | REMOTE (US) | Full-time");
    expect(h.company).toBe("Nova Labs");
    expect(h.title).toBe("Data Scientist, Product Analytics");
    expect(h.location).toBe("REMOTE (US)");
    expect(h.workplace).toBe("REMOTE");
    expect(h.remote).toBe(true);
    expect(h.salary).toBeNull();
  });

  test("ONSITE Palo Alto: remote false", () => {
    const h = parseHeader("Orbital Robotics | Founding Research Engineer, Perception | Palo Alto, CA | ONSITE | $180k-$230k");
    expect(h.title).toBe("Founding Research Engineer, Perception");
    expect(h.location).toBe("Palo Alto, CA");
    expect(h.workplace).toBe("ONSITE");
    expect(h.remote).toBe(false);
    expect(h.salary).toBe("$180k-$230k");
  });

  test("multiple role fields join with ', '; bare REMOTE tag yields location Remote", () => {
    const h = parseHeader("Foo | Backend Engineer | Frontend Engineer | REMOTE");
    expect(h.title).toBe("Backend Engineer, Frontend Engineer");
    expect(h.location).toBe("Remote");
    expect(h.remote).toBe(true);
  });

  test("REMOTE or ONSITE both tagged: remote true, both tags kept", () => {
    const h = parseHeader("Bar | SRE | NYC | REMOTE or ONSITE");
    expect(h.workplace).toBe("REMOTE ONSITE");
    expect(h.remote).toBe(true);
    expect(h.location).toBe("NYC");
  });

  test("no pipes: company from the first sentence, title '(see posting)'", () => {
    const h = parseHeader(
      "Tiny Co is a two-person bootstrapped company building developer tools and we are looking for our first engineer. We are remote-friendly.",
    );
    expect(h.title).toBe("(see posting)");
    expect(h.company).toStartWith("Tiny Co is a two-person bootstrapped company");
    expect(h.company).toEndWith("…");
    expect(h.company!.length).toBeLessThanOrEqual(60);
  });

  test("nothing role-like: title falls back to the header minus the company", () => {
    const h = parseHeader("Widgets Ltd | Berlin, Germany | Full-time");
    expect(h.company).toBe("Widgets Ltd");
    expect(h.location).toBe("Berlin, Germany");
    expect(h.employmentType).toBe("Full-time");
    expect(h.title).toBe("Berlin, Germany | Full-time");
  });

  test("USD salary, mixed Remote/city location, dash-separated header", () => {
    let h = parseHeader("Quill & Co | Machine Learning Engineer, LLM Applications | Remote (US timezones) or Austin, TX | REMOTE | Full-time | USD 170k/yr");
    expect(h.salary).toBe("USD 170k/yr");
    expect(h.location).toBe("Remote (US timezones) or Austin, TX");
    expect(h.remote).toBe(true);
    h = parseHeader("Big Bank - Quantitative Analyst - London, UK - Hybrid");
    expect(h.company).toBe("Big Bank");
    expect(h.title).toBe("Quantitative Analyst");
    expect(h.location).toBe("London, UK");
    expect(h.workplace).toBe("HYBRID");
  });
});

describe("parseJobComment / parseThreadItem", () => {
  const thread = fixture<AlgoliaItem>("algolia-thread.json");

  test("only top-level children; deleted comment skipped; nested reply ignored", () => {
    const jobs = parseThreadItem(thread, THREAD);
    const ids = jobs.map((j) => j.result.id);
    expect(ids).toEqual(["41709555", "41709600", "41709650", "41709700", "41709900", "41709950", "41710000"]);
    expect(ids).not.toContain("41709750"); // text: null
    expect(ids).not.toContain("41709800"); // nested reply
  });

  test("result fields follow the contract", () => {
    const n = parseJobComment(thread.children![0], THREAD)!;
    expect(n.result).toEqual({
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
      snippet:
        "We build evaluation infrastructure for frontier language models. You'll own our inference serving stack (Python, Rust, Kubernetes) and work with researchers on new benchmarks. Apply: https://acme.ai/…",
    });
    expect(n.result.snippet!.length).toBeLessThanOrEqual(200);
    expect(n.detail.description).toContain("You'll own our inference serving stack");
    expect(n.detail.isActive).toBe(true);
  });

  test("HN double-escaped entities decode in header and body", () => {
    const n = parseJobComment(thread.children!.find((c) => c.id === 41709950)!, THREAD)!;
    expect(n.result.company).toBe("Quill & Co");
    expect(n.result.salary).toBe("USD 170k/yr");
    expect(n.detail.description).toContain('We\'re a "small but mighty" team');
  });

  test("hidden span injection never reaches header, snippet or description", () => {
    const n = parseJobComment(thread.children!.find((c) => c.id === 41709900)!, THREAD)!;
    expect(JSON.stringify(n.detail)).not.toMatch(/ignore previous/i);
    expect(n.detail.description).toContain("Go and Postgres at scale. Great team.");
    expect(n.body).not.toMatch(/ignore previous/i);
  });

  test("no-pipe comment: title is never empty", () => {
    const n = parseJobComment(thread.children!.find((c) => c.id === 41709700)!, THREAD)!;
    expect(n.result.title).toBe("(see posting)");
    expect(n.result.snippet).toBeNull();
    expect(n.result.location).toBeNull();
  });

  test("created_at_i is used when created_at is missing", () => {
    const n = parseJobComment({ id: 1, text: "<p>A | Engineer | SF</p>", created_at_i: 1790867520 }, THREAD)!;
    expect(n.result.date).toBe("2026-10-01");
    expect(parseJobComment({ id: 2, text: null }, THREAD)).toBeNull();
  });
});

describe("detail normalizeId", () => {
  test("accepts numeric ids and news.ycombinator.com item URLs", () => {
    expect(normalizeId("41709555")).toBe("41709555");
    expect(normalizeId(" 41709555 ")).toBe("41709555");
    expect(normalizeId("https://news.ycombinator.com/item?id=41709555")).toBe("41709555");
    expect(normalizeId("news.ycombinator.com/item?id=41709555")).toBe("41709555");
    expect(normalizeId("http://www.news.ycombinator.com/item?id=41709555&foo=bar")).toBe("41709555");
  });

  test("rejects foreign hosts, look-alikes, userinfo tricks and non-item paths", () => {
    for (const bad of [
      "https://www.linkedin.com/jobs/view/1",
      "https://news.ycombinator.com.evil.io/item?id=1",
      "https://news.ycombinator.com@evil.io/item?id=1",
      "https://news.ycombinator.com/user?id=pg",
      "https://news.ycombinator.com/item?id=abc",
      "https://hn.algolia.com/api/v1/items/1",
      "abc",
      "",
    ]) {
      expect(normalizeId(bad)).toBeNull();
    }
  });
});
