import {
  testKey,
  type CoverageMode,
  type Execution,
  type Phase,
  type Requirement,
  type TestStatus,
  type UserStory,
  type VcsRef,
} from "./schema.js";
import type { ConductorScenario } from "./conductor.js";

/**
 * Phase-aware, story-level coverage rollup.
 *
 * Links are derived from `@US-xxx` scenario tags (see conductor.ts), so a story
 * owns the scenarios tagged with its id. A test's result is resolved from the
 * Executions recorded against a phase:
 *
 *   strict      — only executions recorded *in* the target phase count.
 *   cumulative  — the latest known result as of the target phase (carried
 *                 forward from earlier phases, by phase order then ranAt).
 *
 * Coverage rules (story-level):
 *   - A story is COVERED when it has ≥1 tagged scenario and all of them pass.
 *   - A requirement is VERIFIED when it has ≥1 story and all its stories are
 *     covered.
 * Acceptance criteria are descriptive and do not affect coverage.
 */

export type StatusMap = Map<string, TestStatus>;
export type ScenariosByStory = Map<string, ConductorScenario[]>;

/**
 * Whether a requirement/story is in scope for a phase report.
 *
 * Mirrors the execution cumulative/strict model:
 *   - unassigned (no phase) → always in scope (backward-compatible),
 *   - strict     → only items assigned to the target phase,
 *   - cumulative → items assigned to the target phase or any earlier phase.
 * An item whose phase id is unknown (not in `phases`) is treated as unassigned.
 */
export function inScope(
  itemPhase: string | undefined,
  targetPhaseId: string | null,
  phases: Phase[],
  mode: CoverageMode,
): boolean {
  if (!itemPhase) return true;
  if (!targetPhaseId) return true;
  if (mode === "strict") return itemPhase === targetPhaseId;
  const itemOrder = phases.find((p) => p.id === itemPhase)?.order;
  const targetOrder = phases.find((p) => p.id === targetPhaseId)?.order;
  if (itemOrder === undefined || targetOrder === undefined) return true;
  return itemOrder <= targetOrder;
}

export function resolveStatuses(
  executionsByPhase: Map<string, Execution[]>,
  phases: Phase[],
  targetPhaseId: string | null,
  mode: CoverageMode,
): StatusMap {
  const out: StatusMap = new Map();
  if (!targetPhaseId) return out;
  const target = phases.find((p) => p.id === targetPhaseId);
  if (!target) return out;

  const feeding =
    mode === "strict"
      ? [target]
      : phases.filter((p) => p.order <= target.order).sort((a, b) => a.order - b.order);

  for (const phase of feeding) {
    const runs = [...(executionsByPhase.get(phase.id) ?? [])].sort((a, b) =>
      a.ranAt < b.ranAt ? -1 : a.ranAt > b.ranAt ? 1 : 0,
    );
    for (const run of runs) out.set(testKey(run), run.status); // newer overwrites
  }
  return out;
}

export interface ScenarioCoverage {
  feature: string;
  name: string;
  status: TestStatus;
}

export interface StoryCoverage {
  id: string;
  title: string;
  status: string;
  requirements: string[];
  scenarios: ScenarioCoverage[];
  passing: number;
  failing: number;
  pending: number;
  /** Has ≥1 tagged scenario. */
  tested: boolean;
  /** Covered = tested AND every tagged scenario passes. */
  covered: boolean;
  /**
   * Merged-MR is a SEPARATE dimension from `covered` (it does not affect it):
   * the merge-request VcsRef (kind="mr") referencing this story, preferring a
   * state="merged" ref. Optional / backward-compatible.
   */
  mergedMr?: { ref: string; state: string; url: string };
}

/** Build a story-id → best MR reference map (prefers a merged MR). */
function mergedMrByStory(vcsRefs: VcsRef[]): Map<string, { ref: string; state: string; url: string }> {
  const out = new Map<string, { ref: string; state: string; url: string }>();
  const mrs = vcsRefs.filter((r) => r.kind === "mr");
  for (const mr of mrs) {
    for (const storyId of mr.storyIds) {
      const current = out.get(storyId);
      // Prefer a merged ref; otherwise keep the first seen.
      if (!current || (current.state !== "merged" && mr.state === "merged")) {
        out.set(storyId, { ref: mr.ref, state: mr.state, url: mr.url });
      }
    }
  }
  return out;
}

