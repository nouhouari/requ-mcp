import {
  testKey,
  type CoverageMode,
  type Execution,
  type Phase,
  type Requirement,
  type Scenario,
  type TestStatus,
  type UserStory,
  type VcsRef,
} from "./schema.js";
import { indexConductor, scenariosByStory } from "./conductor.js";
import { matchTags } from "./tags.js";

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
/** A scenario as far as coverage cares: just its test identity. Both stored
 *  Scenario rows and disk-derived ConductorScenario satisfy this. */
export type ScenarioRef = { feature: string; name: string };
export type ScenariosByStory = Map<string, ScenarioRef[]>;

/** Minimal store surface needed to resolve scenarios (stored or disk fallback). */
export interface ScenarioStore {
  listScenarios(): Promise<Scenario[]>;
  conductorRoot(): Promise<string>;
}

/** Group stored scenarios by the story ids they link to. */
export function groupByStory(scenarios: Scenario[]): Map<string, Scenario[]> {
  const map = new Map<string, Scenario[]>();
  for (const sc of scenarios) {
    for (const story of sc.stories) {
      const arr = map.get(story) ?? [];
      arr.push(sc);
      map.set(story, arr);
    }
  }
  return map;
}

/**
 * Resolve the story→scenarios map for coverage. Stored scenarios are authoritative
 * when present; otherwise fall back to scanning disk feature files (legacy). When
 * neither is available, returns an empty map.
 */
export async function resolveScenariosByStory(store: ScenarioStore): Promise<ScenariosByStory> {
  const out: ScenariosByStory = new Map();
  const stored = await store.listScenarios();
  if (stored.length > 0) {
    for (const [k, v] of groupByStory(stored)) out.set(k, v);
    return out;
  }
  try {
    const index = await indexConductor(await store.conductorRoot());
    for (const [k, v] of scenariosByStory(index)) out.set(k, v);
  } catch {
    /* no disk, no stored → empty */
  }
  return out;
}

/** Filter applied identically by the MCP `list_scenarios` tool and the REST API. */
export interface ScenarioFilter {
  /** Story ids; a scenario matches if any of its stories is listed. */
  story?: string[];
  /** Requirement ids; resolved to stories, then matched like `story`. */
  requirement?: string[];
  /** Phase id; restricts to scenarios whose linked story is in scope for the phase. */
  phase?: string;
  mode?: CoverageMode;
  feature?: string;
  q?: string;
  valid?: boolean;
  /** Cucumber tag expression. Throws if malformed. */
  tags?: string;
}

/**
 * Filter stored scenarios by story/requirement/phase/feature/tags. Requirement and
 * phase filters are resolved against `requirements`/`stories`/`phases` here so the
 * MCP tool and the web API share one implementation (parity). A story has no phase
 * of its own — phase scope is derived from its requirements' phases.
 */
export function filterScenarios(
  scenarios: Scenario[],
  stories: UserStory[],
  phases: Phase[],
  requirements: Requirement[],
  filter: ScenarioFilter,
): Scenario[] {
  // Requirement → set of story ids tracing to it.
  let requirementStoryIds: Set<string> | null = null;
  if (filter.requirement?.length) {
    const reqs = new Set(filter.requirement);
    requirementStoryIds = new Set(
      stories.filter((s) => s.requirements.some((r) => reqs.has(r))).map((s) => s.id),
    );
  }

  // Phase → set of in-scope story ids, resolved through each story's requirements.
  let phaseStoryIds: Set<string> | null = null;
  if (filter.phase) {
    const mode = filter.mode ?? "cumulative";
    const reqPhaseById = requirementPhaseMap(requirements);
    phaseStoryIds = new Set(
      stories.filter((s) => storyInScope(s, filter.phase!, reqPhaseById, phases, mode)).map((s) => s.id),
    );
  }

  const storySet = filter.story?.length ? new Set(filter.story) : null;
  const q = filter.q?.toLowerCase();

  return scenarios.filter((sc) => {
    if (storySet && !sc.stories.some((id) => storySet.has(id))) return false;
    if (requirementStoryIds && !sc.stories.some((id) => requirementStoryIds!.has(id))) return false;
    if (phaseStoryIds && !sc.stories.some((id) => phaseStoryIds!.has(id))) return false;
    if (filter.feature && sc.feature !== filter.feature) return false;
    if (filter.valid !== undefined && sc.valid !== filter.valid) return false;
    if (q && !(`${sc.name}\n${sc.feature}\n${sc.content}`.toLowerCase().includes(q))) return false;
    if (filter.tags && !matchTags(filter.tags, sc.tags)) return false;
    return true;
  });
}

/** Requirement ids a stored scenario traces to (via its linked stories). */
export function requirementIdsForScenario(sc: Scenario, storyById: Map<string, UserStory>): string[] {
  const out = new Set<string>();
  for (const id of sc.stories) {
    const s = storyById.get(id);
    if (s) for (const r of s.requirements) out.add(r);
  }
  return [...out];
}

/**
 * Whether a requirement/story is in scope for a phase report.
 *
 *   - no phase selected (targetPhaseId null) → everything is in scope,
 *     including unassigned items ("All phases" view),
 *   - a phase IS selected → unassigned items are OUT of scope, so the filter
 *     narrows to items that actually belong to the phase (or an earlier one),
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
  if (!targetPhaseId) return true; // "All phases" → everything, incl. unassigned
  if (!itemPhase) return false; // a phase is selected → exclude unassigned items
  if (mode === "strict") return itemPhase === targetPhaseId;
  const targetOrder = phases.find((p) => p.id === targetPhaseId)?.order;
  if (targetOrder === undefined) return true; // unknown target phase → stay permissive
  const itemOrder = phases.find((p) => p.id === itemPhase)?.order;
  if (itemOrder === undefined) return false; // unknown item phase ≈ unassigned → exclude
  return itemOrder <= targetOrder;
}

/** requirement id → its assigned target phase (undefined when unassigned). */
export function requirementPhaseMap(requirements: Requirement[]): Map<string, string | undefined> {
  return new Map(requirements.map((r) => [r.id, r.phase]));
}

