import { boardUrl, jsonFetch, loadCompanies, mapLimit, normalizeBoard, stripInvisible, writeError, type Company } from "../helpers.js"
import { CONCURRENCY, selectCompanies } from "./search.js"

export interface BoardsOpts {
  check: boolean
  format: "json" | "table" | "plain"
  companiesPath?: string
  company?: string
}

export interface BoardStatus {
  name: string
  ats: Company["ats"]
  token: string
  verified: boolean
  url: string
  status: "reachable" | "not_found" | "error" | "unchecked"
  totalJobs: number | null
  error: string | null
}

/** Fetch a board once and report whether the token resolves. Never throws. */
export async function checkBoard(c: Company): Promise<BoardStatus> {
  const base: BoardStatus = {
    name: c.name,
    ats: c.ats,
    token: c.token,
    verified: c.verified === true,
    url: boardUrl(c),
    status: "unchecked",
    totalJobs: null,
    error: null,
  }
  try {
    const body = await jsonFetch<unknown>(boardUrl(c))
    if (body === null) return { ...base, status: "not_found", error: "404 - board token not found" }
    return { ...base, status: "reachable", totalJobs: normalizeBoard(c.ats, body, c).length }
  } catch (e) {
    return { ...base, status: "error", error: e instanceof Error ? e.message : String(e) }
  }
}

function renderTable(rows: BoardStatus[], checked: boolean): string {
  const header =
    "COMPANY".padEnd(16) + " " + "ATS".padEnd(10) + " " + "TOKEN".padEnd(14) + " " + "VERIFIED".padEnd(8) + (checked ? " STATUS      JOBS" : "")
  const lines = rows.map(
    (r) =>
      r.name.slice(0, 16).padEnd(16) +
      " " +
      r.ats.padEnd(10) +
      " " +
      r.token.slice(0, 14).padEnd(14) +
      " " +
      (r.verified ? "yes" : "no").padEnd(8) +
      (checked ? ` ${r.status.padEnd(11)} ${r.totalJobs ?? "—"}${r.error ? "  (" + r.error + ")" : ""}` : ""),
  )
  return [header, "-".repeat(header.length), ...lines].join("\n")
}

export async function runBoards(opts: BoardsOpts): Promise<number> {
  try {
    const companies = selectCompanies(loadCompanies(opts.companiesPath), opts.company)
    if (companies.length === 0) {
      writeError(opts.company ? `no configured company matches "${opts.company}"` : "no companies configured", "NO_COMPANIES")
      return 1
    }
    const rows: BoardStatus[] = opts.check
      ? await mapLimit(companies, CONCURRENCY, checkBoard)
      : companies.map((c) => ({
          name: c.name,
          ats: c.ats,
          token: c.token,
          verified: c.verified === true,
          url: boardUrl(c),
          status: "unchecked" as const,
          totalJobs: null,
          error: null,
        }))
    const out = stripInvisible(rows)
    if (opts.format === "json") {
      const meta = {
        count: out.length,
        checked: opts.check,
        reachable: out.filter((r) => r.status === "reachable").length,
        notFound: out.filter((r) => r.status === "not_found").length,
        errors: out.filter((r) => r.status === "error").length,
      }
      process.stdout.write(JSON.stringify({ meta, boards: out }, null, 2) + "\n")
    } else {
      process.stdout.write(renderTable(out, opts.check) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "BOARDS_FAILED")
    return 1
  }
}
