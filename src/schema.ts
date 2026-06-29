import { z } from "zod";

/**
 * The requ-mcp data model.
 *
 * Traceability spine:
 *   Component ← Requirement → User Story → (acceptance criteria)
 *                                ↑
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
  /** NOTE: a story has no phase of its own. Its phase scope is derived from the
   *  phases of the requirements it traces to (see `storyInScope` in coverage.ts).
   *  This keeps requirement phase as the single source of truth — no drift. */
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
// Project config
// ---------------------------------------------------------------------------

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
  vcsType: z.enum(["gitlab"]).optional(),
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

export const ExportPayload = z.object({
  version: z.literal("1"),
  exportedAt: z.string(),
  source: z.object({ name: z.string() }).optional(),
  data: z.object({
    components:   z.array(Component).default([]),
    requirements: z.array(Requirement).default([]),
    stories:      z.array(UserStory).default([]),
    scenarios:    z.array(Scenario).default([]),
    phases:       z.array(Phase).default([]),
    executions:   z.record(z.array(Execution)).default({}),
    vcsRefs:      z.array(VcsRef).default([]),
  }),
});
export type ExportPayload = z.infer<typeof ExportPayload>;

export type ImportReport = {
  imported: Record<string, number>;
  skipped:  Record<string, string[]>;
  errors:   string[];
};
