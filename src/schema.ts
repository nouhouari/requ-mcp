import { z } from "zod";

/**
 * The requ-mcp data model.
 *
 * Traceability spine:
 *   Component ← Requirement → User Story ─┬→ (acceptance criteria)
 *       ↑           ↑                     └→ Screen (UI spec / HTML mockup)
 *       └───────────┴──── Adr (architecture decision — why the system is shaped so)
 *   Phase → Execution (a scenario result for a run) ─── @US-xxx tag in feature files
 *
 * Component: a sub-system/module that maps to broker domain_tags.
 * Phase.id is free-form — use the same value as the broker phase_id (e.g. "P1")
 * so both systems share a single identifier.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export const Priority = z.enum(["low", "medium", "high", "critical"]);
export type Priority = z.infer<typeof Priority>;

/** ISO-8601 timestamp string. */
export const Timestamp = z.string();

// ---------------------------------------------------------------------------
// Versioning — a project's specification is captured in named, lockable versions
// ---------------------------------------------------------------------------

/**
 * A version is either an editable `draft` or a `locked` baseline. Locking freezes
 * the *specification* fields of every entity in the version while leaving
 * *progress* fields (statuses, executions, VCS links) writable, so a delivery team
 * can keep working against a stable scope while the BA prepares the next one.
 */
export const VersionStatus = z.enum(["draft", "locked"]);
export type VersionStatus = z.infer<typeof VersionStatus>;

/** Versions are semver so a locked baseline can receive patch releases. */
export const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** The version every pre-versioning project is migrated into. */
export const INITIAL_VERSION = "1.0.0";

/**
 * Entity types copied when a new version is created ("in scope"). Executions,
 * scenarios and VCS refs are deliberately excluded: they are progress, not
 * specification, and are merely *tagged* with the version they were produced
 * against.
 */
export const VERSIONED_ENTITIES = [
  "components",
  "requirements",
  "stories",
  "phases",
  "screens",
  "adrs",
] as const;
export type VersionedEntity = (typeof VERSIONED_ENTITIES)[number];

export const ProjectVersion = z.object({
  /** Semver identifier, unique within the project. */
  version: z.string().regex(SEMVER_RE, "version must look like 1.2.0"),
  status: VersionStatus.default("draft"),
  /** Optional human label, e.g. "Q3 scope". */
  label: z.string().default(""),
  /** Version this one was branched from; absent for the first version. */
  parent: z.string().optional(),
  createdAt: Timestamp,
  lockedAt: Timestamp.optional(),
  unlockedAt: Timestamp.optional(),
  /** Caller-supplied, for traceability only — requ-mcp has no authentication. */
  actor: z.string().optional(),
  reason: z.string().optional(),
});
export type ProjectVersion = z.infer<typeof ProjectVersion>;

/**
 * Soft-delete marker carried by every versioned entity. Removing an entity in a
 * draft leaves a tombstone so `diff_versions` can report it, rather than making
 * the row silently vanish.
 */
const tombstone = { removed: z.boolean().default(false) };

// ---------------------------------------------------------------------------
// Component — sub-system/module; maps to broker domain_tags
// ---------------------------------------------------------------------------

export const ComponentStatus = z.enum(["active", "deprecated"]);
export type ComponentStatus = z.infer<typeof ComponentStatus>;

