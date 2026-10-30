#!/usr/bin/env bun
// Self-contained CLI that searches the monthly "Ask HN: Who is hiring?"
// threads on Hacker News through the official, unauthenticated HN APIs
// (Algolia HN Search, Firebase HN API). No external CLI framework, so it runs
// anywhere `bun` is available with zero install beyond the repo clone.
//
// One search is two or three requests (find the threads, fetch each thread
// with all comments in one call); keep volume modest anyway. The CLI backs
// off on 429/5xx.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
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

const HELP = `hn-hiring-cli — search the monthly "Ask HN: Who is hiring?" threads on Hacker News

USAGE
  bun run src/cli.ts search --query "<keywords>" [flags]
  bun run src/cli.ts detail <id|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Keywords. REQUIRED. Case-insensitive match over the whole job
                          comment (header line + body); separate alternatives with | for OR
                          ("machine learning|ml engineer"); a term may be a phrase.
  --location, -l <text>   Substring match over the parsed location AND the header line
                          ("San Francisco", "SF", "Bay Area", "NYC"). "Remote" also matches
                          the REMOTE tag.
  --remote <mode>         remote | hybrid | onsite, from the header's ONSITE/REMOTE/HYBRID tags.
  --jobage <days>         Comment posted within N days (default: every comment in the
                          selected threads).
  --months <1-6>          Search the N most recent monthly threads (default 1).
  --thread <id>           Search one specific thread by its HN story id.
  --page <n>              1-indexed page (20 results/page, newest comment first).
  --limit, -n <n>         Cap results emitted from the page (client-side).
  --format <fmt>          json (default) | table | plain.

DETAIL
  <id> is the search result's id (the HN comment id) or a
  https://news.ycombinator.com/item?id=<id> URL; any other host is rejected.
  A comment outside a "Who is hiring?" thread is rejected with NOT_A_HIRING_POST.

EXAMPLES
  bun run src/cli.ts search -q "machine learning|ml engineer" -l "San Francisco" --format table
  bun run src/cli.ts search -q "data scientist|data engineer" --remote remote --months 2
  bun run src/cli.ts search -q "llm|inference" -l Remote --jobage 14
  bun run src/cli.ts detail 41709555 --format plain

Official public HN APIs (Algolia HN Search, Firebase) - no credentials needed.
`

// Long-form flag names each command accepts (parseFlags resolves the short
// aliases q/l/n to these before validation). "help"/"h" pass so `search --help`
// still prints usage.
const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set(["query", "location", "remote", "jobage", "months", "thread", "page", "limit", "format", "help", "h"]),
  detail: new Set(["format", "help", "h"]),
}

function bad(error: string, code = "BAD_ARG"): number {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
  return 1
}

/** A string-valued flag, or undefined when absent. A bare flag (true) is null. */
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

  const parseIntFlag = (name: string, raw: string | boolean | string[], max?: number): number | null => {
    // Number(), not parseInt(): parseInt truncates, so "--jobage 0.5" would
    // become 0 and silently drop the filter. Whole numbers >= 1 only.
    const val = typeof raw === "string" ? Number(raw.trim()) : NaN
    if (!Number.isInteger(val) || val < 1 || (max !== undefined && val > max)) {
      bad(`--${name} must be a whole number of at least 1${max !== undefined ? ` and at most ${max}` : ""}, got "${raw}"`)
      return null
    }
    return val
  }

  if (cmd === "search") {
    // parseFlags stores a bare -q as true and -q "" as ""; both are rejected
    // rather than matching every comment in the thread.
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

    const thread = stringFlag(flags, "thread")
    if (thread === null || (thread !== undefined && !/^\d{1,12}$/.test(thread.trim()))) {
      return bad(`--thread must be a numeric HN story id, got ${thread ? `"${thread}"` : "no value"}`)
    }

    let jobage: number | undefined
    if (flags.jobage !== undefined) {
      const v = parseIntFlag("jobage", flags.jobage)
      if (v === null) return 1
      jobage = v
    }
    let months = 1
    if (flags.months !== undefined) {
      const v = parseIntFlag("months", flags.months, 6)
      if (v === null) return 1
      months = v
    }
    if (thread !== undefined && flags.months !== undefined) return bad("--thread and --months are mutually exclusive")
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
      months,
      thread: thread?.trim(),
      page,
      limit,
      format: fmt as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  if (cmd === "detail") {
    const id = (flags._ as string[])[1]
    if (!id) return bad("detail requires an <id|url>", "NO_ID")
    const fmt = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "plain"].includes(fmt)) return bad(`--format must be one of json|plain, got "${fmt}"`)
    const opts: DetailOpts = { id, format: fmt as DetailOpts["format"] }
    return runDetail(opts)
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
