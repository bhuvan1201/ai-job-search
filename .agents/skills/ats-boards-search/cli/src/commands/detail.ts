import {
  ATS_NAMES,
  boardUrl,
  greenhouseBase,
  jsonFetch,
  leverBase,
  loadCompanies,
  normalizeAshby,
  normalizeBoard,
  normalizeGreenhouse,
  normalizeLever,
  stripInvisible,
  writeError,
  type Ats,
  type Company,
  type GreenhouseJob,
  type JobDetail,
  type LeverPosting,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
  companiesPath?: string
}

export interface ParsedId {
  ats: Ats
  token: string
  jobId: string
}

const TOKEN_RE = /^[A-Za-z0-9._-]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Accept the CLI's own `<ats>:<token>:<jobId>` id, or a hosted job URL on one
 * of the three ATS job-board hosts (with or without scheme). Any other host is
 * rejected: a posting's own page hands out links to recruiters' sites, apply
 * widgets and the like, and following one would fetch and print whatever that
 * site returns with exit 0. Host and path are read through real URL parsing so
 * look-alike hosts (jobs.lever.co.evil.io) and userinfo tricks
 * (jobs.lever.co@evil.io) fall on the reject side.
 */
export function normalizeId(input: string): ParsedId | null {
  const trimmed = input.trim()

  const parts = trimmed.split(":")
  if (parts.length === 3 && (ATS_NAMES as readonly string[]).includes(parts[0])) {
    const [ats, token, jobId] = parts
    if (TOKEN_RE.test(token) && /^[A-Za-z0-9-]+$/.test(jobId)) return { ats: ats as Ats, token, jobId }
    return null
  }

  const hasScheme = /^https?:\/\//i.test(trimmed)
  if (!hasScheme && !/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) return null
  let parsed: URL
  try {
    parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  const segs = parsed.pathname.split("/").filter(Boolean)

  if (host === "job-boards.greenhouse.io" || host === "boards.greenhouse.io") {
    // /<token>/jobs/<numeric id>[/...]   (also /embed/job_app?for=<token>&token=<id>)
    if (segs[0] === "embed") {
      const token = parsed.searchParams.get("for") ?? ""
      const jobId = parsed.searchParams.get("token") ?? ""
      return TOKEN_RE.test(token) && /^\d+$/.test(jobId) ? { ats: "greenhouse", token, jobId } : null
    }
    if (segs.length >= 3 && segs[1] === "jobs" && TOKEN_RE.test(segs[0]) && /^\d+$/.test(segs[2])) {
      return { ats: "greenhouse", token: segs[0], jobId: segs[2] }
    }
    return null
  }
  if (host === "jobs.lever.co") {
    // /<token>/<uuid>[/apply]
    if (segs.length >= 2 && TOKEN_RE.test(segs[0]) && UUID_RE.test(segs[1])) {
      return { ats: "lever", token: segs[0], jobId: segs[1].toLowerCase() }
    }
    return null
  }
  if (host === "jobs.ashbyhq.com") {
    // /<token>/<uuid>[/application]
    if (segs.length >= 2 && TOKEN_RE.test(segs[0]) && UUID_RE.test(segs[1])) {
      return { ats: "ashby", token: segs[0], jobId: segs[1].toLowerCase() }
    }
    return null
  }
  return null
}

/** The configured company for a board token, or a stand-in named after the token. */
function companyFor(id: ParsedId, companies: Company[]): Company {
  return (
    companies.find((c) => c.ats === id.ats && c.token.toLowerCase() === id.token.toLowerCase()) ?? {
      name: id.token,
      ats: id.ats,
      token: id.token,
    }
  )
}

/** Fetch one job. Returns null when the board or the job does not exist. */
export async function fetchDetail(id: ParsedId, company: Company): Promise<JobDetail | null> {
  if (id.ats === "greenhouse") {
    const job = await jsonFetch<GreenhouseJob>(
      `${greenhouseBase()}/v1/boards/${encodeURIComponent(id.token)}/jobs/${encodeURIComponent(id.jobId)}`,
    )
    if (!job || job.id == null) return null
    return normalizeGreenhouse(job, company).detail
  }
  if (id.ats === "lever") {
    const post = await jsonFetch<LeverPosting>(
      `${leverBase()}/v0/postings/${encodeURIComponent(id.token)}/${encodeURIComponent(id.jobId)}`,
    )
    if (!post || !post.id) return null
    return normalizeLever(post, company).detail
  }
  // Ashby has no single-job endpoint: fetch the board and pick the id. A job
  // that is on the board but unlisted is treated as not found, like the search.
  const board = await jsonFetch<unknown>(boardUrl(company))
  if (board === null) return null
  const hit = normalizeBoard("ashby", board, company).find((n) => n.detail.id.toLowerCase() === `ashby:${id.token}:${id.jobId}`.toLowerCase())
  if (hit) return hit.detail
  // Fall back to a raw scan so an isListed:false job still reports (as inactive).
  const raw = (board as { jobs?: Array<{ id?: string; isListed?: boolean }> })?.jobs?.find(
    (j) => (j.id ?? "").toLowerCase() === id.jobId.toLowerCase(),
  )
  if (!raw) return null
  const d = normalizeAshby(raw as Parameters<typeof normalizeAshby>[0], company).detail
  return { ...d, isActive: false }
}

export function renderPlain(job: JobDetail): string {
  return [
    job.title,
    `${job.company || "—"} · ${job.location || "—"}`,
    job.date ? `Posted: ${job.date}` : "",
    job.department ? `Department: ${job.department}` : "",
    job.employmentType ? `Employment: ${job.employmentType}` : "",
    job.remote === null ? "" : `Remote: ${job.remote ? "yes" : "no"}`,
    job.compensation ? `Compensation: ${job.compensation}` : "",
    `Status: ${job.isActive ? "ACTIVE" : "UNLISTED / CLOSED"}`,
    "",
    job.description || "(no description)",
    "",
    `URL: ${job.url}`,
    job.applyUrl && job.applyUrl !== job.url ? `Apply: ${job.applyUrl}` : "",
    `id: ${job.id}`,
  ]
    .filter((l) => l !== "")
    .join("\n")
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const id = normalizeId(opts.id)
  if (!id) {
    writeError(
      `Could not parse a job id from "${opts.id}" - pass <ats>:<token>:<jobId> from search, or a job URL on job-boards.greenhouse.io, boards.greenhouse.io, jobs.lever.co or jobs.ashbyhq.com`,
      "BAD_ID",
    )
    return 1
  }
  try {
    let companies: Company[] = []
    try {
      companies = loadCompanies(opts.companiesPath)
    } catch {
      // A broken companies file must not block a detail lookup by explicit id.
    }
    const job = await fetchDetail(id, companyFor(id, companies))
    if (!job) {
      writeError("Job not found", "NOT_FOUND")
      return 1
    }
    const out = stripInvisible(job)
    if (opts.format === "plain") {
      process.stdout.write(renderPlain(out) + "\n")
    } else {
      process.stdout.write(JSON.stringify(out, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
