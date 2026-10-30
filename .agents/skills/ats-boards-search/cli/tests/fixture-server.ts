import { join } from "path";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// A loopback stand-in for all three ATS APIs, serving the JSON fixtures. The
// CLI is pointed at it through the ATS_*_API_URL env overrides, so every test
// exercises the real request/normalize/filter/render path offline.

export const FIXTURES = join(import.meta.dir, "fixtures");

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
}

export const TEST_COMPANIES = {
  companies: [
    { name: "Acme AI", ats: "greenhouse", token: "acmeai", verified: true },
    { name: "Nova Labs", ats: "lever", token: "novalabs", verified: true },
    { name: "Orbital", ats: "ashby", token: "orbital", verified: true },
  ],
};

export interface FixtureServer {
  env: Record<string, string>;
  requests: string[];
  companiesPath: string;
  stop: () => void;
}

/**
 * Start the loopback server. `override` lets a test replace a board's response
 * (e.g. a 404 or 500 for one token) by path prefix.
 */
export function startFixtureServer(
  override: (path: string) => Response | null = () => null,
  companies: unknown = TEST_COMPANIES,
): FixtureServer {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      requests.push(path + url.search);
      const o = override(path);
      if (o) return o;

      // Greenhouse: /v1/boards/<token>/jobs[/<id>]
      let m = path.match(/^\/v1\/boards\/([^/]+)\/jobs(?:\/(\d+))?$/);
      if (m) {
        if (m[1] !== "acmeai") return new Response("Not Found", { status: 404 });
        const board = fixture<{ jobs: Array<{ id: number }> }>("greenhouse-board.json");
        if (!m[2]) return Response.json(board);
        const job = board.jobs.find((j) => String(j.id) === m![2]);
        return job ? Response.json(job) : new Response("Not Found", { status: 404 });
      }
      // Lever: /v0/postings/<token>[/<id>]
      m = path.match(/^\/v0\/postings\/([^/]+)(?:\/([^/]+))?$/);
      if (m) {
        if (m[1] !== "novalabs") return new Response("Not Found", { status: 404 });
        const posts = fixture<Array<{ id: string }>>("lever-board.json");
        if (!m[2]) return Response.json(posts);
        const post = posts.find((p) => p.id === m![2]);
        return post ? Response.json(post) : new Response("Not Found", { status: 404 });
      }
      // Ashby: /posting-api/job-board/<token>
      m = path.match(/^\/posting-api\/job-board\/([^/]+)$/);
      if (m) {
        if (m[1] !== "orbital") return new Response("Not Found", { status: 404 });
        return Response.json(fixture("ashby-board.json"));
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  const base = server.url.toString().replace(/\/$/, "");
  const dir = mkdtempSync(join(tmpdir(), "ats-boards-test-"));
  const companiesPath = join(dir, "companies.json");
  writeFileSync(companiesPath, JSON.stringify(companies));
  return {
    env: { ATS_GREENHOUSE_API_URL: base, ATS_LEVER_API_URL: base, ATS_ASHBY_API_URL: base },
    requests,
    companiesPath,
    stop: () => server.stop(true),
  };
}
