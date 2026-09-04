/**
 * Coverage carry-over between specification versions.
 *
 * When a baseline is re-versioned, most of it is copied unchanged. Forcing the
 * team to re-run every test against the new version would be busywork, so a test
 * result recorded against an ancestor version still counts — but only for the
 * stories whose *specification* is byte-identical along the whole ancestor chain.
 * The moment a story's frozen fields change, its old results stop counting and
 * the scenario shows as untested again, which is the honest answer.
 *
 * "Unchanged" reuses the freeze matrix: a story is unchanged when every field
 * that a lock would freeze is equal. Progress fields (status) are ignored,
 * because a status change is not a change of scope.
 */

import { MUTABLE_WHILE_LOCKED } from "./versioning.js";
import { indexConductor } from "./conductor.js";
import type { UserStory, Execution, Scenario, ProjectVersion } from "./schema.js";

/** Stable serialisation of a story's specification, ignoring progress fields. */
export function storyFingerprint(story: Record<string, unknown>): string {
  const skip = new Set([...MUTABLE_WHILE_LOCKED.stories, "createdAt", "updatedAt", "removed"]);
  const keys = Object.keys(story).filter((k) => !skip.has(k)).sort();
  return JSON.stringify(keys.map((k) => [k, story[k]]));
}

/**
 * Ancestor chain of `version`, newest first, following `parent` links.
 * Stops on an unknown parent or a cycle, so malformed history degrades to
 * "no carry-over" rather than looping.
 */
export function ancestorChain(versions: ProjectVersion[], version: string): string[] {
  const byId = new Map(versions.map((v) => [v.version, v]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = version;
  while (cursor && byId.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    cursor = byId.get(cursor)!.parent;
  }
  // A version absent from the registry is still the version we are reporting on.
  if (!chain.length) chain.push(version);
  return chain;
}

export type AcceptedVersions = Map<string, Set<string>>;

/**
 * For each story in the target version, the set of versions whose executions
 * still count for it: the target itself plus every contiguous ancestor in which
 * the story existed with an identical specification.
 *
 * `storiesByVersion` must contain an entry for each version in `chain`.
 */
export function acceptedVersionsByStory(
  chain: string[],
  storiesByVersion: Map<string, UserStory[]>,
): AcceptedVersions {
  const target = chain[0];
  const fingerprints = new Map<string, Map<string, string>>();
  for (const v of chain) {
    const m = new Map<string, string>();
    for (const s of storiesByVersion.get(v) ?? []) m.set(s.id, storyFingerprint(s as never));
    fingerprints.set(v, m);
  }

  const out: AcceptedVersions = new Map();
  for (const [id, fp] of fingerprints.get(target) ?? new Map()) {
    const accepted = new Set<string>([target]);
    for (const ancestor of chain.slice(1)) {
      // Contiguity matters: a story that changed in v2 and was reverted in v3
      // must not silently reclaim its v1 results.
      if (fingerprints.get(ancestor)?.get(id) !== fp) break;
      accepted.add(ancestor);
    }
    out.set(id, accepted);
  }
  return out;
}

/**
 * Drop executions that belong to a version whose specification has since moved on.
 *
 * An execution with no version predates versioning and always counts. An
 * execution whose scenario maps to no story cannot be judged stale, so it is
 * kept — coverage would otherwise lose ad-hoc results.
 */
export function filterCarriedOver(
  executionsByPhase: Map<string, Execution[]>,
  scenarios: Array<{ feature: string; name: string; stories?: string[] }>,
  accepted: AcceptedVersions,
  targetVersion: string,
): Map<string, Execution[]> {
  const storiesByTestKey = new Map<string, string[]>();
  for (const sc of scenarios) storiesByTestKey.set(`${sc.feature}::${sc.name}`, sc.stories ?? []);

  const keep = (e: Execution): boolean => {
    if (!e.version || e.version === targetVersion) return true;
    const stories = storiesByTestKey.get(`${e.feature}::${e.name}`);
    if (!stories || stories.length === 0) return true;
    // One story still vouching for the result is enough: the scenario was run
    // against a specification that is still current for that story.
    return stories.some((id) => accepted.get(id)?.has(e.version!));
  };

  const out = new Map<string, Execution[]>();
  for (const [phase, runs] of executionsByPhase) out.set(phase, runs.filter(keep));
  return out;
}

/** Minimal store surface the carry-over pass needs, kept structural to avoid a cycle. */
type CarryOverStore = {
  version(): Promise<string>;
  listVersions(): Promise<ProjectVersion[]>;
  listScenarios(): Promise<Scenario[]>;
  conductorRoot(): Promise<string>;
  at(version: string): { listStories(opts?: { includeRemoved?: boolean }): Promise<UserStory[]> };
};

/**
 * Scenario → story links, from the store when scenarios have been generated and
 * from the feature files otherwise. Mirrors `resolveScenariosByStory` in
 * coverage.ts, which resolves the same two sources in the same order.
 */
async function scenarioLinks(store: CarryOverStore) {
  const stored = await store.listScenarios();
  if (stored.length > 0) return stored;
  try {
    return (await indexConductor(await store.conductorRoot())).scenarios;
  } catch {
    return [];
  }
}

/**
 * Apply the carry-over rule to a phase→executions map read from a store.
 *
 * Called from `readAllExecutions` in both stores, so every consumer — coverage,
 * gaps, trends, the REST API and the dashboard — sees the same filtered view
 * without a second code path. A project with a single version short-circuits.
 */
export async function applyCarryOver(
  store: CarryOverStore,
  executionsByPhase: Map<string, Execution[]>,
): Promise<Map<string, Execution[]>> {
  const versions = await store.listVersions();
  if (versions.length <= 1) return executionsByPhase;

  const target = await store.version();
  const chain = ancestorChain(versions, target);
  if (chain.length <= 1) return executionsByPhase;

  const storiesByVersion = new Map<string, UserStory[]>();
  for (const v of chain) {
    storiesByVersion.set(v, await store.at(v).listStories({ includeRemoved: true }));
  }
  const accepted = acceptedVersionsByStory(chain, storiesByVersion);
  return filterCarriedOver(executionsByPhase, await scenarioLinks(store), accepted, target);
}
