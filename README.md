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

### Deploying to a server

For a real deployment — an Ubuntu VM on OpenStack running the published image
next to PostgreSQL on a block volume, behind your reverse proxy, signing in
against Active Directory — see [deploy/ansible/README.md](deploy/ansible/README.md).
One playbook provisions the VM, configures it, and verifies the result.

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
| **Audit** | Recent specification changes with their field-level diffs, and the audit log of every tool call and API request — denials included. Needs `audit:read`; see [Authentication](#authentication-roles-and-the-audit-trail) |
| **Access** | *Members* — who can reach this project, with what role, and where that role came from; add, change and remove (project admins). *Roles* — what each role allows, as a permission checklist, for the shared catalogue and the project's own. Plus server-wide user and grant administration (server admins only) |
| **Decisions** | Architecture decisions (ADRs) with status badges and their requirement/component links; open one to read the record with its mermaid diagrams rendered |
| **Versions** | Specification baselines: the version history with lock state, parent and audit trail, plus a side-by-side comparison of any two versions showing additions, removals and field-level changes |

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

Specification entities are additionally keyed by **version**, so a project holds
one full set of rows per baseline (see
[Versions](#versions--lockable-specification-baselines)). Executions, scenarios
and VCS refs are *not* versioned — they are progress, kept in a single namespace
and tagged with the version they were produced against.

## Authentication, roles and the audit trail

Out of the box requ-mcp is **open**: there is no login, every caller is an
admin, and that is deliberate — a development instance should not need a
directory to start. Production is a single environment variable away.

```bash
REQU_AUTH_MODE=disabled   # default — no login, full access, no credentials
REQU_AUTH_MODE=ldap       # users sign in against your directory
```

### Signing in

In `ldap` mode the dashboard opens on a sign-in form and nothing else loads until
a session exists. requ binds to the directory as the user to prove the password,
reads their display name, mail and groups, and never stores the password.

The minimum a deployment needs:

```bash
REQU_AUTH_MODE=ldap
REQU_AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
REQU_LDAP_URL=ldaps://ldap.example.com:636
REQU_LDAP_BASE_DN=dc=example,dc=com
REQU_LDAP_ROLE_MAP='requ-admins=admin;requ-leads=maintainer;requ-devs=contributor'
REQU_AUTH_ADMINS=alice          # a way in before any group mapping exists
```

`REQU_AUTH_SECRET` signs session cookies and peppers stored token hashes.
Changing it signs everyone out and invalidates every access token, so keep it
with your other secrets. Every setting is listed in
[`.env.example`](.env.example); Docker Compose passes them all through.

### Permissions and roles

Permissions are split by entity, and checked identically for an MCP tool call
and for the REST endpoint that does the same thing:

| Group | Permission | What holding it allows |
|---|---|---|
| Reading | `spec:read` | Requirements, stories, screens, scenarios, coverage, decisions |
| | `history:read` | What changed on an entity, and who changed it |
| | `audit:read` | The server-wide audit log, refusals included |
| Specification | `requirement:write` | Create, change and remove requirements; assign them to phases |
| | `story:write` | User stories and their acceptance criteria |
| | `scenario:write` | The cucumber scenarios that verify a story |
| | `screen:write` | UI specifications, and their links to stories |
| | `adr:write` | Architecture decision records |
| | `component:write` | The component breakdown |
| | `phase:write` | Phases, and which one is active |
| Delivery | `execution:write` | Scenario runs, by hand or from a cucumber report |
| | `vcs:write` | Branch and merge-request links |
| Lifecycle | `version:manage` | Create, lock, unlock and activate baselines |
| | `project:manage` | Create a project; edit its configuration and brief |
| | `project:export` | Take a full export |
| | `project:import` | Import over the project's data |
| Administration | `project:members` | Who can reach *this* project, and the roles it defines |
| | `admin:users` | Server-wide grants, shared roles, accounts, everyone's tokens |

The split is what lets a role mean something in the language of the team: a QA
engineer owns `scenario:write` and `execution:write` without `requirement:write`,
so they write and run the tests for a requirement they cannot quietly rewrite —
and an analyst has exactly the opposite.

**A role is a named set of those permissions, stored in the database**, so the
roles a deployment has are its own. Eight are seeded on first boot:

| Role | For |
|---|---|
| `viewer` | Reads the specification and its history. Changes nothing. |
| `contributor` | Reads everything and reports delivery progress, but does not change scope. |
| `maintainer` | Edits the whole specification and manages versions. |
| `admin` | Everything, including who may reach the project. |
| `product-owner` | Scope and release planning: requirements, stories, phases, baselines. Writes no tests. |
| `requirements-analyst` | Writes the specification. Does not freeze a baseline or report on delivery. |
| `qa` | Owns verification: writes scenarios and records their results. |
| `developer` | Implements stories: scenarios, runs, branches and merge requests. |

All eight can be **edited** — what QA may do in your team is yours to decide —
but not deleted, because grants, access tokens and `REQU_LDAP_ROLE_MAP` entries
point at them by id. For the same reason, no role's id ever changes.

#### Defining your own

The **Access** tab's *Roles* card is a permission checklist; the same thing over
the API:

```jsonc
// POST /api/roles                              — shared with every project
// POST /api/projects/<slug>/roles              — this project's own
{
  "name": "Release Manager",
  "description": "Cuts and freezes the baselines.",
  "permissions": ["spec:read", "history:read", "version:manage", "project:export"]
}
// → 201 { "id": "release-manager", ... }   PATCH to edit, DELETE to remove
```

Two scopes. A **shared** role is defined once and assignable anywhere: editing it
changes what it means everywhere it is already granted. A **project** role
belongs to one project, and one that reuses a shared role's id replaces it there
and nowhere else — which is how "QA means something different on this project"
gets said. A project's own role may not name `admin:users`: a project cannot
confer it, and a role listing a permission it does not grant is a lie the next
reader has to discover for themselves.

> **You cannot give away what you do not have.** Defining, editing, deleting or
> assigning a role is refused if it would hand out a permission the caller does
> not hold in that scope. Without that rule, "define your project's own roles"
> would be a complete bypass of everything else. Editing checks only the
> permissions being *added*, so an administrator whose own rights were narrowed
> can still take permissions away from a role. Deleting one that people still
> hold needs `?force=true`, which revokes those grants rather than leaving them
> pointing at nothing.

A user's roles come from three places, unioned:

1. `REQU_AUTH_ADMINS` — usernames that are always admin;
2. `REQU_LDAP_ROLE_MAP` — directory group → role, so the directory stays the
   source of truth for who is on the team. Groups match on either the bare name
   (`requ-leads`) or the full DN, and the role may be any role id, including one
   you defined;
3. explicit grants — either on one project (the **Access** tab's members panel,
   see below) or server-wide.

Anyone matched by none of them gets `REQU_AUTH_DEFAULT_ROLE` (viewer), or is
refused the sign-in when that is set to `none`. Role ids in the configuration are
checked for shape at boot and against the catalogue once the database is
reachable; one that names no role is warned about on startup rather than
refused, since a deployment may wire up its directory before defining its roles.

### Adding people to a project

Roles resolve **per project**, so the same person can be a maintainer on one and
a viewer on another. The **Access** tab's *Members* panel is where that is
decided — add someone by their directory username, pick their role, and they
have it on that project and nowhere else:

```jsonc
// POST /api/projects/<slug>/members
{ "username": "jdupont", "role": "maintainer" }
```

They do **not** need to have signed in first. The grant waits for them, they show
as *invited*, and their real name, mail and groups are filled in from the
directory the first time they sign in. Someone whose only role is on one project
can still sign in — they simply see that project.

The panel lists everyone who can reach the project and **where each role came
from**: granted here, inherited from a directory group, granted server-wide, or
handed out by `REQU_AUTH_DEFAULT_ROLE`. Only the first is editable — removing a
member drops the grant made on this project and says so if they still reach it
another way, rather than offering a button that could not work.

Two scopes, kept apart deliberately:

| | granted by | can do |
|---|---|---|
| **Project admin** — `admin` on one project | that project's admins | manage that project's members; nothing elsewhere |
| **Server admin** — `admin` globally (`REQU_AUTH_ADMINS`, a mapped group, or a server-wide grant) | server admins | everything above, plus server-wide grants, disabling accounts, and every token |

A project's admin genuinely cannot reach past it: server-wide administration is
always evaluated in the global scope, so holding `admin` on one project never
adds up to holding it everywhere. The last administrator of a project also
cannot remove themselves, since that would leave a project nobody can administer.

### Two-factor authentication

A password and a code from an authenticator app. Off by default; one variable
turns it on:

```bash
REQU_2FA=optional     # anyone may enrol
REQU_2FA=required     # everyone must — sign-in leads to enrolment until they have
REQU_2FA_REQUIRED_ROLES=admin   # or: anyone may, administrators must
```

**Microsoft Authenticator** enrols requ as a standard **TOTP** account (RFC
6238) — its push-approval flow is proprietary to Entra ID and not available to
third-party applications, so TOTP is what "2FA with Microsoft Authenticator"
means here. In the app: **+ → Other account (Google, Facebook, etc.)**, then
scan the QR code requ shows under *Account → Two-factor authentication*. The same
code works with Google Authenticator, 1Password, Authy or anything else that
reads `otpauth://`, so nobody is forced onto one vendor.

Once enrolled, signing in takes two steps: the password proves who you are, and
the code proves you still have the phone. Between the two the server holds a
*pending* session that authenticates nothing — a stolen half-finished sign-in is
worth no more than the password alone.

What the implementation guards against:

- **Replay** — each code is spent: the time step it belongs to is recorded, and
  a code from that step or earlier is refused even inside its 30-second window.
- **Brute force** — a six-digit code is a million guesses, so attempts are
  throttled on the same per-user and per-address counters as the password.
- **A stolen database** — the TOTP seed is the one secret that cannot be hashed,
  because verifying a code needs it back. It is encrypted with AES-256-GCM under
  a key derived from `REQU_AUTH_SECRET`, which lives in the environment, not the
  database.
- **Clock drift** — one step either side of now is accepted (±30s), which covers
  a phone that is slightly out without meaningfully widening the window.

**Recovery codes.** Ten are issued once, at enrolment, and shown exactly once —
only their hashes are stored. Each works a single time. Someone who loses their
phone signs in with one of these; if they have lost those too, an administrator
can reset the enrolment from the **Access** tab (which also ends that user's
sessions, since a reset is what you do when an account may be compromised).

**Access tokens are unaffected.** A token is already a credential of its own and
there is no phone to prompt behind an MCP client, so tokens keep working without
a code — the same way they do on GitHub. Enrolling and removing a second factor
requires a browser session, not a token.

### Access tokens for MCP clients

An MCP client cannot fill in a login form, so each user mints **personal access
tokens** from the dashboard (the avatar in the header → *New access token*).
The token is shown exactly once — only a peppered SHA-256 of it is stored — along
with the client configuration to paste:

```json
{
  "mcpServers": {
    "requ": {
      "type": "http",
      "url": "https://requ.example.com/mcp",
      "headers": { "Authorization": "Bearer requ_pat_…" }
    }
  }
}
```

A token acts as its owner and can be narrowed further:

- **capped at a role** — a `qa` token for a CI job gets what its owner and the
  `qa` role *both* allow, so a maintainer's token can record test results
  without being able to rewrite the requirements, and gains nothing if its owner
  is later promoted. Capping is an intersection rather than a ceiling on a
  ladder: with roles a team defines for itself there is no "at or below", since
  nothing says whether QA outranks a requirements analyst;
- **limited to projects** — refused on anything else;
- **expiring** — after `expiresInDays`, or `REQU_AUTH_TOKEN_TTL_DAYS` by default.

Revoking a token takes effect on the next call. Give each client its own so one
can be revoked without disturbing the others.

### Audit log and change history

`REQU_AUDIT` (`auto` by default: on whenever authentication is on) records two
different things, both on the dashboard's **Audit** tab:

- **Audit log** — one row per tool call or API request: who, when, from where
  (MCP or dashboard), which project and version, and the outcome. **Refused
  calls are recorded too**, with the permission that was missing, which is what
  makes the log useful for answering "who tried to do that?". Filter by actor,
  action, outcome, source, or across every project at once.
- **Change history** — "what changed on REQ-014?", the way an issue tracker
  shows it: one entry per write with the fields that actually differed, old
  value beside new, attributed to a person. Open it from the **History** button
  on a requirement or story, or from any entry in *Recent changes*.

Both are produced centrally — the tool dispatcher audits, and the store is
wrapped by a recorder that diffs every write — so an edit is recorded the same
way whether it came from an agent over MCP or from a person in the dashboard,
and a tool added later is covered without being told to.

The tables live wherever requ's own data does: in PostgreSQL when `REQU_PG_URL`
is set, otherwise in a SQLite file (`REQU_AUTH_DB`, default `~/.requ/auth.db`)
so a laptop still keeps its history across restarts.

### Hardening

Two settings decide what the server believes about where a request came from,
and both default to the strict reading:

```bash
REQU_TRUSTED_PROXIES=10.0.0.5,::1          # peers whose X-Forwarded-For is believed
REQU_CORS_ORIGINS=https://tools.example.com # browser origins allowed to call the API
```

- **`REQU_TRUSTED_PROXIES`** — the login throttle and the audit trail key on the
  caller's address. `X-Forwarded-For` is only honoured when the socket peer is
  one of these addresses; from anyone else it is ignored, so a caller cannot
  pick a fresh address per attempt or lock a colleague's real address out.
  Leave it empty when requ is reached directly.
- **`REQU_CORS_ORIGINS`** — by default no CORS headers are sent: the dashboard is
  same-origin and MCP clients are not browsers. List origins to let a page on
  one of them drive the REST API with a token, or `*` for the old wildcard.
  Credentials are never allowed, so the session cookie stays same-origin either
  way.

Beyond those, every response carries `X-Content-Type-Options: nosniff`,
`X-Frame-Options: SAMEORIGIN` and `Referrer-Policy: same-origin`, plus
`Strict-Transport-Security` whenever the session cookie is `Secure`. The
dashboard shell is served with a Content Security Policy that limits scripts to
this server and the pinned jsDelivr files, with no inline scripts; the CDN tags
carry Subresource Integrity hashes, and Tailwind is compiled at build time
(`npm run build:css`) rather than in the browser. `/mcp` accepts access tokens
only — never the dashboard cookie — so a session taken over through the browser
cannot reach the tools. Unexpected failures answer with a reference id and put
the real error in the server log, not in the response.

`npm run smoke:auth` pins each of these so a regression fails CI: the project a
request is authorised for must be the project served, every write route must
have an explicit permission entry, the shell must carry its policy headers, the
throttle must ignore a spoofed address, and cross-origin access must be opt-in.

### Testing against a directory

`npm run smoke:auth` runs a **real LDAP server in the test process**
([`scripts/lib/ldap-fixture.ts`](scripts/lib/ldap-fixture.ts)), so the bind path
is covered in CI with no container and no network: correct and wrong passwords,
unknown users, filter-injection attempts, `memberOf` versus group-tree
discovery, a DN-template direct bind, LDAPS over a generated self-signed
certificate, and the whole sign-in → session → token → MCP round trip.

To try requ against your own directory before rolling it out, point it at a
staging server and use the health check:

```bash
REQU_AUTH_MODE=ldap REQU_AUTH_SECRET=… REQU_LDAP_URL=ldaps://… \
REQU_LDAP_BASE_DN=dc=example,dc=com npm start

curl -s localhost:8788/api/admin/ldap-check   # as an admin: reachable? bind ok?
```

`GET /api/admin/ldap-check` binds with the service account and performs one
search, so a wrong URL, a bad service password or an unreachable host surfaces
before anyone tries to log in. The **Access** tab shows the same result.

If you would rather not point at a live directory at all, any throwaway LDAP
server works — `docker run -p 389:389 -e LDAP_ORGANISATION=Example \
-e LDAP_DOMAIN=example.com -e LDAP_ADMIN_PASSWORD=secret osixia/openldap` is the
usual one — with `REQU_LDAP_ALLOW_PLAINTEXT=true` while it is plaintext.

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
| `list_versions` / `create_version` / `lock_version` / `unlock_version` / `set_active_version` / `diff_versions` | BA/release | Manage specification baselines — see [Versions](#versions--lockable-specification-baselines) |
| `set_repo` / `get_repo` | dev | Record the project's repository reference — `repoUrl`, `defaultBranch`, `vcsType` (`gitlab` / `github` / `bitbucket`) |
| `link_branch` / `link_merge_request` / `update_merge_request` / `list_vcs_refs` | dev | Link branches and merge/pull requests to stories and requirements — see [VCS references](#vcs-references) |

Every tool also accepts an optional `key` selecting the target project (see
[How it finds the project](#how-it-finds-the-project)) and an optional `version`
selecting the specification baseline (see [Versions](#versions--lockable-specification-baselines)).

## Versions — lockable specification baselines

A **version** is a complete, frozen set of requirements, stories, screens,
decisions, components and phases. It exists so a delivery team can build against
a specification that cannot move under them, while the BA prepares the next one.

```
1.0.0  locked   ← the team is building this
  └── 1.1.0  draft    ← the BA is writing the next scope here
```

Creating a version **copies** every entity, so each version is a full set of
rows you can read, filter and report on exactly like any other. There is no
second query path and no blob to hydrate — `coverage_report`, `find_gaps`, the
REST API and the dashboard all work per version without knowing how it is
stored.

### The lifecycle

```bash
lock_version   { actor: "ba@example.com", reason: "Sprint 1 baseline" }
create_version { bump: "minor", label: "Sprint 2 scope" }   # → 1.1.0, editable
# …the BA edits 1.1.0 while the team keeps delivering 1.0.0…
diff_versions  { from: "1.0.0", to: "1.1.0" }
lock_version   { version: "1.1.0" }
```

**Exactly one version is editable at a time.** `create_version` refuses while a
draft is open, so "which version am I changing?" always has one answer.

### What a lock freezes

Locking freezes the *specification* and leaves *progress* writable, because the
team still has to report how far they have got against the baseline they were
handed.

| Entity | Writable while locked | Frozen |
|---|---|---|
| Requirement | *(nothing)* | all fields |
| UserStory | `status` | title, description, requirements, acceptance criteria, platforms, data fields |
| Screen | `status` | html, elements, story links, name, platform, phase |
| Adr | `status`, `supersededBy` | title, content, requirements, components |
| Component | *(nothing)* | all fields |
| Phase | `status` | name, order, description |

Creating or deleting an entity in a locked version is always rejected. Test
executions, scenario results and VCS links are never frozen — they are progress,
not specification.

The check runs in the store, not in the tool handlers, so the MCP tools and the
REST API are guarded by the same code. A rejected write says exactly which
fields were frozen and what to do instead:

```
Cannot change frozen field(s) [title] of a user story in locked version 1.0.0.
Only [status] stay writable while locked. Create the next version
(create_version) and make the change there.
```

`unlock_version { force: true }` reopens a baseline for the case where a lock
was a mistake. It is deliberately awkward: someone may already be building
against that version, and the reason is recorded in the audit trail.

### Which version a call targets

Every tool accepts an optional `version`. Without one, the project's two
pointers decide:

- **specification edits** go to `draftVersion` — the open draft;
- **reads and progress updates** go to `currentVersion` — the locked baseline.

That split is the point: `record_execution` and `link_merge_request` default to
the version the team is *delivering*, while `update_user_story`'s title change
defaults to the version the BA is *writing*. `set_active_version` moves either
pointer.

The split is decided per call, not per tool, because several tools do both. A
call to `update_user_story` that sets only `status` is a progress update and
lands on the locked baseline; the same tool given a `title` is a scope change
and lands on the draft. The rule is the freeze matrix above: supply nothing but
fields that stay writable while locked, and the call is treated as progress.

A few tools own a `version` field of their own — the version `create_version` is
about to create, or a screen's content hash. Those are addressed with
`atVersion` instead, so their own field keeps its meaning.

### Versions and phases are different things

A **phase** is a release slot (P1, P2…) — planning. A **version** is a content
snapshot — what the specification said at a moment in time. A phase can be
re-baselined many times, and a version can span several phases.

### Coverage carry-over

A test result recorded against 1.0.0 still counts in 1.1.0 — but only for the
stories whose specification is byte-identical along the whole ancestor chain.
Reword a story's acceptance criteria and its old results stop counting, so the
scenario reads as untested until it is re-run. Copying a version therefore costs
nothing in re-testing, while a real scope change is never silently signed off by
an old green run.

### REST endpoints

```
GET  /api/versions                                # history + both pointers
GET  /api/versions/diff?from=1.0.0&to=1.1.0       # &entity= to scope it
POST /api/versions                                # {from, version|bump, label, actor, reason}
POST /api/versions/:version/lock                  # {actor, reason}
POST /api/versions/:version/unlock                # {force, actor, reason}
POST /api/versions/active                         # {current, draft}
```

Every read route also accepts `?version=` — `/api/requirements?version=1.0.0`
returns the requirements as they were in that baseline. Omitted, routes resolve
the project's current version, so a caller that predates versioning is
unaffected.

### Export and import

`export_project` exports one version — the current baseline, or the one you name
— and `allVersions: true` exports the whole history plus the version registry.
Importing a payload that carries a registry restores every version with its lock
state.

### Upgrading

Existing projects are migrated in place on first open: all data is stamped
`1.0.0`, registered as a **draft**, and both pointers aim at it. Nothing is
frozen and no call changes behaviour until you lock for the first time.

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
