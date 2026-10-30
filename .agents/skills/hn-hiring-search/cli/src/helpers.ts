// Data source: the monthly "Ask HN: Who is hiring? (Month Year)" threads on
// Hacker News, read through the two official, unauthenticated HN APIs: the
// Algolia HN Search API (finding the threads; fetching a thread with all of
// its comments in one call) and the Firebase HN API (fallback, one item per
// request). Each top-level comment of a thread is one job ad written as free
// text, usually with a header line like
//   Company | Role(s) | Location | ONSITE/REMOTE | Full-time | $salary
// so the "parsing" here is a set of header heuristics, kept pure so the test
// suite can run them offline over fixtures.

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

const UA = "Mozilla/5.0 (compatible; hn-hiring-search-cli/1.0)"

// Base URLs. The env overrides exist so the offline test suite can point the
// CLI at a loopback server; they are not a self-hosting feature.
export function algoliaBase(): string {
  return (process.env.HN_ALGOLIA_API_URL || "https://hn.algolia.com").replace(/\/+$/, "")
}
export function firebaseBase(): string {
  return (process.env.HN_FIREBASE_API_URL || "https://hacker-news.firebaseio.com").replace(/\/+$/, "")
}

/**
 * GET JSON with exponential backoff + jitter on 429/5xx (six retries), a 15s
 * per-request timeout, and `null` on a 404 (an unknown item is a documented
 * state, not a crash). Firebase answers an unknown id with the literal `null`
 * body, which also comes back as null.
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
    const body = (await response.json().catch(() => undefined)) as T | null | undefined
    if (body === undefined) throw new Error("API returned an unparseable response body")
    return body
  }
  throw new Error("Request failed after max retries")
}

// ---------------------------------------------------------------------------
// Wire shapes (the fields this skill reads; each API carries more)
// ---------------------------------------------------------------------------

/** One hit of the Algolia search endpoint (a story). */
export interface AlgoliaHit {
  objectID: string
  title?: string | null
  author?: string | null
  created_at?: string | null
  created_at_i?: number | null
  num_comments?: number | null
}
export interface AlgoliaSearch {
  hits: AlgoliaHit[]
  nbHits?: number
  page?: number
  hitsPerPage?: number
}

/** One item of the Algolia items endpoint: a story or a comment, with its children inlined. */
export interface AlgoliaItem {
  id: number
  created_at?: string | null
  created_at_i?: number | null
  type?: string | null
  author?: string | null
  title?: string | null
  text?: string | null
  parent_id?: number | null
  story_id?: number | null
  children?: AlgoliaItem[]
}

/** One item of the Firebase API (`/v0/item/{id}.json`). */
export interface FirebaseItem {
  id: number
  type?: string
  by?: string
  time?: number
  title?: string
  text?: string
  parent?: number
  kids?: number[]
  deleted?: boolean
  dead?: boolean
}

export const HIRING_TITLE_RE = /^ask hn: who is hiring\?/i

/** A "Who is hiring?" thread as the CLI reports it in `meta.threads`. */
export interface Thread {
  id: string
  title: string
  createdAt: string | null
}

/**
 * Keep only the hiring threads among the whoishiring account's stories (it
 * also posts "Who wants to be hired?" and "Freelancer? Seeking freelancer?"),
 * newest first. Pure, for tests.
 */
export function selectHiringThreads(body: AlgoliaSearch | null, months: number): Thread[] {
  const hits = Array.isArray(body?.hits) ? body!.hits : []
  return hits
    .filter((h) => h && typeof h.objectID === "string" && /^\d+$/.test(h.objectID))
    .filter((h) => HIRING_TITLE_RE.test(cleanField(h.title) ?? ""))
    .map((h) => ({ id: h.objectID, title: cleanField(h.title) ?? "Ask HN: Who is hiring?", createdAt: h.created_at ?? null }))
    .sort((a, b) => (Date.parse(b.createdAt ?? "") || 0) - (Date.parse(a.createdAt ?? "") || 0))
    .slice(0, months)
}

// ---------------------------------------------------------------------------
// Result shapes (portal-skill contract + HN extras)
// ---------------------------------------------------------------------------

export interface JobResult {
  id: string // the comment id - what `detail` consumes
  title: string
  company: string | null
  location: string | null
  date: string | null // YYYY-MM-DD
  url: string
  remote: boolean | null
  workplace: string | null // raw ONSITE/REMOTE/HYBRID tags from the header
  salary: string | null
  employmentType: string | null
  author: string | null
  threadId: string
  threadTitle: string
  snippet: string | null // first 200 chars of the body after the header
}

