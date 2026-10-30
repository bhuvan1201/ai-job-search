import { describe, expect, test } from "bun:test";
import { runCLI } from "./helpers";

// Invalid flags fail before any request: no fixture server is running here,
// and a request to the real ATS hosts would fail differently (a network
// error with SEARCH_FAILED), so a BAD_ARG / UNKNOWN_FLAG proves the guard ran.

function parsedStderr(stderr: string): { error?: string; code?: string } {
  try {
    return JSON.parse(stderr);
  } catch {
    return {};
  }
}

describe("ats-boards CLI flag validation", () => {
  test("no command prints help and exits 1", async () => {
    const r = await runCLI([]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("USAGE");
  });

  test("--help exits 0 with usage", async () => {
    const r = await runCLI(["search", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("SEARCH FLAGS");
  });

  test("unknown command exits 1 with BAD_CMD", async () => {
    const r = await runCLI(["frobnicate"]);
    expect(r.exitCode).toBe(1);
    expect(parsedStderr(r.stderr).code).toBe("BAD_CMD");
    expect(r.stdout).toBe("");
  });

  for (const cmd of ["search", "detail", "boards"]) {
    test(`${cmd}: a bogus flag exits 1 with UNKNOWN_FLAG on stderr, nothing on stdout`, async () => {
      const args = cmd === "search" ? ["search", "-q", "ml", "--bogus", "1"] : cmd === "detail" ? ["detail", "greenhouse:x:1", "--bogus"] : ["boards", "--bogus"];
      const r = await runCLI(args);
      expect(r.exitCode).toBe(1);
      const err = parsedStderr(r.stderr);
      expect(err.code).toBe("UNKNOWN_FLAG");
      expect(err.error).toContain("--bogus");
      expect(r.stdout).toBe("");
    });
  }

  test("search without --query exits 1 with BAD_ARG", async () => {
    const r = await runCLI(["search", "-l", "Remote"]);
    expect(r.exitCode).toBe(1);
    expect(parsedStderr(r.stderr).code).toBe("BAD_ARG");
  });

  test("bare -q and -q '' are BAD_ARG", async () => {
    for (const args of [["search", "-q"], ["search", "--query", ""], ["search", "-q", "  "], ["search", "-q", "|"]]) {
      const r = await runCLI(args);
      expect(r.exitCode).toBe(1);
      expect(parsedStderr(r.stderr).code).toBe("BAD_ARG");
    }
  });

  for (const name of ["jobage", "page", "limit"]) {
    for (const value of ["foo", "0", "1.5", "0.5"]) {
      test(`--${name} ${value} exits 1 with BAD_ARG`, async () => {
        const r = await runCLI(["search", "-q", "ml", `--${name}`, value]);
        expect(r.exitCode).toBe(1);
        const err = parsedStderr(r.stderr);
        expect(err.code).toBe("BAD_ARG");
        expect(err.error).toMatch(new RegExp(name));
      });
    }
  }

  test("--format outside json|table|plain is BAD_ARG for search, json|plain for detail", async () => {
    let r = await runCLI(["search", "-q", "ml", "--format", "xml"]);
    expect(parsedStderr(r.stderr).code).toBe("BAD_ARG");
    r = await runCLI(["detail", "greenhouse:x:1", "--format", "table"]);
    expect(parsedStderr(r.stderr).code).toBe("BAD_ARG");
  });

  test("--remote must be remote|hybrid|onsite", async () => {
    for (const args of [["--remote"], ["--remote", "wfh"], ["--remote", "remote,hybrid"]]) {
      const r = await runCLI(["search", "-q", "ml", ...args]);
      expect(r.exitCode).toBe(1);
      expect(parsedStderr(r.stderr).code).toBe("BAD_ARG");
    }
  });

  test("bare --location / --company / --companies are BAD_ARG", async () => {
    for (const args of [["-l"], ["--location", ""], ["--company"], ["--companies"]]) {
      const r = await runCLI(["search", "-q", "ml", ...args]);
      expect(r.exitCode).toBe(1);
      expect(parsedStderr(r.stderr).code).toBe("BAD_ARG");
    }
  });

  test("detail without an id exits 1 with NO_ID", async () => {
    const r = await runCLI(["detail"]);
    expect(r.exitCode).toBe(1);
    expect(parsedStderr(r.stderr).code).toBe("NO_ID");
  });

  test("detail on a foreign-host URL exits 1 with BAD_ID before any request", async () => {
    const r = await runCLI(["detail", "https://www.linkedin.com/jobs/view/4426311357"]);
    expect(r.exitCode).toBe(1);
    expect(parsedStderr(r.stderr).code).toBe("BAD_ID");
  });

  test("a missing --companies file is a clean error", async () => {
    const r = await runCLI(["search", "-q", "ml", "--companies", "/nonexistent/companies.json"]);
    expect(r.exitCode).toBe(1);
    const err = parsedStderr(r.stderr);
    expect(err.code).toBe("SEARCH_FAILED");
    expect(err.error).toContain("companies file");
  });
});
