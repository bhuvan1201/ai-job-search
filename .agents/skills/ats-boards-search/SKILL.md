---
name: ats-boards-search
version: 1.0.0
description: >
  Use this skill to search the public job boards of US tech / AI companies that run
  Greenhouse, Lever or Ashby (Anthropic, OpenAI, Databricks, Stripe, Figma, Notion,
  Scale AI, Mistral, Cursor and a configurable company list) for roles in the
  United States, remote, or the SF Bay Area, or to look up one posting from a
  Greenhouse / Lever / Ashby job URL. Best for AI/ML, research, data and software
  roles at named companies. Trigger phrases: jobs at <company>, is <company> hiring,
  search company career pages, Greenhouse jobs, Lever jobs, Ashby jobs, ATS job
  boards, ML engineer jobs at AI labs, "what AI companies are hiring in SF",
  remote US data roles, look up this Greenhouse/Lever/Ashby posting.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/ats-boards-search/cli/src/cli.ts *)
---

# ATS Boards Search Skill

Search the **public job-board JSON APIs** of companies that run **Greenhouse**,
**Lever** or **Ashby** - the official, unauthenticated endpoints each company
embeds on its own careers page. One search fans out over every company in
`companies.json`, merges the postings and filters them locally. No API key,
no scraping of HTML, **zero runtime dependencies** - it runs with just `bun`.

> Unlike `linkedin-search`, this skill reads documented public APIs that are meant
> for embedding, so there is no terms-of-service concern. Keep volume modest
> anyway: every search fetches each configured board once, and the CLI backs off
> on 429/5xx.

Market focus for this fork: **United States / remote / SF Bay Area**, AI/ML and
data-heavy tech companies. The company list is yours to edit.

## Company list (`companies.json`)

The boards searched live in `.agents/skills/ats-boards-search/companies.json`:

```json
{ "companies": [
    { "name": "Anthropic", "ats": "greenhouse", "token": "anthropic", "verified": false },
    { "name": "Mistral AI", "ats": "lever",      "token": "mistral",   "verified": false },
    { "name": "OpenAI",     "ats": "ashby",      "token": "openai",    "verified": false }
] }
```

- `token` is the board slug in the public URL (`job-boards.greenhouse.io/<token>`,
  `jobs.lever.co/<token>`, `jobs.ashbyhq.com/<token>`).
- **The shipped tokens are guesses** (`verified: false`). On first run, confirm them:

  ```bash
  bun run .agents/skills/ats-boards-search/cli/src/cli.ts boards --check --format table
  ```

  Fix or remove any `not_found` entry, then set `verified: true`. A company that
  has moved ATS (or runs Workday/SmartRecruiters/its own site) is simply not
  reachable through this skill.
- `--companies <path>` points a run at a different list; `--company <name|token>`
  restricts a run to one entry.

## When to use this skill

- "Is <company> hiring ML engineers?" / "What's open at Anthropic / OpenAI / Databricks?"
- Sweep a curated set of AI/ML companies for new roles in SF, remote-US, or anywhere in the US
- Fetch the full description, compensation range and apply link of one posting
  from its Greenhouse / Lever / Ashby URL

## Commands

### Search job listings

```bash
bun run .agents/skills/ats-boards-search/cli/src/cli.ts search --query "<keywords>" [flags]
```

Key flags:
- `--query <text>` / `-q <text>` - **required.** Case-insensitive keyword match over
  the title and department/team. Separate alternatives with `|` for OR:
  `-q "machine learning|ml engineer|research engineer"`.
- `--deep` - also match `--query` against the full description text (slower to
  read, catches roles whose title is generic).
- `--location <text>` / `-l <text>` - substring match over every location field the
  ATS exposes (`"San Francisco"`, `"New York"`, `"United States"`). The special value
  `Remote` also matches postings the ATS flags as remote (Lever `workplaceType`,
  Ashby `isRemote`).
- `--remote remote|hybrid|onsite` - workplace-type filter. Exact where the ATS
  exposes it (Lever, Ashby); Greenhouse falls back to "remote"/"hybrid" in the
  location text, so `onsite` matches no Greenhouse job.
- `--jobage <days>` - posted/updated within N days (Greenhouse `updated_at`, Lever
  `createdAt`, Ashby `publishedAt`).
- `--page <n>` - 1-indexed page, **20 results per page**, over the merged list sorted
  newest first.
- `--limit <n>` / `-n <n>` - cap results emitted from the page (client-side).
- `--format json|table|plain` - default `json`.
- `--companies <path>`, `--company <name|token>` - see "Company list".

### Fetch full job detail

