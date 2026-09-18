# 3. Roles as editable sets of per-entity permissions

- **Status:** accepted
- **Date:** 2026-09-13
- **Amends:** [ADR 0002](0002-ldap-authentication-rbac-and-audit.md) — the
  "Permissions derived, not annotated" section, and the fixed four-role ladder

## Context

ADR 0002 gave requ four roles — viewer, contributor, maintainer, admin — and
three write permissions derived from what a tool already declared it does to the
data: `spec:write`, `progress:write`, `spec:read`. That derivation was almost
free, which is why it was chosen, and for a while it was enough.

It stopped being enough as soon as a real team was described in it. A
requirements team has product owners, requirements analysts, QA engineers and
developers, and those are not four rungs of one ladder — they are four different
jobs. The specific thing the old model could not express is small and decisive:

> A QA engineer writes the scenarios that verify a requirement and records their
> results, but must not be able to rewrite the requirement they are testing.

With a single `spec:write` permission, "may write scenarios" and "may rewrite
requirements" are the same grant. The only way to deny the second was to deny the
first, which left QA unable to do their job, or to grant both, which made the
requirement's approval meaningless. No arrangement of four roles fixes that,
because the problem is the granularity of the permission underneath them.

Two ways out: ship more roles, or let deployments define their own. Shipping more
roles only moves the argument — every team's idea of what "QA" may do is slightly
different, and a role nobody can adjust is one they will work around.

## Decision

### Permissions are split by entity

One permission per entity per kind of change: `requirement:write`,
`story:write`, `scenario:write`, `screen:write`, `adr:write`,
`component:write`, `phase:write`, `execution:write`, `vcs:write`, alongside the
reads (`spec:read`, `history:read`, `audit:read`), the lifecycle permissions
(`version:manage`, `project:manage`, `project:export`, `project:import`) and the
two administrative ones (`project:members`, `admin:users`).

The derivation from `mutates` survives as a fallback, but the authority is now a
table keyed by tool name, plus a suffix rule (`*_scenario` → `scenario:write`)
for tools added later that follow the convention. That is a table of about forty
entries in one file, which is a price worth paying to be able to answer "what can
a QA engineer do?" by reading one screen instead of sixty call sites.

### A role is a row, not a constant

Roles live in `auth_roles` and are edited over the API and in the dashboard. Eight
are seeded on first boot: the original four, so every existing grant, token and
`REQU_LDAP_ROLE_MAP` entry keeps meaning exactly what it meant, plus
`product-owner`, `requirements-analyst`, `qa` and `developer` as a starting
vocabulary. The seeded roles can be edited — a team's reading of QA is theirs —
but not deleted, and no role's id ever changes, because grants, tokens and the
directory group map all point at it by id.

Roles are shared by default and may also be scoped to one project, where they
shadow a shared role of the same id. That is how "QA means something different on
this project" is said without renaming anything.

### The rule that makes it safe: you cannot give away what you do not have

Every write to a role — define, edit, delete, assign — is checked permission by
permission against what the caller holds, in the scope the permission is decided
in. Without it the feature is a complete authorisation bypass: a project
administrator invents a role holding `admin:users`, assigns it to themselves, and
administers the server.

Three details took the most deciding, and each is a place where the obvious rule
is wrong:

- **Editing checks only the permissions being *added*.** An administrator whose
  own rights were later narrowed must still be able to take permissions away from
  a role; requiring them to hold everything a role already grants would freeze it.
- **A project-scoped role may not *name* `admin:users`, but assigning a shared
  role that contains one is fine.** The first is a claim a project cannot honour,
  and a role listing a permission it does not confer is a lie the next reader has
  to discover. The second is inert — `admin:users` is only ever evaluated
  globally — and refusing it would stop a project's administrator from appointing
  a second one, which is the ordinary case, not an escalation.
- **An unknown permission id is refused, not dropped.** A role that silently
  grants less than it was asked to is worse than one that would not save, because
  the difference only shows up as someone else's permission error weeks later.

### Capping a token is an intersection

A token could be capped "at or below maintainer" when roles were a ladder. A
catalogue has no total order — nothing says whether QA outranks a requirements
analyst — so a capped token now gets the permissions its owner and the ceiling
role *both* hold. That keeps the guarantee that actually mattered: a token can
never do more than its owner, nor more than the role it was capped to. It also
turns out to be more useful, since a maintainer can now mint a token that records
test results and cannot touch requirements.

`/api/auth/me` reports the ceiling beside the owner's roles, so a permission set
smaller than the roles suggest has a visible reason.

### Configured role ids are checked twice

`REQU_LDAP_ROLE_MAP`, `REQU_AUTH_DEFAULT_ROLE` and `REQU_2FA_REQUIRED_ROLES` are
read at boot, before the database is necessarily reachable, so configuration
validation can only check that an id is well formed — it can no longer refuse an
unknown role, as ADR 0002 had it. The catalogue check happens once the store is
up and produces a startup warning rather than a refusal: a deployment may wire up
its directory before defining its roles. It is a warning rather than silence
because a typo there grants nothing and looks, from the inside, exactly like a
permissions bug.

## Consequences

- Existing deployments are unaffected on upgrade. The four original roles are
  seeded with the permissions they had, and `spec:write` simply becomes the seven
  specification permissions, held by the same people.
- "What can this person do?" is no longer answerable from a role name alone. The
  members panel therefore shows the permissions a member's roles add up to, and
  sorts by how many they have — a rough ordering, not a ranking, since there
  isn't one.
- Anything that used to compare roles has to stop. There is no `highestRole`, no
  rank, and code that wants to know whether someone may do something asks about
  the permission.
- Reading a role requires the database, so permission resolution is now an async
  call. It happens once per request, when the principal is built.
- A deployment can define a role that grants nothing, or one that duplicates
  another. Neither is harmful, and refusing them would mean deciding on a team's
  behalf what their vocabulary should be.