export interface JobDetail extends JobResult {
  description: string | null
  isActive: boolean
}

/** A parsed job comment with the text the search filters need. */
export interface Normalized {
  result: JobResult
  detail: JobDetail
  header: string // the header line, plain text
  body: string // the whole comment, plain text with paragraph breaks
  workplace: "remote" | "hybrid" | "onsite" | null
  timestamp: number | null // ms epoch for sorting and --jobage
}

/** The contract date (YYYY-MM-DD) from an ISO timestamp or ms epoch, else null. */
export function contractDate(value: string | number | null | undefined): string | null {
  const ms = toMs(value)
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10)
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
 * HTML comment -> plain text with paragraph breaks. HN comments are `<p>`
 * separated paragraphs with `<a>` and `<i>` inline, entities for everything
 * else (`&#x27;`, `&quot;`, `&#x2F;`). Hidden markup goes before the line
 * split (a hidden element can span the breaks), then each rendered line is
 * cleaned separately so `stripTags`'s whitespace collapse cannot erase the
 * boundaries.
 */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null
  const withBreaks = visibleHtml(html)
    .replace(/\s+/g, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|ul|ol|div|h\d|tr|blockquote|pre)>/gi, "\n")
    .replace(/<p\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    // Inline tags (links, emphasis, spans) separate nothing: dropping them
    // outright keeps "per <a>local law</a>." from becoming "per local law ."
    .replace(/<\/?(a|b|i|u|em|strong|span|code|small|sup|sub|mark|abbr)\b[^>]*>/gi, "")
  return withBreaks.split("\n").map(clean).filter((l) => l.length > 0).join("\n").trim() || null
}

/** A short text field: entities decoded, tags dropped, whitespace collapsed; null when empty. */
export function cleanField(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  return clean(value) || null
}

// ---------------------------------------------------------------------------
// Header heuristics (pure functions over the comment text, for offline tests)
// ---------------------------------------------------------------------------

const US_STATES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC"
const US_STATE_RE = new RegExp(`(?:^|[\\s,(])(?:${US_STATES})(?=$|[\\s,)/])`)
const PLACE_RE =
  /\b(?:san francisco|sf|bay area|silicon valley|palo alto|mountain view|menlo park|san jose|oakland|berkeley|nyc|new york|brooklyn|boston|cambridge|seattle|austin|denver|boulder|chicago|los angeles|la|san diego|portland|washington|miami|atlanta|toronto|vancouver|london|berlin|paris|amsterdam|dublin|zurich|stockholm|copenhagen|tel aviv|singapore|sydney|tokyo|bangalore|bengaluru|usa?|u\.s\.|united states|us-only|north america|canada|uk|united kingdom|germany|france|netherlands|switzerland|europe|eu|emea|worldwide|global|anywhere|remote)\b/i
const WORKPLACE_RE = /\b(?:remote|onsite|on-site|in-office|in-person|hybrid)\b/i
const SALARY_RE = /\$\s?\d|\d\s?k\b.*\$|€|£|\bUSD\b|\bEUR\b|\bGBP\b|\d{2,3}k\s?-\s?\d{2,3}k/i
const EMPLOYMENT_RE = /\bfull[- ]?time|part[- ]?time|contract(?:or|ing)?|intern(?:ship)?s?|freelance|FT\b|PT\b/i
const ROLE_RE =
  /\b(?:engineer|engineering|scientist|developer|dev|manager|lead|founding|staff|principal|head|director|vp|cto|researcher|research|analyst|architect|designer|product|swe|sre|devops|data|ml|ai|backend|frontend|front-end|back-end|full[- ]?stack|mobile|ios|android|security|infra|platform|recruiter|sales|marketing|ops|operations|finance|accountant|counsel|support|writer|pm|roles?|positions?|hiring|openings?)\b/i

export interface ParsedHeader {
  company: string | null
  title: string
  location: string | null
  workplace: string | null
  remote: boolean | null
  salary: string | null
  employmentType: string | null
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s
}

