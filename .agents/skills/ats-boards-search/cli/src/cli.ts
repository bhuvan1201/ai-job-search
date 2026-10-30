#!/usr/bin/env bun
// Self-contained CLI that searches the public job-board JSON APIs of companies
// running Greenhouse, Lever or Ashby. No external CLI framework, so it runs
// anywhere `bun` is available with zero install beyond the repo clone.
//
// These are the official, unauthenticated endpoints companies use to embed
// their own boards; there is no ToS issue, but keep volume modest - every
// search fetches each configured board once. The CLI backs off on 429/5xx.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { runBoards, type BoardsOpts } from "./commands/boards.js"
import { remoteMode } from "./helpers.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  const alias: Record<string, string> = { q: "query", l: "location", n: "limit" }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--") || a.startsWith("-")) {
      const key = alias[a.replace(/^-+/, "")] ?? a.replace(/^-+/, "")
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("-")) {
        flags[key] = true
      } else {
        flags[key] = next
        i++
      }
    } else {
      ;(flags._ as string[]).push(a)
    }
  }
  return flags
}

const HELP = `ats-boards-cli — search the public Greenhouse / Lever / Ashby job boards of configured companies

USAGE
  bun run src/cli.ts search --query "<keywords>" [flags]
  bun run src/cli.ts detail <id|url> [--format json|plain]
  bun run src/cli.ts boards [--check] [--format json|table]

SEARCH FLAGS
  --query, -q <text>      Keywords. REQUIRED. Case-insensitive match over title and
                          department/team; separate alternatives with | for OR
                          ("machine learning|ml engineer").
  --deep                  Also match --query against the full description text.
  --location, -l <text>   Substring match over the posting's location fields.
                          "Remote" also matches postings the ATS flags as remote.
  --remote <mode>         remote | hybrid | onsite (Lever workplaceType / Ashby isRemote;
                          falls back to the location text elsewhere).
  --jobage <days>         Posted/updated within N days.
  --page <n>              1-indexed page (20 results/page over the merged, newest-first list).
  --limit, -n <n>         Cap results emitted from the page (client-side).
  --format <fmt>          json (default) | table | plain.
  --companies <path>      Alternative companies.json (default: the skill's own).
  --company <name|token>  Restrict to one configured company.

DETAIL
  <id> is the search result's id: <ats>:<token>:<jobId>. A job URL on
  job-boards.greenhouse.io, boards.greenhouse.io, jobs.lever.co or jobs.ashbyhq.com
  also works; any other host is rejected.

BOARDS
  Lists the configured boards. --check fetches each once and reports reachable /
  not_found / total jobs, so guessed tokens can be confirmed.

EXAMPLES
  bun run src/cli.ts search -q "machine learning engineer" -l "San Francisco" --jobage 14 --format table
  bun run src/cli.ts search -q "data scientist|data engineer" -l Remote --format table
  bun run src/cli.ts search -q "research" --company anthropic --deep
  bun run src/cli.ts detail greenhouse:anthropic:4000000001 --format plain
  bun run src/cli.ts boards --check --format table

Official public job-board APIs - no credentials needed. Keep volume modest; the CLI backs off on 429.
`

// Long-form flag names each command accepts (parseFlags resolves the short
// aliases q/l/n to these before validation). "help"/"h" pass so `search --help`
// still prints usage.
const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set([
    "query", "deep", "location", "remote", "jobage", "page", "limit", "format", "companies", "company", "help", "h",
  ]),
  detail: new Set(["format", "companies", "help", "h"]),
  boards: new Set(["check", "format", "companies", "company", "help", "h"]),
}

function bad(error: string, code = "BAD_ARG"): number {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
  return 1
}

