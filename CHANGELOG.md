# Changelog

All notable changes to this project will be documented here.

## [Unreleased]

## [1.0.0] – 2026-08-28

### Removed — BREAKING
- **Local mode is gone.** requ-mcp is an HTTP server only. The stdio transport,
  the YAML `.requ/` store and all filesystem project resolution (`REQU_ROOT`
  auto-detection, MCP workspace roots, walking up from the cwd, and the
  cwd-derived "legacy SQLite" fallback) have been deleted, along with the
  `projectPath` argument on every tool.

  *Why:* there were two ways to reach requ and no way for an agent to tell them
  apart. A client wired as `npx -y requ-mcp` silently read and wrote a private
  `.requ/` folder in whatever repo it happened to be in, while the team's data
  sat on the server. Projects are now addressed by `key` and nothing else, so
  landing on the wrong store is not possible.

  *Migrating:* the migration tool ships in the git repo, not in the npm package
  (`files` is `dist` only). From a checkout of the last release that still had
  local mode — `git checkout v0.8.0` — run, for each `.requ/` project:

  ```bash
  # start a 1.0 server first, then create the target project with init_project
  npx tsx scripts/sync-yaml-to-pg.ts <repo-root> <project-key> http://localhost:8788
  ```

  Then upgrade. Clients change from a `command`/`args` entry to
  `{"type": "http", "url": "http://<host>:8788/mcp"}`, and every call that
  passed `projectPath` passes `key` instead. `conductorPath` must become a path
  the **server** can read (under Docker, below the mounted `/workspace`).

### Added
- **`assign_requirements_to_phase`** — move many requirements onto a phase in one
  call, selected either by explicit `ids` or by filter (status / component / tag /
  current phase), with `dryRun`. Unknown ids reject the whole batch rather than
  half-applying it.
- **Docker Compose runs the whole stack** (`docker compose up -d`): Postgres plus
  the server, with your workspace mounted read-only at `/workspace`. Credentials
  and the workspace path come from `.env` (see `.env.example`) instead of being
  hardcoded.

### Fixed
- **Path-based tools failed silently when the server could not see the path.**
  `search_tests` returned zero results and the `list_links` disk scan returned
  nothing — indistinguishable from "there is nothing there", and the usual
  outcome when running in a container with no mount. They now return an explicit
  error naming the resolved path. `create_or_update_screen`'s mockup error names
  the resolved path too, instead of just the store root.

### Changed
- The smoke suites drive the server over HTTP (SQLite-backed, so CI needs no
  database service) through a shared harness in `scripts/lib/http-harness.ts`.
  `smoke:search` now runs in CI.

- **Architecture decisions (ADRs) as a first-class entity** — the decisions the
  architect produces are now tracked next to the requirements they serve, not
  left as loose files. `create_adr` / `update_adr` / `get_adr` / `list_adrs` /
  `search_adrs` / `get_adr_content` / `delete_adr`, stored across all three
  backends, with the decision body stored apart from its metadata so listings
  stay small; included in export/import, and counted in `/api/summary` and the
  SSE feed. Ids run `ADR-001`; status is `proposed` → `accepted` → `superseded`
  with a `supersededBy` pointer, so decision history is superseded rather than
  rewritten. Decisions link to requirements and components, and are deliberately
  a separate dimension from coverage — the requirement → story → scenario
  percentages are unchanged.
- **`import_adrs_from_files`** — bulk-import an existing `docs/adr/` folder: id
  from the filename's leading number (`0004-…` → `ADR-004`), title from the
  first `# ` heading, status from a `Status` section or inline `Status:` line.
  Records `sourcePath`, after which `get_adr_content` prefers the live file over
  requ's snapshot. Idempotent, with a `dryRun` preview.