export interface RequirementCoverage {
  id: string;
  title: string;
  priority: string;
  status: string;
  components: string[];
  storyIds: string[];
  hasStory: boolean;
  verified: boolean;
}

export interface ComponentCoverage {
  component: string;
  requirements: number;
  withStory: number;
  verified: number;
  verifiedPct: number;
}

export interface CoverageSummary {
  requirementsTotal: number;
  requirementsWithStory: number;
  requirementsVerified: number;
  storiesTotal: number;
  storiesTested: number;
  storiesCovered: number;
  scenariosLinked: number;
  scenariosPassing: number;
  storyCoveragePct: number;
  verifiedPct: number;
  testedStoryCoveragePct: number;
}

export interface CoverageReport {
  phase: string | null;
  mode: CoverageMode;
  requirements: RequirementCoverage[];
  stories: StoryCoverage[];
  byComponent: ComponentCoverage[];
  summary: CoverageSummary;
}

function pct(num: number, den: number): number {
  return den === 0 ? 0 : Math.round((num / den) * 1000) / 10;
}

export function computeStoryCoverage(
  story: UserStory,
  scenariosByStory: ScenariosByStory,
  status: StatusMap,
  mergedMr?: { ref: string; state: string; url: string },
): StoryCoverage {
  const scs = scenariosByStory.get(story.id) ?? [];
  let passing = 0;
  let failing = 0;
  let pending = 0;
  const scenarios: ScenarioCoverage[] = scs.map((sc) => {
    const s = status.get(testKey(sc)) ?? "pending";
    if (s === "pass") passing++;
    else if (s === "fail") failing++;
    else pending++;
    return { feature: sc.feature, name: sc.name, status: s };
  });
  return {
    id: story.id,
    title: story.title,
    status: story.status,
    requirements: story.requirements,
    scenarios,
    passing,
    failing,
    pending,
    tested: scs.length > 0,
    covered: scs.length > 0 && passing === scs.length,
    ...(mergedMr ? { mergedMr } : {}),
  };
}

export function buildReport(
  requirements: Requirement[],
  stories: UserStory[],
  scenariosByStory: ScenariosByStory,
  status: StatusMap,
  phaseId: string | null,
  mode: CoverageMode,
  vcsRefs: VcsRef[] = [],
  phases: Phase[] = [],
): CoverageReport {
  // Scope to the items planned for this phase (unassigned items always count).
  requirements = requirements.filter((r) => inScope(r.phase, phaseId, phases, mode));
  stories = stories.filter((s) => inScope(s.phase, phaseId, phases, mode));

  const mrByStory = mergedMrByStory(vcsRefs);
  const storyCov = stories.map((s) => computeStoryCoverage(s, scenariosByStory, status, mrByStory.get(s.id)));
  const storyById = new Map(storyCov.map((s) => [s.id, s]));

  const storiesByReq = new Map<string, string[]>();
  for (const s of stories) {
    for (const reqId of s.requirements) {
      const arr = storiesByReq.get(reqId) ?? [];
      arr.push(s.id);
      storiesByReq.set(reqId, arr);
    }
  }

  const reqCov: RequirementCoverage[] = requirements.map((r) => {
    const storyIds = storiesByReq.get(r.id) ?? [];
    const linked = storyIds.map((id) => storyById.get(id)!).filter(Boolean);
    return {
      id: r.id,
      title: r.title,
      priority: r.priority,
      status: r.status,
      components: r.components,
      storyIds,
      hasStory: storyIds.length > 0,
      verified: linked.length > 0 && linked.every((s) => s.covered),
    };
  });

  const activeReqs = reqCov.filter((r) => r.status === "active");
  const withStory = activeReqs.filter((r) => r.hasStory).length;
  const verified = activeReqs.filter((r) => r.verified).length;
  const storiesTested = storyCov.filter((s) => s.tested).length;
  const storiesCovered = storyCov.filter((s) => s.covered).length;
  const scenariosLinked = storyCov.reduce((n, s) => n + s.scenarios.length, 0);
  const scenariosPassing = storyCov.reduce((n, s) => n + s.passing, 0);

  const compMap = new Map<string, { reqs: number; withStory: number; verified: number }>();
  for (const r of activeReqs) {
    const comps = r.components.length ? r.components : ["(unassigned)"];
    for (const c of comps) {
      const e = compMap.get(c) ?? { reqs: 0, withStory: 0, verified: 0 };
      e.reqs++;
      if (r.hasStory) e.withStory++;
      if (r.verified) e.verified++;
      compMap.set(c, e);
    }
  }
  const byComponent: ComponentCoverage[] = [...compMap.entries()]
    .map(([component, e]) => ({
      component,
      requirements: e.reqs,
      withStory: e.withStory,
      verified: e.verified,
      verifiedPct: pct(e.verified, e.reqs),
    }))
    .sort((a, b) => a.component.localeCompare(b.component));

  return {
    phase: phaseId,
    mode,
    requirements: reqCov,
    stories: storyCov,
    byComponent,
    summary: {
      requirementsTotal: activeReqs.length,
      requirementsWithStory: withStory,
      requirementsVerified: verified,
      storiesTotal: storyCov.length,
      storiesTested,
      storiesCovered,
      scenariosLinked,
      scenariosPassing,
      storyCoveragePct: pct(withStory, activeReqs.length),
      verifiedPct: pct(verified, activeReqs.length),
      testedStoryCoveragePct: pct(storiesCovered, storyCov.length),
    },
  };
}