```bash
bun run .agents/skills/ats-boards-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

`id` is the `id` from a search result: `<ats>:<token>:<jobId>`, e.g.
`greenhouse:anthropic:4000000001` or `ashby:openai:9d8c7b6a-...`. A job URL on
`job-boards.greenhouse.io`, `boards.greenhouse.io`, `jobs.lever.co` or
`jobs.ashbyhq.com` also works; **a URL on any other host is rejected** with
`BAD_ID` before any request. Returns the plain-text description (paragraph breaks
kept), employment type, compensation summary when the ATS publishes one, and the
apply link.

### List / verify configured boards

```bash
bun run .agents/skills/ats-boards-search/cli/src/cli.ts boards [--check] [--format json|table]
```

Without `--check` it lists the configured boards and makes no request. With
`--check` it fetches each board once and reports `reachable` (with the number of
listed jobs), `not_found` (bad token) or `error`.

## Usage examples

```bash
# ML / research engineer roles in the SF Bay Area, last 14 days
bun run .agents/skills/ats-boards-search/cli/src/cli.ts search -q "machine learning|research engineer" -l "San Francisco" --jobage 14 --format table

# Remote-US data roles across every configured company
bun run .agents/skills/ats-boards-search/cli/src/cli.ts search -q "data scientist|data engineer|analytics engineer" -l Remote --format table

# Everything Anthropic has open that mentions inference anywhere in the posting
bun run .agents/skills/ats-boards-search/cli/src/cli.ts search -q "inference" --company anthropic --deep

# Hybrid applied-scientist roles, second page of results
bun run .agents/skills/ats-boards-search/cli/src/cli.ts search -q "applied scientist|ml engineer" --remote hybrid --page 2

# Full detail for one posting (by id or by its hosted URL)
bun run .agents/skills/ats-boards-search/cli/src/cli.ts detail greenhouse:anthropic:4000000001 --format plain
bun run .agents/skills/ats-boards-search/cli/src/cli.ts detail https://jobs.ashbyhq.com/openai/9d8c7b6a-5f4e-4d3c-b2a1-0f9e8d7c6b5a

# Confirm the guessed board tokens on first run
bun run .agents/skills/ats-boards-search/cli/src/cli.ts boards --check --format table
```

## Output formats

| Format | Best for |
|--------|----------|
| `json` | Default - programmatic use, passing `id`s to `detail` |
| `table` | Quick human-readable scanning |
| `plain` | Reading a single job's full detail (`detail` command) |

Search JSON is `{ "meta": { "count", "page", "pageSize", "total", "boards", "boardsFailed", "errors" }, "results": [...] }`.
Each result carries `id`, `title`, `company`, `location`, `date` (`YYYY-MM-DD`),
`url`, plus `ats`, `department`, `remote` (`true`/`false`/`null` when unknown) and
`applyUrl`; missing values are `null`, never omitted. `detail` adds `description`,
`employmentType`, `compensation` (string or `null`) and `isActive`.

All errors are written to **stderr** as `{ "error": "...", "code": "..." }` and the
process exits with code `1`. A board that fails while others succeed is **not** an
error: it is listed in `meta.errors` as `{ company, error }` (and as a stderr
`warning` line in `table`/`plain` output) and the run exits `0`. Only when every
board fails does the CLI exit `1` with `SEARCH_FAILED`.

## Notes

- **Official public APIs, no credentials.** Greenhouse `boards-api.greenhouse.io`,
  Lever `api.lever.co/v0/postings`, Ashby `api.ashbyhq.com/posting-api`. See
  `url-reference.md`.
- **Volume.** One search = one request per configured company (fetched ~5 at a
  time). With 25 companies that is 25 requests; don't loop searches in a tight
  cycle. Rate-limited responses back off automatically.
- **Filtering is client-side.** None of the three APIs takes a keyword parameter;
  the CLI downloads each board and filters locally, so `--query` is a plain
  substring match, not full-text search. Use `|` for synonyms.
- **Greenhouse descriptions are HTML-escaped HTML** on the wire; the CLI decodes
  the entities, drops hidden/non-rendered markup and strips tags. Greenhouse
  exposes no structured remote flag or compensation; `remote` is inferred from the
  location text and `compensation` is `null`.
- **Ashby has no single-job endpoint.** `detail` on an Ashby id re-fetches that
  company's board and picks the job. Unlisted (`isListed: false`) jobs are skipped
  by `search` and reported by `detail` with `isActive: false`.
- **Dates.** Greenhouse reports `updated_at` (a re-published posting looks fresh),
  Lever `createdAt`, Ashby `publishedAt`. Treat `--jobage` as approximate.
- **`company` in results is the configured `name`**, not something the ATS returns,
  so keep `companies.json` names tidy - they flow into the tracker.
- The company list is **this fork's configuration**: add the boards you care about,
  prune the rest.
