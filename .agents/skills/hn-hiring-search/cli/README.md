# hn-hiring-cli

CLI for searching the monthly **"Ask HN: Who is hiring?"** threads on Hacker
News and for fetching one job comment's full text.

**Data source**: the official HN APIs - Algolia HN Search (`hn.algolia.com/api/v1`)
to find and download the threads, Firebase HN API (`hacker-news.firebaseio.com/v0`)
as fallback.
**Authentication**: None required.
**Dependencies**: None (plain `bun` + `fetch`). `bun install` is optional and only
pulls dev type defs.

> Official public APIs - no ToS concern. One search is two or three requests;
> the CLI backs off on 429/5xx.

## Installation

```bash
cd .agents/skills/hn-hiring-search/cli
bun install   # optional — only installs TypeScript dev types
```

The CLI runs without any install because it has zero runtime dependencies.

## Commands

| Command | Description |
|---------|-------------|
| `search` | Search the current (or the last N) monthly threads (`--query` required) |
| `detail` | Fetch one job comment by HN id or `news.ycombinator.com/item?id=N` URL |

`search` accepts `--format json|table|plain` (default `json`); `detail` accepts
`--format json|plain`. All errors are written to **stderr** as
`{ "error": "...", "code": "..." }` with exit code `1`.

## Quick examples

```bash
# ML roles in the SF Bay Area, this month's thread
bun run src/cli.ts search -q "machine learning|ml engineer" -l "San Francisco" --format table

# Remote-US data roles across the last two threads
bun run src/cli.ts search -q "data scientist|data engineer" --remote remote --months 2 --format table

# Full text of one job comment
bun run src/cli.ts detail 41709555 --format plain
```

See `../SKILL.md` for the full flag reference and `../url-reference.md` for the
APIs and the header-parsing heuristics.

## Search flags

| Flag | Alias | Description |
|------|-------|-------------|
| `--query` | `-q` | **Required.** Keywords over header + body; `a|b` = OR, phrases allowed. |
| `--location` | `-l` | Substring over the location field and the header line; `Remote` also matches the REMOTE tag. |
| `--remote` | | `remote` \| `hybrid` \| `onsite` (header tags). |
| `--jobage` | | Comment posted within N days. |
| `--months` | | 1-6 most recent monthly threads (default 1). |
| `--thread` | | One thread by HN story id. |
| `--page` | | 1-indexed page (20 results/page, newest first). |
| `--limit` | `-n` | Cap results emitted. |
| `--format` | | `json` \| `table` \| `plain`. |

## Tests

```bash
bun run typecheck
bun run test                        # offline: fixtures + loopback server
LIVE_PORTAL_TESTS=1 bun run test    # also hits the real HN APIs
```