- **Decisions tab in the dashboard** — decision cards with status badges and
  their requirement/component links, and a reader that renders the markdown with
  its ```mermaid diagrams (C4, sequence) drawn in place. `GET /api/adrs`,
  `/api/adrs/:id` and `/api/adrs/:id/content`.
- `npm run smoke:adrs` — end-to-end smoke test for the whole decision chain,
  now run in CI.


### Security
- The dashboard now sanitizes rendered markdown with DOMPurify before inserting
  it. The decision reader renders in the page rather than the screens viewer's
  sandboxed iframe, because mermaid needs scripts that `sandbox=""` forbids.

## [0.9.0] – 2026-08-27

_Never published to npm: the changes below shipped as part of 1.0.0._

### Added
- **Bitbucket and GitHub as VCS types** — `set_repo`'s `vcsType` now accepts
  `gitlab | github | bitbucket` (previously `gitlab` only). The value is a label:
  requ-mcp still never calls the VCS provider and holds no token. `bitbucket`
  covers both Bitbucket Cloud and Server/Data Center. The merge-request
  vocabulary stays provider-neutral — `kind: "mr"` and `MR-<ref>` ids cover
  GitLab MRs, GitHub PRs and Bitbucket PRs alike, `ref` is the MR iid / PR
  number, and Bitbucket `DECLINED`/`SUPERSEDED` and GitHub closed-unmerged PRs
  map to `state: "closed"`. Existing configs are unaffected.
- **UI specification traceability (`Screen`)** — the missing link between a user
  story and the tests written from it. A screen is a self-contained static HTML
  mockup, generated by an agent from the specs, versioned in requ next to them,
  and linked many-to-many to the stories it materializes (`primary` / `secondary`
  / `entry` / `confirmation` role per edge). Shared fragments are registered as
  `UIC-…` components and embedded by screens, so their traceability is declared once.
- **`data-req-*` convention + parser** — every significant element of a mockup
  carries `data-req-el` (stable id — the anchor step definitions bind to instead
  of a CSS selector), `data-req-stories`, `data-req-role`
  (`action`/`input`/`display`/`feedback`/`navigation`), plus optional
  `data-req-field`, `data-req-target` and `data-req-component`. Elements are
  re-extracted on every write.
- **Executable UI consistency checks** (`check_ui_coverage`) — per-platform and
  per-story screen coverage, screens that trace to nothing, duplicate/untraced
  (gold-plating) elements, missing or invalid roles, story data fields and error
  states with nowhere to surface, navigation dead ends and unknown exits, and
  drift. Errors are traceability holes, warnings are heuristics for a human.
  Business relevance stays a human validation (QA then Operations).
- **Drift detection** (`get_stale_screens`) — a screen snapshots each linked
  story's version when generated, so editing a story marks every screen built
  from it stale until regenerated.
- **MCP tools** — `create_or_update_screen`, `get_screen`, `get_screen_html`,
  `list_screens`, `get_screens_for_story`, `get_stories_for_screen`,
  `link_story_screen`, `unlink_story_screen`, `check_ui_coverage`,
  `get_stale_screens`, `delete_screen`. `create_user_story`/`update_user_story`
  gained `platforms` and `dataFields`; `init_project` gained `uiPlatforms`.
- **REST API** — `GET /api/screens`, `/api/screens/:id`, `/api/screens/:id/html`
  (served sandboxed, with CSP), `/api/ui-coverage`.
- **Screens dashboard tab** — filterable screen cards, the check results, and a
  viewer that renders the mockup in a fully sandboxed iframe with traced elements
  outlined (untraced ones flagged), its element table, exits and linked stories.
- Screens are carried by `export_project` / `import_project`, and stored in every
  backend: YAML (`.requ/screens/<id>.yaml` + a reviewable `<id>.html` beside it),
  SQLite and Postgres.
- `npm run smoke:screens` — end-to-end smoke test for the whole UI chain.

## [0.8.0] – 2026-07-31

### Added
- **Allure report serving** — the HTTP dashboard serves the static Allure report
  from `<project>/allure-report` (or the Conductor root) at `/allure/<slug>/`,
  with `GET /api/allure-status` and a per-story "Allure" button in the Stories tab.
- **Story detail modal** — `GET /api/story?id=US-…` returns the full story
  enriched with linked scenarios and pass counts; the dashboard shows it in a
  modal (description, acceptance criteria, requirements, scenario statuses).
- **"Verified (delivered)" delivered-scope metric** — `computeDeliveredCoverage()`
  restricts the verified denominator to requirements whose target phase is
  delivered (status `completed`/`active`), excluding planned phases. Exposed as
  `deliveredVerifiedPct`/`deliveredVerified`/`deliveredTotal` in `/api/summary`
  and `deliveredVerifiedPct` + `verifiedPctCumulative` in `/api/global`.
- **Coverage Trend strict/cumulative toggle** on the Overview tab.
- **`ingest-cucumber-pg`** CLI script — imports a cucumber-json execution report
  directly into the Postgres store (replica of the `import_execution_report` MCP tool).
- **`sync-yaml-to-pg`** CLI script — pushes the YAML store export into the
  Postgres-backed HTTP store via `POST /api/import`.
- Optional multi-project auto-discovery in `start-http-pg.sh` via `REQU_WORKSPACE_DIR`.
- Dashboard favicon; extended static-file MIME map (fonts, images, csv, …).

### Fixed
- **Overview charts no longer crash intermittently.** Chart.js instances now
  live in a non-reactive registry (Alpine deep-proxying them caused "Maximum
  call stack size exceeded"), init retries are bounded, and each chart registers
  its `$watch` exactly once.
- Overview Scenarios KPI reads passing/linked counts from a single consistent
  source instead of mixing cumulative and strict scopes.
- Removed a dead duplicate `GET /api/scenarios` handler.
- **HTTP mode no longer overwrites projects.** `init_project` previously resolved
  the target project via filesystem path auto-detection (`REQU_ROOT` / cwd walk).
  In HTTP mode the server is the store, so auto-detection always landed on the
  same root and every `init_project` call clobbered the existing project.
  Project resolution in HTTP mode is now **key-based**: `init_project` requires a
  `key` and creates an independent project identified by it, all tools accept
  `key` as the project selector, `projectPath` is rejected with a clear error,
  and `list_projects` returns every project registered in the server database.

## [0.7.0] – 2026-06-22

### Added
- **`search_requirements`** MCP tool — full-text search across requirement title, description, source, and tags; optional status/component/phase filters.
- **`search_user_stories`** MCP tool — full-text search across story title, description, and acceptance criteria; optional status/requirement/phase filters.
- **`search_tests`** MCP tool — search Conductor scenarios by feature name, scenario name, or tag; optional `storyId` filter; returns `conductorRoot`.
- **Scenarios tab** in the HTTP web dashboard — paginated scenario list with text search, tag filter (type `manual` for `@manual` scenarios), status badges, and expandable rows with one-click Pass / Fail / Pending execution recording.
- `GET /api/scenarios` REST endpoint — paginated, filtered, status-enriched scenario list.
- `POST /api/scenarios/execute` REST endpoint — validates against conductor index, appends execution to active phase log.

## [0.6.0] – prior release

Initial public release with requirements-coverage MCP tools, VCS integration, multi-phase/multi-project support, and HTTP web dashboard.
