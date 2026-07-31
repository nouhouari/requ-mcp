# Changelog

All notable changes to this project will be documented here.

## [0.8.0] – 2026-07-31

### Added
- **Allure report serving** — the HTTP dashboard serves the static Allure report
  from `<project>/allure-report` (or the Conductor root) at `/allure/<slug>/`,
  with `GET /api/allure-status` and a per-story "Allure" button in the Stories tab.
- **Story detail modal** — `GET /api/story?id=US-…` returns the full story
  enriched with linked scenarios and pass counts; the dashboard shows it in a
  modal (description, acceptance criteria, requirements, scenario statuses).
- **"Verified (livré)" delivered-scope metric** — `computeDeliveredCoverage()`
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
