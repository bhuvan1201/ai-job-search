# Fork notes — US-market adaptation (Bay Area + remote, AI/ML + data roles)

This private fork of [ai-job-search](https://github.com/ai-job-search-dev/ai-job-search) carries the changes below on top of upstream. Keep `upstream` as a remote and merge releases per SETUP.md §8; everything here is additive and lives in new files or clearly marked lines, so merges stay clean.

## What changed

| Area | Change | Files |
|---|---|---|
| Portals | New `ats-boards-search` skill: Greenhouse / Lever / Ashby public board APIs for a configurable company list | `.agents/skills/ats-boards-search/` |
| Portals | New `hn-hiring-search` skill: monthly HN "Who is hiring?" threads | `.agents/skills/hn-hiring-search/` |
| Portals | Danish demos stay `enabled: false` (upstream default); `linkedin-search` and `freehire-search` stay on | — |
| Permissions | Both new CLIs pre-approved for `/scrape` | `.claude/settings.json`, `tools/security_guards.py` |
| Search strategy | Rewritten for Bay Area + Remote US, four priority categories (AI/ML eng, data eng/sci, ML platform, broader SWE), commute map from San Mateo | `.claude/skills/job-scraper/search-queries.md` |
| Pipeline | New `/daily` command: scrape (2-day window) → rank → digest with 🔥/⏰ deadline flags, quiet-application list, optional `--gmail` proposals | `.claude/commands/daily.md` |
| Scheduling | `tools/schedule_daily.py` installs a weekday launchd agent (macOS) or cron line (Linux) running `claude -p "/daily --quiet"` | `tools/schedule_daily.py` |
| Docs | `/daily` row in the README command table; this file | `README.md`, `FORK_NOTES.md` |

## Why no Indeed / Dice / Built In CLI

- **Indeed** — its terms of service prohibit crawling or scraping the site, and the pages sit behind aggressive bot detection. Not built; `site:indeed.com` WebSearch fallback queries are in `search-queries.md` instead.
- **Dice** — public pages are Cloudflare-protected and the working scrapers all rely on an undocumented internal API, which fails the honest-User-Agent rule in `/add-portal`'s contract. WebSearch fallback only.
- **Built In / Built In SF** — JS-rendered listings behind bot protection; same verdict. WebSearch fallback only.

Coverage for those boards' postings mostly arrives anyway through `freehire-search` (which aggregates the ATS platforms most Built In / Dice employers post from) and `ats-boards-search`.

## First-run checklist (on your machine)

The two new CLIs were built and tested against recorded API fixtures (157 tests) because the build sandbox had no access to the portals. Before trusting them, run the live checks once:

```bash
python3 tools/install_portal_clis.py                       # bun install for every CLI (dev types only)

# 1. Confirm the starter company board tokens — fix or remove any 404s in companies.json
bun run .agents/skills/ats-boards-search/cli/src/cli.ts boards --check --format table

# 2. Live searches
bun run .agents/skills/ats-boards-search/cli/src/cli.ts search -q "machine learning|ML engineer" -l "San Francisco" --jobage 14 --format table
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts search -q "machine learning|ML" -l Remote --format table
bun run .agents/skills/linkedin-search/cli/src/cli.ts search -q "machine learning engineer" -l "San Francisco Bay Area" --jobage 7 --format table

# 3. One detail fetch each, with an id from the searches above
bun run .agents/skills/ats-boards-search/cli/src/cli.ts detail <ats:token:id> --format plain
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts detail <comment id> --format plain

# 4. Full test suites (the live tests run when LIVE_PORTAL_TESTS=1)
LIVE_PORTAL_TESTS=1 bun --cwd .agents/skills/ats-boards-search/cli test
LIVE_PORTAL_TESTS=1 bun --cwd .agents/skills/hn-hiring-search/cli test
```

Then, inside Claude Code in this repo: `/setup` (or confirm the profile is filled), `/scrape`, `/rank`, and `/daily --window 14` for the first digest. Schedule with `python3 tools/schedule_daily.py --time 07:30`.

## Publishing to a private repository

```bash
gh repo create <you>/ai-job-search-private --private --source . --remote origin --push
git remote add upstream https://github.com/ai-job-search-dev/ai-job-search.git
```

Never push this repo to a public fork: `/setup` writes personal data into tracked files (`CLAUDE.md`, the profile skill files). The tracker, salary data, `documents/`, digests and logs are gitignored and never enter git.
