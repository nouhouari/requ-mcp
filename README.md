# requ-mcp

[![CI](https://github.com/nouhouari/requ-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/nouhouari/requ-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/requ-mcp.svg)](https://www.npmjs.com/package/requ-mcp)

📦 **Published on npm:** [npmjs.com/package/requ-mcp](https://www.npmjs.com/package/requ-mcp)

An MCP server that tracks **requirements coverage** for a project, and how it
**evolves across phases/releases**. It gives AI agents structured tools to
maintain a living traceability graph:

```
Requirement → User Story ─┬→ (descriptive acceptance criteria)
                 ▲        └→ Screen (UI spec: a static HTML mockup)
                 │  link = an @US-xxx tag on a cucumber scenario
                 │
Phase (v1.0, v1.1, …) → Execution (a scenario result for a run)
```

At the end of a working session — or for any release — you ask the server one
question — *"what's our coverage?"* — and get a precise, always-current answer
instead of a stale spreadsheet, plus the **trend** of how coverage changed
release over release. The server also ships a **web dashboard** (in HTTP mode)
that visualizes coverage and requirements in 6 interactive tabs.

## Quickstart

requ-mcp is an HTTP server: you run it once, and every client and agent talks to
the same store. There is no per-repo mode — that is deliberate, see
[How it finds the project](#how-it-finds-the-project).

```bash
git clone https://github.com/nouhouari/requ-mcp.git
cd requ-mcp
cp .env.example .env      # set REQU_WORKSPACE_DIR and a PG_PASSWORD
docker compose up -d      # Postgres + the requ-mcp server on :8788
```

Then register the endpoint with your MCP client (e.g. Claude Code) once,
globally:

```json
{
  "mcpServers": {
    "requ": { "type": "http", "url": "http://localhost:8788/mcp" }
  }
}
```

Create a project and start working — every tool takes a `key` to say which
project it means:

```jsonc
// init_project
{ "key": "my-app", "name": "My App", "conductorPath": "/workspace/my-app/e2e", "initialPhase": "v1.0" }
```

> **`conductorPath` is a path the *server* sees.** The container mounts
> `REQU_WORKSPACE_DIR` read-only at `/workspace`, so a repo at
> `$REQU_WORKSPACE_DIR/my-app` is `/workspace/my-app` to requ. Paths the server
> cannot read now fail with an explicit error rather than looking empty.

<details>
<summary>Running from source instead of Docker</summary>

```bash
npm install
npm run build
REQU_PG_URL=postgresql://… REQU_PORT=8788 npm start
```

Without `REQU_PG_URL` the server uses SQLite and takes its projects from
`REQU_PROJECTS` (a comma-separated list of project roots). Key-based project
*creation* requires Postgres.
</details>

## Web Dashboard

The same server that answers MCP calls also serves a web dashboard, so there is
nothing extra to launch:

```
Dashboard:    http://localhost:8788/
MCP endpoint: http://localhost:8788/mcp
```

**Default port:** `8788`. Override with `REQU_PORT` (or `REQU_PORT` in `.env`
when running under Docker Compose).

### Dashboard tabs

| Tab | Content |
|-----|---------|
| **Overview** | KPI cards with project totals (requirements, stories, scenarios, verified %), a **counts-by-phase** table (requirements / stories / scenarios per phase, partitioned by earliest phase, with an Unassigned row and a Total), coverage trend chart, component breakdown, gaps summary, and phases strip |
| **Requirements** | Sortable/filterable table of all requirements with inline expansion showing linked story IDs and tags |
| **Stories** | User stories with status, acceptance criteria count, and coverage badge; expand to see acceptance criteria and linked scenarios with pass/fail/pending icons |
| **Screens** | UI specs: filterable screen cards (platform, status, staleness), the UI consistency-check results, and a viewer that renders the mockup in a sandboxed frame with traced elements outlined, its element table, exits and linked stories — see [Screens](#screens--ui-specifications) |
| **Coverage** | Phase + mode selector (Cumulative / Strict), summary stats, per-component breakdown, and gaps (reqs without story / stories without scenarios / stories not covered) |
| **Components** | Card grid of components showing description, domain tags, requirement count, and verified percentage |
| **VCS** | Table of VCS refs (branches and MRs/PRs) linked to stories and requirements, with state badges and external links |
| **Decisions** | Architecture decisions (ADRs) with status badges and their requirement/component links; open one to read the record with its mermaid diagrams rendered |

**Live updates:** The dashboard polls for KPI count changes every 5 seconds via Server-Sent Events (SSE) — no page refresh needed. The summary payload (`GET /api/summary` and the SSE feed) includes project totals plus `scenariosTotal` and a `byPhase[]` array of per-phase `{ requirements, stories, scenarios }` counts (partitioned by earliest phase, with an Unassigned bucket).

**Before init:** If the project hasn't been initialized with `init_project` yet, all API endpoints and the dashboard show a "Project not initialized" message rather than crashing.

## Scenario REST API

requ stores cucumber scenario gherkin as the single source of truth (see [Scenarios](#scenarios)). In HTTP mode it exposes a small, CORS-enabled REST API so any external tool — including the tool that runs the scenarios — can fetch and filter them. The contract is published as **OpenAPI 3.1** at `openapi/scenarios.yaml` (committed) and served live at `GET /api/openapi.json` and `GET /api/openapi.yaml`.

Select a project with `?project=<slug>` or `?key=<key>` (required only when more than one project is loaded).

| Endpoint | Purpose |
|----------|---------|
| `GET /api/scenarios` | List/filter scenarios. Query params (AND-combined): `story`, `requirement`, `phase`+`mode`, `tags` (cucumber tag expression), `feature`, `q`, `valid`, `content=true`, `limit`, `offset`. Returns `{ total, scenarios[] }`. |
| `GET /api/scenarios/:id` | One scenario by `testKey` (`feature::name`, URL-encoded), including full gherkin `content`. |
| `GET /api/stories/:id/scenarios` | All scenarios linked to a story, with content. |
| `GET /api/tags` | Distinct tags across stored scenarios, with counts. |
| `GET /api/openapi.json` / `.yaml` | The OpenAPI 3.1 contract. |

```bash
# scenarios tagged @smoke but not @wip, with their pass/fail status in phase P1
curl 'http://localhost:8788/api/scenarios?tags=@smoke%20and%20not%20@wip&phase=P1'

# every scenario tracing to a requirement, gherkin content inline
curl 'http://localhost:8788/api/scenarios?requirement=REQ-001&content=true'
```

`story`, `requirement`, and `phase` are also accepted as filters by the MCP `list_scenarios` tool — the tool and the REST API share one filter implementation, so results match.

## Usage

A typical flow, all driven through the agent:

0. `check_conductor` *(optional)* — confirm the Conductor folder exists and see its detected name before initializing.
1. `init_project` — points at your Conductor project (`conductorPath`); it **verifies the folder exists and is a real Conductor project** (has `features/` or a cucumber config) and reports its name before creating the project. Pass `force:true` to override.
2. `create_requirement` — import the requirements (with `components`).
3. `create_user_story` — PO authors stories, each tracing to ≥1 requirement.
4. `create_or_update_screen` + `link_story_screen` — a BA/design agent publishes the
   UI specs (HTML mockups) for each story, then `check_ui_coverage` validates the graph.
5. **Tag scenarios** `@US-007` in your feature files — that *is* the test link.
6. `import_execution_report` — ingest a Conductor cucumber-json run into the active phase.
7. `coverage_report` / `find_gaps` / `coverage_trend` — see coverage now and how it evolves.

## Why

- **The server** serves the imported **requirements** (the upstream "what must be built").
- A **PO agent** reads them and authors **user stories**, each tracing to **≥1 requirement** (enforced) with **acceptance criteria**.
- A **tester agent** links **Conductor tests** (cucumber scenarios) to each criterion and records results per phase.

A requirement is only **verified** when it has a story *and* every acceptance
criterion of every linked story has a passing test **in that phase**. That
distinction — "has tests" vs. real **coverage** — is the whole point.

### Phases & executions

A **TestLink** is pure intent ("this scenario verifies this criterion").
Results are **Executions** owned by a **Phase**, so the same test can pass in
v1.0 and fail in v1.1 — and coverage reflects it. Coverage is computed in one of
two modes:

- **cumulative** (default) — the latest known result for each test *as of* the
  phase, carried forward from earlier phases. The smooth evolution curve.
- **strict** — only runs recorded *in* that phase count. Honest release sign-off:
  anything not re-run this phase is uncovered.

`coverage_trend` returns the summary at each phase in order — the evolution view.

### Phase planning & scope

Requirements are **assigned a target phase** — the release they're planned for —
via the optional `phase` field on `create_requirement` (defaults to the active
phase; pass `phase: ""` to leave unassigned) and `update_requirement`. This is
*planning* ("what's in scope for v1.1?"), distinct from *execution* ("what was
tested").

A **user story has no phase of its own** — its phase is *derived* from the phases
of the requirements it traces to. The requirement is the single source of truth,
so there's no second field to drift. A story is in scope for a phase when **any**
of its linked requirements is in scope (under the same cumulative/strict rules),
and the dashboard shows the distinct set of requirement phases per story. Filter
stories by phase (`list_user_stories phase=…`, `?project` API) the same way.

Phase reports are then scoped to the items planned for that phase, mirroring the
coverage modes:

- **cumulative** — items assigned to the target phase **or any earlier phase**.
- **strict** — only items assigned to **that** phase.
- items with **no** phase assigned are **always in scope** (so existing,
  un-phased data behaves exactly as before until you start assigning phases).
- a story counts wherever **any** of its requirements is in scope.

### Components

Requirements carry a `components` array, so coverage can be sliced per
sub-system (the `byComponent` rollup in every report).

### Ingesting Conductor results

Conductor runs `cucumber-js --format json`. Point `import_execution_report` at
that file and it records one execution per scenario into a phase, then reports
how many results mapped onto a linked test.

It pairs with [Conductor](https://github.com/nouhouari/conductor): Conductor
owns the e2e *test definitions*; requ-mcp owns the *requirements and their
coverage*. A test reference is a cucumber scenario (feature + scenario name);
maestro-driven mobile tests run through cucumber step definitions and appear in
the report as scenarios too, so scenarios are the single unit of linkage.
References are validated by reading the Conductor project's
`features/**/*.feature` directly off disk — no runtime coupling between the two
servers.

## Storage

Projects live in the server's database, not in your repo:

- **PostgreSQL** (recommended, and required for key-based project creation) —
  all projects share one database, each row scoped by `project_id`.
- **SQLite** — a single-node alternative; project roots are declared up front in
  `REQU_PROJECTS` and each gets a `.requ/requ.db`.

Both hold the same entities: components, requirements, stories, scenarios,
screens, architecture decisions, phases, executions and VCS refs. Move data
between servers with `export_project` / `import_project`.

## Tools

| Tool | Actor | Purpose |
|------|-------|---------|
| `init_project` | setup | Verify the Conductor folder exists & is valid, then create the project (requires a `key`), record Conductor + report path, optional first phase |
| `check_conductor` | setup | Inspect the Conductor folder (exists? valid? name? feature count?) without writing anything |
| `create_requirement` / `list_requirements` / `get_requirement` / `update_requirement` | server | Manage imported requirements (with `components`) |
| `assign_requirements_to_phase` | release | Move many requirements onto a phase at once — by explicit `ids` or by filter (status / component / tag / current phase); `dryRun` previews |
| `create_user_story` | PO | Author a story (rejects unless it links ≥1 existing requirement) |
| `update_user_story` / `add_acceptance_criterion` / `delete_acceptance_criterion` / `list_user_stories` / `get_user_story` | PO | Edit stories & criteria (deleting a criterion never renumbers the others) |
| `create_phase` / `list_phases` / `update_phase` / `set_active_phase` | release | Manage phases/releases |
| `list_links` | tester | Show which scenarios are tagged to which story; flag dangling `@US-xxx` tags and stories with no scenario |
| `create_scenario` / `update_scenario` / `get_scenario` / `delete_scenario` | tester/PO | Manage requ-owned cucumber scenarios (gherkin content, tags, story links) — see [Scenarios](#scenarios) |
| `list_scenarios` | tester/PO | List/filter scenarios by story, requirement, phase, feature, and tags (cucumber tag expression) |
| `validate_scenario` | tester/PO | Validate cucumber gherkin syntax (content, or a stored scenario) |
| `import_scenarios_from_features` | tester | One-time migration: import `.feature` files into requ as stored scenarios |
| `record_execution` | tester | Record one scenario result against a phase |
| `import_execution_report` | tester | Ingest a Conductor cucumber-json file into a phase |
| `create_or_update_screen` / `get_screen` / `get_screen_html` / `list_screens` / `delete_screen` | BA/design | Publish, read and regenerate UI specs (HTML mockups) — see [Screens](#screens--ui-specifications) |
| `link_story_screen` / `unlink_story_screen` | BA/design | Establish the story ↔ screen traceability edge (with its role) |
| `get_screens_for_story` / `get_stories_for_screen` | tester/BA | Reference screens for a story (grouped by platform), and reverse impact analysis |
| `check_ui_coverage` / `get_stale_screens` | reporting | Run the UI consistency checks; list the screens to regenerate after a spec change |
| `coverage_report` | reporting | Phase/mode rollup + per-component + summary % (json or markdown) |
| `coverage_trend` | reporting | Coverage summary at each phase — the evolution view |
| `find_gaps` | reporting | Requirements without stories, stories without scenarios, stories not covered (per phase) |
| `create_adr` / `update_adr` / `get_adr` / `list_adrs` / `search_adrs` / `delete_adr` | architect | Record and evolve architecture decisions — see [Architecture decisions](#architecture-decisions--adrs) |
| `get_adr_content` / `import_adrs_from_files` | architect | Read a decision's markdown; bulk-import an existing `docs/adr/` folder |
| `set_repo` / `get_repo` | dev | Record the project's repository reference — `repoUrl`, `defaultBranch`, `vcsType` (`gitlab` / `github` / `bitbucket`) |
| `link_branch` / `link_merge_request` / `update_merge_request` / `list_vcs_refs` | dev | Link branches and merge/pull requests to stories and requirements — see [VCS references](#vcs-references) |

Every tool also accepts an optional `key` selecting the target project (see
[How it finds the project](#how-it-finds-the-project)).

## Architecture decisions — ADRs

An **ADR** records *why* the system is shaped the way it is: the decision, the
context that forced it, the consequences accepted, and the alternatives
rejected. requ owns the markdown, so decisions are queryable, linked to the
requirements that drove them, and readable without repo access.

```jsonc
// create_adr
{ "title": "Use a modular monolith", "status": "accepted",
  "requirements": ["REQ-001"], "components": ["booking"],
  "content": "# Use a modular monolith\n\n## Context\n…" }
```

- **Ids** are `ADR-001`, assigned in sequence like `REQ-`/`US-`.
- **Status** is `proposed` → `accepted` → `superseded`. A decision is never
  silently rewritten: supersede it and point `supersededBy` at the replacement,
  so the history stays readable. `get_adr` reports the reverse edge
  (`supersedes`) too.
- **Links** are to requirements (what drove the decision) and components (what
  it applies to). ADRs are a separate dimension from test coverage — they never
  affect the requirement → story → scenario percentages.
- **The body is markdown**, and ` ```mermaid ` fences render as diagrams in the
  dashboard — C4 context/container views and sequence diagrams travel with the
  decision instead of living in a separate tool. The body is omitted from
  `list_adrs`/`get_adr` (they report `hasContent`); fetch it with
  `get_adr_content`.

**Already have `docs/adr/`?** `import_adrs_from_files` scans a folder of ADR
markdown, taking the id from the filename's leading number
(`0004-cqrs.md` → `ADR-004`), the title from the first `# ` heading, and the
status from a `Status` section or an inline `Status:` line. It records the
origin as `sourcePath`, and thereafter `get_adr_content` prefers the live file
over requ's snapshot (the response's `source` says which you got). Existing ids
are skipped, never overwritten; pass `dryRun` to preview.

The decision body is stored separately from its metadata, so list and detail
responses stay small; fetch it with `get_adr_content`.

## VCS references

requ-mcp records references to branches and merge/pull requests so a story can
be traced to the code that implements it. **It never calls the VCS provider and
holds no token** — the references are whatever an agent or CI job reports.

`set_repo` accepts `vcsType: gitlab | github | bitbucket`. The value is a label
only; no behaviour depends on it. `bitbucket` covers both Bitbucket Cloud and
Bitbucket Server/Data Center.

The vocabulary is provider-neutral and modelled on GitLab: a merge request
reference has `kind: "mr"` and id `MR-<ref>`, where `ref` is the MR iid on
GitLab or the PR number on GitHub and Bitbucket (numeric in all three). States
are `opened` / `merged` / `closed` — Bitbucket's `DECLINED` and `SUPERSEDED`,
and GitHub's closed-unmerged PRs, all map to `closed`.

```jsonc
// set_repo
{ "repoUrl": "https://bitbucket.org/acme/app", "defaultBranch": "main", "vcsType": "bitbucket" }
// link_merge_request — PR #42 implementing US-001
{ "ref": "42", "url": "https://bitbucket.org/acme/app/pull-requests/42",
  "branch": "feature/login", "targetBranch": "main", "storyIds": ["US-001"] }
```

A story whose MR/PR is `merged` is surfaced as such in `coverage_report`,
separately from whether its scenarios pass.

## Linking tests — `@US-xxx` tags

There is no manual link step. A scenario is linked to a story by tagging it in
the feature file:

```gherkin
@US-007
Scenario: Reset email is sent for a registered address
  ...
```

One feature file can hold scenarios for many stories. The server derives the
links by scanning `features/**/*.feature` (the same tags ride along in the
cucumber-JSON, so imported results map straight onto stories). `list_links`
shows the derived graph and flags `@US-xxx` tags that point at a story that
doesn't exist.

## Scenarios

requ can own the cucumber **scenario content** itself — the gherkin text — as the
single source of truth, instead of only deriving scenario names from disk feature
files. A stored scenario holds its `feature`/`name` identity (the same `testKey`
executions join on), the full gherkin `content`, the feature's `background` block
(the steps that run before the scenario, so a runner can execute it standalone),
its `tags`, and explicit `stories` links (defaulted from `@US-xxx` tags but
independently settable).

- **Validation:** gherkin content is checked with the official cucumber parser on
  write; invalid content is rejected unless `force:true` (stored with `valid:false`).
- **Migration:** run `import_scenarios_from_features` once to import your existing
  `.feature` files. Authoring afterwards uses `create_scenario`/`update_scenario`.
- **Source precedence (backward compatible):** if a project has **any** stored
  scenario, coverage is derived from stored scenarios; otherwise it falls back to
  scanning `features/**/*.feature` on disk exactly as before. Legacy projects and
  projects are unaffected until you import.
- **HTTP/DB mode:** with `REQU_PG_URL` set, projects live entirely in Postgres —
  no filesystem root is needed; select a project by its `key` or slug. The
  [Scenario REST API](#scenario-rest-api) + OpenAPI contract expose stored
  scenarios to external tools (including the scenario runner).

## Screens — UI specifications

Without a UI artefact, the development agent and the test agent each invent their
own reading of the acceptance criteria, and the gap only shows up after the code
is written. A **Screen** closes that gap: a UI specification, generated by an
agent from the specs, stored and versioned in requ, and consumed downstream to
generate tests.

```
Requirement → User Story ─┬→ Acceptance Criteria → Scenarios → Execution → Results
                          └→ Screen (HTML mockup) ──────────────↗
```

- The mockup is a **self-contained static HTML file** — inline CSS, no build. For
  mobile it renders inside a CSS device frame: the point is to validate the
  **flow**, not the pixel.
- It is **regenerable**: never hand-edited without updating the source spec. requ
  **stores and traces** mockups — it is not a UI editor, and does not replace Figma.
- Mockups are versioned with the specs they serve. The body is stored apart from
  the metadata so listings stay small (fetch it with `get_screen_html`);
  `mockupPath` instead points at a file the **server** can read — under Docker
  that means a path beneath the mounted `/workspace`.

| Field | Meaning |
|-------|---------|
| `id` | Stable, readable — `SCR-BOOK-DETAIL-MOB`; `UIC-…` for a shared component |
| `name` / `description` | Functional name, and the screen's intent + usage context |
| `platform` | `mobile` \| `web` \| `desktop` \| `tablet` |
| `phase` | Delivery phase the screen belongs to |
| `version` | Semver, or a content hash of the HTML (the default) |
| `status` | `draft` \| `reviewed_qa` \| `validated_ops` \| `obsolete` |
| `stories` | The stories it materializes, each with a role: `primary` \| `secondary` \| `entry` \| `confirmation` |

**Story ↔ screen is many-to-many**, and the link is made at the **story** level
(acceptance criteria have no stable id): a story spans several platforms and
several steps of a flow, and a shared detail screen serves several stories. Both
directions are navigable — `get_screens_for_story` (grouped by platform) and
`get_stories_for_screen` (impact analysis).

### `data-req-*` — traceability inside the HTML

Every significant element carries the attributes the downstream agents consume:

```html
<button
  data-req-el="btn-confirm-booking"
  data-req-stories="US-014,US-021"
  data-req-role="action">
  Confirm booking
</button>
```

| Attribute | Purpose |
|-----------|---------|
| `data-req-el` | **Stable element id**, unique per screen. This is what step definitions bind to — it replaces fragile CSS selectors, and is ideally kept in the production markup |
| `data-req-stories` | Story ids the element materializes (many-to-many here too). An element without one is flagged as potential **gold plating** |
| `data-req-role` | `action`, `input`, `display`, `feedback`, `navigation` — tells the test agent which assertion to write |
| `data-req-field` | Data-model field the element renders or captures |
| `data-req-target` | Screen id this element navigates to (the flow graph) |
| `data-req-component` | Embeds a shared `UIC-…` component at this point |

**Shared components** avoid duplicating traceability: a `UIC-…` component owns its
own elements and stories, screens reference it, and updating it updates every
screen that embeds it (its elements resolve into theirs).

### Automatic checks — `check_ui_coverage`

| Family | Checks |
|--------|--------|
| Platform coverage | A story targeting N platforms has ≥1 screen per platform (`platforms` on the story, else `uiPlatforms` on the project) |
| Functional coverage | Every story of the phase has ≥1 screen; every screen references ≥1 story |
| Structural | Element ids unique per screen; every element has a story and a valid role; every `dataFields` entry of the story surfaces in a screen; every error state described in the criteria has a `data-req-role="feedback"` element; no navigation dead end (unless `terminal`), no exit to an unknown screen |
| Drift | A screen whose linked story changed since generation is **stale** and must be regenerated (`get_stale_screens`) |

These checks are about **coherence**. Business **relevance** — does this flow match
the real field work? — stays a human validation: QA, then Operations, before any
code is written.

### Generating tests from screens

The test agent consumes **acceptance criteria + screen**: `get_screens_for_story`
returns the reference screens with their elements, and `get_screen_html` the
mockup to derive steps from. Steps target `data-req-el`, never a CSS selector or
visible text, and the feature file records its reference screens as metadata:

```gherkin
@story:US-014 @screens:SCR-BOOK-DETAIL-MOB,SCR-BOOK-CONFIRM-MOB
Feature: Booking a slot
```

Development agents and test agents **share only the spec and the screens** — never
each other's artefacts — so the validation stays independent.

### REST endpoints (HTTP mode)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/screens` | List/filter screens (`phase`, `platform`, `status`, `kind`, `story`, `q`), with resolved elements, exits and staleness |
| `GET /api/screens/:id` | One screen with its elements, story details and the screens embedding it |
| `GET /api/screens/:id/html` | The raw mockup, served with a restrictive CSP (the dashboard renders it in a sandboxed iframe) |
| `GET /api/ui-coverage` | The checks above (`phase`, `mode`) |

## Develop

```bash
npm install
npm run build      # tsc -> dist/
npm run smoke      # end-to-end test against the built server over HTTP
npm run smoke:screens # UI specification chain
npm run smoke:adrs # architecture decisions
npm run smoke:pg   # Postgres backend (needs a live PG; see docker-compose.yml)
npm start          # run from source with tsx
```

## How it finds the project

**By `key`, and only by `key`.** requ-mcp is a server, so there is no "current
project" to infer — it never looks at a working directory, a workspace root or a
`.requ/` folder. Every tool takes an optional `key`; REST endpoints take
`?project=<slug>`.

- With **one** project loaded, `key` may be omitted.
- With several, omitting it is an error listing the known keys, rather than a
  guess.
- `init_project` **requires** a `key` — that is how a project is created.
- `list_projects` returns everything the server holds.

This is the point: an agent working in a repo cannot silently read or write a
different store than the rest of the team. Local (stdio + YAML) mode was removed
in 1.0 for exactly this reason — see the CHANGELOG for the migration path.

## Releasing (npm)

Publishing is automated by `.github/workflows/publish.yml`. It runs on every
push to `main`: when the `package.json` version is **not yet on npm**, it
builds, runs the smoke test, publishes with provenance, and then creates the
matching `vX.Y.Z` git tag and GitHub release with generated notes. When the
version is already published the run is a no-op, so ordinary pushes to `main`
are safe.

One-time setup:

1. Create an npm **Automation** access token at npmjs.com → Access Tokens.
2. Add it as a repo secret named `NPM_TOKEN`
   (`gh secret set NPM_TOKEN`, or repo → Settings → Secrets → Actions).

To cut a release:

```bash
# bump the version and update CHANGELOG.md, then land it on main:
npm version 0.9.0 --no-git-tag-version
git commit -am "chore(release): v0.9.0"
git push   # (or merge via PR)
```

That's it — the workflow publishes to npm and creates the tag + GitHub release
automatically. Creating a GitHub Release by hand still works as a fallback
trigger (the tag must match `package.json`), and the workflow can also be run
manually via **Actions → Publish → Run workflow**.

## Coverage metrics (story-level)

- **Story coverage** — % of active requirements that trace to ≥1 story.
- **Story tested** — the story has ≥1 scenario tagged `@US-xxx`.
- **Story covered** — every tagged scenario passes in the phase.
- **Verified** — % of active requirements where every linked story is covered.
