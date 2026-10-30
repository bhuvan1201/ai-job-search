import {
  algoliaBase,
  firebaseBase,
  jsonFetch,
  mapLimit,
  matchesLocation,
  matchesQuery,
  matchesRemote,
  parseFirebaseComment,
  parseThreadItem,
  queryTerms,
  selectHiringThreads,
  stripInvisible,
  threadFromItem,
  withinJobage,
  writeError,
  HIRING_TITLE_RE,
  cleanField,
  type AlgoliaItem,
  type AlgoliaSearch,
  type FirebaseItem,
  type JobResult,
  type Normalized,
  type Thread,
} from "../helpers.js"

export const PAGE_SIZE = 20
/** Firebase fallback: one request per comment, at most this many in flight. */
export const FIREBASE_CONCURRENCY = 8

export interface SearchOpts {
  query: string
  location?: string
  remote?: "remote" | "hybrid" | "onsite"
  jobage?: number
  months: number
  thread?: string
  page: number
  limit?: number
  format: "json" | "table" | "plain"
}

export interface ThreadMeta {
  id: string
  title: string
  comments: number
}

/** Find the n most recent "Who is hiring?" threads via the Algolia search API. */
export async function findThreads(months: number): Promise<Thread[]> {
  // 12 hits: the account posts three threads a month, so 12 covers four months
  // in one page; a second page covers the six-month maximum.
  const threads: Thread[] = []
  for (let page = 0; page < 2 && threads.length < months; page++) {
    const url = `${algoliaBase()}/api/v1/search_by_date?tags=story,author_whoishiring&query=${encodeURIComponent("who is hiring")}&hitsPerPage=12&page=${page}`
    const body = await jsonFetch<AlgoliaSearch>(url)
    const found = selectHiringThreads(body, months)
    for (const t of found) if (!threads.some((x) => x.id === t.id)) threads.push(t)
    if (!body || !Array.isArray(body.hits) || body.hits.length < 12) break
  }
  return threads
    .sort((a, b) => (Date.parse(b.createdAt ?? "") || 0) - (Date.parse(a.createdAt ?? "") || 0))
    .slice(0, months)
}

/**
 * Fetch a thread with all of its comments. The Algolia items endpoint returns
 * the whole tree in one call; when it fails (5xx after retries, timeout) the
 * Firebase API is used instead, one request per top-level comment.
 */
export async function fetchThread(thread: Thread): Promise<{ thread: Thread; jobs: Normalized[] }> {
  let item: AlgoliaItem | null = null
  let algoliaError: unknown = null
  try {
    item = await jsonFetch<AlgoliaItem>(`${algoliaBase()}/api/v1/items/${encodeURIComponent(thread.id)}`)
  } catch (e) {
    algoliaError = e
  }
  if (item && item.id != null) {
    const t = item.title ? threadFromItem(item) : thread
    if (!HIRING_TITLE_RE.test(t.title)) throw new Error(`thread ${thread.id} is not a "Who is hiring?" thread: "${t.title}"`)
    return { thread: t, jobs: parseThreadItem(item, t) }
  }
  // Algolia failed or answered 404: Firebase may still know the id.
  const story = await jsonFetch<FirebaseItem>(`${firebaseBase()}/v0/item/${encodeURIComponent(thread.id)}.json`)
  if (!story || story.type !== "story") {
    if (algoliaError) throw algoliaError instanceof Error ? algoliaError : new Error(String(algoliaError))
    throw new Error(`thread ${thread.id} not found`)
  }
  const t: Thread = {
    id: String(story.id),
    title: cleanField(story.title) ?? thread.title,
    createdAt: typeof story.time === "number" ? new Date(story.time * 1000).toISOString() : thread.createdAt,
  }
  if (!HIRING_TITLE_RE.test(t.title)) throw new Error(`thread ${thread.id} is not a "Who is hiring?" thread: "${t.title}"`)
  const kids = Array.isArray(story.kids) ? story.kids : []
  const items = await mapLimit(kids, FIREBASE_CONCURRENCY, (kid) =>
    jsonFetch<FirebaseItem>(`${firebaseBase()}/v0/item/${kid}.json`).catch(() => null),
  )
  const jobs: Normalized[] = []
  for (const it of items) {
    const n = parseFirebaseComment(it, t)
    if (n) jobs.push(n)
  }
  return { thread: t, jobs }
}

/** Apply the search filters and the date-desc sort (pure, for tests). */
export function filterAndSort(all: Normalized[], opts: SearchOpts, now = Date.now()): Normalized[] {
  const terms = queryTerms(opts.query)
  return all
    .filter(
      (n) =>
        matchesQuery(n, terms) &&
        matchesLocation(n, opts.location) &&
        matchesRemote(n, opts.remote) &&
        withinJobage(n, opts.jobage, now),
    )
    .sort((a, b) => (b.timestamp ?? -Infinity) - (a.timestamp ?? -Infinity))
}

function renderTable(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  const lines = rows.map((c) => {
    const title = (c.title || "").slice(0, 40).padEnd(40)
    const company = (c.company || "—").slice(0, 22).padEnd(22)
    const loc = (c.location || "—").slice(0, 22).padEnd(22)
    const wp = (c.workplace || "—").slice(0, 13).padEnd(13)
    const date = c.date || "—"
    return `${c.id.padEnd(10)} ${title} ${company} ${loc} ${wp} ${date}`
  })
  const header =
    "ID".padEnd(10) + " " + "TITLE".padEnd(40) + " " + "COMPANY".padEnd(22) + " " + "LOCATION".padEnd(22) + " " + "WORKPLACE".padEnd(13) + " DATE"
  return [header, "-".repeat(header.length), ...lines].join("\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const threads: Thread[] = opts.thread
      ? [{ id: opts.thread, title: "Ask HN: Who is hiring?", createdAt: null }]
      : await findThreads(opts.months)
    if (threads.length === 0) {
      writeError('no "Ask HN: Who is hiring?" thread found via the Algolia HN search API', "NO_THREADS")
      return 1
    }

    const fetched = await mapLimit(threads, 2, fetchThread)
    const threadMeta: ThreadMeta[] = fetched.map((f) => ({ id: f.thread.id, title: f.thread.title, comments: f.jobs.length }))

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
      threads: threadMeta,
    })

    if (opts.format === "table") {
      process.stdout.write(renderTable(rows) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(
        (rows.length === 0
          ? "No results."
          : rows
              .map(
                (c) =>
                  `${c.title}\n  ${c.company || "—"} · ${c.location || "—"} · ${c.workplace || "—"} · ${c.date || "—"}${c.salary ? `\n  ${c.salary}` : ""}\n  id: ${c.id}\n  ${c.url}`,
              )
              .join("\n\n")) + "\n",
      )
    } else {
      process.stdout.write(JSON.stringify({ meta, results: rows }, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
