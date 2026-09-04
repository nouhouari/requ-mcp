# 1. Copy-on-write specification versioning

## Status

Accepted

## Context

requ-mcp stored exactly one mutable set of rows per project. There was no way to
freeze a specification, so a delivery team building against it and a business
analyst preparing the next scope were editing the same data. The team could not
tell whether a story had changed since they picked it up, and the BA could not
write the next version without disturbing the current one.

The existing `Phase` concept did not solve this. A phase is a *release slot*
(P1, P2…) — planning — not a content snapshot. A phase gets re-baselined many
times over its life, so it cannot also be the identity of a frozen specification.

Two shapes were considered.

**Snapshots.** Keep the live rows as they are and store a frozen copy of the
specification as a blob when a version is locked. Cheap to add, but it inverts
the requirement: the mutable set is always "latest", so the thing a team builds
against is the thing that keeps moving. Worse, every consumer that reports on a
version — `coverage_report`, `find_gaps`, the `search_*` tools, the REST API and
the dashboard — would need a second code path that hydrates a blob instead of
querying rows.

**Copy-on-write.** Add `version` to the primary key of every specification
table. Creating a version copies every row.

## Decision

Copy-on-write. `version` joins the primary key of the six specification tables
(requirements, stories, screens, ADRs, components, phases), and each version is
a full, independently queryable and editable set of rows.

Consequences of that choice, decided together with it:

- **Every read stays `WHERE project_id = ? AND version = ?`.** There is one
  query path for locked and draft versions alike, so nothing downstream needs a
  version-aware branch.

- **Lock enforcement lives in the store, not in the tool handlers.** A single
  freeze matrix drives one `assertWritable` call inside the row-write helper, so
  the MCP tools and the REST API are guarded by the same code and cannot drift.

- **A lock freezes specification, not progress.** Story/screen/phase `status` and
  ADR `status`/`supersededBy` stay writable, because the team still has to report
  progress against the baseline they were handed. Executions, scenario results
  and VCS links are never frozen.

- **Executions, scenarios and VCS refs are tagged, not versioned.** They keep a
  single namespace with a nullable `version` column recording provenance. They
  are records of what happened, and what happened does not fork.

- **Ids are allocated across all versions.** `REQ-060` never means two different
  requirements, which matters because ids travel outside the system in commit
  messages and test tags.

- **Deletion in a draft is a soft delete.** A tombstone is what lets a diff say
  "removed" instead of the row silently vanishing.

- **Coverage carries over only for unchanged stories.** A result recorded against
  an ancestor version counts while the story's frozen fields are byte-identical
  along the whole ancestor chain. Copying a version therefore costs nothing in
  re-testing, but a genuine scope change is never signed off by an old green run.

- **Exactly one draft is open at a time**, so "which version am I editing?"
  always has one answer.

## Consequences

Positive: versions are ordinary rows, so every existing report, filter and API
route works per version for free. The guard is unbypassable because it sits
below both entry points. Diffing is a straightforward row comparison.

Negative: storage grows linearly in the number of versions, since every version
copies every row. At the scale requ-mcp operates (tens to hundreds of rows per
project) this is not worth optimising; if it ever is, unchanged rows can be
shared behind the same interface without changing any caller.

Negative: because scenarios are tagged rather than versioned, one `testKey`
cannot hold different gherkin in two versions — regenerating a scenario for v2
overwrites v1's text. Promoting scenarios into the copy-on-write set is a
contained follow-up if that becomes a problem.

Negative: progress recorded against a locked baseline does not propagate into
the open draft. Marking a story done in v1.0.0 leaves the copy in the v1.1.0
draft at whatever status it held when the draft branched, so when v1.1.0 is
locked and becomes current the progress appears to revert. This falls out of
copy-on-write combined with routing progress to the baseline being delivered,
and both halves are wanted individually. The pragmatic answer for now is that
`status` is one of the fields that stays writable while locked, so it can be
re-asserted on the new baseline; a carry-forward of progress at lock time is the
obvious improvement if this proves annoying.

Neutral: SQLite cannot change a primary key with `ALTER TABLE`, so the migration
rebuilds each table (create, copy, drop, rename) in one transaction. It is
idempotent and guarded by a column check, and runs before any read.

## Alternatives considered

**Snapshot blobs** — rejected: the mutable set would always be "latest", which is
the opposite of what a baseline is for, and every reporting path would need a
second implementation.

**Reusing `Phase` as the version** — rejected: a phase is a release slot that is
re-baselined repeatedly. Overloading it would make it impossible to express "the
scope of P2 changed twice before we shipped it".

**Event sourcing the specification** — rejected as disproportionate. It answers
"how did we get here?", which nobody asked for, at the cost of rewriting every
read in the system.