/** Split the header on `|` / `｜`; when it has none, on ` - `, ` – ` or ` — `. */
export function splitHeader(header: string): string[] {
  let parts: string[]
  if (/[|｜]/.test(header)) parts = header.split(/\s*[|｜]\s*/)
  else if (/\s[-–—]\s/.test(header)) parts = header.split(/\s+[-–—]\s+/)
  else parts = [header]
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

/**
 * Classify the fields of a "Company | Role | Location | REMOTE | Full-time |
 * $salary" header. Field order is only a convention on HN, so every field
 * after the company is classified by what it looks like; `title` is never
 * empty so a result always has something to show.
 */
export function parseHeader(header: string): ParsedHeader {
  const fields = splitHeader(header)
  const empty: ParsedHeader = {
    company: null,
    title: "(see posting)",
    location: null,
    workplace: null,
    remote: null,
    salary: null,
    employmentType: null,
  }
  if (fields.length === 0) return empty

  if (fields.length === 1 && !/[|｜]/.test(header)) {
    // No separators: a prose opening. The company is the first sentence (or
    // its first 60 chars); there is no reliable title.
    const sentence = header.split(/(?<=[.!?])\s/)[0] ?? header
    const company = truncate(sentence.trim(), 60) || null
    const wp = workplaceTags(header)
    return { ...empty, company, workplace: wp, remote: remoteFromTags(wp) }
  }

  const company = truncate(fields[0], 80) || null
  const locations: string[] = []
  const workplaces: string[] = []
  const titles: string[] = []
  let salary: string | null = null
  let employmentType: string | null = null

  for (const f of fields.slice(1)) {
    const tags = workplaceTags(f)
    const isWorkplaceOnly =
      tags !== null && f.replace(new RegExp(WORKPLACE_RE.source, "gi"), "").replace(/\b(?:or|and|only)\b/gi, "").replace(/[\s,/()&+-]/g, "").length === 0
    if (isWorkplaceOnly) {
      workplaces.push(tags!)
      continue
    }
    if (salary === null && SALARY_RE.test(f) && !ROLE_RE.test(f.replace(/\b(?:ai|ml|data)\b/gi, ""))) {
      salary = f
      continue
    }
    if (employmentType === null && EMPLOYMENT_RE.test(f) && !ROLE_RE.test(f.replace(/\b(?:roles?|positions?|openings?)\b/gi, ""))) {
      employmentType = f
      continue
    }
    const looksLikePlace = US_STATE_RE.test(f) || PLACE_RE.test(f)
    if (looksLikePlace && !ROLE_RE.test(f.replace(/\b(?:remote|la|us|ai)\b/gi, ""))) {
      locations.push(f)
      if (tags) workplaces.push(tags)
      continue
    }
    if (ROLE_RE.test(f)) {
      titles.push(f)
      continue
    }
    // Unclassified: a place we don't know, a stack, a tagline. A field that
    // carries a workplace tag is a location ("Remote (US timezones)").
    if (tags) {
      locations.push(f)
      workplaces.push(tags)
    } else if (titles.length === 0 && locations.length > 0) {
      titles.push(f)
    } else if (locations.length === 0 && /^[A-Z][A-Za-z.' -]+(?:,\s*[A-Z][A-Za-z.' -]+)+$/.test(f)) {
      // "City, Country" shaped
      locations.push(f)
    } else {
      titles.push(f)
    }
  }

  let title = titles.join(", ").trim()
  if (!title) title = fields.slice(1).join(" | ").trim() || "(see posting)"
  title = truncate(title, 120)
  const workplace = workplaces.length ? uniqTags(workplaces.join(" ")) : null
  // A location field made only of workplace tags ("REMOTE") is still a
  // location for the reader; keep "Remote" as the location when nothing else.
  const location = locations.length ? truncate(locations.join("; "), 120) : workplace && /remote/i.test(workplace) ? "Remote" : null
  return { company, title, location, workplace, remote: remoteFromTags(workplace), salary, employmentType }
}

/** The ONSITE/REMOTE/HYBRID tags present in a string, upper-cased and de-duplicated, or null. */
function workplaceTags(s: string): string | null {
  const found = s.match(new RegExp(WORKPLACE_RE.source, "gi"))
  return found ? uniqTags(found.join(" ")) : null
}

function uniqTags(s: string): string {
  const seen = new Set<string>()
  for (const m of s.match(new RegExp(WORKPLACE_RE.source, "gi")) ?? []) {
    const t = m.toUpperCase().replace(/^ON-SITE$|^IN-OFFICE$|^IN-PERSON$/, "ONSITE")
    seen.add(t)
  }
  return [...seen].join(" ")
}

