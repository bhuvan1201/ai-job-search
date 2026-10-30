# Hacker News "Who is hiring?" API Reference

Public, unauthenticated JSON endpoints used by this skill. Both are the official
HN APIs: the Algolia-hosted HN Search API and the Firebase-hosted HN API. No
keys, no login; the CLI backs off on 429/5xx. Base URLs can be overridden with
`HN_ALGOLIA_API_URL` and `HN_FIREBASE_API_URL`; this exists for the offline test
suite's loopback server.

## 1. Find the threads (Algolia HN Search)

```
GET https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=who%20is%20hiring&hitsPerPage=12[&page=N]
```

| Param | Meaning |
|-------|---------|
| `tags=story,author_whoishiring` | Stories posted by the `whoishiring` account only |
| `query=who is hiring` | Text match on the title (loose: the other monthly threads also match) |
| `hitsPerPage=12` | Three threads per month, so 12 covers four months; `page=1` reaches six |

Response: `{ "hits": [ ... ], "nbHits", "page", "hitsPerPage" }`. Each hit:

| Field | Used as |
|-------|---------|
| `objectID` (string) | thread id |
| `title` | must start with `Ask HN: Who is hiring?` - "Who wants to be hired?" and "Freelancer? Seeking freelancer?" hits are dropped |
| `created_at` (ISO) | newest-first ordering, `--months` selection |
| `num_comments` | informational only |

## 2. Fetch a thread with all comments (Algolia items)

```
GET https://hn.algolia.com/api/v1/items/{id}
```

Response: the story with its whole comment tree inlined.

| Field | Used as |
|-------|---------|
| `id`, `title`, `created_at` | `meta.threads[]`, `threadId` / `threadTitle` |
| `children[]` | **top-level comments = job ads**; their own `children` (replies) are ignored |
| `children[].id` | result `id`; `url` = `https://news.ycombinator.com/item?id={id}` |
| `children[].text` | **HTML** (`<p>` paragraphs, `<a>`, `<i>`; entities `&#x27;` `&quot;` `&#x2F;` `&gt;`) - `visibleHtml` → paragraph breaks → strip tags → decode entities. `null` = deleted/dead → skipped |
| `children[].author` | `author` |
| `children[].created_at` / `created_at_i` | `date` (YYYY-MM-DD), sort order, `--jobage` |
| `children[].parent_id`, `story_id` | `detail` checks `parent_id === story_id` (top-level) |

The same endpoint on a **comment** id returns that comment (with `type:
"comment"`, `story_id`, `parent_id`); `detail` then fetches `items/{story_id}`
to verify the parent's title. Unknown id → `404`.

### Header parsing (first paragraph of `text`)

Split on `|` (or `｜`); without pipes, on ` - ` / ` – ` / ` — `. Field 0 is the
company. Each later field is classified, in order:

| Looks like | Regex (case-insensitive) | Becomes |
|------------|--------------------------|---------|
| only workplace tags | `remote\|onsite\|on-site\|in-office\|hybrid` and nothing else | `workplace` (tags upper-cased, de-duplicated) |
| salary | `\$\s?\d`, `€`, `£`, `USD`, `170k-200k` | `salary` |
| employment | `full-time`, `part-time`, `contract`, `intern`, `freelance` | `employmentType` |
| place | US state abbreviation, SF/Bay Area/NYC/… city list, country/region words, `remote` | `location` (several joined with `; `) |
| role words | engineer, scientist, developer, manager, lead, founding, staff, head, researcher, analyst, … | `title` (several joined with `, `) |

`remote` = `true` if the tags include REMOTE, `false` if only ONSITE/HYBRID,
`null` without tags. If no field looks like a role, `title` = the header minus
the company (≤120 chars). No pipes at all: `company` = first sentence (≤60
chars), `title` = `"(see posting)"`.

## 3. Fallback: Firebase HN API

```
GET https://hacker-news.firebaseio.com/v0/item/{id}.json
```

Used when the Algolia items endpoint fails (5xx after retries, timeout) or does
not know the id. Returns `null` (HTTP 200) for an unknown id.

| Field | Used as |
|-------|---------|
| `type` (`story` / `comment`) | story: `title`, `kids[]` = top-level comment ids; comment: one job |
| `kids[]` | fetched one by one, at most 8 in flight |
| `text` | HTML as above (same entity escaping) |
| `by`, `time` (unix seconds), `parent` | `author`, `date`, parent-story check for `detail` |
| `deleted`, `dead` | skipped |

## CLI behaviour on top of the APIs

- All filtering (`--query`, `--location`, `--remote`, `--jobage`) is client-side;
  neither API searches comment text in a way that would honour the header fields.
- `--months n` (1-6) fetches the n newest hiring threads, two at a time, and
  merges their comments; `--thread <id>` fetches that one story and refuses it
  (`SEARCH_FAILED`) if its title is not a "Who is hiring?" title.
- Pagination is client-side over the merged, newest-first list: 20 per page.
- `detail` accepts a bare numeric id or a `news.ycombinator.com/item?id=N` URL
  only; other hosts are `BAD_ID`. A comment whose parent story is not a
  hiring thread, a story, or a nested reply is `NOT_A_HIRING_POST`.