/** Distinct target phases a story belongs to, derived from its requirements. */
export function storyPhases(
  story: UserStory,
  reqPhaseById: Map<string, string | undefined>,
): string[] {
  const out: string[] = [];
  for (const rid of story.requirements) {
    const p = reqPhaseById.get(rid);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Whether a story is in scope for a phase report. A story has no phase of its own;
 * it inherits scope from the requirements it traces to. It is in scope when ANY
 * linked requirement is in scope for the target phase (so a story spanning phases
 * counts from its earliest requirement onward under cumulative).
 */
export function storyInScope(
  story: UserStory,
  targetPhaseId: string | null,
  reqPhaseById: Map<string, string | undefined>,
  phases: Phase[],
  mode: CoverageMode,
): boolean {
  if (!targetPhaseId) return true; // "All phases" → everything, incl. unassigned
  return story.requirements.some((rid) => inScope(reqPhaseById.get(rid), targetPhaseId, phases, mode));
}

/** Raw count of requirements/stories/scenarios attributed to one phase. */
export interface PhaseCount {
  /** Phase id; "" for the Unassigned bucket. */
  phase: string;
  /** Display label; "Unassigned" for the "" bucket. */
  phaseName: string;
  /** Sort key (Unassigned sorts last). */
  order: number;
  requirements: number;
  stories: number;
  scenarios: number;
}

/**
 * Partition raw counts of requirements, stories and scenarios across phases.
 *
 * Each item is counted EXACTLY ONCE, in the earliest phase its requirements
 * touch, so the per-phase rows sum to the totals (requirements.length /
 * stories.length / scenarios.length):
 *   - a requirement → its own assigned phase (or Unassigned),
 *   - a story → the earliest phase among its requirements' phases,
 *   - a scenario → the earliest phase among its linked stories' phases.
 * Items with no known phase (and orphan scenarios with no story) fall into the
 * Unassigned bucket, which is always returned (0 when empty) and sorts last.
 */
export function countsByPhase(
  requirements: Requirement[],
  stories: UserStory[],
  scenarios: Scenario[],
  phases: Phase[],
): PhaseCount[] {
  const orderById = new Map(phases.map((p) => [p.id, p.order]));
  const reqPhaseById = requirementPhaseMap(requirements);
  const storyById = new Map(stories.map((s) => [s.id, s]));

  // The earliest (lowest-order) known phase among the candidates, else "".
  const earliest = (ids: string[]): string => {
    let best = "";
    let bestOrder = Infinity;
    for (const id of ids) {
      const o = orderById.get(id);
      if (o === undefined) continue; // unknown phase ≈ unassigned
      if (o < bestOrder) { bestOrder = o; best = id; }
    }
    return best;
  };

  type Bucket = { requirements: number; stories: number; scenarios: number };
  const buckets = new Map<string, Bucket>();
  const bucket = (key: string): Bucket => {
    let b = buckets.get(key);
    if (!b) { b = { requirements: 0, stories: 0, scenarios: 0 }; buckets.set(key, b); }
    return b;
  };
  // Pre-seed every phase + Unassigned so empty rows still appear.
  for (const p of phases) bucket(p.id);
  bucket("");

  for (const r of requirements) {
    bucket(r.phase && orderById.has(r.phase) ? r.phase : "").requirements++;
  }
  for (const s of stories) {
    bucket(earliest(storyPhases(s, reqPhaseById))).stories++;
  }
  for (const sc of scenarios) {
    const phaseIds: string[] = [];
    for (const sid of sc.stories) {
      const s = storyById.get(sid);
      if (s) for (const p of storyPhases(s, reqPhaseById)) phaseIds.push(p);
    }
    bucket(earliest(phaseIds)).scenarios++;
  }

  const maxOrder = phases.reduce((m, p) => Math.max(m, p.order), 0);
  const rows: PhaseCount[] = phases
    .map((p) => ({ phase: p.id, phaseName: p.name || p.id, order: p.order, ...bucket(p.id) }))
    .sort((a, b) => a.order - b.order);
  rows.push({ phase: "", phaseName: "Unassigned", order: maxOrder + 1, ...bucket("") });
  return rows;
}

export function resolveStatuses(
  executionsByPhase: Map<string, Execution[]>,
  phases: Phase[],
  targetPhaseId: string | null,
  mode: CoverageMode,
): StatusMap {
  const out: StatusMap = new Map();
  // "All phases" (no target): latest status per scenario across every phase.
  let feeding: Phase[];
  if (!targetPhaseId) {
    feeding = [...phases].sort((a, b) => a.order - b.order);
  } else {
    const target = phases.find((p) => p.id === targetPhaseId);
    if (!target) return out;
    feeding =
      mode === "strict"
        ? [target]
        : phases.filter((p) => p.order <= target.order).sort((a, b) => a.order - b.order);
  }

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
  // A story's phase is derived from its requirements, so resolve the requirement
  // phase map from the FULL list before narrowing `requirements` itself.
  const reqPhaseById = requirementPhaseMap(requirements);
  requirements = requirements.filter((r) => inScope(r.phase, phaseId, phases, mode));
  stories = stories.filter((s) => storyInScope(s, phaseId, reqPhaseById, phases, mode));

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