export const Component = z.object({
  /** Unique identifier. Use the same value as broker domain_tag (e.g. 'C-auth'). */
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  /** Broker routing tags this component maps to. E.g. ["auth","security"]. */
  domainTags: z.array(z.string()).default([]),
  status: ComponentStatus.default("active"),
  ...tombstone,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Component = z.infer<typeof Component>;

// ---------------------------------------------------------------------------
// Requirement — imported source of truth ("what must be built")
// ---------------------------------------------------------------------------

export const RequirementStatus = z.enum(["active", "deprecated"]);
export type RequirementStatus = z.infer<typeof RequirementStatus>;

export const Requirement = z.object({
  id: z.string().regex(/^REQ-\d+$/, "id must look like REQ-001"),
  title: z.string().min(1),
  description: z.string().default(""),
  /** Provenance: where this requirement came from (doc, spec section, ticket). */
  source: z.string().default(""),
  priority: Priority.default("medium"),
  /** Component IDs this requirement belongs to (matches Component.id). */
  components: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  status: RequirementStatus.default("active"),
  /** Target phase this requirement is planned for (matches Phase.id). Optional;
   *  unassigned requirements are always in scope for every phase report. */
  phase: z.string().optional(),
  ...tombstone,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Requirement = z.infer<typeof Requirement>;

// ---------------------------------------------------------------------------
// Conductor test identity (shared by Execution)
// ---------------------------------------------------------------------------

export const TestStatus = z.enum(["pass", "fail", "pending"]);
export type TestStatus = z.infer<typeof TestStatus>;

/**
 * Identity of a Conductor test = a cucumber scenario, addressed by its feature
 * name + scenario name.
 */
const testIdentity = {
  feature: z.string().min(1),
  name: z.string().min(1),
};

/** Stable key for a scenario, used to join executions to scenarios. */
export function testKey(t: { feature: string; name: string }): string {
  return `${t.feature}::${t.name}`;
}

/** Tag convention: a scenario tag like `@US-007` links it to story US-007. */
export const STORY_TAG_RE = /^@?(US-\d+)$/;

/** Derive story ids from a scenario's tags (e.g. ["@US-007","@auth"] -> ["US-007"]). */
export function storiesFromTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const m = t.match(STORY_TAG_RE);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Acceptance Criterion — descriptive PO content
// ---------------------------------------------------------------------------

export const AcceptanceCriterion = z.object({
  id: z.string().regex(/^AC-\d+$/, "id must look like AC-1"),
  text: z.string().min(1),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

// ---------------------------------------------------------------------------
// Screen — a UI specification (static HTML mockup) that materializes stories.
//
//   Requirement → User Story ─┬→ Acceptance Criteria → Scenario → Execution
//                             └→ Screen (mockup HTML)
//
// requ stores and traces mockups; it is not a UI editor. The mockup is a
// self-contained static HTML file, regenerable by an agent from the specs, whose
// significant elements carry `data-req-*` attributes (see screen-html.ts).
// ---------------------------------------------------------------------------

export const ScreenPlatform = z.enum(["mobile", "web", "desktop", "tablet"]);
export type ScreenPlatform = z.infer<typeof ScreenPlatform>;

export const ScreenStatus = z.enum(["draft", "reviewed_qa", "validated_ops", "obsolete"]);
export type ScreenStatus = z.infer<typeof ScreenStatus>;

/** A full screen, or a shared UI component embedded by screens. */
export const ScreenKind = z.enum(["screen", "component"]);
export type ScreenKind = z.infer<typeof ScreenKind>;

/** What the screen does for the story it is linked to. */
export const ScreenLinkRole = z.enum(["primary", "secondary", "entry", "confirmation"]);
export type ScreenLinkRole = z.infer<typeof ScreenLinkRole>;

/** Nature of a traced element — tells the test agent which assertion to write. */
export const ElementRole = z.enum(["action", "input", "display", "feedback", "navigation"]);
export type ElementRole = z.infer<typeof ElementRole>;

/** Screen ids look like `SCR-BOOK-DETAIL-MOB`; shared components use `UIC-`. */
export const SCREEN_ID_RE = /^(SCR|UIC)-[A-Z0-9][A-Z0-9_-]*$/;

/** Kind implied by an id prefix (`UIC-` = shared component, else screen). */
export function kindFromScreenId(id: string): ScreenKind {
  return id.startsWith("UIC-") ? "component" : "screen";
}

/**
 * One traced element of a mockup, extracted from its `data-req-*` attributes.
 * Derived data: recomputed from the HTML on every write, never hand-edited.
 */
export const ScreenElement = z.object({
  /** `data-req-el` — stable id, unique within the screen. The anchor step
   *  definitions bind to, in place of a fragile CSS selector. */
  el: z.string().min(1),
  /** `data-req-role` — kept free-form; unknown roles are reported as warnings. */
  role: z.string().default(""),
  /** `data-req-stories` — story ids this element materializes. */
  stories: z.array(z.string()).default([]),
  /** `data-req-field` — data-model field this element renders/captures. */
  field: z.string().optional(),
  /** `data-req-target` — screen id this element navigates to. */
  target: z.string().optional(),
  /** HTML tag the attributes were found on, e.g. "button". */
  tag: z.string().default(""),
  /** Best-effort inner text, for review and for the error-feedback check. */
  text: z.string().default(""),
  /** Shared component id this element came from; absent when declared inline. */
  from: z.string().optional(),
});
export type ScreenElement = z.infer<typeof ScreenElement>;

/** Story ↔ screen edge. Many-to-many, stored on the screen row. */
export const ScreenStoryLink = z.object({
  id: z.string().regex(/^US-\d+$/, "id must look like US-001"),
  role: ScreenLinkRole.default("primary"),
});
export type ScreenStoryLink = z.infer<typeof ScreenStoryLink>;

export const Screen = z.object({
  id: z.string().regex(SCREEN_ID_RE, "id must look like SCR-BOOK-DETAIL-MOB (or UIC-… for a shared component)"),
  kind: ScreenKind.default("screen"),
  name: z.string().min(1),
  /** Optional for shared components, which may be platform-agnostic. */
  platform: ScreenPlatform.optional(),
  /** Delivery phase this screen belongs to (matches Phase.id). */
  phase: z.string().optional(),
  description: z.string().default(""),
  /** Repo path of the static HTML mockup, when it lives as a file next to the
   *  specs. `html` holds the content requ serves (a snapshot when both are set). */
  mockupPath: z.string().optional(),
  html: z.string().default(""),
  /** Semver or content hash — defaults to a hash of `html` on write. */
  version: z.string().default(""),
  status: ScreenStatus.default("draft"),
  /** Stories this screen materializes, with the role it plays for each. */
  stories: z.array(ScreenStoryLink).default([]),
  /** Shared component ids this screen embeds (explicit + `data-req-component`). */
  uses: z.array(z.string()).default([]),
  /** Screen ids reachable from here (explicit + `data-req-target`). */
  exits: z.array(z.string()).default([]),
  /** Marks an intentional end of a flow, exempt from the dead-end check. */
  terminal: z.boolean().default(false),
  /** Derived from `html` on every write. */
  elements: z.array(ScreenElement).default([]),
  /** storyId → that story's `updatedAt` when the screen was last generated.
   *  A linked story whose current updatedAt differs has drifted → screen is stale. */
  storyVersions: z.record(z.string()).default({}),
  ...tombstone,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Screen = z.infer<typeof Screen>;

// ---------------------------------------------------------------------------
// User Story — PO-authored, must trace to ≥1 requirement
// ---------------------------------------------------------------------------

export const StoryStatus = z.enum(["draft", "ready", "in_progress", "done"]);
export type StoryStatus = z.infer<typeof StoryStatus>;

export const UserStory = z.object({
  id: z.string().regex(/^US-\d+$/, "id must look like US-001"),
  title: z.string().min(1),
  description: z.string().default(""),
  /** Must contain at least one requirement id. Enforced at write time. */
  requirements: z.array(z.string().regex(/^REQ-\d+$/)).min(1),
  acceptanceCriteria: z.array(AcceptanceCriterion).default([]),
  status: StoryStatus.default("draft"),
  /** UI platforms this story must be materialized on. Drives the per-platform
   *  screen coverage check; empty falls back to config.uiPlatforms. */
  platforms: z.array(ScreenPlatform).default([]),
  /** Data-model fields the story touches, e.g. ["guestCount","slotDate"]. Each one
   *  must surface in at least one linked screen (structural UI check). */
  dataFields: z.array(z.string()).default([]),
  /** NOTE: a story has no phase of its own. Its phase scope is derived from the
   *  phases of the requirements it traces to (see `storyInScope` in coverage.ts).
   *  This keeps requirement phase as the single source of truth — no drift. */
  ...tombstone,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type UserStory = z.infer<typeof UserStory>;

// ---------------------------------------------------------------------------
// Phase / Release — id is free-form to align with broker phase_id (e.g. "P1")
// ---------------------------------------------------------------------------

export const PhaseStatus = z.enum(["planned", "active", "completed"]);
export type PhaseStatus = z.infer<typeof PhaseStatus>;

export const Phase = z.object({
  /**
   * Free-form identifier. Use the same value as the broker phase_id
   * (e.g. "P1", "Sprint-3") so both systems share one identifier.
   * Previously required PHASE-\d+ format; that format is still valid.
   */
  id: z.string().min(1),
  name: z.string().min(1),
  /** Sort key for evolution; lower = earlier. */
  order: z.number().int(),
  status: PhaseStatus.default("planned"),
  description: z.string().default(""),
  ...tombstone,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Phase = z.infer<typeof Phase>;

// ---------------------------------------------------------------------------
// Execution — a recorded test result within a phase
// ---------------------------------------------------------------------------

export const ExecutionSource = z.enum(["manual", "cucumber-json", "import"]);
export type ExecutionSource = z.infer<typeof ExecutionSource>;

export const Execution = z.object({
  ...testIdentity,
  status: TestStatus,
  ranAt: Timestamp,
  /** Optional run identifier (CI job, report file). Latest by ranAt wins per test. */
  runId: z.string().optional(),
  source: ExecutionSource.default("manual"),
  note: z.string().optional(),
  /** Project version this run was produced against. Absent on pre-versioning
   *  rows, which are treated as belonging to every version. */
  version: z.string().optional(),
});
export type Execution = z.infer<typeof Execution>;

/** Per-phase execution log file shape (YAML mode). */
export const ExecutionLog = z.object({
  phase: z.string(),
  runs: z.array(Execution).default([]),
});
export type ExecutionLog = z.infer<typeof ExecutionLog>;

// ---------------------------------------------------------------------------
// Scenario — a cucumber scenario whose gherkin content requ owns as the single
// source of truth. Identity = testKey(feature,name) so executions join unchanged.
// Linked to user stories via explicit `stories` (defaulted from @US-xxx tags).
// ---------------------------------------------------------------------------

export const ScenarioSource = z.enum(["manual", "import-feature", "import"]);
export type ScenarioSource = z.infer<typeof ScenarioSource>;

export const Scenario = z.object({
  ...testIdentity,                               // feature, name (min 1)
  /** Stable id == testKey(feature,name); the row primary key. */
  testKey: z.string().min(1),
  /** Full gherkin scenario text (the Scenario:/Scenario Outline: block incl. steps,
   *  tag lines, and any Examples:). May be "" for legacy/manually-linked rows. */
  content: z.string().default(""),
  /** The feature's Background: block (steps that run before this scenario), if any.
   *  Stored alongside the scenario so a runner can execute it standalone. */
  background: z.string().default(""),
  /** All tags on the scenario incl. inherited feature-level tags, e.g. ["@auth","@US-007"]. */
  tags: z.array(z.string()).default([]),
  /** Linked story ids. Defaulted from @US tags on write; explicit value wins. */
  stories: z.array(z.string().regex(/^US-\d+$/)).default([]),
  source: ScenarioSource.default("manual"),
  /** Origin feature file path (for imported scenarios). */
  file: z.string().optional(),
  /** Whether the gherkin content parses (set on every write; true when content is empty). */
  valid: z.boolean().default(true),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Scenario = z.infer<typeof Scenario>;

// ---------------------------------------------------------------------------
// Adr — an Architecture Decision Record.
// The durable answer to *why* the system is shaped the way it is. requ owns the
// markdown (mermaid diagrams included); the body is stored inline on the record
// and split to a sidecar `.md` by the YAML store alone, exactly like Screen.html.
// ---------------------------------------------------------------------------

/** proposed → accepted → superseded. A decision is never silently rewritten:
 *  it is superseded by a newer one, so the history stays readable. */
export const AdrStatus = z.enum(["proposed", "accepted", "superseded"]);
export type AdrStatus = z.infer<typeof AdrStatus>;

export const Adr = z.object({
  id: z.string().regex(/^ADR-\d+$/, "id must look like ADR-001"),
  title: z.string().min(1),
  status: AdrStatus.default("proposed"),
  /** The decision record itself: markdown, ```mermaid fences included. */
  content: z.string().default(""),
  /** Requirements this decision is driven by or constrains. */
  requirements: z.array(z.string().regex(/^REQ-\d+$/)).default([]),
  /** Components the decision applies to. */
  components: z.array(z.string()).default([]),
  /** The ADR that replaced this one — set when status becomes 'superseded'. */
  supersededBy: z.string().optional(),
  /** Origin path when imported from a repo file (e.g. docs/adr/0004-cqrs.md). */
  sourcePath: z.string().optional(),
  phase: z.string().optional(),
  /** Content hash, refreshed whenever the body changes. */
  version: z.string().default(""),
  ...tombstone,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Adr = z.infer<typeof Adr>;

// ---------------------------------------------------------------------------
// Project config
// ---------------------------------------------------------------------------

/** VCS provider label. requ-mcp never calls the provider — this records which
 *  one the project uses. "bitbucket" covers Bitbucket Cloud and Server/Data
 *  Center alike (the distinction has no effect since no API is called). */
export const VcsType = z.enum(["gitlab", "github", "bitbucket"]);
export type VcsType = z.infer<typeof VcsType>;

export const Config = z.object({
  name: z.string().default("requ project"),
  key:   z.string().optional(),
  brief: z.string().optional(),
  conductorPath: z.string().default("."),
  conductorName: z.string().optional(),
  conductorReportPath: z.string().optional(),
  /** Free-form phase identifier (e.g. "P1"). */
  activePhase: z.string().optional(),
  /** VCS repository reference (requ-mcp never calls VCS; it only records references). */
  repoUrl: z.string().optional(),
  /** Default branch name; treated as "main" when unset. */
  defaultBranch: z.string().optional(),
  /** VCS provider (gitlab | github | bitbucket). */
  vcsType: VcsType.optional(),
  /** Platforms every story is expected to be materialized on, unless the story
   *  overrides them. Drives the per-platform screen coverage check. */
  uiPlatforms: z.array(ScreenPlatform).optional(),
  /** Default version for *reads* — the baseline a delivery team builds against.
   *  Usually the most recently locked version. */
  currentVersion: z.string().optional(),
  /** Default version for *writes* — the open draft the BA is editing. At most one
   *  draft exists per project. */
  draftVersion: z.string().optional(),
});
export type Config = z.infer<typeof Config>;

// ---------------------------------------------------------------------------
// VcsRef — a recorded reference to a VCS branch or merge request.
// requ-mcp holds NO token and never calls the VCS provider; it only stores
// references that nodes report, for traceability.
// ---------------------------------------------------------------------------

export const VcsRefKind = z.enum(["branch", "mr"]);
export type VcsRefKind = z.infer<typeof VcsRefKind>;

export const VcsRefState = z.enum(["opened", "merged", "closed"]);
export type VcsRefState = z.infer<typeof VcsRefState>;

export const VcsRef = z.object({
  /** Auto-id, e.g. "MR-5" / "BR-1". */
  id: z.string().min(1),
  kind: VcsRefKind,
  /** MR iid as string, or branch name. */
  ref: z.string().min(1),
  url: z.string().default(""),
  branch: z.string().default(""),
  targetBranch: z.string().optional(),
  component: z.string().optional(),
  storyIds: z.array(z.string()).default([]),
  requirementIds: z.array(z.string()).default([]),
  state: VcsRefState.default("opened"),
  mergeCommit: z.string().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type VcsRef = z.infer<typeof VcsRef>;

/** Coverage resolution mode across phases. */
export const CoverageMode = z.enum(["cumulative", "strict"]);
export type CoverageMode = z.infer<typeof CoverageMode>;

// ---------------------------------------------------------------------------
// Export / Import
// ---------------------------------------------------------------------------

export const ExportData = z.object({
  components:   z.array(Component).default([]),
  requirements: z.array(Requirement).default([]),
  stories:      z.array(UserStory).default([]),
  scenarios:    z.array(Scenario).default([]),
  screens:      z.array(Screen).default([]),
  adrs:         z.array(Adr).default([]),
  phases:       z.array(Phase).default([]),
  executions:   z.record(z.array(Execution)).default({}),
  vcsRefs:      z.array(VcsRef).default([]),
});
export type ExportData = z.infer<typeof ExportData>;

export const ExportPayload = z.object({
  /** Payload *format* version — unrelated to the project version below.
   *  "1" is the pre-versioning flat shape; "2" adds the version envelope. */
  version: z.enum(["1", "2"]).default("1"),
  exportedAt: z.string(),
  source: z.object({ name: z.string() }).optional(),
  /** Project version `data` was taken from (format "2"). */
  projectVersion: z.string().optional(),
  /** Version registry included with an `allVersions` export (format "2"). */
  versions: z.array(ProjectVersion).default([]),
  /** The primary snapshot. Always populated, so a format-"1" consumer still works. */
  data: ExportData,
  /** Remaining versions of an `allVersions` export, keyed by version id.
   *  Excludes `projectVersion`, which lives in `data`. */
  versionedData: z.record(ExportData).default({}),
});
export type ExportPayload = z.infer<typeof ExportPayload>;

export type ImportReport = {
  imported: Record<string, number>;
  skipped:  Record<string, string[]>;
  errors:   string[];
};
