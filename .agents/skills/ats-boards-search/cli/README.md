# ats-boards-cli

CLI for searching the **public Greenhouse / Lever / Ashby job boards** of a
configurable list of companies (shipped list: US AI/ML and data-heavy tech
companies), and for fetching one posting's full detail.

**Data source**: the official job-board JSON APIs - `boards-api.greenhouse.io`,
`api.lever.co/v0/postings`, `api.ashbyhq.com/posting-api`.
**Authentication**: None required.
**Dependencies**: None (plain `bun` + `fetch`). `bun install` is optional and only
pulls dev type defs.

> Official public APIs meant for embedding a company's board on its own site - no
> ToS concern. Keep volume modest (one request per configured company per search);
> the CLI backs off on 429/5xx.

## Installation

```bash
cd .agents/skills/ats-boards-search/cli
bun install   # optional — only installs TypeScript dev types
```

The CLI runs without any install because it has zero runtime dependencies.

## Configuration

Boards come from `../companies.json` (`{ "companies": [ { name, ats, token, verified } ] }`).
The shipped tokens are guesses; verify them once:

```bash
bun run src/cli.ts boards --check --format table
```

## Commands

| Command | Description |
|---------|-------------|
| `search` | Search every configured board (`--query` required) |
| `detail` | Fetch full detail for one job (`<ats>:<token>:<jobId>` or a hosted job URL) |
| `boards` | List configured boards; `--check` fetches each once to confirm the token |

`search` and `boards` accept `--format json|table|plain` (default `json`); `detail`
accepts `--format json|plain`. All errors are written to **stderr** as
`{ "error": "...", "code": "..." }` with exit code `1`.

## Quick examples

```bash
# ML roles in the SF Bay Area, last 14 days
bun run src/cli.ts search -q "machine learning|ml engineer" -l "San Francisco" --jobage 14 --format table

# Remote-US data roles
bun run src/cli.ts search -q "data scientist|data engineer" -l Remote --format table

# One company, matching anywhere in the description
bun run src/cli.ts search -q "inference" --company anthropic --deep

# Full detail for one job
bun run src/cli.ts detail greenhouse:anthropic:4000000001 --format plain
```

See `../SKILL.md` for the full flag reference and `../url-reference.md` for the APIs.

## Search flags

| Flag | Alias | Description |
|------|-------|-------------|
| `--query` | `-q` | **Required.** Keywords over title + department; `a|b` = OR. |
| `--deep` | | Also match the description text. |
| `--location` | `-l` | Substring over location fields; `Remote` also matches ATS remote flags. |
| `--remote` | | `remote` \| `hybrid` \| `onsite`. |
| `--jobage` | | Posted/updated within N days. |
| `--page` | | 1-indexed page (20 results/page, merged + newest first). |
| `--limit` | `-n` | Cap results emitted. |
| `--format` | | `json` \| `table` \| `plain`. |
| `--companies` | | Alternative companies.json path. |
| `--company` | | Restrict to one configured company (name or token). |

## Tests

```bash
bun run typecheck
bun run test                        # offline: fixtures + loopback server
LIVE_PORTAL_TESTS=1 bun run test    # also hits the real APIs (modest volume)
```
