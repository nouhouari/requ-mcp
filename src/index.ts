#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import url from "node:url";
import { Store } from "./storage.js";
import {
  CoverageMode,
  Priority,
  PhaseStatus,
  RequirementStatus,
  StoryStatus,
  TestStatus,
  testKey,
  type AcceptanceCriterion,
  type Execution,
  type Phase,
  type Requirement,
  type UserStory,
} from "./schema.js";
import {
  danglingStoryTags,
  indexConductor,
  linkedScenarioKeys,
  scenariosByStory,
  validateTestRef,
  type ConductorIndex,
} from "./conductor.js";
import { buildReport, buildTrend, findGaps, resolveStatuses, type ScenariosByStory } from "./coverage.js";
import { parseCucumberJson } from "./ingest.js";

const now = () => new Date().toISOString();

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
function fail(message: string, extra?: Record<string, unknown>) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...extra }, null, 2) }],
  };
}

const server = new McpServer({ name: "requ-mcp", version: "0.4.0" });

// ===========================================================================
// Project resolution
//
// A user-level (global) server must figure out which project each call targets.
// Precedence: explicit projectPath → REQU_ROOT → a workspace root (MCP roots)
// or cwd-ancestor that already contains `.requ/` → first workspace root → cwd.
// ===========================================================================

let cachedRoots: string[] | null = null;
async function workspaceRoots(): Promise<string[]> {
  if (cachedRoots) return cachedRoots;
  try {
    const res = await server.server.listRoots();
    cachedRoots = (res.roots ?? [])
      .map((r) => r.uri)
      .filter((u) => u.startsWith("file://"))
      .map((u) => url.fileURLToPath(u));
  } catch {
    cachedRoots = []; // client doesn't support roots
  }
  return cachedRoots;
}

async function hasRequ(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, ".requ"));
    return true;
  } catch {
    return false;
  }
}

