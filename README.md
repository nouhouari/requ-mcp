# requ-mcp

An MCP server that tracks **requirements coverage** for a project, and how it
**evolves across phases/releases**. It gives AI agents structured tools to
maintain a living traceability graph:

```
Requirement → User Story → Acceptance Criterion → TestLink ──┐
                                                              │ resolved per phase
Phase (v1.0, v1.1, …) → Execution (a test result for a run) ─┘
```

At the end of a working session — or for any release — you ask the server one
question — *"what's our coverage?"* — and get a precise, always-current answer
instead of a stale spreadsheet, plus the **trend** of how coverage changed
release over release.

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

Everything is flat YAML under `.requ/`, so coverage is version-controlled and
reviewable in PRs:

```
.requ/
  config.yaml                 # project name, Conductor path, active phase
  requirements/REQ-001.yaml
  stories/US-001.yaml         # story → criteria → linked tests
  phases/PHASE-001.yaml       # a phase / release
  executions/PHASE-001.yaml   # test results recorded against that phase
```

## Tools

| Tool | Actor | Purpose |
|------|-------|---------|
| `init_project` | setup | Create `.requ/`, record Conductor + report path, optional first phase |
| `create_requirement` / `list_requirements` / `get_requirement` / `update_requirement` | server | Manage imported requirements (with `components`) |
| `create_user_story` | PO | Author a story (rejects unless it links ≥1 existing requirement) |
| `update_user_story` / `add_acceptance_criterion` / `list_user_stories` / `get_user_story` | PO | Edit stories & criteria |
| `create_phase` / `list_phases` / `update_phase` / `set_active_phase` | release | Manage phases/releases |
| `list_links` | tester | Show which scenarios are tagged to which story; flag dangling `@US-xxx` tags and stories with no scenario |
| `record_execution` | tester | Record one scenario result against a phase |
| `import_execution_report` | tester | Ingest a Conductor cucumber-json file into a phase |
| `coverage_report` | reporting | Phase/mode rollup + per-component + summary % (json or markdown) |
| `coverage_trend` | reporting | Coverage summary at each phase — the evolution view |
| `find_gaps` | reporting | Requirements without stories, stories without scenarios, stories not covered (per phase) |

Every tool also accepts an optional `projectPath` (see below).

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

## Develop

```bash
npm install
npm run build      # tsc -> dist/
npm run smoke      # end-to-end test against the built server over stdio
npm run dev        # run from source with tsx
```

## Register with an MCP client

The server talks stdio. It can be installed **once at the user level** and serve
any project — it resolves the target project per call:

```json
{
  "mcpServers": {
    "requ": {
      "command": "node",
      "args": ["/absolute/path/to/requ-mcp/dist/index.js"]
    }
  }
}
```

### How it finds the project

For each tool call, the project root (the directory containing `.requ/`) is
resolved in this order:

1. The tool's explicit **`projectPath`** argument, if given (use this in monorepos).
2. The **`REQU_ROOT`** env var, if set at launch (a hard pin).
3. A **workspace root** advertised by the client (MCP `roots`) that contains `.requ/`.
4. The nearest **ancestor of the cwd** that contains `.requ/`.
5. Otherwise the first workspace root, else the cwd (used by `init_project`).

So a single global server works across projects: most clients (Claude Code, IDEs)
advertise the open workspace as a root, and you can always pass `projectPath`
explicitly. The Conductor `features/` location is read from `.requ/config.yaml`
relative to that resolved root.

## Coverage metrics (story-level)

- **Story coverage** — % of active requirements that trace to ≥1 story.
- **Story tested** — the story has ≥1 scenario tagged `@US-xxx`.
- **Story covered** — every tagged scenario passes in the phase.
- **Verified** — % of active requirements where every linked story is covered.
