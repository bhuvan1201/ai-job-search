// Data source: the public, unauthenticated job-board JSON APIs of Greenhouse,
// Lever and Ashby. These are the official endpoints companies embed on their
// own careers pages, so there is no markup to scrape and no ToS problem; keep
// volume modest anyway (the CLI backs off on 429/5xx). Each configured company
// is one board; search fans out across the boards and merges the results into
// the portal-skill contract shape.

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

export type Ats = "greenhouse" | "lever" | "ashby"
export const ATS_NAMES: readonly Ats[] = ["greenhouse", "lever", "ashby"]

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

const UA = "Mozilla/5.0 (compatible; ats-boards-search-cli/1.0)"

// Base URLs. The env overrides exist so the offline test suite can point the
// CLI at a loopback server; they are not a self-hosting feature.
export function greenhouseBase(): string {
  return (process.env.ATS_GREENHOUSE_API_URL || "https://boards-api.greenhouse.io").replace(/\/+$/, "")
}
export function leverBase(): string {
  return (process.env.ATS_LEVER_API_URL || "https://api.lever.co").replace(/\/+$/, "")
}
export function ashbyBase(): string {
  return (process.env.ATS_ASHBY_API_URL || "https://api.ashbyhq.com").replace(/\/+$/, "")
}

/**
 * GET JSON with exponential backoff + jitter on 429/5xx (six retries), a 15s
 * per-request timeout, and `null` on a 404 (an unknown board or job is a
 * documented state, not a crash).
 */
export async function jsonFetch<T>(url: string): Promise<T | null> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`)
      }
      const jitter = Math.floor(Math.random() * 500)
      await new Promise((r) => setTimeout(r, delay + jitter))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`)
    }
    const body = (await response.json().catch(() => undefined)) as T | undefined
    if (body === undefined) throw new Error("API returned an unparseable response body")
    return body
  }
  throw new Error("Request failed after max retries")
}

// ---------------------------------------------------------------------------
// Company list
// ---------------------------------------------------------------------------

export interface Company {
  name: string
  ats: Ats
  token: string
  verified?: boolean
}

/** Default list: `<skill>/companies.json`, resolved from this file's location. */
export const DEFAULT_COMPANIES_PATH = resolve(import.meta.dir, "..", "..", "companies.json")

/** Parse a companies document (pure, for tests). Throws on a malformed entry. */
export function parseCompanies(doc: unknown): Company[] {
  const list = (doc as { companies?: unknown })?.companies
  if (!Array.isArray(list)) throw new Error('companies file must be an object with a "companies" array')
  return list.map((raw, i) => {
    const c = raw as Partial<Company>
    if (!c || typeof c.name !== "string" || !c.name.trim()) throw new Error(`companies[${i}]: "name" is required`)
    if (!ATS_NAMES.includes(c.ats as Ats)) {
      throw new Error(`companies[${i}] (${c.name}): "ats" must be one of ${ATS_NAMES.join("|")}`)
    }
    if (typeof c.token !== "string" || !/^[A-Za-z0-9._-]+$/.test(c.token)) {
      throw new Error(`companies[${i}] (${c.name}): "token" must be a board slug (letters, digits, . _ -)`)
    }
    return { name: c.name.trim(), ats: c.ats as Ats, token: c.token, verified: c.verified === true }
  })
}

