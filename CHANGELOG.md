# Changelog

All notable changes to this project will be documented here.

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