export interface TrendPoint {
  phase: string;
  phaseName: string;
  order: number;
  summary: CoverageSummary;
}

export function buildTrend(
  requirements: Requirement[],
  stories: UserStory[],
  scenariosByStory: ScenariosByStory,
  executionsByPhase: Map<string, Execution[]>,
  phases: Phase[],
  mode: CoverageMode,
): TrendPoint[] {
  return [...phases]
    .sort((a, b) => a.order - b.order)
    .map((p) => {
      const status = resolveStatuses(executionsByPhase, phases, p.id, mode);
      const report = buildReport(requirements, stories, scenariosByStory, status, p.id, mode, [], phases);
      return { phase: p.id, phaseName: p.name, order: p.order, summary: report.summary };
    });
}

export interface Gaps {
  phase: string | null;
  mode: CoverageMode;
  requirementsWithoutStory: { id: string; title: string; priority: string; components: string[] }[];
  storiesWithoutScenario: { id: string; title: string }[];
  storiesNotCovered: {
    id: string;
    title: string;
    failing: string[];
    pending: string[];
  }[];
}

export function findGaps(
  requirements: Requirement[],
  stories: UserStory[],
  scenariosByStory: ScenariosByStory,
  status: StatusMap,
  phaseId: string | null,
  mode: CoverageMode,
  phases: Phase[] = [],
): Gaps {
  const report = buildReport(requirements, stories, scenariosByStory, status, phaseId, mode, [], phases);

  const requirementsWithoutStory = report.requirements
    .filter((r) => r.status === "active" && !r.hasStory)
    .map((r) => ({ id: r.id, title: r.title, priority: r.priority, components: r.components }));

  const storiesWithoutScenario: Gaps["storiesWithoutScenario"] = [];
  const storiesNotCovered: Gaps["storiesNotCovered"] = [];

  for (const s of report.stories) {
    if (!s.tested) {
      storiesWithoutScenario.push({ id: s.id, title: s.title });
      continue;
    }
    if (!s.covered) {
      storiesNotCovered.push({
        id: s.id,
        title: s.title,
        failing: s.scenarios.filter((x) => x.status === "fail").map((x) => x.name),
        pending: s.scenarios.filter((x) => x.status === "pending").map((x) => x.name),
      });
    }
  }

  return { phase: phaseId, mode, requirementsWithoutStory, storiesWithoutScenario, storiesNotCovered };
}