async function findUp(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  for (;;) {
    if (await hasRequ(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function resolveRoot(explicit?: string): Promise<string> {
  if (explicit) return path.resolve(explicit);
  if (process.env.REQU_ROOT) return path.resolve(process.env.REQU_ROOT);
  const roots = await workspaceRoots();
  for (const r of roots) if (await hasRequ(r)) return r; // initialized workspace wins
  const found = await findUp(process.cwd());
  if (found) return found;
  return roots[0] ?? process.cwd(); // not yet initialized
}

async function getStore(explicit?: string): Promise<Store> {
  return new Store(await resolveRoot(explicit));
}

const projectPathSchema = z
  .string()
  .optional()
  .describe(
    "Absolute path to the project root (the dir containing .requ/). Omit to auto-detect: REQU_ROOT, else a workspace root or ancestor of the cwd that contains .requ/.",
  );

type Handler = (args: any, store: Store) => Promise<unknown>;

/** Register a tool that auto-injects `projectPath` and resolves the Store. */
function tool(
  name: string,
  config: { title?: string; description?: string; inputSchema?: Record<string, z.ZodTypeAny> },
  handler: Handler,
) {
  const inputSchema = { ...(config.inputSchema ?? {}), projectPath: projectPathSchema };
  server.registerTool(name, { title: config.title, description: config.description, inputSchema }, async (args: any) => {
    try {
      const store = await getStore(args.projectPath);
      return (await handler(args, store)) as ReturnType<typeof json>;
    } catch (e) {
      return fail((e as Error).message);
    }
  });
}

async function ensureInit(store: Store) {
  if (!(await store.isInitialized())) {
    throw new Error(
      `requ project not initialized at ${store.root}. Run \`init_project\` first (pass projectPath to target a specific directory).`,
    );
  }
}

async function loadConductorIndex(store: Store): Promise<{ root: string; index: ConductorIndex }> {
  const root = await store.conductorRoot();
  return { root, index: await indexConductor(root) };
}

// ===========================================================================
// Setup
// ===========================================================================

tool(
  "init_project",
  {
    title: "Initialize requ project",
    description:
      "Create the `.requ/` directory at the resolved project root, record the Conductor project path and optional cucumber-json report path, and optionally create an initial phase. Idempotent.",
    inputSchema: {
      name: z.string().optional(),
      conductorPath: z.string().optional().describe("Path to the Conductor project root (has features/). Default '.'."),
      conductorReportPath: z
        .string()
        .optional()
        .describe("Default path to Conductor's cucumber-json result file, for import_execution_report."),
      initialPhase: z.string().optional().describe("If set, create and activate a first phase with this name."),
    },
  },
  async (args, store) => {
    const existing = (await store.isInitialized()) ? await store.readConfig() : null;
    const config = {
      name: args.name ?? existing?.name ?? path.basename(store.root),
      conductorPath: args.conductorPath ?? existing?.conductorPath ?? ".",
      conductorReportPath: args.conductorReportPath ?? existing?.conductorReportPath,
      activePhase: existing?.activePhase,
    };
    await store.init(config);
    let phase: Phase | undefined;
    if (args.initialPhase) {
      phase = {
        id: "PHASE-001",
        name: args.initialPhase,
        order: 1,
        status: "active",
        description: "",
        createdAt: now(),
        updatedAt: now(),
      };
      await store.writePhase(phase);
      await store.writeConfig({ ...config, activePhase: phase.id });
    }
    return json({ initialized: true, root: store.root, config: await store.readConfig(), phase });
  },
);

// ===========================================================================
// Requirements
// ===========================================================================

tool(
  "create_requirement",
  {
    title: "Create requirement",
    description: "Register an imported requirement (the upstream 'what must be built').",
    inputSchema: {
      title: z.string(),
      description: z.string().optional(),
      source: z.string().optional().describe("Provenance: doc, spec section, ticket id."),
      priority: Priority.optional(),
      components: z.array(z.string()).optional().describe("Sub-systems/modules this requirement belongs to."),
      tags: z.array(z.string()).optional(),
      id: z.string().regex(/^REQ-\d+$/).optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const existing = await store.listRequirements();
    const id = args.id ?? Store.nextId("REQ", existing.map((r) => r.id));
    if (existing.some((r) => r.id === id)) return fail(`Requirement ${id} already exists.`);
    const req: Requirement = {
      id,
      title: args.title,
      description: args.description ?? "",
      source: args.source ?? "",
      priority: args.priority ?? "medium",
      components: args.components ?? [],
      tags: args.tags ?? [],
      status: "active",
      createdAt: now(),
      updatedAt: now(),
    };
    await store.writeRequirement(req);
    return json(req);
  },
);

tool(
  "list_requirements",
  {
    title: "List requirements",
    description: "List requirements, optionally filtered by status, component, or tag.",
    inputSchema: {
      status: RequirementStatus.optional(),
      component: z.string().optional(),
      tag: z.string().optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    let reqs = await store.listRequirements();
    if (args.status) reqs = reqs.filter((r) => r.status === args.status);
    if (args.component) reqs = reqs.filter((r) => r.components.includes(args.component));
    if (args.tag) reqs = reqs.filter((r) => r.tags.includes(args.tag));
    return json(reqs);
  },
);

tool(
  "get_requirement",
  {
    title: "Get requirement",
    description: "Fetch a requirement and the stories that trace to it.",
    inputSchema: { id: z.string().regex(/^REQ-\d+$/) },
  },
  async (args, store) => {
    await ensureInit(store);
    const req = await store.getRequirement(args.id);
    if (!req) return fail(`Requirement ${args.id} not found.`);
    const stories = await store.listStories();
    return json({ ...req, linkedStories: stories.filter((s) => s.requirements.includes(args.id)).map((s) => s.id) });
  },
);

tool(
  "update_requirement",
  {
    title: "Update requirement",
    description: "Update a requirement's fields (title, description, priority, components, tags, status).",
    inputSchema: {
      id: z.string().regex(/^REQ-\d+$/),
      title: z.string().optional(),
      description: z.string().optional(),
      source: z.string().optional(),
      priority: Priority.optional(),
      components: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      status: RequirementStatus.optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const req = await store.getRequirement(args.id);
    if (!req) return fail(`Requirement ${args.id} not found.`);
    for (const k of ["title", "description", "source", "priority", "components", "tags", "status"] as const) {
      if (args[k] !== undefined) (req as Record<string, unknown>)[k] = args[k];
    }
    req.updatedAt = now();
    await store.writeRequirement(req);
    return json(req);
  },
);

// ===========================================================================
// User Stories (PO agent)
// ===========================================================================

tool(
  "create_user_story",
  {
    title: "Create user story",
    description:
      "Author a user story. MUST link ≥1 existing requirement (validated). Acceptance criteria are descriptive; tests are linked by tagging scenarios with @<this story id> in the feature files.",
    inputSchema: {
      title: z.string(),
      requirements: z.array(z.string().regex(/^REQ-\d+$/)).min(1),
      description: z.string().optional(),
      acceptanceCriteria: z.array(z.string()).optional().describe("Descriptive criterion texts."),
      id: z.string().regex(/^US-\d+$/).optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const missing: string[] = [];
    for (const reqId of args.requirements) if (!(await store.getRequirement(reqId))) missing.push(reqId);
    if (missing.length) return fail(`Unknown requirement(s): ${missing.join(", ")}`);

    const existing = await store.listStories();
    const id = args.id ?? Store.nextId("US", existing.map((s) => s.id));
    if (existing.some((s) => s.id === id)) return fail(`Story ${id} already exists.`);

    const acceptanceCriteria: AcceptanceCriterion[] = (args.acceptanceCriteria ?? []).map((t: string, i: number) => ({
      id: `AC-${i + 1}`,
      text: t,
    }));
    const story: UserStory = {
      id,
      title: args.title,
      description: args.description ?? "",
      requirements: args.requirements,
      acceptanceCriteria,
      status: "draft",
      createdAt: now(),
      updatedAt: now(),
    };
    await store.writeStory(story);
    return json({ ...story, hint: `Tag scenarios with @${id} in your feature files to link tests to this story.` });
  },
);

tool(
  "list_user_stories",
  {
    title: "List user stories",
    description: "List user stories, optionally filtered by status or linked requirement.",
    inputSchema: { status: StoryStatus.optional(), requirement: z.string().regex(/^REQ-\d+$/).optional() },
  },
  async (args, store) => {
    await ensureInit(store);
    let stories = await store.listStories();
    if (args.status) stories = stories.filter((s) => s.status === args.status);
    if (args.requirement) stories = stories.filter((s) => s.requirements.includes(args.requirement));
    return json(stories);
  },
);

tool(
  "get_user_story",
  {
    title: "Get user story",
    description:
      "Fetch one user story with its descriptive acceptance criteria and the scenarios tagged to it (with their latest status in the active phase, cumulative).",
    inputSchema: { id: z.string().regex(/^US-\d+$/) },
  },
  async (args, store) => {
    await ensureInit(store);
    const story = await store.getStory(args.id);
    if (!story) return fail(`Story ${args.id} not found.`);
    const { index } = await loadConductorIndex(store);
    const scs = scenariosByStory(index).get(args.id) ?? [];
    const [phases, execByPhase] = await Promise.all([store.listPhases(), store.readAllExecutions()]);
    const phaseId = await store.resolvePhaseId();
    const status = resolveStatuses(execByPhase, phases, phaseId, "cumulative");
    return json({
      ...story,
      phase: phaseId,
      linkedScenarios: scs.map((sc) => ({
        feature: sc.feature,
        name: sc.name,
        status: status.get(testKey(sc)) ?? "pending",
      })),
    });
  },
);

tool(
  "update_user_story",
  {
    title: "Update user story",
    description: "Update a story's title, description, status, or linked requirements (re-validated, must stay ≥1).",
    inputSchema: {
      id: z.string().regex(/^US-\d+$/),
      title: z.string().optional(),
      description: z.string().optional(),
      status: StoryStatus.optional(),
      requirements: z.array(z.string().regex(/^REQ-\d+$/)).min(1).optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const story = await store.getStory(args.id);
    if (!story) return fail(`Story ${args.id} not found.`);
    if (args.requirements) {
      const missing: string[] = [];
      for (const reqId of args.requirements) if (!(await store.getRequirement(reqId))) missing.push(reqId);
      if (missing.length) return fail(`Unknown requirement(s): ${missing.join(", ")}`);
      story.requirements = args.requirements;
    }
    if (args.title !== undefined) story.title = args.title;
    if (args.description !== undefined) story.description = args.description;
    if (args.status !== undefined) story.status = args.status;
    story.updatedAt = now();
    await store.writeStory(story);
    return json(story);
  },
);

tool(
  "add_acceptance_criterion",
  {
    title: "Add acceptance criterion",
    description: "Append a descriptive acceptance criterion to a story.",
    inputSchema: { storyId: z.string().regex(/^US-\d+$/), text: z.string() },
  },
  async (args, store) => {
    await ensureInit(store);
    const story = await store.getStory(args.storyId);
    if (!story) return fail(`Story ${args.storyId} not found.`);
    const maxN = story.acceptanceCriteria.reduce((m, c) => {
      const n = parseInt(c.id.replace("AC-", ""), 10);
      return Number.isFinite(n) ? Math.max(m, n) : m;
    }, 0);
    const ac: AcceptanceCriterion = { id: `AC-${maxN + 1}`, text: args.text };
    story.acceptanceCriteria.push(ac);
    story.updatedAt = now();
    await store.writeStory(story);
    return json({ storyId: args.storyId, criterion: ac });
  },
);

// ===========================================================================
// Phases / Releases
// ===========================================================================

tool(
  "create_phase",
  {
    title: "Create phase/release",
    description:
      "Create a phase (sprint or release) to capture coverage at a point in time. Order auto-increments. Optionally make it the active phase.",
    inputSchema: {
      name: z.string().describe("e.g. 'v1.0', 'Sprint 3'."),
      order: z.number().int().optional().describe("Sort key; defaults to max+1."),
      description: z.string().optional(),
      activate: z.boolean().optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const existing = await store.listPhases();
    const id = Store.nextId("PHASE", existing.map((p) => p.id));
    const order = args.order ?? (existing.reduce((m, p) => Math.max(m, p.order), 0) + 1);
    const phase: Phase = {
      id,
      name: args.name,
      order,
      status: args.activate ? "active" : "planned",
      description: args.description ?? "",
      createdAt: now(),
      updatedAt: now(),
    };
    await store.writePhase(phase);
    if (args.activate || existing.length === 0) {
      const cfg = await store.readConfig();
      await store.writeConfig({ ...cfg, activePhase: id });
    }
    return json(phase);
  },
);

tool(
  "list_phases",
  { title: "List phases", description: "List phases in order, marking which one is active.", inputSchema: {} },
  async (_args, store) => {
    await ensureInit(store);
    const [phases, cfg] = await Promise.all([store.listPhases(), store.readConfig()]);
    return json({ activePhase: cfg.activePhase ?? null, phases });
  },
);

tool(
  "update_phase",
  {
    title: "Update phase",
    description: "Update a phase's name, order, status, or description.",
    inputSchema: {
      id: z.string().regex(/^PHASE-\d+$/),
      name: z.string().optional(),
      order: z.number().int().optional(),
      status: PhaseStatus.optional(),
      description: z.string().optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const phase = await store.getPhase(args.id);
    if (!phase) return fail(`Phase ${args.id} not found.`);
    for (const k of ["name", "order", "status", "description"] as const) {
      if (args[k] !== undefined) (phase as Record<string, unknown>)[k] = args[k];
    }
    phase.updatedAt = now();
    await store.writePhase(phase);
    return json(phase);
  },
);

tool(
  "set_active_phase",
  {
    title: "Set active phase",
    description: "Set which phase new executions are recorded against by default.",
    inputSchema: { id: z.string().regex(/^PHASE-\d+$/) },
  },
  async (args, store) => {
    await ensureInit(store);
    if (!(await store.getPhase(args.id))) return fail(`Phase ${args.id} not found.`);
    const cfg = await store.readConfig();
    await store.writeConfig({ ...cfg, activePhase: args.id });
    return json({ activePhase: args.id });
  },
);

// ===========================================================================
// Links (derived from @US-xxx scenario tags) — discovery & validation
// ===========================================================================

tool(
  "list_links",
  {
    title: "List tag-derived links",
    description:
      "Scan the Conductor feature files and report which scenarios are tagged to which user story, plus problems: stories with no tagged scenario, and @US-xxx tags pointing at unknown stories.",
    inputSchema: {},
  },
  async (_args, store) => {
    await ensureInit(store);
    const [{ root, index }, stories] = await Promise.all([loadConductorIndex(store), store.listStories()]);
    const knownIds = new Set(stories.map((s) => s.id));
    const byStory = scenariosByStory(index);
    const links = stories.map((s) => ({
      story: s.id,
      title: s.title,
      scenarios: (byStory.get(s.id) ?? []).map((sc) => ({ feature: sc.feature, name: sc.name, file: sc.file })),
    }));
    return json({
      conductorRoot: root,
      scenariosIndexed: index.scenarios.length,
      links,
      storiesWithoutScenario: links.filter((l) => l.scenarios.length === 0).map((l) => l.story),
      danglingTags: danglingStoryTags(index, knownIds),
    });
  },
);

// ===========================================================================
// Executions (test results per phase)
// ===========================================================================

tool(
  "record_execution",
  {
    title: "Record a test execution",
    description:
      "Record one scenario result against a phase (default: active). Validated against the Conductor project. Use for ad-hoc results or corrections; use import_execution_report for whole cucumber runs.",
    inputSchema: {
      feature: z.string().describe("Feature name (the `Feature:` line)."),
      name: z.string().describe("Scenario name (the `Scenario:` line)."),
      status: TestStatus,
      phase: z.string().regex(/^PHASE-\d+$/).optional().describe("Defaults to the active phase."),
      runId: z.string().optional(),
      note: z.string().optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const phaseId = await store.resolvePhaseId(args.phase);
    if (!phaseId) return fail("No phase to record against. Create one with create_phase.");
    if (!(await store.getPhase(phaseId))) return fail(`Phase ${phaseId} not found.`);

    const { root, index } = await loadConductorIndex(store);
    const result = validateTestRef({ feature: args.feature, name: args.name }, index);
    if (!result.ok)
      return fail(result.reason ?? "Test does not resolve.", { conductorRoot: root, suggestions: result.suggestions });

    const exec: Execution = {
      feature: args.feature,
      name: args.name,
      status: args.status,
      ranAt: now(),
      runId: args.runId,
      source: "manual",
      note: args.note,
    };
    await store.appendExecutions(phaseId, [exec]);
    return json({ phase: phaseId, recorded: exec });
  },
);

tool(
  "import_execution_report",
  {
    title: "Import Conductor cucumber-json report",
    description:
      "Parse a Conductor cucumber-js JSON result file and record one execution per scenario into a phase (default: active). Reports how many scenarios are tagged to a story. Path defaults to config.conductorReportPath.",
    inputSchema: {
      filePath: z.string().optional().describe("Path to the cucumber-json file. Defaults to config.conductorReportPath."),
      phase: z.string().regex(/^PHASE-\d+$/).optional(),
      runId: z.string().optional().describe("Run identifier stamped on every imported execution."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const cfg = await store.readConfig();
    const rel = args.filePath ?? cfg.conductorReportPath;
    if (!rel) return fail("No report path. Pass filePath or set conductorReportPath in init_project.");
    const file = store.resolvePath(rel);

    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      return fail(`Cannot read report file: ${file}`);
    }

    let scenarios;
    try {
      scenarios = parseCucumberJson(content);
    } catch (e) {
      return fail(`Failed to parse report: ${(e as Error).message}`);
    }

    const phaseId = await store.resolvePhaseId(args.phase);
    if (!phaseId) return fail("No phase to record against. Create one with create_phase.");
    if (!(await store.getPhase(phaseId))) return fail(`Phase ${phaseId} not found.`);

    const ranAt = now();
    const execs: Execution[] = scenarios.map((s) => ({
      feature: s.feature,
      name: s.name,
      status: s.status,
      ranAt,
      runId: args.runId,
      source: "cucumber-json",
    }));
    await store.appendExecutions(phaseId, execs);

    const { index } = await loadConductorIndex(store);
    const linked = linkedScenarioKeys(index);
    const matched = execs.filter((e) => linked.has(testKey(e)));
    const counts = {
      pass: execs.filter((e) => e.status === "pass").length,
      fail: execs.filter((e) => e.status === "fail").length,
      pending: execs.filter((e) => e.status === "pending").length,
    };
    return json({
      phase: phaseId,
      file,
      scenariosParsed: execs.length,
      counts,
      taggedToAStory: matched.length,
      untaggedScenarios: execs
        .filter((e) => !linked.has(testKey(e)))
        .map((e) => ({ feature: e.feature, name: e.name, status: e.status })),
    });
  },
);

// ===========================================================================
// Reporting (phase- and mode-aware, story-level)
// ===========================================================================

async function resolveForReport(store: Store, phase?: string, mode?: CoverageMode) {
  const [reqs, stories, phases, execByPhase, { index }] = await Promise.all([
    store.listRequirements(),
    store.listStories(),
    store.listPhases(),
    store.readAllExecutions(),
    loadConductorIndex(store),
  ]);
  const phaseId = await store.resolvePhaseId(phase);
  const m = mode ?? "cumulative";
  const status = resolveStatuses(execByPhase, phases, phaseId, m);
  const byStory: ScenariosByStory = scenariosByStory(index);
  return { reqs, stories, phases, byStory, status, phaseId, mode: m };
}

tool(
  "coverage_report",
  {
    title: "Coverage report",
    description:
      "Story-level coverage for a phase: requirement → story → tagged scenarios, per-component breakdown, summary %. mode='cumulative' (latest result as of the phase) or 'strict' (only this phase's runs). Defaults to active phase, cumulative.",
    inputSchema: {
      phase: z.string().regex(/^PHASE-\d+$/).optional(),
      mode: CoverageMode.optional(),
      format: z.enum(["json", "markdown"]).optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const { reqs, stories, byStory, status, phaseId, mode } = await resolveForReport(store, args.phase, args.mode);
    const report = buildReport(reqs, stories, byStory, status, phaseId, mode);
    if (args.format === "markdown") {
      const phases = await store.listPhases();
      const name = phases.find((p) => p.id === phaseId)?.name ?? "(none)";
      return text(renderMarkdown(report, name));
    }
    return json(report);
  },
);

tool(
  "coverage_trend",
  {
    title: "Coverage evolution by phase",
    description: "The evolution view: coverage summary at each phase, in order. mode='cumulative' or 'strict'.",
    inputSchema: { mode: CoverageMode.optional() },
  },
  async (args, store) => {
    await ensureInit(store);
    const [reqs, stories, phases, execByPhase, { index }] = await Promise.all([
      store.listRequirements(),
      store.listStories(),
      store.listPhases(),
      store.readAllExecutions(),
      loadConductorIndex(store),
    ]);
    const trend = buildTrend(reqs, stories, scenariosByStory(index), execByPhase, phases, args.mode ?? "cumulative");
    return json({ mode: args.mode ?? "cumulative", points: trend });
  },
);

tool(
  "find_gaps",
  {
    title: "Find coverage gaps",
    description:
      "For a phase: active requirements with no story, stories with no tagged scenario, and stories not covered (with failing/not-run scenarios). Defaults to active phase, cumulative.",
    inputSchema: { phase: z.string().regex(/^PHASE-\d+$/).optional(), mode: CoverageMode.optional() },
  },
  async (args, store) => {
    await ensureInit(store);
    const { reqs, stories, byStory, status, phaseId, mode } = await resolveForReport(store, args.phase, args.mode);
    return json(findGaps(reqs, stories, byStory, status, phaseId, mode));
  },
);

function renderMarkdown(report: ReturnType<typeof buildReport>, phaseName: string): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(`# Requirements Coverage — ${phaseName} (${report.mode})`, "");
  lines.push("## Summary", "");
  lines.push(`- Requirements (active): **${s.requirementsTotal}**`);
  lines.push(`- With a story: **${s.requirementsWithStory}/${s.requirementsTotal}** (${s.storyCoveragePct}%)`);
  lines.push(`- Verified (all stories covered): **${s.requirementsVerified}/${s.requirementsTotal}** (${s.verifiedPct}%)`);
  lines.push(`- Stories covered: **${s.storiesCovered}/${s.storiesTotal}** (tested: ${s.storiesTested})`);
  lines.push(`- Scenarios passing: **${s.scenariosPassing}/${s.scenariosLinked}**`, "");
  if (report.byComponent.length) {
    lines.push("## By component", "");
    for (const c of report.byComponent)
      lines.push(`- **${c.component}** — verified ${c.verified}/${c.requirements} (${c.verifiedPct}%)`);
    lines.push("");
  }
  lines.push("## Requirements", "");
  for (const r of report.requirements) {
    const mark = r.verified ? "✅" : r.hasStory ? "🟡" : "❌";
    const comp = r.components.length ? ` _[${r.components.join(", ")}]_` : "";
    lines.push(`- ${mark} **${r.id}** ${r.title}${comp} — stories: ${r.storyIds.join(", ") || "none"}`);
  }
  lines.push("", "## Stories", "");
  for (const st of report.stories) {
    const mark = st.covered ? "✅" : !st.tested ? "❌" : "🟡";
    lines.push(`- ${mark} **${st.id}** ${st.title} — ${st.passing}/${st.scenarios.length} scenarios pass (${st.status})`);
    for (const sc of st.scenarios) {
      const cm = sc.status === "pass" ? "✓" : sc.status === "fail" ? "✗" : "·";
      lines.push(`  - ${cm} ${sc.feature} :: ${sc.name} — ${sc.status}`);
    }
    if (!st.tested) lines.push(`  - _(no scenarios tagged @${st.id})_`);
  }
  return lines.join("\n");
}

// ===========================================================================
// Boot
// ===========================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("requ-mcp running (per-call project resolution).");
}

main().catch((err) => {
  console.error("requ-mcp fatal:", err);
  process.exit(1);
});