/** true if REMOTE is tagged, false if only ONSITE/HYBRID is, null without tags. */
function remoteFromTags(tags: string | null): boolean | null {
  if (!tags) return null
  return /\bREMOTE\b/.test(tags)
}

export function workplaceMode(tags: string | null): Normalized["workplace"] {
  if (!tags) return null
  if (/\bREMOTE\b/.test(tags)) return "remote"
  if (/\bHYBRID\b/.test(tags)) return "hybrid"
  if (/\bONSITE\b/.test(tags)) return "onsite"
  return null
}

// ---------------------------------------------------------------------------
// Comment -> result
// ---------------------------------------------------------------------------

export function itemUrl(id: string | number): string {
  return `https://news.ycombinator.com/item?id=${id}`
}

/**
 * Parse one top-level comment of a hiring thread (pure). Returns null for a
 * deleted/dead comment (`text` null) or one that has no visible text.
 */
export function parseJobComment(
  comment: { id: number | string; text?: string | null; author?: string | null; created_at?: string | null; created_at_i?: number | null },
  thread: Thread,
): Normalized | null {
  if (comment.text === null || comment.text === undefined || typeof comment.text !== "string") return null
  const body = htmlToText(comment.text)
  if (!body) return null
  const lines = body.split("\n")
  const header = lines[0].trim()
  const rest = lines.slice(1).join("\n").trim()
  const parsed = parseHeader(header)
  const timestamp = toMs(comment.created_at) ?? (typeof comment.created_at_i === "number" ? comment.created_at_i * 1000 : null)
  const id = String(comment.id)
  const result: JobResult = {
    id,
    title: parsed.title,
    company: parsed.company,
    location: parsed.location,
    date: contractDate(timestamp),
    url: itemUrl(id),
    remote: parsed.remote,
    workplace: parsed.workplace,
    salary: parsed.salary,
    employmentType: parsed.employmentType,
    author: cleanField(comment.author),
    threadId: thread.id,
    threadTitle: thread.title,
    snippet: rest ? truncate(rest.replace(/\s+/g, " "), 200) : null,
  }
  const detail: JobDetail = { ...result, description: body, isActive: true }
  return { result, detail, header, body, workplace: workplaceMode(parsed.workplace), timestamp }
}

/** Parse the top-level children of an Algolia thread item (nested replies are ignored). */
export function parseThreadItem(item: AlgoliaItem | null, thread: Thread): Normalized[] {
  const children = Array.isArray(item?.children) ? item!.children : []
  const out: Normalized[] = []
  for (const c of children) {
    if (!c || c.id == null) continue
    const n = parseJobComment(c, thread)
    if (n) out.push(n)
  }
  return out
}

/** Thread metadata from an Algolia story item or search hit. */
export function threadFromItem(item: AlgoliaItem): Thread {
  return { id: String(item.id), title: cleanField(item.title) ?? "Ask HN: Who is hiring?", createdAt: item.created_at ?? null }
}

/** Parse a Firebase comment item (the fallback path) into the same shape. */
export function parseFirebaseComment(item: FirebaseItem | null, thread: Thread): Normalized | null {
  if (!item || item.deleted || item.dead || item.type !== "comment") return null
  return parseJobComment(
    { id: item.id, text: item.text ?? null, author: item.by ?? null, created_at_i: item.time ?? null },
    thread,
  )
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

export function matchesQuery(n: Normalized, terms: string[]): boolean {
  if (terms.length === 0) return true
  const hay = n.body.toLowerCase()
  return terms.some((t) => hay.includes(t))
}

/**
 * `--location` is a substring match over the location field and the whole
 * header line (people write "SF", "Bay Area" or "US timezones" anywhere in
 * it). `Remote` additionally matches the REMOTE tag.
 */
export function matchesLocation(n: Normalized, location: string | undefined): boolean {
  if (!location) return true
  const needle = location.trim().toLowerCase()
  if (!needle) return true
  if ((n.result.location ?? "").toLowerCase().includes(needle)) return true
  if (n.header.toLowerCase().includes(needle)) return true
  if (needle === "remote") return n.workplace === "remote"
  return false
}

export function matchesRemote(n: Normalized, mode: string | undefined): boolean {
  if (!mode) return true
  if (mode === "remote") return n.result.remote === true
  if (mode === "hybrid") return /\bHYBRID\b/.test(n.result.workplace ?? "")
  // onsite: tagged ONSITE and not also REMOTE
  return /\bONSITE\b/.test(n.result.workplace ?? "") && n.result.remote !== true
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
