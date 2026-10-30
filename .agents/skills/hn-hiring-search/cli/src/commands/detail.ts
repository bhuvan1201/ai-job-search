import {
  algoliaBase,
  cleanField,
  firebaseBase,
  HIRING_TITLE_RE,
  jsonFetch,
  parseFirebaseComment,
  parseJobComment,
  stripInvisible,
  writeError,
  type AlgoliaItem,
  type FirebaseItem,
  type JobDetail,
  type Thread,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

/**
 * Accept a bare numeric HN item id, or a `news.ycombinator.com/item?id=N` URL
 * (with or without scheme, `www.` tolerated). Any other host is rejected: a
 * job comment is full of links to the company's own site, apply forms and
 * so on, and following one would fetch and print whatever that site returns
 * with exit 0. Host and query are read through real URL parsing so look-alike
 * hosts (news.ycombinator.com.evil.io) and userinfo tricks
 * (news.ycombinator.com@evil.io) fall on the reject side.
 */
export function normalizeId(input: string): string | null {
  const trimmed = input.trim()
  if (/^\d{1,12}$/.test(trimmed)) return trimmed

  const hasScheme = /^https?:\/\//i.test(trimmed)
  if (!hasScheme && !/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) return null
  let parsed: URL
  try {
    parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  if (host !== "news.ycombinator.com" && host !== "www.news.ycombinator.com") return null
  if (parsed.pathname.replace(/\/+$/, "") !== "/item") return null
  const id = parsed.searchParams.get("id") ?? ""
  return /^\d{1,12}$/.test(id) ? id : null
}

export class DetailError extends Error {
  constructor(message: string, public code: string) {
    super(message)
  }
}

/**
 * Fetch one comment and its parent story, checking that the story is a
 * "Who is hiring?" thread. Returns null when the item does not exist.
 */
export async function fetchDetail(id: string): Promise<JobDetail | null> {
  let item: AlgoliaItem | null = null
  let algoliaError: unknown = null
  try {
    item = await jsonFetch<AlgoliaItem>(`${algoliaBase()}/api/v1/items/${encodeURIComponent(id)}`)
  } catch (e) {
    algoliaError = e
  }

  if (item && item.id != null) {
    if (item.type !== "comment") {
      throw new DetailError(`item ${id} is a ${item.type ?? "non-comment item"}, not a job comment in a "Who is hiring?" thread`, "NOT_A_HIRING_POST")
    }
    const storyId = item.story_id ?? item.parent_id
    if (storyId == null) throw new DetailError(`item ${id} has no parent story`, "NOT_A_HIRING_POST")
    // Only top-level comments are job ads; a reply has parent_id != story_id.
    if (item.parent_id != null && item.story_id != null && item.parent_id !== item.story_id) {
      throw new DetailError(`item ${id} is a reply, not a top-level job comment`, "NOT_A_HIRING_POST")
    }
    const story = await jsonFetch<AlgoliaItem>(`${algoliaBase()}/api/v1/items/${storyId}`).catch(() => null)
    const storyTitle = cleanField(story?.title) ?? (await firebaseTitle(String(storyId)))
    if (!storyTitle || !HIRING_TITLE_RE.test(storyTitle)) {
      throw new DetailError(`item ${id} is not in a "Who is hiring?" thread (parent: "${storyTitle ?? "unknown"}")`, "NOT_A_HIRING_POST")
    }
    const thread: Thread = { id: String(storyId), title: storyTitle, createdAt: story?.created_at ?? null }
    const n = parseJobComment(item, thread)
    return n ? n.detail : null
  }

  // Firebase fallback (Algolia down, or it does not know the id).
  const fb = await jsonFetch<FirebaseItem>(`${firebaseBase()}/v0/item/${encodeURIComponent(id)}.json`)
  if (!fb) {
    if (algoliaError) throw algoliaError instanceof Error ? algoliaError : new Error(String(algoliaError))
    return null
  }
  if (fb.type !== "comment") throw new DetailError(`item ${id} is a ${fb.type ?? "non-comment item"}, not a job comment`, "NOT_A_HIRING_POST")
  if (fb.parent == null) throw new DetailError(`item ${id} has no parent story`, "NOT_A_HIRING_POST")
  const parent = await jsonFetch<FirebaseItem>(`${firebaseBase()}/v0/item/${fb.parent}.json`)
  const title = cleanField(parent?.title)
  if (!parent || parent.type !== "story" || !title || !HIRING_TITLE_RE.test(title)) {
    throw new DetailError(`item ${id} is not a top-level comment in a "Who is hiring?" thread`, "NOT_A_HIRING_POST")
  }
  const thread: Thread = {
    id: String(parent.id),
    title,
    createdAt: typeof parent.time === "number" ? new Date(parent.time * 1000).toISOString() : null,
  }
  const n = parseFirebaseComment(fb, thread)
  return n ? n.detail : null
}

async function firebaseTitle(storyId: string): Promise<string | null> {
  const s = await jsonFetch<FirebaseItem>(`${firebaseBase()}/v0/item/${storyId}.json`).catch(() => null)
  return cleanField(s?.title)
}

export function renderPlain(job: JobDetail): string {
  return [
    job.title,
    `${job.company || "—"} · ${job.location || "—"}`,
    job.date ? `Posted: ${job.date}` : "",
    job.workplace ? `Workplace: ${job.workplace}` : "",
    job.employmentType ? `Employment: ${job.employmentType}` : "",
    job.salary ? `Salary: ${job.salary}` : "",
    `Thread: ${job.threadTitle} (${job.threadId})`,
    job.author ? `Posted by: ${job.author}` : "",
    "",
    job.description || "(no description)",
    "",
    `URL: ${job.url}`,
    `id: ${job.id}`,
  ]
    .filter((l) => l !== "")
    .join("\n")
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const id = normalizeId(opts.id)
  if (!id) {
    writeError(
      `Could not parse an HN item id from "${opts.id}" - pass the numeric id from search, or a https://news.ycombinator.com/item?id=<id> URL`,
      "BAD_ID",
    )
    return 1
  }
  try {
    const job = await fetchDetail(id)
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
    if (e instanceof DetailError) {
      writeError(e.message, e.code)
      return 1
    }
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
