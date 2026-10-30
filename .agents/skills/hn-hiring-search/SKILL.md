---
name: hn-hiring-search
version: 1.0.0
description: >
  Use this skill to search the monthly "Ask HN: Who is hiring?" threads on
  Hacker News (news.ycombinator.com) for tech, AI/ML, research, data and software
  roles in the United States, remote, or the SF Bay Area, or to look up one job
  comment from its HN URL. Startups and small teams post here that never reach
  LinkedIn or an ATS. Trigger phrases: HN who is hiring, Hacker News jobs,
  Ask HN hiring thread, whoishiring, "who is hiring this month", startup jobs on
  HN, YC startup jobs, remote ML jobs on Hacker News, SF startup engineering jobs,
  look up this news.ycombinator.com posting.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/hn-hiring-search/cli/src/cli.ts *)
---

# HN "Who is hiring?" Search Skill

Search the monthly **"Ask HN: Who is hiring? (Month Year)"** threads on Hacker
News. Every top-level comment in such a thread is one job ad written as free
text, almost always opening with a header line like

```
Company | Role(s) | Location | ONSITE/REMOTE/HYBRID | Full-time | $salary
```

The CLI finds the current thread(s) through the official **Algolia HN Search
API**, downloads each thread with all its comments in one call, parses the
header heuristically and filters locally. No API key, no HTML scraping,
**zero runtime dependencies** - it runs with just `bun`.

> Both data sources are the official, public HN APIs (Algolia HN Search and the
> Firebase HN API), so there is no terms-of-service concern. One search is two
> or three requests; the CLI backs off on 429/5xx.

Market focus for this fork: **United States / remote / SF Bay Area**, AI/ML and
data roles - the thread is dominated by US startups and remote-US positions.

## When to use this skill

- "What AI startups are hiring on HN this month?" / "remote ML jobs on Hacker News"
- Sweep the last few monthly threads for roles that never reach LinkedIn or an ATS
- Fetch the full text of one job comment from a `news.ycombinator.com/item?id=...` URL

## Commands

### Search job listings

```bash
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts search --query "<keywords>" [flags]
```

Key flags:
- `--query <text>` / `-q <text>` - **required.** Case-insensitive match over the
  whole comment (header line + body). Separate alternatives with `|` for OR; a
  term may be a phrase: `-q "machine learning|ml engineer|research engineer"`.
- `--location <text>` / `-l <text>` - substring match over the parsed location
  **and the whole header line**, because posters write "SF", "Bay Area", "NYC" or
  "US timezones" wherever they like. The special value `Remote` also matches the
  `REMOTE` tag.
- `--remote remote|hybrid|onsite` - from the header's `ONSITE` / `REMOTE` /
  `HYBRID` tags. `remote` = tagged REMOTE (also when ONSITE is offered too);
  `onsite` = tagged ONSITE and not REMOTE; `hybrid` = tagged HYBRID.
- `--jobage <days>` - comment posted within N days. Default: every comment in the
  selected thread(s).
- `--months <1-6>` - search the N most recent monthly threads (default `1`, the
  current thread). Threads open on the first weekday of each month.
- `--thread <id>` - search one specific thread by its HN story id (exclusive with `--months`).
- `--page <n>` - 1-indexed page, **20 results per page**, newest comment first.
- `--limit <n>` / `-n <n>` - cap results emitted from the page (client-side).
- `--format json|table|plain` - default `json`.

### Fetch full job detail

```bash
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

`id` is the `id` from a search result (the HN comment id, e.g. `41709555`). A
`https://news.ycombinator.com/item?id=41709555` URL also works; **a URL on any
other host is rejected** with `BAD_ID` before any request. The CLI fetches the
comment and its parent story and rejects anything that is not a top-level
comment of a "Who is hiring?" thread with `NOT_A_HIRING_POST`. Returns the
parsed header fields plus the full plain-text `description` (paragraph breaks
kept) and `isActive: true`.

## Usage examples

```bash
# ML / research engineer roles in the SF Bay Area in this month's thread
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts search -q "machine learning|ml engineer|research engineer" -l "San Francisco" --format table

# Remote-US data roles across the last two monthly threads
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts search -q "data scientist|data engineer|analytics" --remote remote --months 2 --format table

# LLM / inference work posted in the last 14 days, remote anywhere in the header
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts search -q "llm|inference|rag" -l Remote --jobage 14

# Hybrid roles mentioning PyTorch, second page
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts search -q "pytorch" --remote hybrid --page 2

# Everything in one specific thread
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts search -q "engineer" --thread 41709301 --limit 50

# Full text of one job comment (by id or by its HN URL)
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts detail 41709555 --format plain
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts detail https://news.ycombinator.com/item?id=41709555
```

Note: `-l` is a single substring; to OR several places run the search once per
place, or match on the header with `-q` (which does take `|`).

## Output formats

| Format | Best for |
|--------|----------|
| `json` | Default - programmatic use, passing `id`s to `detail` |
| `table` | Quick human-readable scanning (includes the workplace tags) |
| `plain` | Reading a single job's full detail (`detail` command) |

Search JSON is `{ "meta": { "count", "page", "pageSize", "total", "threads": [{ "id", "title", "comments" }] }, "results": [...] }`.
Each result carries `id`, `title`, `company`, `location`, `date` (`YYYY-MM-DD`,
the comment date), `url`, plus `remote` (`true`/`false`/`null` when untagged),
`workplace` (the raw tags, e.g. `"REMOTE ONSITE"`), `salary`, `employmentType`,
`author`, `threadId`, `threadTitle` and `snippet` (first 200 characters of the
body); missing values are `null`, never omitted. `detail` adds `description`
and `isActive`.

All errors are written to **stderr** as `{ "error": "...", "code": "..." }` and the
process exits with code `1`.

## Notes

- **Official public APIs, no credentials.** Threads are found with the Algolia
  HN Search API (`hn.algolia.com/api/v1/search_by_date`, filtered to the
  `whoishiring` account's "Who is hiring?" stories - the same account also posts
  "Who wants to be hired?" and "Freelancer?" threads, which are excluded) and
  fetched with the Algolia items endpoint; the Firebase HN API is the fallback
  (one request per comment, 8 in flight). See `url-reference.md`.
- **The header is parsed heuristically.** Field order is only a convention, so
  each `|`-separated field is classified by what it looks like (workplace tag,
  salary, employment type, place, role). When a header has no `|`, `company` is
  the first sentence and `title` is `"(see posting)"` - `title` is never empty.
  Expect occasional misfiled fields; `detail` gives the raw text.
- **`company` comes from the poster**, not a registry: "Acme AI (YC W24)" and
  "Acme" are different strings to the tracker.
- **`date` is the comment date**, not a posting date, and threads are monthly:
  `--jobage 7` late in a month returns little. `--months 2` is the usual way to
  widen a search.
- **Filtering is client-side.** The thread is downloaded once and filtered
  locally, so `--query` is a substring match, not full-text search. Use `|` for
  synonyms.
- **Only top-level comments are jobs.** Replies (questions, "applied!") are
  ignored; deleted/dead comments (`text: null`) are skipped.
- **Volume.** One search = 1 request to find the threads + 1 per thread.
  Don't loop searches in a tight cycle; the Algolia API rate-limits.
