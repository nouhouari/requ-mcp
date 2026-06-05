import { z } from "zod";

/**
 * The requ-mcp data model.
 *
 * Traceability spine:
 *   Requirement → User Story → Acceptance Criterion → TestLink ──┐
 *                                                                 │ (resolved per phase)
 *   Phase → Execution (test result for a given run) ─────────────┘
 *
 * A TestLink is pure intent ("this Conductor test verifies this criterion").
 * Results are Executions owned by a Phase, so coverage is computed *per phase*
 * and its evolution can be tracked across releases.
 *
 * Everything is persisted as flat YAML in `.requ/`.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export const Priority = z.enum(["low", "medium", "high", "critical"]);
export type Priority = z.infer<typeof Priority>;

/** ISO-8601 timestamp string. */
export const Timestamp = z.string();

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
  /** Sub-systems / modules this requirement belongs to (used to slice coverage). */
  components: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  status: RequirementStatus.default("active"),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Requirement = z.infer<typeof Requirement>;

// ---------------------------------------------------------------------------
// Conductor test identity (shared by TestLink and Execution)
// ---------------------------------------------------------------------------

export const TestStatus = z.enum(["pass", "fail", "pending"]);
export type TestStatus = z.infer<typeof TestStatus>;

/**
 * Identity of a Conductor test = a cucumber scenario, addressed by its feature
 * name + scenario name. Maestro flows run through cucumber step definitions and
 * appear in the report as scenarios too, so this is the single unit of linkage.
 *
 * Scenario → story links are NOT stored here. They live in the feature files as
 * `@US-xxx` tags and are derived by scanning the Conductor project (see
 * conductor.ts). Executions reference scenarios by this identity.
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

// ---------------------------------------------------------------------------
// Acceptance Criterion — descriptive PO content (not individually tested)
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
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type UserStory = z.infer<typeof UserStory>;

// ---------------------------------------------------------------------------
// Phase / Release — the dimension coverage evolves along
// ---------------------------------------------------------------------------

export const PhaseStatus = z.enum(["planned", "active", "completed"]);
export type PhaseStatus = z.infer<typeof PhaseStatus>;

export const Phase = z.object({
  id: z.string().regex(/^PHASE-\d+$/, "id must look like PHASE-001"),
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

/** Per-phase execution log file shape. */
export const ExecutionLog = z.object({
  phase: z.string().regex(/^PHASE-\d+$/),
  runs: z.array(Execution).default([]),
});
export type ExecutionLog = z.infer<typeof ExecutionLog>;

// ---------------------------------------------------------------------------
// Project config
// ---------------------------------------------------------------------------

export const Config = z.object({
  name: z.string().default("requ project"),
  /**
   * Path to the Conductor project root (dir containing features/ and flows/).
   * Absolute, or relative to the .requ/ parent (the repo root).
   */
  conductorPath: z.string().default("."),
  /** Default path to Conductor's cucumber-json result file (for import). */
  conductorReportPath: z.string().optional(),
  /** The phase new executions are recorded against by default. */
  activePhase: z.string().regex(/^PHASE-\d+$/).optional(),
});
export type Config = z.infer<typeof Config>;

/** Coverage resolution mode across phases. */
export const CoverageMode = z.enum(["cumulative", "strict"]);
export type CoverageMode = z.infer<typeof CoverageMode>;