/** A string-valued flag, or undefined when absent. A bare flag (true) is an error. */
function stringFlag(flags: Flags, name: string): string | undefined | null {
  const v = flags[name]
  if (v === undefined) return undefined
  if (typeof v !== "string") return null
  return v
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const flags = parseFlags(argv)
  const cmd = (flags._ as string[])[0]

  if (!cmd || flags.help || flags.h) {
    process.stdout.write(HELP)
    return cmd ? 0 : 1
  }

  // Reject unknown flags instead of silently discarding them: a discarded
  // filter changes what the search returns with no error. add-portal.md's
  // contract requires a bogus flag to exit 1 with a JSON error on stderr.
  const knownFlags = KNOWN_FLAGS[cmd]
  if (knownFlags) {
    for (const key of Object.keys(flags)) {
      if (key === "_" || knownFlags.has(key)) continue
      return bad(
        `unknown flag --${key} for '${cmd}' - flags are never silently ignored, because a discarded filter changes what the search returns; see --help for the supported flags`,
        "UNKNOWN_FLAG",
      )
    }
  }

  const companiesPath = stringFlag(flags, "companies")
  if (companiesPath === null || companiesPath === "") return bad("--companies requires a file path")
  const company = stringFlag(flags, "company")
  if (company === null || (company !== undefined && !company.trim())) return bad("--company requires a non-empty value")

  const parseIntFlag = (name: string, raw: string | boolean | string[]): number | null => {
    // Number(), not parseInt(): parseInt truncates, so "--jobage 0.5" would
    // become 0 and silently drop the filter. Whole numbers >= 1 only.
    const val = typeof raw === "string" ? Number(raw.trim()) : NaN
    if (!Number.isInteger(val) || val < 1) {
      bad(`--${name} must be a whole number of at least 1, got "${raw}"`)
      return null
    }
    return val
  }

  if (cmd === "search") {
    // parseFlags stores a bare -q as true and -q "" as ""; both are rejected
    // rather than matching every posting on every board.
    if (flags.query === undefined || typeof flags.query !== "string" || !flags.query.trim()) {
      return bad('the --query/-q flag is required and needs keywords (e.g. -q "machine learning engineer")')
    }
    if (flags.query.split("|").every((t) => !t.trim())) return bad("--query has no keywords between the | separators")

    const fmt = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "table", "plain"].includes(fmt)) return bad(`--format must be one of json|table|plain, got "${fmt}"`)

    const location = stringFlag(flags, "location")
    if (location === null || (location !== undefined && !location.trim())) return bad("--location requires a non-empty value")

    if (flags.remote !== undefined && (typeof flags.remote !== "string" || remoteMode(flags.remote) === null)) {
      const got = typeof flags.remote === "string" ? `"${flags.remote}"` : "no value"
      return bad(`--remote must be one of remote|hybrid|onsite, got ${got}`)
    }
    if (flags.deep !== undefined && flags.deep !== true) return bad("--deep takes no value")

    let jobage: number | undefined
    if (flags.jobage !== undefined) {
      const v = parseIntFlag("jobage", flags.jobage)
      if (v === null) return 1
      jobage = v
    }
    let page = 1
    if (flags.page !== undefined) {
      const v = parseIntFlag("page", flags.page)
      if (v === null) return 1
      page = v
    }
    let limit: number | undefined
    if (flags.limit !== undefined) {
      const v = parseIntFlag("limit", flags.limit)
      if (v === null) return 1
      limit = v
    }

    const opts: SearchOpts = {
      query: flags.query,
      location,
      remote: flags.remote !== undefined ? remoteMode(flags.remote as string)! : undefined,
      jobage,
      deep: flags.deep === true,
      page,
      limit,
      format: fmt as SearchOpts["format"],
      companiesPath,
      company,
    }
    return runSearch(opts)
  }

  if (cmd === "detail") {
    const id = (flags._ as string[])[1]
    if (!id) return bad("detail requires an <id|url>", "NO_ID")
    const fmt = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "plain"].includes(fmt)) return bad(`--format must be one of json|plain, got "${fmt}"`)
    const opts: DetailOpts = { id, format: fmt as DetailOpts["format"], companiesPath }
    return runDetail(opts)
  }

  if (cmd === "boards") {
    if (flags.check !== undefined && flags.check !== true) return bad("--check takes no value")
    const fmt = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "table", "plain"].includes(fmt)) return bad(`--format must be one of json|table|plain, got "${fmt}"`)
    const opts: BoardsOpts = { check: flags.check === true, format: fmt as BoardsOpts["format"], companiesPath, company }
    return runBoards(opts)
  }

  return bad(`Unknown command "${cmd}"`, "BAD_CMD")
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e), code: "INTERNAL_ERROR" }) + "\n",
    )
    process.exit(1)
  })
