/**
 * Shared export/import logic — used by both MCP tools and REST routes.
 */
import type { Store } from "./storage.js";
import type { SqliteStore } from "./sqlite-store.js";
import type { PostgresStore } from "./postgres-store.js";
import type { Execution, ExportPayload, ImportReport } from "./schema.js";

type AnyStore = Store | SqliteStore | PostgresStore;

export async function buildExport(store: AnyStore): Promise<ExportPayload> {
  const [config, components, requirements, stories, scenarios, phases, vcsRefs, executionsByPhase] =
    await Promise.all([
      store.readConfig().catch(() => null),
      store.listComponents(),
      store.listRequirements(),
      store.listStories(),
      store.listScenarios(),
      store.listPhases(),
      store.listVcsRefs(),
      store.readAllExecutions(),
    ]);

  // Convert Map<phaseId, Execution[]> to plain object
  const executions: Record<string, Execution[]> = {};
  for (const [phaseId, runs] of executionsByPhase.entries()) {
    executions[phaseId] = runs;
  }

  return {
    version: "1",
    exportedAt: new Date().toISOString(),
    source: config ? { name: config.name } : undefined,
    data: { components, requirements, stories, scenarios, phases, executions, vcsRefs },
  };
}

export async function applyImport(
  store: AnyStore,
  payload: ExportPayload,
): Promise<ImportReport> {
  const report: ImportReport = {
    imported: {},
    skipped: {},
    errors: [],
  };

  const inc = (key: string) => { report.imported[key] = (report.imported[key] ?? 0) + 1; };
  const skip = (key: string, id: string) => {
    (report.skipped[key] ??= []).push(id);
  };

  // Fetch existing IDs for all entity types in parallel
  const [
    existingComponents,
    existingRequirements,
    existingStories,
    existingPhases,
    existingVcsRefs,
    existingExecutionsByPhase,
  ] = await Promise.all([
    store.listComponents(),
    store.listRequirements(),
    store.listStories(),
    store.listPhases(),
    store.listVcsRefs(),
    store.readAllExecutions(),
  ]);

  const existingComponentIds   = new Set(existingComponents.map(x => x.id));
  const existingRequirementIds = new Set(existingRequirements.map(x => x.id));
  const existingStoryIds       = new Set(existingStories.map(x => x.id));
  const existingPhaseIds       = new Set(existingPhases.map(x => x.id));
  const existingVcsRefIds      = new Set(existingVcsRefs.map(x => x.id));

  const { data } = payload;

  // --- Components ---
  for (const comp of data.components) {
    if (existingComponentIds.has(comp.id)) { skip("components", comp.id); continue; }
    await store.writeComponent(comp);
    existingComponentIds.add(comp.id);
    inc("components");
  }

  // --- Requirements ---
  for (const req of data.requirements) {
    if (existingRequirementIds.has(req.id)) { skip("requirements", req.id); continue; }
    await store.writeRequirement(req);
    existingRequirementIds.add(req.id);
    inc("requirements");
  }

  // --- Stories ---
  for (const story of data.stories) {
    if (existingStoryIds.has(story.id)) { skip("stories", story.id); continue; }
    // FK check: all referenced requirements must exist (in DB or just imported)
    const missingReqs = story.requirements.filter(rid => !existingRequirementIds.has(rid));
    if (missingReqs.length > 0) {
      report.errors.push(
        `Story ${story.id} references unknown requirement(s): ${missingReqs.join(", ")}`
      );
      continue;
    }
    await store.writeStory(story);
    existingStoryIds.add(story.id);
    inc("stories");
  }

  // --- Scenarios ---
  const existingScenarios = await store.listScenarios();
  const existingScenarioKeys = new Set(existingScenarios.map(x => x.testKey));
  for (const sc of data.scenarios) {
    if (existingScenarioKeys.has(sc.testKey)) { skip("scenarios", sc.testKey); continue; }
    const unknown = sc.stories.filter(sid => !existingStoryIds.has(sid));
    if (unknown.length > 0) {
      report.errors.push(`Scenario ${sc.testKey} references unknown story(ies): ${unknown.join(", ")}`);
    }
    await store.writeScenario(sc);
    existingScenarioKeys.add(sc.testKey);
    inc("scenarios");
  }

  // --- Phases ---
  for (const phase of data.phases) {
    if (existingPhaseIds.has(phase.id)) { skip("phases", phase.id); continue; }
    await store.writePhase(phase);
    existingPhaseIds.add(phase.id);
    inc("phases");
  }

  // --- Executions (keyed by phaseId) ---
  for (const [phaseId, runs] of Object.entries(data.executions)) {
    if (!existingPhaseIds.has(phaseId)) {
      report.errors.push(
        `Executions reference unknown phase "${phaseId}" — skipped ${runs.length} execution(s)`
      );
      continue;
    }
    // Build a set of existing execution keys for this phase to avoid duplicates
    const existingForPhase = existingExecutionsByPhase.get(phaseId) ?? [];
    const existingKeys = new Set(existingForPhase.map(e => `${e.feature}::${e.name}`));
    const newRuns = runs.filter(e => !existingKeys.has(`${e.feature}::${e.name}`));
    const skippedCount = runs.length - newRuns.length;
    if (skippedCount > 0) {
      (report.skipped["executions"] ??= []).push(
        ...runs
          .filter(e => existingKeys.has(`${e.feature}::${e.name}`))
          .map(e => `${phaseId}::${e.feature}::${e.name}`)
      );
    }
    if (newRuns.length > 0) {
      await store.appendExecutions(phaseId, newRuns);
      report.imported["executions"] = (report.imported["executions"] ?? 0) + newRuns.length;
    }
  }

  // --- VCS Refs ---
  for (const ref of data.vcsRefs) {
    if (existingVcsRefIds.has(ref.id)) { skip("vcsRefs", ref.id); continue; }
    await store.writeVcsRef(ref);
    existingVcsRefIds.add(ref.id);
    inc("vcsRefs");
  }

  return report;
}
