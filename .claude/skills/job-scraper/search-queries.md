# Search Queries for Job Scraper

<!-- Configured for Bhuvan's US search: AI/ML engineering + data engineering/science,
     SF Bay Area (hybrid/onsite) and US-remote. Skill-specific tokens marked
     [FROM_CV] are filled in from the CV during /setup. -->

## Installed portal CLIs (primary for `/scrape`)

`/scrape` discovers every portal skill under `.agents/skills/*/SKILL.md` and runs its CLI first. Enabled in this fork:

| Portal skill | Covers | Location flag | Notes |
|---|---|---|---|
| `linkedin-search` | LinkedIn public job listings | `-l "San Francisco Bay Area"` and `-l "United States" --remote remote` | Personal-use only (LinkedIn ToS): one pass per category per day, `--jobage` scoped |
| `ats-boards-search` | Greenhouse / Lever / Ashby boards of the companies in `.agents/skills/ats-boards-search/companies.json` | `-l "San Francisco"`, `-l "Remote"` | Official public APIs. Run `boards --check` once to confirm tokens; add target companies as you find them |
| `hn-hiring-search` | Monthly HN "Who is hiring?" threads | `-l "SF"`, `-l "Bay Area"`, `-l Remote` | Official HN API. Strong for AI/ML startups; headers are free text, so verify location in the posting |
| `freehire-search` | Aggregator over ~50 ATS platforms, tech-only | `--country us` (plus `--city "San Francisco"` or `--remote remote`) | Structured facets: use `--category ml_ai` for Priority 1 and `--seniority` per the CV |

The Danish demo portals (`jobindex`, `jobnet`, `jobbank`, `jobdanmark`) ship `enabled: false` and stay off.

The `site:` query templates below are the **WebSearch fallback** — for boards without a CLI, company career pages, or when a CLI fails. In this fork the fallback is also the *only* route to Indeed, Dice and Built In: Indeed's terms prohibit automated access and all three sit behind bot protection, so no CLI was built for them.

**Language scope:** English only (see the Languages table in CLAUDE.md).

## Search Sites

Primary (CLI-covered):
- **linkedin.com/jobs** — `linkedin-search` CLI
- **Greenhouse / Lever / Ashby company boards** — `ats-boards-search` CLI
- **news.ycombinator.com "Who is hiring?"** — `hn-hiring-search` CLI
- **freehire.me** — `freehire-search` CLI

Secondary (WebSearch fallback only):
- **indeed.com** — `site:indeed.com` queries below; never fetched by a CLI (terms prohibit it)
- **dice.com** — `site:dice.com`
- **builtin.com / builtinsf.com** — `site:builtin.com`
- **wellfound.com** — `site:wellfound.com` (startup roles; login-walled for detail, so store the employer's own careers URL instead)
- Company career pages via `site:` searches for target companies not on an ATS the CLI covers

## Query Categories

Queries are grouped by priority. Combine each with the two location frames: **Bay Area** (`San Francisco Bay Area` / `San Francisco, CA` / `San Mateo, CA` / `Palo Alto, CA`) and **Remote US** (`Remote` + `--remote remote`, or `United States` with the remote filter).

**Organize by function, not job title.** The same work is posted as "ML Engineer", "AI Engineer", "Applied Scientist" or "Member of Technical Staff" depending on the company, so each category lists several title variants.

### Priority 1: AI / ML Engineering

Core direction: building and shipping ML and LLM systems.

CLI query terms (pass as `--query`, `|` = OR where the CLI supports it):
```
"machine learning engineer" | "ML engineer" | "AI engineer" | "applied scientist" | "LLM engineer" | "member of technical staff"
"generative AI" | "LLM" | "agents" | "RAG"
[FROM_CV: 1-2 headline ML skills, e.g. "PyTorch" | "LangChain"]
```

WebSearch fallback:
```
site:indeed.com "machine learning engineer" "San Francisco" OR "San Mateo" OR "Palo Alto"
site:indeed.com "AI engineer" remote "United States"
site:dice.com "machine learning engineer" "San Francisco Bay Area"
site:builtin.com "machine learning engineer" san-francisco OR remote
site:wellfound.com "AI engineer" "San Francisco"
```

### Priority 2: Data Engineering / Data Science

Direct experience domain.

CLI query terms:
```
"data engineer" | "analytics engineer" | "data platform engineer"
"data scientist" | "applied data scientist" | "quantitative analyst"
[FROM_CV: 1-2 headline data skills, e.g. "Spark" | "dbt" | "Snowflake"]
```

WebSearch fallback:
```
site:indeed.com "data engineer" "San Francisco" OR "San Mateo" OR "Oakland" OR "San Jose"
site:indeed.com "data scientist" remote "United States"
site:dice.com "data engineer" "San Francisco Bay Area"
site:builtin.com "data engineer" san-francisco OR remote
```

### Priority 3: ML Platform / MLOps / AI Infrastructure

Adjacent roles between the two above.

CLI query terms:
```
"MLOps" | "ML platform" | "ML infrastructure" | "AI infrastructure" | "model deployment"
"research engineer" | "inference" | "evaluation"
```

WebSearch fallback:
```
site:indeed.com "MLOps" OR "ML platform" "San Francisco" OR remote
site:builtin.com "ML platform engineer" san-francisco OR remote
```

### Priority 4: Broader Software Engineering with ML Exposure

Wider net; run only with `/scrape broad`.

CLI query terms:
```
"software engineer" "machine learning" | "backend engineer" AI | "full stack" AI
"forward deployed engineer" | "solutions engineer" AI
```

WebSearch fallback:
```
site:indeed.com "software engineer" "machine learning" "San Francisco Bay Area"
site:dice.com "software engineer" AI remote
```

## Location Filter

Home base: San Mateo, CA. When evaluating results:
- **Accept — commutable:** San Mateo, San Francisco, South San Francisco, Burlingame, Redwood City, Menlo Park, Palo Alto, Mountain View, Foster City, San Carlos, Belmont (≈ 10–35 min by Caltrain or car)
- **Accept — borderline (~45–60 min):** Sunnyvale, Santa Clara, San Jose, Oakland, Berkeley, Emeryville — fine for hybrid (≤3 days/week), flag for 5-day onsite
- **Accept — remote:** "Remote (US)", "Remote - United States", US-timezone remote. **Flag** remote roles restricted to specific states if California is excluded, and roles that say "remote" but require weekly office days outside the Bay Area
- **Exclude:** onsite/hybrid roles anywhere outside the Bay Area; non-US remote unless the posting explicitly allows US-based candidates

## Language Filter

English only; no non-English requirement expected in this market. Apply `04-job-evaluation.md`'s Language Gate anyway: a posting requiring a language not in the CLAUDE.md Languages table is excluded.

## Date Filter

Default `/scrape`: last 14 days. `/daily`: 2-day window (it runs every weekday). Include undated postings but flag "date unknown". US postings rarely state a deadline; a missing deadline is `null`, never guessed.

## Adapting Queries

If the user specifies a focus area (e.g. `/scrape LLM evaluation`), select queries from the matching category and generate 2-3 custom queries for that focus across the same location frames.
