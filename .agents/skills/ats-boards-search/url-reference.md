# ATS Job-Board API Reference

Public, unauthenticated JSON endpoints used by this skill. These are the official
"job board" APIs each ATS vendor documents for embedding a company's open roles on
its own site. No keys, no login; keep volume modest and the CLI backs off on 429/5xx.

`{token}` is the company's board slug (see `companies.json`). All three return
`404` for an unknown board; the CLI reports that per company and carries on.

## Greenhouse (Job Board API)

```
GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}
```

| Param | Meaning |
|-------|---------|
| `content=true` | Include the `content` field (the description) in the list response |

Response (list): `{ "jobs": [ ... ], "meta": { "total": N } }`. Each job:

| Field | Used as |
|-------|---------|
| `id` (number) | `jobId` in `greenhouse:{token}:{id}` |
| `title` | `title` |
| `updated_at` (ISO, with offset) | `date` and `--jobage` |
| `location.name` | `location`; part of the `--location` match |
| `offices[].name`, `offices[].location` | rest of the `--location` match |
| `departments[].name` | `department`; part of the `--query` match |
| `absolute_url` | `url` and `applyUrl` |
| `content` | **HTML-escaped HTML** (`&lt;p&gt;...`): entity-decode, then `visibleHtml` + tag strip -> `description` |
| `metadata[]` with name "Employment Type" | `employmentType` when present (custom per board) |

No structured remote flag or compensation: `remote` is inferred from "remote"/"hybrid"
in the location strings; `compensation` is `null`. The single-job endpoint returns
the same object (content included) and `404` for an unknown id.

Hosted job URLs accepted by `detail`:
`https://job-boards.greenhouse.io/{token}/jobs/{id}`,
`https://boards.greenhouse.io/{token}/jobs/{id}`,
`https://boards.greenhouse.io/embed/job_app?for={token}&token={id}`.

## Lever (Postings API)

```
GET https://api.lever.co/v0/postings/{token}?mode=json
GET https://api.lever.co/v0/postings/{token}/{id}
```

| Param | Meaning |
|-------|---------|
| `mode=json` | JSON instead of the HTML embed |

Response (list): a bare array of postings. Each posting:

| Field | Used as |
|-------|---------|
| `id` (uuid) | `jobId` in `lever:{token}:{id}` |
| `text` | `title` |
| `createdAt` (ms epoch) | `date` and `--jobage` |
| `categories.location`, `categories.allLocations[]` | `location` / `--location` match |
| `categories.department`, `categories.team` | `department` ("Dept / Team"); `--query` match |
| `categories.commitment` | `employmentType` |
| `workplaceType` (`remote` / `hybrid` / `onsite` / `unspecified`) | `remote`, `--remote` |
| `hostedUrl`, `applyUrl` | `url`, `applyUrl` |
| `description` + `lists[].text`/`lists[].content` + `additional` (HTML) | `description` (heading + bullet list per section) |
| `salaryRange {min,max,currency,interval}` | `compensation` ("USD 220000 – 310000 per year") when present |

Hosted job URLs accepted by `detail`: `https://jobs.lever.co/{token}/{uuid}[/apply]`.

## Ashby (Job Posting API)

```
GET https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true
```

| Param | Meaning |
|-------|---------|
| `includeCompensation=true` | Include the `compensation` object |

Response: `{ "apiVersion": "1", "jobs": [ ... ] }`. Each job:

| Field | Used as |
|-------|---------|
| `id` (uuid) | `jobId` in `ashby:{token}:{id}` |
| `title` | `title` |
| `publishedAt` (ISO) | `date` and `--jobage` |
| `location`, `secondaryLocations[].location` | `location` / `--location` match |
| `department`, `team` | `department`; `--query` match |
| `employmentType` (`FullTime`, `PartTime`, `Intern`, `Contract`, ...) | `employmentType` |
| `isRemote` (bool) | `remote`, `--remote` |
| `isListed` (bool) | `false` -> skipped by `search`; `detail` reports `isActive: false` |
| `jobUrl`, `applyUrl` | `url`, `applyUrl` |
| `descriptionHtml` | `description` (`descriptionPlain` as fallback) |
| `compensation.compensationTierSummary` | `compensation` ("$250K – $400K • Offers Equity") |

**There is no single-job endpoint.** `detail` re-fetches the board and selects the
job by id.

Hosted job URLs accepted by `detail`: `https://jobs.ashbyhq.com/{token}/{uuid}[/application]`.

## CLI behaviour on top of the APIs

- All filtering (`--query`, `--location`, `--remote`, `--jobage`) is client-side;
  none of the APIs takes a search parameter.
- Boards are fetched concurrently, at most 5 at a time; one board's failure is
  recorded in `meta.errors` and does not fail the run.
- Pagination is client-side over the merged, newest-first list: 20 per page.
- Base URLs can be overridden with `ATS_GREENHOUSE_API_URL`, `ATS_LEVER_API_URL`,
  `ATS_ASHBY_API_URL`; this exists for the offline test suite's loopback server.
