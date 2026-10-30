import {
  boardUrl,
  jsonFetch,
  loadCompanies,
  mapLimit,
  matchesLocation,
  matchesQuery,
  matchesRemote,
  normalizeBoard,
  queryTerms,
  stripInvisible,
  withinJobage,
  writeError,
  type Company,
  type JobResult,
  type Normalized,
} from "../helpers.js"

export const PAGE_SIZE = 20
export const CONCURRENCY = 5

export interface SearchOpts {
  query: string
  location?: string
  remote?: "remote" | "hybrid" | "onsite"
  jobage?: number
  deep: boolean
  page: number
  limit?: number
  format: "json" | "table" | "plain"
  companiesPath?: string
  company?: string
}

export interface BoardError {
  company: string
  error: string
}

/** Fetch and normalize one board; a failure becomes a BoardError, never a throw. */
export async function fetchBoard(c: Company): Promise<{ jobs: Normalized[]; error: BoardError | null }> {
  try {
    const body = await jsonFetch<unknown>(boardUrl(c))
    if (body === null) {
      return { jobs: [], error: { company: c.name, error: `board "${c.token}" not found on ${c.ats} (404) - check companies.json` } }
    }
    return { jobs: normalizeBoard(c.ats, body, c), error: null }
  } catch (e) {
    return { jobs: [], error: { company: c.name, error: e instanceof Error ? e.message : String(e) } }
  }
}

/** Apply the search filters and the date-desc sort (pure, for tests). */
export function filterAndSort(all: Normalized[], opts: SearchOpts, now = Date.now()): Normalized[] {
  const terms = queryTerms(opts.query)
  return all
    .filter(
      (n) =>
        matchesQuery(n, terms, opts.deep) &&
        matchesLocation(n, opts.location) &&
        matchesRemote(n, opts.remote) &&
        withinJobage(n, opts.jobage, now),
    )
    .sort((a, b) => (b.timestamp ?? -Infinity) - (a.timestamp ?? -Infinity))
}

export function selectCompanies(companies: Company[], only: string | undefined): Company[] {
  if (!only) return companies
  const needle = only.trim().toLowerCase()
  return companies.filter((c) => c.name.toLowerCase() === needle || c.token.toLowerCase() === needle)
}

function renderTable(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  const lines = rows.map((c) => {
    const title = (c.title || "").slice(0, 42).padEnd(42)
    const company = (c.company || "—").slice(0, 20).padEnd(20)
    const loc = (c.location || "—").slice(0, 24).padEnd(24)
    const date = c.date || "—"
    return `${c.id.slice(0, 44).padEnd(44)} ${title} ${company} ${loc} ${date}`
  })
  const header =
    "ID".padEnd(44) + " " + "TITLE".padEnd(42) + " " + "COMPANY".padEnd(20) + " " + "LOCATION".padEnd(24) + " DATE"
  return [header, "-".repeat(header.length), ...lines].join("\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const companies = selectCompanies(loadCompanies(opts.companiesPath), opts.company)
    if (companies.length === 0) {
      writeError(
        opts.company
          ? `no configured company matches "${opts.company}" (match on name or token; see \`boards\`)`
          : "no companies configured",
        "NO_COMPANIES",
      )
      return 1
    }

    const fetched = await mapLimit(companies, CONCURRENCY, fetchBoard)
    const errors = fetched.map((f) => f.error).filter((e): e is BoardError => e !== null)
    if (errors.length === companies.length) {
      writeError(
        `every configured board failed: ${errors.map((e) => `${e.company}: ${e.error}`).join("; ")}`,
        "SEARCH_FAILED",
      )
      return 1
    }

    const matched = filterAndSort(fetched.flatMap((f) => f.jobs), opts)
    const start = (opts.page - 1) * PAGE_SIZE
    let rows = matched.slice(start, start + PAGE_SIZE).map((n) => n.result)
    if (opts.limit !== undefined) rows = rows.slice(0, opts.limit)
    rows = stripInvisible(rows)
    const meta = stripInvisible({
      count: rows.length,
      page: opts.page,
      pageSize: PAGE_SIZE,
      total: matched.length,
      boards: companies.length,
      boardsFailed: errors.length,
      errors,
    })

    if (opts.format === "table") {
      process.stdout.write(renderTable(rows) + "\n")
      if (errors.length) process.stderr.write(JSON.stringify({ warning: `${errors.length} board(s) failed`, errors }) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(
        (rows.length === 0
          ? "No results."
          : rows
              .map(
                (c) =>
                  `${c.title}\n  ${c.company || "—"} · ${c.location || "—"} · ${c.date || "—"}\n  id: ${c.id}\n  ${c.url}`,
              )
              .join("\n\n")) + "\n",
      )
      if (errors.length) process.stderr.write(JSON.stringify({ warning: `${errors.length} board(s) failed`, errors }) + "\n")
    } else {
      process.stdout.write(JSON.stringify({ meta, results: rows }, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