export function loadCompanies(path: string = DEFAULT_COMPANIES_PATH): Company[] {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (e) {
    throw new Error(`could not read companies file ${path}: ${e instanceof Error ? e.message : String(e)}`)
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (e) {
    throw new Error(`companies file ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  return parseCompanies(doc)
}

/** The board-listing URL for a company. */
export function boardUrl(c: Company): string {
  switch (c.ats) {
    case "greenhouse":
      return `${greenhouseBase()}/v1/boards/${encodeURIComponent(c.token)}/jobs?content=true`
    case "lever":
      return `${leverBase()}/v0/postings/${encodeURIComponent(c.token)}?mode=json`
    case "ashby":
      return `${ashbyBase()}/posting-api/job-board/${encodeURIComponent(c.token)}?includeCompensation=true`
  }
}

// ---------------------------------------------------------------------------
// Wire shapes (the fields this skill reads; each API carries more)
// ---------------------------------------------------------------------------

export interface GreenhouseJob {
  id: number | string
  title: string
  updated_at?: string
  first_published?: string
  location?: { name?: string }
  absolute_url?: string
  content?: string // HTML-escaped HTML
  departments?: Array<{ name?: string }>
  offices?: Array<{ name?: string; location?: string }>
  metadata?: Array<{ name?: string; value?: unknown }>
}
export interface GreenhouseBoard {
  jobs: GreenhouseJob[]
  meta?: { total?: number }
}

export interface LeverPosting {
  id: string
  text: string
  createdAt?: number
  hostedUrl?: string
  applyUrl?: string
  categories?: {
    commitment?: string
    department?: string
    location?: string
    team?: string
    allLocations?: string[]
  }
  workplaceType?: string
  description?: string
  descriptionPlain?: string
  lists?: Array<{ text?: string; content?: string }>
  additional?: string
  additionalPlain?: string
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string }
}

export interface AshbyJob {
  id: string
  title: string
  department?: string
  team?: string
  employmentType?: string
  location?: string
  secondaryLocations?: Array<{ location?: string }>
  publishedAt?: string
  isRemote?: boolean
  isListed?: boolean
  jobUrl?: string
  applyUrl?: string
  descriptionHtml?: string
  descriptionPlain?: string
  compensation?: { compensationTierSummary?: string } | null
}
export interface AshbyBoard {
  apiVersion?: string
  jobs: AshbyJob[]
}

// ---------------------------------------------------------------------------
// Result shapes (portal-skill contract + ATS extras)
// ---------------------------------------------------------------------------

export interface JobResult {
  id: string // "<ats>:<token>:<jobId>" - what `detail` consumes
  title: string
  company: string | null
  location: string | null
  date: string | null // YYYY-MM-DD
  url: string
  ats: Ats
  department: string | null
  remote: boolean | null
  applyUrl: string | null
}

export interface JobDetail extends JobResult {
  description: string | null
  employmentType: string | null
  compensation: string | null
  isActive: boolean
}

/**
 * A normalized posting with everything the search filters need. `locations`
 * and `text` never reach the output: search emits the JobResult fields and
 * detail emits JobDetail.
 */
export interface Normalized {
  result: JobResult
  detail: JobDetail
  locations: string[] // every location string the ATS exposes
  workplace: "remote" | "hybrid" | "onsite" | null
  text: string // department/team text for --query matching
  timestamp: number | null // ms epoch for sorting and --jobage
}

export function makeId(ats: Ats, token: string, jobId: string | number): string {
  return `${ats}:${token}:${jobId}`
}

/** The contract date (YYYY-MM-DD) from an ISO timestamp or ms epoch, else null. */
export function contractDate(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null
  const ms = typeof value === "number" ? value : Date.parse(value)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(0, 10)
}

function toMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null
  const ms = typeof value === "number" ? value : Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

// ---------------------------------------------------------------------------
// Output hygiene (copied from linkedin-search; a security requirement)
// ---------------------------------------------------------------------------

/**
 * Convert a Unicode code point to a string. Uses `fromCodePoint` (not
 * `fromCharCode`) so supplementary-plane code points (e.g. emoji, U+1F600)
 * decode correctly, and drops out-of-range values instead of throwing.
 */
function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    // Numeric character references: decimal (&#233;) and hexadecimal (&#xE9;).
    .replace(/&#(\d+);/g, (_, dec) => numericEntity(parseInt(dec, 10)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => numericEntity(parseInt(hex, 16)))
    .replace(/&nbsp;/g, " ")
}

/**
 * Characters a reader of the posting never sees but a model reading this
 * output does: C0/C1 controls other than tab, newline and carriage return, the
 * soft hyphen, bidi marks/embeddings/overrides/isolates, zero-width characters
 * and invisible operators, the BOM, variation selectors, and Unicode tag
 * characters (U+E0000-E007F), which can spell out a whole hidden instruction.
 * Listing text is third-party data, and these arrive raw in a portal's JSON or
 * markup as easily as through a numeric entity.
 */
const INVISIBLE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁯︀-️﻿\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu

/** Strip INVISIBLE_CHARS from every string in a result, recursively: the CLI's output boundary. */
export function stripInvisible<T>(value: T): T {
  if (typeof value === "string") return value.replace(INVISIBLE_CHARS, "") as T
  if (Array.isArray(value)) return value.map(stripInvisible) as T
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripInvisible(v)])) as T
  }
  return value
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"])

/** Whether an opening tag's attributes keep it from rendering: `hidden`, or an inline style that hides it. */
function isHiddenTag(attrs: string): boolean {
  for (const m of attrs.matchAll(/([^\s"'=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = m[1].toLowerCase()
    const value = m[2] ?? m[3] ?? m[4] ?? ""
    if (name === "hidden") return true
    if (name === "style" && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)\b/i.test(value)) {
      return true
    }
  }
  return false
}

/**
 * Drop markup a browser never renders - comments (including Word's
 * conditional ones), <script>/<style>/<template> blocks, and elements marked
 * hidden - before tags are stripped. A plain tag strip keeps their text, which
 * hands the model words the posting's reader never saw. CSS-only tricks
 * (off-screen, zero font size) need a renderer and are not caught here.
 */
export function visibleHtml(html: string): string {
  const src = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
  // One pass, collecting what is kept: slicing the string per hidden element
  // would make a page full of them quadratic.
  const open = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/g
  const kept: string[] = []
  let from = 0
  let m: RegExpExecArray | null
  while ((m = open.exec(src)) !== null) {
    if (!m[2] || !isHiddenTag(m[2])) continue
    const tag = m[1].toLowerCase()
    let end = open.lastIndex
    if (!VOID_TAGS.has(tag) && !m[0].endsWith("/>")) {
      // Skip to the matching close tag, counting nested same-name elements. An
      // unclosed hidden element runs to the end: failing closed drops visible
      // text, failing open would leak the hidden text.
      const same = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi")
      same.lastIndex = end
      end = src.length
      let depth = 1
      let s: RegExpExecArray | null
      while ((s = same.exec(src)) !== null) {
        if (s[1]) depth--
        else if (!s[0].endsWith("/>")) depth++
        if (depth === 0) {
          end = same.lastIndex
          break
        }
      }
    }
    kept.push(src.slice(from, m.index))
    from = end
    open.lastIndex = end
  }
  kept.push(src.slice(from))
  return kept.join("")
}

function stripTags(html: string): string {
  return visibleHtml(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
}

function clean(html: string): string {
  return decodeHtmlEntities(stripTags(html))
}

/**
 * HTML description -> plain text with paragraph breaks. Hidden markup goes
 * before the line split (a hidden element can span the breaks), then each
 * rendered line is cleaned separately so `stripTags`'s whitespace collapse
 * cannot erase the boundaries.
 */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null
  const withBreaks = visibleHtml(html)
    .replace(/\s+/g, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|ul|ol|div|h\d|tr|blockquote)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    // Inline tags (links, emphasis, spans) separate nothing: dropping them
    // outright keeps "per <a>local law</a>." from becoming "per local law ."
    .replace(/<\/?(a|b|i|u|em|strong|span|code|small|sup|sub|mark|abbr)\b[^>]*>/gi, "")
  return withBreaks.split("\n").map(clean).join("\n").replace(/\n{3,}/g, "\n\n").trim() || null
}

/** A short text field: entities decoded, tags dropped, whitespace collapsed; null when empty. */
export function cleanField(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  return clean(value) || null
}

// ---------------------------------------------------------------------------
// Normalizers (pure functions over the fetched JSON, for offline tests)
// ---------------------------------------------------------------------------

function workplaceFromText(texts: string[]): "remote" | "hybrid" | "onsite" | null {
  const joined = texts.join(" ").toLowerCase()
  if (/\bremote\b/.test(joined)) return "remote"
  if (/\bhybrid\b/.test(joined)) return "hybrid"
  return null
}

function uniq(values: Array<string | null | undefined>): string[] {
  const out: string[] = []
  for (const v of values) {
    if (typeof v === "string" && v.trim() && !out.includes(v.trim())) out.push(v.trim())
  }
  return out
}

export function normalizeGreenhouse(job: GreenhouseJob, company: Company): Normalized {
  const locations = uniq([
    job.location?.name,
    ...(job.offices ?? []).flatMap((o) => [o.name, o.location]),
  ])
  const department = cleanField((job.departments ?? []).map((d) => d.name).filter(Boolean).join(" / "))
  const workplace = workplaceFromText(locations)
  const jobId = String(job.id)
  const url = job.absolute_url || `https://job-boards.greenhouse.io/${company.token}/jobs/${jobId}`
  // Greenhouse ships `content` as HTML-escaped HTML: decode the entities to get
  // markup, then run the usual visible-text pipeline over it.
  const contentHtml = job.content ? decodeHtmlEntities(job.content) : null
  const timestamp = toMs(job.updated_at) ?? toMs(job.first_published)
  const result: JobResult = {
    id: makeId("greenhouse", company.token, jobId),
    title: cleanField(job.title) ?? "(untitled)",
    company: company.name,
    location: cleanField(job.location?.name) ?? (locations[0] ?? null),
    date: contractDate(timestamp),
    url,
    ats: "greenhouse",
    department,
    remote: workplace === null ? null : workplace === "remote",
    applyUrl: url,
  }
  const employmentType =
    (job.metadata ?? []).find((m) => /employment\s*type/i.test(m.name ?? ""))?.value ?? null
  const detail: JobDetail = {
    ...result,
    description: htmlToText(contentHtml),
    employmentType: typeof employmentType === "string" ? cleanField(employmentType) : null,
    compensation: null,
    isActive: true,
  }
  return { result, detail, locations, workplace, text: department ?? "", timestamp }
}

function leverWorkplace(value: string | undefined): "remote" | "hybrid" | "onsite" | null {
  switch ((value || "").toLowerCase()) {
    case "remote":
      return "remote"
    case "hybrid":
      return "hybrid"
    case "onsite":
    case "on-site":
      return "onsite"
    default:
      return null
  }
}

/** Lever's salary interval ("per-year-salary", "per-hour-wage") as "per year" / "per hour". */
function leverInterval(interval: string): string {
  const words = interval.toLowerCase().split(/[-_\s]+/).filter((w) => w && w !== "salary" && w !== "wage")
  return (words[0] === "per" ? words : ["per", ...words]).join(" ")
}

export function normalizeLever(post: LeverPosting, company: Company): Normalized {
  const cats = post.categories ?? {}
  const locations = uniq([cats.location, ...(cats.allLocations ?? [])])
  const department = cleanField([cats.department, cats.team].filter(Boolean).join(" / "))
  const workplace = leverWorkplace(post.workplaceType) ?? workplaceFromText(locations)
  const url = post.hostedUrl || `https://jobs.lever.co/${company.token}/${post.id}`
  const timestamp = typeof post.createdAt === "number" ? post.createdAt : null
  const result: JobResult = {
    id: makeId("lever", company.token, post.id),
    title: cleanField(post.text) ?? "(untitled)",
    company: company.name,
    location: cleanField(cats.location) ?? (locations[0] ?? null),
    date: contractDate(timestamp),
    url,
    ats: "lever",
    department,
    remote: workplace === null ? null : workplace === "remote",
    applyUrl: post.applyUrl || url,
  }
  // description + each list section (heading then items) + additional.
  const parts = [
    post.description,
    ...(post.lists ?? []).map((l) => `<h3>${l.text ?? ""}</h3><ul>${l.content ?? ""}</ul>`),
    post.additional,
  ].filter((p): p is string => typeof p === "string" && p.trim().length > 0)
  const sr = post.salaryRange
  const compensation =
    sr && (sr.min != null || sr.max != null)
      ? `${sr.currency ? sr.currency + " " : ""}${[sr.min, sr.max].filter((v) => v != null).join(" – ")}${sr.interval ? " " + leverInterval(sr.interval) : ""}`
      : null
  const detail: JobDetail = {
    ...result,
    description: htmlToText(parts.join("\n")),
    employmentType: cleanField(cats.commitment),
    compensation,
    isActive: true,
  }
  return { result, detail, locations, workplace, text: department ?? "", timestamp }
}

export function normalizeAshby(job: AshbyJob, company: Company): Normalized {
  const locations = uniq([job.location, ...(job.secondaryLocations ?? []).map((s) => s.location)])
  const department = cleanField([job.department, job.team].filter(Boolean).join(" / "))
  const workplace: Normalized["workplace"] =
    job.isRemote === true ? "remote" : job.isRemote === false ? (workplaceFromText(locations) ?? "onsite") : workplaceFromText(locations)
  const url = job.jobUrl || `https://jobs.ashbyhq.com/${company.token}/${job.id}`
  const timestamp = toMs(job.publishedAt)
  const result: JobResult = {
    id: makeId("ashby", company.token, job.id),
    title: cleanField(job.title) ?? "(untitled)",
    company: company.name,
    location: cleanField(job.location) ?? (locations[0] ?? null),
    date: contractDate(timestamp),
    url,
    ats: "ashby",
    department,
    remote: job.isRemote === true ? true : job.isRemote === false ? false : workplace === null ? null : workplace === "remote",
    applyUrl: job.applyUrl || url,
  }
  const detail: JobDetail = {
    ...result,
    description: htmlToText(job.descriptionHtml) ?? (job.descriptionPlain?.trim() || null),
    employmentType: cleanField(job.employmentType),
    compensation: cleanField(job.compensation?.compensationTierSummary),
    isActive: true,
  }
  return { result, detail, locations, workplace, text: department ?? "", timestamp }
}

/** Normalize a whole board response for a company. Tolerates a malformed body by returning []. */
export function normalizeBoard(ats: Ats, body: unknown, company: Company): Normalized[] {
  if (ats === "greenhouse") {
    const jobs = (body as GreenhouseBoard | null)?.jobs
    return Array.isArray(jobs) ? jobs.filter((j) => j && j.id != null).map((j) => normalizeGreenhouse(j, company)) : []
  }
  if (ats === "lever") {
    return Array.isArray(body) ? (body as LeverPosting[]).filter((p) => p && p.id).map((p) => normalizeLever(p, company)) : []
  }
  const jobs = (body as AshbyBoard | null)?.jobs
  return Array.isArray(jobs)
    ? jobs.filter((j) => j && j.id && j.isListed !== false).map((j) => normalizeAshby(j, company))
    : []
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** Split "a|b|c" into trimmed, non-empty, lower-cased OR terms. */
export function queryTerms(query: string): string[] {
  return query
    .split("|")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
}

export function matchesQuery(n: Normalized, terms: string[], deep: boolean): boolean {
  if (terms.length === 0) return true
  const hay = [n.result.title, n.text, deep ? n.detail.description ?? "" : ""].join("\n").toLowerCase()
  return terms.some((t) => hay.includes(t))
}

export function matchesLocation(n: Normalized, location: string | undefined): boolean {
  if (!location) return true
  const needle = location.trim().toLowerCase()
  if (!needle) return true
  const texts = n.locations.map((l) => l.toLowerCase())
  if (texts.some((l) => l.includes(needle))) return true
  if (needle === "remote") return n.workplace === "remote"
  return false
}

export function matchesRemote(n: Normalized, mode: string | undefined): boolean {
  if (!mode) return true
  return n.workplace === mode
}

export function withinJobage(n: Normalized, days: number | undefined, now = Date.now()): boolean {
  if (days === undefined) return true
  if (n.timestamp === null) return false
  return now - n.timestamp <= days * 86_400_000
}

export function remoteMode(mode: string | undefined): "remote" | "hybrid" | "onsite" | null {
  switch ((mode || "").toLowerCase()) {
    case "remote":
      return "remote"
    case "hybrid":
      return "hybrid"
    case "onsite":
    case "on-site":
      return "onsite"
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}
