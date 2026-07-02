# Changelog

All notable changes to this project will be documented here.

## [Unreleased]

### Fixed
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
