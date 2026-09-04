/**
 * Shared export/import logic — used by both MCP tools and REST routes.
 */
import type { SqliteStore } from "./sqlite-store.js";
import type { PostgresStore } from "./postgres-store.js";
import type { Execution, ExportData, ExportPayload, ImportReport } from "./schema.js";

type AnyStore = SqliteStore | PostgresStore;

/** Everything in one version, plus the shared (tagged) scenarios and VCS links. */
async function snapshot(store: AnyStore): Promise<ExportData> {
  const [components, requirements, stories, scenarios, screens, adrs, phases, vcsRefs, executionsByPhase] =
    await Promise.all([
      store.listComponents(),
      store.listRequirements(),
      store.listStories(),
      store.listScenarios(),
      store.listScreens(),
      store.listAdrs(),
      store.listPhases(),
      store.listVcsRefs(),
      store.readAllExecutions({ carryOver: false }),
    ]);

  const executions: Record<string, Execution[]> = {};
  for (const [phaseId, runs] of executionsByPhase.entries()) executions[phaseId] = runs;

  return { components, requirements, stories, scenarios, screens, adrs, phases, executions, vcsRefs };
}

/**
 * Export one version by default — the one the store is bound to — because that
 * is the baseline a consumer asked about. `allVersions` adds the registry and
 * every other version under `versionedData`, so the whole history round-trips.
 *
 * `data` is always the primary snapshot, so a reader that predates versioning
 * keeps working against a format-"2" payload.
 */
export async function buildExport(
  store: AnyStore,
  opts: { allVersions?: boolean } = {},
): Promise<ExportPayload> {
  const config = await store.readConfig().catch(() => null);
  const projectVersion = await store.version();
  const data = await snapshot(store);

  const base = {
    exportedAt: new Date().toISOString(),
    source: config ? { name: config.name } : undefined,
    projectVersion,
    data,
  };

  if (!opts.allVersions) {
    return { ...base, version: "2" as const, versions: [], versionedData: {} };
  }

  const versions = await store.listVersions();
  const versionedData: Record<string, ExportData> = {};
  for (const v of versions) {
    if (v.version === projectVersion) continue;
    versionedData[v.version] = await snapshot(store.at(v.version) as AnyStore);
  }
  return { ...base, version: "2" as const, versions, versionedData };
}

/**
 * Import a payload.
 *
 * A format-"2" payload carrying a version registry restores the whole history:
 * each version is registered as a draft, filled, and only then set to its
 * recorded status — otherwise the lock guard would reject the very rows that
 * define the locked baseline. Everything else imports into the version the
 * store is bound to, which is what a single-version payload means.
 */
export async function applyImport(
  store: AnyStore,
  payload: ExportPayload,
  opts: { allVersions?: boolean; force?: boolean } = {},
): Promise<ImportReport> {
  const restoreHistory =
    opts.allVersions !== false && payload.version === "2" && payload.versions.length > 0;

  if (!restoreHistory) return importSnapshot(store, payload.data);

  const merged: ImportReport = { imported: {}, skipped: {}, errors: [] };
  const mergeInto = (r: ImportReport, prefix: string) => {
    for (const [k, n] of Object.entries(r.imported)) merged.imported[k] = (merged.imported[k] ?? 0) + n;
    for (const [k, ids] of Object.entries(r.skipped)) (merged.skipped[k] ??= []).push(...ids);
    merged.errors.push(...r.errors.map((e) => `[${prefix}] ${e}`));
  };

  const primary = payload.projectVersion;
  for (const v of payload.versions) {
    const existing = await store.getVersion(v.version);

    // A locked version already present in the target is a baseline someone is
    // building against. Importing into it would both mutate frozen scope and,
    // via the temporary unlock below, leave it open. Refuse instead.
    if (existing?.status === "locked" && !opts.force) {
      merged.errors.push(
        `[${v.version}] version already exists and is locked; ` +
          `it was left untouched. Import into a new version, or pass force to overwrite.`,
      );
      continue;
    }

    // Register as a draft first: a locked row would refuse its own contents.
    // `existing` is only ever a draft here unless force was given.
    if (!existing) await store.writeVersion({ ...v, status: "draft" });
    else if (existing.status === "locked") await store.writeVersion({ ...existing, status: "draft" });

    try {
      const data = v.version === primary ? payload.data : payload.versionedData[v.version];
      if (data) mergeInto(await importSnapshot(store.at(v.version) as AnyStore, data), v.version);
      merged.imported["versions"] = (merged.imported["versions"] ?? 0) + 1;
    } finally {
      // Restore the lock whatever happened, so a failure part-way cannot leave a
      // baseline open. An existing row keeps its own status; a new one takes the
      // status it was exported with.
      const restore = existing ?? v;
      if (restore.status === "locked") await store.writeVersion(restore);
    }
  }
  return merged;
}

async function importSnapshot(
  store: AnyStore,
  data: ExportData,
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

  // --- Screens ---
  const existingScreenIds = new Set((await store.listScreens()).map(x => x.id));
  for (const screen of data.screens) {
    if (existingScreenIds.has(screen.id)) { skip("screens", screen.id); continue; }
    const unknown = screen.stories.map(l => l.id).filter(sid => !existingStoryIds.has(sid));
    if (unknown.length > 0) {
      report.errors.push(`Screen ${screen.id} references unknown story(ies): ${unknown.join(", ")}`);
    }
    await store.writeScreen(screen);
    existingScreenIds.add(screen.id);
    inc("screens");
  }

  // --- Architecture decisions ---
  const existingAdrIds = new Set((await store.listAdrs()).map(x => x.id));
  for (const adr of data.adrs) {
    if (existingAdrIds.has(adr.id)) { skip("adrs", adr.id); continue; }
    const unknown = adr.requirements.filter(rid => !existingRequirementIds.has(rid));
    if (unknown.length > 0) {
      report.errors.push(`Adr ${adr.id} references unknown requirement(s): ${unknown.join(", ")}`);
    }
    await store.writeAdr(adr);
    existingAdrIds.add(adr.id);
    inc("adrs");
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
