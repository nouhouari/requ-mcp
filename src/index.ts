#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { Store } from "./storage.js";
import { SqliteStore } from "./sqlite-store.js";
import { PostgresStore, initPgPool } from "./postgres-store.js";
import {
  Component,
  ComponentStatus,
  CoverageMode,
  ExportPayload,
  Priority,
  PhaseStatus,
  RequirementStatus,
  StoryStatus,
  TestStatus,
  testKey,
  storiesFromTags,
  VcsRefKind,
  VcsRefState,
  type AcceptanceCriterion,
  type Component as TComponent,
  type Execution,
  type Phase,
  type Requirement,
  type Scenario as TScenario,
  type UserStory,
  type VcsRef,
} from "./schema.js";
import {
  danglingStoryTags,
  indexConductor,
  inspectConductorProject,
  linkedScenarioKeys,
  scenariosByStory,
  validateTestRef,
  type ConductorIndex,
} from "./conductor.js";
import {
  buildReport,
  buildTrend,
  findGaps,
  resolveStatuses,
  resolveScenariosByStory,
  groupByStory,
  filterScenarios,
  requirementPhaseMap,
  requirementIdsForScenario,
  type ScenariosByStory,
  type ScenarioFilter,
} from "./coverage.js";
import { validateGherkin } from "./gherkin.js";
import { parseCucumberJson } from "./ingest.js";
import { buildExport, applyImport } from "./export-import.js";

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

/** Store instances for HTTP mode, keyed by URL-safe slug. */
const _stores: Map<string, SqliteStore | PostgresStore> = new Map();

/** Derive a URL-safe slug from a project root path. Deduplicates against `_stores`. */
function slugify(root: string): string {
  const base = path.basename(root).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!_stores.has(base)) return base;
  let i = 2;
  while (_stores.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/**
 * Pre-load projects from env vars at HTTP server startup (legacy SQLite mode only).
 * REQU_PROJECTS: comma-separated absolute paths. Falls back to REQU_ROOT.
 *
 * In Postgres mode this is a no-op: project_ids come from the DB
 * (attachAllDbProjects) and from init_project — never from a filesystem path.
 * Slugifying REQU_ROOT/REQU_PROJECTS here would mint a phantom project named
 * after the server's working directory (e.g. "requ-mcp").
 */
function loadProjectsFromEnv(): void {
  if (process.env.REQU_PG_URL) return;
  const raw = process.env.REQU_PROJECTS ?? process.env.REQU_ROOT;
  if (!raw) return;
  // Deduplicate by resolved root — duplicate paths would share one .db file.
  const roots = [...new Set(
    raw.split(",").map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(p)),
  )];
  // Scope REQU_DB to single-project SQLite mode only.
  const dbOverride = roots.length === 1 ? (process.env.REQU_DB ?? undefined) : undefined;
  for (const root of roots) {
    try {
      const slug = slugify(root);
      _stores.set(slug, new SqliteStore(root, dbOverride));
    } catch (err) {
      throw new Error(
        `Failed to open store for project ${root}: ${(err as Error).message}`,
      );
    }
  }
}

type AnyStore = Store | SqliteStore | PostgresStore;

// ===========================================================================
// Project resolution
// ===========================================================================

let cachedRoots: string[] | null = null;
async function workspaceRoots(server: McpServer): Promise<string[]> {
  if (cachedRoots) return cachedRoots;
  try {
    const res = await server.server.listRoots();
    cachedRoots = (res.roots ?? [])
      .map((r) => r.uri)
      .filter((u) => u.startsWith("file://"))
      .map((u) => url.fileURLToPath(u));
  } catch {
    cachedRoots = [];
  }
  return cachedRoots;
}

async function hasRequ(dir: string): Promise<boolean> {
  try { await fs.access(path.join(dir, ".requ")); return true; } catch { return false; }
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

async function resolveRoot(server: McpServer, explicit?: string): Promise<string> {
  if (explicit) return path.resolve(explicit);
  if (process.env.REQU_ROOT) return path.resolve(process.env.REQU_ROOT);
  const roots = await workspaceRoots(server);
  for (const r of roots) if (await hasRequ(r)) return r;
  const found = await findUp(process.cwd());
  if (found) return found;
  return roots[0] ?? process.cwd();
}

/** Synthetic root for DB-native projects (no filesystem .requ/). */
function synthRoot(slug: string): string {
  return path.join(os.tmpdir(), "requ", slug);
}

/** URL-safe project_id from a user-supplied selector (slug or name). */
function toSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "project";
}

/** Attach every project_id present in the Postgres DB to `_stores` (lazy discovery). */
async function attachAllDbProjects(): Promise<void> {
  if (!process.env.REQU_PG_URL) return;
  let ids: string[];
  try { ids = await PostgresStore.listProjectIds(); } catch { return; }
  for (const id of ids) {
    if (_stores.has(id)) continue;
    if ([..._stores.values()].some((s) => s instanceof PostgresStore && s.projectId === id)) continue;
    _stores.set(id, new PostgresStore(synthRoot(id), id));
  }
}

/** Find a loaded store by slug (the `_stores` key) or by config.key. */
async function resolveLoadedBySlugOrKey(sel: string): Promise<AnyStore | null> {
  if (_stores.has(sel)) return _stores.get(sel)!;
  for (const store of _stores.values()) {
    try { const cfg = await store.readConfig(); if (cfg.key === sel) return store; } catch { /* skip */ }
  }
  return null;
}

async function getStore(server: McpServer, explicit?: string, allowCreate = false): Promise<AnyStore> {
  if (process.env.REQU_TRANSPORT === "http") {
    const usePg = !!process.env.REQU_PG_URL;

    if (explicit) {
      // 1. Already-loaded project by slug or key.
      let found = await resolveLoadedBySlugOrKey(explicit);
      if (found) return found;
      if (usePg) {
        // 2. Discover DB projects, retry slug/key.
        await attachAllDbProjects();
        found = await resolveLoadedBySlugOrKey(explicit);
        if (found) return found;
        // 3. Unknown selector. Only init_project may mint a new project_id, and only
        //    from a plain name — never a filesystem path. Lookups never create.
        if (!allowCreate) {
          throw new Error(
            `Unknown project '${explicit}'. Known: [${[..._stores.keys()].join(", ")}]`,
          );
        }
        if (/[/\\]/.test(explicit)) {
          throw new Error(
            `Invalid project name '${explicit}': pass a plain name, not a filesystem path.`,
          );
        }
        const slug = toSlug(explicit);
        const store = new PostgresStore(synthRoot(slug), slug);
        _stores.set(slug, store);
        return store;
      }
      // SQLite legacy: treat `explicit` as a filesystem path.
      const root = path.resolve(explicit);
      for (const store of _stores.values()) if (store.root === root) return store;
      const slug = slugify(root);
      const store = new SqliteStore(root);
      _stores.set(slug, store);
      return store;
    }

    // No explicit selector.
    if (usePg) await attachAllDbProjects();
    if (_stores.size === 1) return [..._stores.values()][0];
    if (_stores.size === 0) {
      // Postgres mode never derives a project_id from cwd/workspace root — that mints
      // a phantom project named after the server's directory. Require an explicit name.
      if (usePg) {
        throw new Error("No requ project exists; run init_project with an explicit name.");
      }
      // Legacy local SQLite dev: fall back to filesystem resolution (cwd/workspace root).
      const root = await resolveRoot(server, explicit);
      const slug = slugify(root);
      const store = new SqliteStore(root);
      _stores.set(slug, store);
      return store;
    }
    throw new Error(
      `Multiple projects loaded; pass projectPath=<slug|key>. Known: [${[..._stores.keys()].join(", ")}]`,
    );
  }
  return new Store(await resolveRoot(server, explicit));
}

async function getStoreByKey(key: string, server: McpServer): Promise<AnyStore | null> {
  // HTTP mode: discover DB-native projects, then search loaded stores.
  await attachAllDbProjects();
  for (const store of _stores.values()) {
    try {
      const cfg = await store.readConfig();
      if (cfg.key === key) return store;
    } catch { /* skip uninitialized */ }
  }
  // stdio fallback: check the single auto-resolved store.
  if (_stores.size === 0) {
    try {
      const store = await getStore(server, undefined);
      const cfg = await store.readConfig();
      if (cfg.key === key) return store;
    } catch { /* no match */ }
  }
  return null;
}

const projectPathSchema = z
  .string()
  .optional()
  .describe(
    "Absolute path to the project root (the dir containing .requ/). Omit to auto-detect: REQU_ROOT, else a workspace root or ancestor of the cwd that contains .requ/.",
  );

type Handler = (args: any, store: AnyStore) => Promise<unknown>;

type ToolDef = {
  name: string;
  config: { title?: string; description?: string; inputSchema?: Record<string, z.ZodTypeAny> };
  handler: Handler;
};

/**
 * All tool definitions, collected once at module load. They are registered onto a
 * fresh `McpServer` by `createServer()` — one server instance per stdio process or
 * per HTTP session — so a single server is never connected to two transports.
 */
const toolDefs: ToolDef[] = [];

/** Collect a tool definition that auto-injects `projectPath` and resolves the Store. */
function tool(
  name: string,
  config: { title?: string; description?: string; inputSchema?: Record<string, z.ZodTypeAny> },
  handler: Handler,
) {
  toolDefs.push({ name, config, handler });
}

/** Build a fresh McpServer with every collected tool registered on it. */
function createServer(): McpServer {
  const server = new McpServer({ name: "requ-mcp", version: "0.7.1" });
  for (const { name, config, handler } of toolDefs) {
    const inputSchema = { ...(config.inputSchema ?? {}), projectPath: projectPathSchema };
    server.registerTool(
      name,
      { title: config.title, description: config.description, inputSchema },
      async (args: any) => {
        try {
          const store = await getStore(server, args.projectPath, name === "init_project");
          return (await handler(args, store)) as ReturnType<typeof json>;
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    );
  }

  // list_projects — enumerate all active projects on this server instance.
  server.registerTool(
    "list_projects",
    {
      title: "List Projects",
      description:
        "List all requ projects currently loaded on this server instance. " +
        "Returns each project's key, name, and root path. " +
        "Use this to discover which projects are available before calling other tools.",
      inputSchema: {},
    },
    async () => {
      try {
        // HTTP mode: discover DB-native projects, then enumerate loaded stores.
        await attachAllDbProjects();
        if (_stores.size > 0) {
          const projects: Array<{ slug: string; key: string | null; name: string; root: string }> = [];
          for (const [slug, store] of _stores.entries()) {
            try {
              const cfg = await store.readConfig();
              projects.push({ slug, key: cfg.key ?? null, name: cfg.name, root: (store as any).root ?? "" });
            } catch { /* skip uninitialized */ }
          }
          return json(projects);
        }
        // Stdio / single-store mode: resolve the default store and report it.
        try {
          const store = await getStore(server, undefined);
          const cfg = await store.readConfig();
          return json([{ key: cfg.key ?? null, name: cfg.name, root: (store as any).root ?? "" }]);
        } catch {
          return json([]);
        }
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // get_project_brief is registered directly so it can use the server closure for key-based lookup.
  server.registerTool(
    "get_project_brief",
    {
      title: "Get Project Brief",
      description: "Retrieve a project's name, key, and Markdown brief by its project key. Useful when you know the project key but not its filesystem path.",
      inputSchema: {
        key: z.string().describe("The project key to look up (e.g. 'AUTH')."),
      },
    },
    async (args: { key: string }) => {
      try {
        const store = await getStoreByKey(args.key, server);
        if (!store) {
          return json({ error: `No project found with key '${args.key}'.` });
        }
        const cfg = await store.readConfig();
        return json({
          key:   cfg.key   ?? null,
          name:  cfg.name,
          brief: cfg.brief ?? "",
          root:  (store as any).root ?? "",
        });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  return server;
}

async function ensureInit(store: AnyStore) {
  if (!(await store.isInitialized())) {
    throw new Error(
      `requ project not initialized at ${store.root}. Run \`init_project\` first (pass projectPath to target a specific directory).`,
    );
  }
}

/** A `fail()` result if `id` is not an existing phase, else null. */
async function phaseError(store: AnyStore, id: string) {
  if (await store.getPhase(id)) return null;
  const phases = await store.listPhases();
  return fail(`Unknown phase ${id}.`, { knownPhases: phases.map((p) => p.id) });
}

/**
 * Resolve the target phase for a newly created requirement/story:
 *   undefined → default to the active phase (may be unassigned),
 *   ""        → explicitly unassigned,
 *   "P1"      → validated against existing phases.
 * Returns `{ value }` (value may be undefined = unassigned) or `{ error }`.
 */
async function resolveAssignedPhase(store: AnyStore, input: string | undefined) {
  let id: string | null | undefined;
  if (input === undefined) id = await store.resolvePhaseId();
  else if (input === "") id = undefined;
  else id = input;
  if (!id) return { value: undefined as string | undefined };
  const error = await phaseError(store, id);
  if (error) return { error };
  return { value: id as string | undefined };
}

async function loadConductorIndex(store: AnyStore): Promise<{ root: string; index: ConductorIndex }> {
  const root = await store.conductorRoot();
  return { root, index: await indexConductor(root) };
}

/** testKeys of scenarios linked to a story: stored scenarios win, else disk tags. */
async function linkedKeysForStore(store: AnyStore): Promise<Set<string>> {
  const stored = await store.listScenarios();
  if (stored.length > 0) {
    return new Set(stored.filter((s) => s.stories.length > 0).map((s) => s.testKey));
  }
  try {
    return linkedScenarioKeys(await indexConductor(await store.conductorRoot()));
  } catch {
    return new Set();
  }
}

// ===========================================================================
// Setup
// ===========================================================================

tool(
  "init_project",
  {
    title: "Initialize requ project",
    description:
      "Create the `.requ/` directory at the resolved project root, record the Conductor project path and optional cucumber-json report path, and optionally create an initial phase. Before writing, it verifies the Conductor folder exists and is a real Conductor project (has features/ or a cucumber config), and reports its detected name. Refuses if the folder is missing/invalid unless force=true. Idempotent.",
    inputSchema: {
      name: z.string().optional(),
      key: z.string().optional().describe("Short unique project identifier (e.g. 'AUTH'). Uppercase letters, digits, hyphens, underscores. 2–20 chars. Must be unique across projects."),
      brief: z.string().optional().describe("Markdown-formatted description of what this project is about."),
      conductorPath: z.string().optional().describe("Path to the Conductor project root (has features/). Default '.'."),
      conductorReportPath: z
        .string()
        .optional()
        .describe("Default path to Conductor's cucumber-json result file, for import_execution_report."),
      initialPhase: z.string().optional().describe("If set, create and activate a first phase with this name."),
      force: z.boolean().optional().describe("Initialize even if the Conductor folder is missing or not a Conductor project."),
    },
  },
  async (args, store) => {
    const existing = (await store.isInitialized()) ? await store.readConfig() : null;
    const conductorPath = args.conductorPath ?? existing?.conductorPath ?? ".";

    // DB-native HTTP projects have no filesystem Conductor folder; skip the hard check.
    const isHttpPg = process.env.REQU_TRANSPORT === "http" && !!process.env.REQU_PG_URL;
    const conductorAbs = store.resolvePath(conductorPath);
    const conductor = await inspectConductorProject(conductorAbs);
    if (!conductor.isConductorProject && !args.force && !isHttpPg) {
      return fail(
        conductor.exists
          ? `'${conductorAbs}' exists but doesn't look like a Conductor project (no features/ directory or cucumber config). Pass force:true to init anyway, or set the correct conductorPath.`
          : `Conductor folder not found at '${conductorAbs}'. Set conductorPath to your Conductor project root (the folder containing features/), or pass force:true.`,
        { conductor },
      );
    }

    const config = {
      name: args.name ?? existing?.name ?? path.basename(store.root),
      key:   args.key   ?? existing?.key,
      brief: args.brief ?? existing?.brief,
      conductorPath,
      conductorName: conductor.isConductorProject ? conductor.name : existing?.conductorName,
      conductorReportPath: args.conductorReportPath ?? existing?.conductorReportPath,
      activePhase: existing?.activePhase,
    };
    await store.init(config);
    let phase: Phase | undefined;
    if (args.initialPhase) {
      phase = {
        id: "P1",
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
    return json({
      initialized: true,
      root: store.root,
      config: await store.readConfig(),
      conductor: {
        path: conductor.path,
        name: conductor.name,
        isConductorProject: conductor.isConductorProject,
        featureFiles: conductor.featureFiles,
        cucumberConfig: conductor.cucumberConfig,
      },
      phase,
    });
  },
);

tool(
  "check_conductor",
  {
    title: "Check the Conductor project",
    description:
      "Inspect the Conductor folder without modifying anything: whether it exists, looks like a Conductor project, its detected name, cucumber config, and number of .feature files. Pass conductorPath to check a candidate before init; otherwise uses the configured path.",
    inputSchema: {
      conductorPath: z.string().optional().describe("Candidate Conductor project root. Defaults to the configured conductorPath."),
    },
  },
  async (args, store) => {
    const candidate =
      args.conductorPath !== undefined
        ? store.resolvePath(args.conductorPath)
        : (await store.isInitialized())
          ? await store.conductorRoot()
          : store.root;
    return json(await inspectConductorProject(candidate));
  },
);

// ===========================================================================
// Components
// ===========================================================================

tool(
  "create_component",
  {
    title: "Create component",
    description:
      "Register a sub-system/component. The id should match broker domain_tags (e.g. 'C-auth' with domainTags=['auth','security']). Requirements reference component IDs in their components[] field. Coverage reports slice by component.",
    inputSchema: {
      id:          z.string().min(1).describe("Unique identifier, e.g. 'C-auth'. Should match broker domain_tags."),
      name:        z.string().min(1).describe("Human-readable name, e.g. 'Authentication'."),
      description: z.string().optional(),
      domainTags:  z.array(z.string()).optional().describe("Broker routing tags this component maps to, e.g. ['auth','security']."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const existing = await store.listComponents();
    if (existing.some((c) => c.id === args.id)) return fail(`Component ${args.id} already exists.`);
    const comp: TComponent = {
      id:          args.id,
      name:        args.name,
      description: args.description ?? "",
      domainTags:  args.domainTags ?? [],
      status:      "active",
      createdAt:   now(),
      updatedAt:   now(),
    };
    await store.writeComponent(comp);
    return json(comp);
  },
);

tool(
  "list_components",
  {
    title: "List components",
    description: "List all registered components, optionally filtered by status.",
    inputSchema: { status: ComponentStatus.optional() },
  },
  async (args, store) => {
    await ensureInit(store);
    let comps = await store.listComponents();
    if (args.status) comps = comps.filter((c) => c.status === args.status);
    return json(comps);
  },
);

tool(
  "get_component",
  {
    title: "Get component",
    description: "Fetch one component and the requirements that reference it.",
    inputSchema: { id: z.string().min(1) },
  },
  async (args, store) => {
    await ensureInit(store);
    const comp = await store.getComponent(args.id);
    if (!comp) return fail(`Component ${args.id} not found.`);
    const reqs = await store.listRequirements();
    return json({ ...comp, linkedRequirements: reqs.filter((r) => r.components.includes(args.id)).map((r) => r.id) });
  },
);

tool(
  "update_component",
  {
    title: "Update component",
    description: "Update a component's name, description, domainTags, or status.",
    inputSchema: {
      id:          z.string().min(1),
      name:        z.string().optional(),
      description: z.string().optional(),
      domainTags:  z.array(z.string()).optional(),
      status:      ComponentStatus.optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const comp = await store.getComponent(args.id);
    if (!comp) return fail(`Component ${args.id} not found.`);
    if (args.name        !== undefined) comp.name        = args.name;
    if (args.description !== undefined) comp.description = args.description;
    if (args.domainTags  !== undefined) comp.domainTags  = args.domainTags;
    if (args.status      !== undefined) comp.status      = args.status;
    comp.updatedAt = now();
    await store.writeComponent(comp);
    return json(comp);
  },
);

// ===========================================================================
// Requirements
// ===========================================================================

tool(
  "create_requirement",
  {
    title: "Create requirement",
    description: "Register an imported requirement (the upstream 'what must be built'). components[] must contain valid Component IDs if any components have been registered.",
    inputSchema: {
      title: z.string(),
      description: z.string().optional(),
      source: z.string().optional().describe("Provenance: doc, spec section, ticket id."),
      priority: Priority.optional(),
      components: z.array(z.string()).optional().describe("Component IDs this requirement belongs to (matches Component.id)."),
      tags: z.array(z.string()).optional(),
      phase: z.string().optional().describe("Target phase this requirement is planned for (e.g. 'P1'). Defaults to the active phase; pass '' to leave unassigned."),
      id: z.string().regex(/^REQ-\d+$/).optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);

    // Resolve & validate target phase (default to active phase; "" = unassigned).
    const phase = await resolveAssignedPhase(store, args.phase);
    if (phase.error) return phase.error;

    // Validate component IDs if components exist
    if (args.components?.length) {
      const existingComps = await store.listComponents();
      if (existingComps.length > 0) {
        const unknown = (args.components as string[]).filter((c: string) => !existingComps.some((e) => e.id === c));
        if (unknown.length) {
          return fail(`Unknown component(s): ${unknown.join(", ")}. Create them first with create_component.`, {
            knownComponents: existingComps.map((c) => c.id),
          });
        }
      }
    }

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
      ...(phase.value ? { phase: phase.value } : {}),
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
      phase: z.string().optional().describe("Filter by assigned target phase (exact match)."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    let reqs = await store.listRequirements();
    if (args.status) reqs = reqs.filter((r) => r.status === args.status);
    if (args.component) reqs = reqs.filter((r) => r.components.includes(args.component));
    if (args.tag) reqs = reqs.filter((r) => r.tags.includes(args.tag));
    if (args.phase) reqs = reqs.filter((r) => r.phase === args.phase);
    return json(reqs);
  },
);

tool(
  "search_requirements",
  {
    title: "Search requirements",
    description:
      "Case-insensitive substring search across requirement title, description, source, and tags. " +
      "Supports optional filters (status, component, phase) combined with the text query.",
    inputSchema: {
      query:     z.string().min(1).describe("Substring to search for (case-insensitive)."),
      status:    RequirementStatus.optional(),
      component: z.string().optional(),
      phase:     z.string().optional().describe("Filter by assigned target phase (exact match)."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const q = args.query.toLowerCase();
    let reqs = await store.listRequirements();
    if (args.status)    reqs = reqs.filter((r) => r.status === args.status);
    if (args.component) reqs = reqs.filter((r) => r.components.includes(args.component));
    if (args.phase)     reqs = reqs.filter((r) => r.phase === args.phase);
    const matches = reqs.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.source.toLowerCase().includes(q) ||
        r.tags.some((t) => t.toLowerCase().includes(q)),
    );
    return json({ query: args.query, total: matches.length, requirements: matches });
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
      phase: z.string().optional().describe("Target phase (e.g. 'P1'). Pass '' to clear the assignment."),
      status: RequirementStatus.optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const req = await store.getRequirement(args.id);
    if (!req) return fail(`Requirement ${args.id} not found.`);
    if (args.phase !== undefined) {
      if (args.phase === "") req.phase = undefined;
      else {
        const error = await phaseError(store, args.phase);
        if (error) return error;
        req.phase = args.phase;
      }
    }
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
      requirements: z.array(z.string().regex(/^REQ-\d+$/)).min(1).describe("IDs of existing requirements this story implements."),
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
    inputSchema: {
      status: StoryStatus.optional(),
      requirement: z.string().regex(/^REQ-\d+$/).optional(),
      phase: z.string().optional().describe("Filter by target phase, derived from the story's requirements: matches if any linked requirement is assigned to this phase."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    let stories = await store.listStories();
    if (args.status) stories = stories.filter((s) => s.status === args.status);
    if (args.requirement) stories = stories.filter((s) => s.requirements.includes(args.requirement));
    if (args.phase) {
      // A story has no phase of its own — derive it from its requirements' phases.
      const reqPhaseById = requirementPhaseMap(await store.listRequirements());
      stories = stories.filter((s) => s.requirements.some((rid) => reqPhaseById.get(rid) === args.phase));
    }
    return json(stories);
  },
);

tool(
  "search_user_stories",
  {
    title: "Search user stories",
    description:
      "Case-insensitive substring search across story title, description, and acceptance criteria text. " +
      "Supports optional filters (status, requirement, phase) combined with the text query.",
    inputSchema: {
      query:       z.string().min(1).describe("Substring to search for (case-insensitive)."),
      status:      StoryStatus.optional(),
      requirement: z.string().regex(/^REQ-\d+$/).optional(),
      phase:       z.string().optional().describe("Filter by target phase, derived from the story's requirements: matches if any linked requirement is assigned to this phase."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const q = args.query.toLowerCase();
    let stories = await store.listStories();
    if (args.status)      stories = stories.filter((s) => s.status === args.status);
    if (args.requirement) stories = stories.filter((s) => s.requirements.includes(args.requirement));
    if (args.phase) {
      // A story has no phase of its own — derive it from its requirements' phases.
      const reqPhaseById = requirementPhaseMap(await store.listRequirements());
      stories = stories.filter((s) => s.requirements.some((rid) => reqPhaseById.get(rid) === args.phase));
    }
    const matches = stories.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.acceptanceCriteria.some((ac) => ac.text.toLowerCase().includes(q)),
    );
    return json({ query: args.query, total: matches.length, stories: matches });
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
    const byStory = await resolveScenariosByStory(store);
    const scs = byStory.get(args.id) ?? [];
    const [phases, execByPhase] = await Promise.all([store.listPhases(), store.readAllExecutions()]);
    const phaseId = await store.resolvePhaseId();
    const status = resolveStatuses(execByPhase, phases, phaseId, "cumulative");
    return json({
      ...story,
      statusPhase: phaseId,
      linkedScenarios: scs.map((sc) => ({
        feature: sc.feature,
        name: sc.name,
        // content/tags present only for stored scenarios.
        content: (sc as Partial<TScenario>).content,
        tags: (sc as Partial<TScenario>).tags,
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
      "Create a phase (sprint or release). The id must be unique and MUST match the broker phase_id (e.g. 'P1', 'Sprint-3') so both systems share the same identifier. Order auto-increments if not provided. Optionally make it the active phase.",
    inputSchema: {
      id:          z.string().min(1).describe("Phase identifier; use the same value as broker phase_id (e.g. 'P1', 'Sprint-3')."),
      name:        z.string().describe("e.g. 'Phase 1 MVP', 'Sprint 3'."),
      order:       z.number().int().optional().describe("Sort key; defaults to max+1."),
      description: z.string().optional(),
      activate:    z.boolean().optional().describe("Make this the active phase."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const existing = await store.listPhases();
    if (existing.some((p) => p.id === args.id)) return fail(`Phase ${args.id} already exists.`);
    const order = args.order ?? (existing.reduce((m, p) => Math.max(m, p.order), 0) + 1);
    const phase: Phase = {
      id:          args.id,
      name:        args.name,
      order,
      status:      args.activate ? "active" : "planned",
      description: args.description ?? "",
      createdAt:   now(),
      updatedAt:   now(),
    };
    await store.writePhase(phase);
    if (args.activate || existing.length === 0) {
      const cfg = await store.readConfig();
      await store.writeConfig({ ...cfg, activePhase: args.id });
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
      id:          z.string().min(1),
      name:        z.string().optional(),
      order:       z.number().int().optional(),
      status:      PhaseStatus.optional(),
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
    inputSchema: { id: z.string().min(1) },
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
// Links (derived from @US-xxx scenario tags)
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
    const [stored, stories] = await Promise.all([store.listScenarios(), store.listStories()]);
    const knownIds = new Set(stories.map((s) => s.id));

    if (stored.length > 0) {
      // DB-native: links come from stored scenarios.
      const byStory = groupByStory(stored);
      const links = stories.map((s) => ({
        story: s.id,
        title: s.title,
        scenarios: (byStory.get(s.id) ?? []).map((sc) => ({ feature: sc.feature, name: sc.name, file: sc.file ?? null })),
      }));
      const dangling: { feature: string; name: string; story: string }[] = [];
      for (const sc of stored) {
        for (const st of sc.stories) if (!knownIds.has(st)) dangling.push({ feature: sc.feature, name: sc.name, story: st });
      }
      return json({
        source: "store",
        scenariosIndexed: stored.length,
        links,
        storiesWithoutScenario: links.filter((l) => l.scenarios.length === 0).map((l) => l.story),
        danglingTags: dangling,
      });
    }

    // Legacy: scan feature files on disk.
    const { root, index } = await loadConductorIndex(store);
    const byStory = scenariosByStory(index);
    const links = stories.map((s) => ({
      story: s.id,
      title: s.title,
      scenarios: (byStory.get(s.id) ?? []).map((sc) => ({ feature: sc.feature, name: sc.name, file: sc.file })),
    }));
    return json({
      source: "disk",
      conductorRoot: root,
      scenariosIndexed: index.scenarios.length,
      links,
      storiesWithoutScenario: links.filter((l) => l.scenarios.length === 0).map((l) => l.story),
      danglingTags: danglingStoryTags(index, knownIds),
    });
  },
);

tool(
  "search_tests",
  {
    title: "Search test scenarios",
    description:
      "Case-insensitive substring search across Conductor feature file scenarios: " +
      "feature name, scenario name, and tags. Optionally filter results to scenarios " +
      "linked to a specific story (@US-xxx tag). Requires an initialized Conductor project with feature files.",
    inputSchema: {
      query:   z.string().min(1).describe("Substring to search for (case-insensitive)."),
      storyId: z.string().regex(/^US-\d+$/).optional().describe("Restrict to scenarios tagged with this story id."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const q = args.query.toLowerCase();
    const { root, index } = await loadConductorIndex(store);
    let scenarios = index.scenarios;
    if (args.storyId) scenarios = scenarios.filter((sc) => sc.stories.includes(args.storyId));
    const matches = scenarios.filter(
      (sc) =>
        sc.feature.toLowerCase().includes(q) ||
        sc.name.toLowerCase().includes(q) ||
        sc.tags.some((t) => t.toLowerCase().includes(q)),
    );
    return json({
      query: args.query,
      conductorRoot: root,
      total: matches.length,
      scenarios: matches.map((sc) => ({
        feature: sc.feature,
        name: sc.name,
        file: sc.file,
        tags: sc.tags,
        stories: sc.stories,
      })),
    });
  },
);

// ===========================================================================
// Scenarios (requ-owned cucumber scenario content + story links)
// ===========================================================================

/** Story ids referenced by a scenario that don't exist (for non-fatal warnings). */
async function unknownStories(store: AnyStore, stories: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of stories) if (!(await store.getStory(id))) out.push(id);
  return out;
}

/** Latest status of a scenario in the active (or given) phase, cumulative. */
async function scenarioStatus(store: AnyStore, tk: string, phase?: string): Promise<{ phase: string | null; status: TestStatus }> {
  const [phases, execByPhase] = await Promise.all([store.listPhases(), store.readAllExecutions()]);
  const phaseId = await store.resolvePhaseId(phase);
  const status = resolveStatuses(execByPhase, phases, phaseId, "cumulative");
  return { phase: phaseId, status: status.get(tk) ?? "pending" };
}

tool(
  "create_scenario",
  {
    title: "Create / upsert a scenario",
    description:
      "Store a cucumber scenario's gherkin content in requ as the source of truth, linked to user stories. " +
      "Upserts by feature+name. Story links default to the @US-xxx tags in `tags` but can be set explicitly. " +
      "Gherkin content is validated; invalid content is rejected unless force=true (then stored with valid=false). " +
      "Once a project has any stored scenario, coverage is derived from stored scenarios (not disk feature files).",
    inputSchema: {
      feature: z.string().min(1).describe("Feature name (the `Feature:` line)."),
      name:    z.string().min(1).describe("Scenario name (the `Scenario:` line)."),
      content: z.string().optional().describe("Full gherkin text of the scenario (Scenario:/Outline + steps + Examples)."),
      background: z.string().optional().describe("The feature's Background: block (steps that run before this scenario)."),
      tags:    z.array(z.string()).optional().describe("Tags incl. @US-xxx, e.g. [\"@US-007\",\"@smoke\"]."),
      stories: z.array(z.string().regex(/^US-\d+$/)).optional().describe("Explicit story links; defaults to @US tags in `tags`."),
      force:   z.boolean().optional().describe("Store even if the gherkin content is invalid."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const tk = testKey({ feature: args.feature, name: args.name });
    const tags = args.tags ?? [];
    const stories = args.stories ?? storiesFromTags(tags);
    const content = args.content ?? "";

    const validation = validateGherkin(content);
    if (!validation.ok && !args.force) {
      return fail("Invalid gherkin content. Pass force:true to store anyway.", { errors: validation.errors });
    }

    const existing = await store.getScenario(tk);
    const ts = now();
    const sc: TScenario = {
      feature: args.feature,
      name: args.name,
      testKey: tk,
      content,
      background: args.background ?? existing?.background ?? "",
      tags,
      stories,
      source: existing?.source ?? "manual",
      file: existing?.file,
      valid: validation.ok,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    await store.writeScenario(sc);
    return json({ scenario: sc, valid: validation.ok, warnings: { unknownStories: await unknownStories(store, stories) } });
  },
);

tool(
  "update_scenario",
  {
    title: "Update a scenario",
    description:
      "Patch a stored scenario's content, tags, or story links (identified by feature+name). " +
      "If tags change and `stories` is not given, story links are re-derived from @US tags. " +
      "Edited content is re-validated; invalid content is rejected unless force=true.",
    inputSchema: {
      feature: z.string().min(1),
      name:    z.string().min(1),
      content: z.string().optional(),
      background: z.string().optional(),
      tags:    z.array(z.string()).optional(),
      stories: z.array(z.string().regex(/^US-\d+$/)).optional(),
      force:   z.boolean().optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const tk = testKey({ feature: args.feature, name: args.name });
    const sc = await store.getScenario(tk);
    if (!sc) return fail(`Scenario "${args.name}" in feature "${args.feature}" not found.`);

    if (args.content !== undefined) {
      const validation = validateGherkin(args.content);
      if (!validation.ok && !args.force) {
        return fail("Invalid gherkin content. Pass force:true to store anyway.", { errors: validation.errors });
      }
      sc.content = args.content;
      sc.valid = validation.ok;
    }
    if (args.background !== undefined) sc.background = args.background;
    if (args.tags !== undefined) sc.tags = args.tags;
    if (args.stories !== undefined) sc.stories = args.stories;
    else if (args.tags !== undefined) sc.stories = storiesFromTags(args.tags);
    sc.updatedAt = now();
    await store.writeScenario(sc);
    return json({ scenario: sc, valid: sc.valid, warnings: { unknownStories: await unknownStories(store, sc.stories) } });
  },
);

tool(
  "list_scenarios",
  {
    title: "List / filter scenarios",
    description:
      "List stored scenarios, filtered by story, requirement, phase, feature, and tags (cucumber tag expression). " +
      "Filters combine with AND. Returns [] for legacy projects with no stored scenarios. " +
      "When `phase` is given, each scenario is annotated with its resolved status for that phase.",
    inputSchema: {
      story:       z.string().optional().describe("Story id or comma-separated ids (match any), e.g. 'US-007'."),
      requirement: z.string().optional().describe("Requirement id or comma-separated ids; resolved via its stories."),
      phase:       z.string().optional().describe("Phase id; restricts to in-scope scenarios and adds per-phase status."),
      mode:        CoverageMode.optional().describe("Phase resolution mode (default cumulative)."),
      feature:     z.string().optional().describe("Exact feature name."),
      q:           z.string().optional().describe("Case-insensitive substring over name/feature/content."),
      tags:        z.string().optional().describe("Cucumber tag expression, e.g. '@smoke and not @wip'."),
      valid:       z.boolean().optional().describe("Filter by gherkin validity."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const scenarios = await store.listScenarios();
    if (scenarios.length === 0) return json([]);
    const [stories, phases, requirements] = await Promise.all([
      store.listStories(),
      store.listPhases(),
      store.listRequirements(),
    ]);

    const filter: ScenarioFilter = {
      story: args.story?.split(",").map((s: string) => s.trim()).filter(Boolean),
      requirement: args.requirement?.split(",").map((s: string) => s.trim()).filter(Boolean),
      phase: args.phase,
      mode: args.mode,
      feature: args.feature,
      q: args.q,
      valid: args.valid,
      tags: args.tags,
    };
    let filtered: TScenario[];
    try {
      filtered = filterScenarios(scenarios, stories, phases, requirements, filter);
    } catch (e) {
      return fail(`Invalid filter: ${(e as Error).message}`);
    }

    const storyById = new Map(stories.map((s) => [s.id, s]));
    let statusMap: Map<string, TestStatus> | null = null;
    if (args.phase) {
      const execByPhase = await store.readAllExecutions();
      statusMap = resolveStatuses(execByPhase, phases, args.phase, args.mode ?? "cumulative");
    }
    return json(
      filtered.map((sc) => ({
        ...sc,
        requirementIds: requirementIdsForScenario(sc, storyById),
        ...(statusMap ? { status: statusMap.get(sc.testKey) ?? "pending" } : {}),
      })),
    );
  },
);

tool(
  "get_scenario",
  {
    title: "Get a scenario",
    description: "Fetch one stored scenario (by feature+name) with its content, tags, story links, and latest status.",
    inputSchema: {
      feature: z.string().min(1),
      name:    z.string().min(1),
      phase:   z.string().optional().describe("Phase id for status (default active)."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const tk = testKey({ feature: args.feature, name: args.name });
    const sc = await store.getScenario(tk);
    if (!sc) return fail(`Scenario "${args.name}" in feature "${args.feature}" not found.`);
    const st = await scenarioStatus(store, tk, args.phase);
    return json({ ...sc, statusPhase: st.phase, status: st.status });
  },
);

tool(
  "delete_scenario",
  {
    title: "Delete a scenario",
    description: "Remove a stored scenario by feature+name.",
    inputSchema: { feature: z.string().min(1), name: z.string().min(1) },
  },
  async (args, store) => {
    await ensureInit(store);
    const tk = testKey({ feature: args.feature, name: args.name });
    const deleted = await store.deleteScenario(tk);
    return json({ deleted, testKey: tk });
  },
);

tool(
  "validate_scenario",
  {
    title: "Validate gherkin",
    description:
      "Validate cucumber gherkin syntax. Pass `content` to check arbitrary text, or feature+name to validate a stored scenario.",
    inputSchema: {
      content: z.string().optional(),
      feature: z.string().optional(),
      name:    z.string().optional(),
    },
  },
  async (args, store) => {
    let content = args.content;
    if (content === undefined) {
      if (!args.feature || !args.name) return fail("Pass `content`, or both `feature` and `name`.");
      await ensureInit(store);
      const sc = await store.getScenario(testKey({ feature: args.feature, name: args.name }));
      if (!sc) return fail(`Scenario "${args.name}" in feature "${args.feature}" not found.`);
      content = sc.content;
    }
    return json(validateGherkin(content));
  },
);

tool(
  "import_scenarios_from_features",
  {
    title: "Import scenarios from feature files",
    description:
      "One-time migration: read the Conductor project's .feature files and store each scenario (content, tags, story " +
      "links from @US tags) in requ. After this, requ is the source of truth and coverage is derived from stored " +
      "scenarios. Invalid gherkin is skipped (reported) unless force=true. Existing scenarios are skipped unless overwrite=true.",
    inputSchema: {
      conductorPath: z.string().optional().describe("Conductor project root. Defaults to config.conductorPath."),
      overwrite:     z.boolean().optional().describe("Replace scenarios that already exist."),
      force:         z.boolean().optional().describe("Import even scenarios whose gherkin is invalid (valid=false)."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const root = args.conductorPath ? store.resolvePath(args.conductorPath) : await store.conductorRoot();
    let index: ConductorIndex;
    try { index = await indexConductor(root); }
    catch (e) { return fail(`Cannot read feature files at ${root}: ${(e as Error).message}`); }

    const imported: string[] = [];
    const skipped: string[] = [];
    const invalid: { feature: string; name: string; errors: unknown[] }[] = [];
    const ts = now();

    for (const cs of index.scenarios) {
      const tk = testKey({ feature: cs.feature, name: cs.name });
      const existing = await store.getScenario(tk);
      if (existing && !args.overwrite) { skipped.push(tk); continue; }

      const validation = validateGherkin(cs.content);
      if (!validation.ok && !args.force) {
        invalid.push({ feature: cs.feature, name: cs.name, errors: validation.errors });
        continue;
      }
      const sc: TScenario = {
        feature: cs.feature,
        name: cs.name,
        testKey: tk,
        content: cs.content,
        background: cs.background,
        tags: cs.tags,
        stories: cs.stories,
        source: "import-feature",
        file: cs.file,
        valid: validation.ok,
        createdAt: existing?.createdAt ?? ts,
        updatedAt: ts,
      };
      await store.writeScenario(sc);
      imported.push(tk);
    }
    return json({ root, scenariosParsed: index.scenarios.length, imported: imported.length, skipped: skipped.length, invalid });
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
      "Record one scenario result against a phase (default: active). Validated against the Conductor project. Use for ad-hoc results or for teams running on a different machine than the requ-mcp server (no local file access needed). Use import_execution_report for whole cucumber runs on the same machine.",
    inputSchema: {
      feature: z.string().describe("Feature name (the `Feature:` line)."),
      name:    z.string().describe("Scenario name (the `Scenario:` line)."),
      status:  TestStatus,
      phase:   z.string().optional().describe("Phase ID (e.g. 'P1'). Defaults to the active phase."),
      runId:   z.string().optional(),
      note:    z.string().optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const phaseId = await store.resolvePhaseId(args.phase);
    if (!phaseId) return fail("No phase to record against. Create one with create_phase.");
    if (!(await store.getPhase(phaseId))) return fail(`Phase ${phaseId} not found.`);

    // Validate the scenario exists: stored scenarios win, else the disk index.
    const stored = await store.listScenarios();
    if (stored.length > 0) {
      const tk = testKey({ feature: args.feature, name: args.name });
      if (!stored.some((s) => s.testKey === tk)) {
        return fail(`No stored scenario "${args.name}" in feature "${args.feature}".`, {
          source: "store",
          suggestions: stored.filter((s) => s.name === args.name).map((s) => `${s.feature} :: ${s.name}`),
        });
      }
    } else {
      const { root, index } = await loadConductorIndex(store);
      const result = validateTestRef({ feature: args.feature, name: args.name }, index);
      if (!result.ok)
        return fail(result.reason ?? "Test does not resolve.", { conductorRoot: root, suggestions: result.suggestions });
    }

    const exec: Execution = {
      feature: args.feature,
      name:    args.name,
      status:  args.status,
      ranAt:   now(),
      runId:   args.runId,
      source:  "manual",
      note:    args.note,
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
      "Parse a Conductor cucumber-js JSON result file and record one execution per scenario into a phase (default: active). Reports how many scenarios are tagged to a story. Path defaults to config.conductorReportPath. Requires the report file to be accessible on the machine running requ-mcp.",
    inputSchema: {
      filePath: z.string().optional().describe("Path to the cucumber-json file. Defaults to config.conductorReportPath."),
      phase:    z.string().optional().describe("Phase ID (e.g. 'P1'). Defaults to active phase."),
      runId:    z.string().optional().describe("Run identifier stamped on every imported execution."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const cfg = await store.readConfig();
    const rel = args.filePath ?? cfg.conductorReportPath;
    if (!rel) return fail("No report path. Pass filePath or set conductorReportPath in init_project.");
    const file = store.resolvePath(rel);

    let content: string;
    try { content = await fs.readFile(file, "utf8"); }
    catch { return fail(`Cannot read report file: ${file}`); }

    let scenarios;
    try { scenarios = parseCucumberJson(content); }
    catch (e) { return fail(`Failed to parse report: ${(e as Error).message}`); }

    const phaseId = await store.resolvePhaseId(args.phase);
    if (!phaseId) return fail("No phase to record against. Create one with create_phase.");
    if (!(await store.getPhase(phaseId))) return fail(`Phase ${phaseId} not found.`);

    const ranAt = now();
    const execs: Execution[] = scenarios.map((s) => ({
      feature: s.feature,
      name:    s.name,
      status:  s.status,
      ranAt,
      runId: args.runId,
      source: "cucumber-json",
    }));
    await store.appendExecutions(phaseId, execs);

    const linked = await linkedKeysForStore(store);
    const matched = execs.filter((e) => linked.has(testKey(e)));
    const counts = {
      pass:    execs.filter((e) => e.status === "pass").length,
      fail:    execs.filter((e) => e.status === "fail").length,
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
// Reporting
// ===========================================================================

async function resolveForReport(store: AnyStore, phase?: string, mode?: CoverageMode) {
  const [reqs, stories, phases, execByPhase, byStory, vcsRefs] = await Promise.all([
    store.listRequirements(),
    store.listStories(),
    store.listPhases(),
    store.readAllExecutions(),
    resolveScenariosByStory(store),
    store.listVcsRefs(),
  ]);
  const phaseId = await store.resolvePhaseId(phase);
  const m = mode ?? "cumulative";
  const status = resolveStatuses(execByPhase, phases, phaseId, m);
  return { reqs, stories, phases, byStory: byStory as ScenariosByStory, status, phaseId, mode: m, vcsRefs };
}

tool(
  "coverage_report",
  {
    title: "Coverage report",
    description:
      "Story-level coverage for a phase: requirement → story → tagged scenarios, per-component breakdown (with component name and domainTags), summary %. mode='cumulative' (latest result as of the phase) or 'strict' (only this phase's runs). Defaults to active phase, cumulative.",
    inputSchema: {
      phase:  z.string().optional().describe("Phase ID (e.g. 'P1'). Defaults to active phase."),
      mode:   CoverageMode.optional(),
      format: z.enum(["json", "markdown"]).optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const { reqs, stories, byStory, status, phaseId, mode, vcsRefs, phases } = await resolveForReport(store, args.phase, args.mode);
    const report = buildReport(reqs, stories, byStory, status, phaseId, mode, vcsRefs, phases);

    // Enrich byComponent with component name and domainTags
    const components = await store.listComponents();
    const compMap = new Map(components.map((c) => [c.id, c]));
    const enrichedByComponent = report.byComponent.map((bc) => ({
      ...bc,
      componentName: compMap.get(bc.component)?.name ?? bc.component,
      domainTags:    compMap.get(bc.component)?.domainTags ?? [],
    }));

    const enrichedReport = { ...report, byComponent: enrichedByComponent };

    if (args.format === "markdown") {
      const phases = await store.listPhases();
      const name = phases.find((p) => p.id === phaseId)?.name ?? "(none)";
      return text(renderMarkdown(enrichedReport, name));
    }
    return json(enrichedReport);
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
    const [reqs, stories, phases, execByPhase, byStory] = await Promise.all([
      store.listRequirements(),
      store.listStories(),
      store.listPhases(),
      store.readAllExecutions(),
      resolveScenariosByStory(store),
    ]);
    const trend = buildTrend(reqs, stories, byStory, execByPhase, phases, args.mode ?? "cumulative");
    return json({ mode: args.mode ?? "cumulative", points: trend });
  },
);

tool(
  "find_gaps",
  {
    title: "Find coverage gaps",
    description:
      "For a phase: active requirements with no story, stories with no tagged scenario, and stories not covered (with failing/not-run scenarios). Defaults to active phase, cumulative.",
    inputSchema: {
      phase: z.string().optional().describe("Phase ID (e.g. 'P1'). Defaults to active phase."),
      mode:  CoverageMode.optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const { reqs, stories, byStory, status, phaseId, mode, phases } = await resolveForReport(store, args.phase, args.mode);
    return json(findGaps(reqs, stories, byStory, status, phaseId, mode, phases));
  },
);

// ===========================================================================
// VCS references (GitLab branches / merge requests)
//
// requ-mcp NEVER calls the VCS provider and holds NO token. These tools only
// record references that nodes report, for traceability.
// ===========================================================================

tool(
  "set_repo",
  {
    title: "Set VCS repository reference",
    description:
      "Record the project's VCS repository reference (repoUrl, defaultBranch, vcsType) in config. requ-mcp never calls the VCS provider — it only stores these references for traceability.",
    inputSchema: {
      repoUrl:       z.string().describe("Repository URL, e.g. 'https://gitlab.com/group/project'."),
      defaultBranch: z.string().optional().describe("Default branch name. Defaults to 'main'."),
      vcsType:       z.enum(["gitlab"]).optional().describe("VCS provider type."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const cfg = await store.readConfig();
    const next = {
      ...cfg,
      repoUrl: args.repoUrl,
      defaultBranch: args.defaultBranch ?? cfg.defaultBranch ?? "main",
      vcsType: args.vcsType ?? cfg.vcsType,
    };
    await store.writeConfig(next);
    return json({ repoUrl: next.repoUrl, defaultBranch: next.defaultBranch, vcsType: next.vcsType ?? null });
  },
);

tool(
  "get_repo",
  {
    title: "Get VCS repository reference",
    description: "Return the recorded VCS repository config: repoUrl, defaultBranch, vcsType.",
    inputSchema: {},
  },
  async (_args, store) => {
    await ensureInit(store);
    const cfg = await store.readConfig();
    return json({ repoUrl: cfg.repoUrl ?? null, defaultBranch: cfg.defaultBranch ?? "main", vcsType: cfg.vcsType ?? null });
  },
);

/** Validate story/requirement ids referenced by a VcsRef; fail on unknown ids. */
async function validateVcsLinks(store: AnyStore, storyIds: string[], requirementIds: string[]) {
  const missingStories: string[] = [];
  for (const id of storyIds) if (!(await store.getStory(id))) missingStories.push(id);
  if (missingStories.length) return fail(`Unknown story id(s): ${missingStories.join(", ")}`);
  const missingReqs: string[] = [];
  for (const id of requirementIds) if (!(await store.getRequirement(id))) missingReqs.push(id);
  if (missingReqs.length) return fail(`Unknown requirement id(s): ${missingReqs.join(", ")}`);
  return null;
}

tool(
  "link_branch",
  {
    title: "Link a VCS branch reference",
    description:
      "Record a reference to a VCS branch (kind='branch', state='opened'), auto-id 'BR-n'. Referenced storyIds/requirementIds must exist (fails if unknown). requ-mcp does not create the branch — it only records the reference.",
    inputSchema: {
      branch:         z.string().min(1).describe("Branch name."),
      component:      z.string().optional().describe("Component id this branch relates to."),
      storyIds:       z.array(z.string().regex(/^US-\d+$/)).optional().describe("User story ids (US-…) this branch implements."),
      requirementIds: z.array(z.string().regex(/^REQ-\d+$/)).optional().describe("Requirement ids (REQ-…) this branch relates to."),
      url:            z.string().optional().describe("URL of the branch (optional)."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const storyIds: string[] = args.storyIds ?? [];
    const requirementIds: string[] = args.requirementIds ?? [];
    const bad = await validateVcsLinks(store, storyIds, requirementIds);
    if (bad) return bad;

    const existing = await store.listVcsRefs();
    const dup = existing.find((r) => r.kind === "branch" && r.ref === args.branch);
    const id = dup?.id ?? Store.nextId("BR", existing.map((r) => r.id));
    const ts = now();
    const ref: VcsRef = {
      id,
      kind: "branch",
      ref: args.branch,
      url: args.url ?? "",
      branch: args.branch,
      component: args.component,
      storyIds,
      requirementIds,
      state: "opened",
      createdAt: dup?.createdAt ?? ts,
      updatedAt: ts,
    };
    await store.writeVcsRef(ref);
    return json(ref);
  },
);

tool(
  "link_merge_request",
  {
    title: "Link a VCS merge request reference",
    description:
      "Record (or upsert) a reference to a merge request (kind='mr'), keyed by `ref` (the MR iid), id 'MR-<ref>'. Referenced storyIds/requirementIds must exist (fails if unknown). requ-mcp does not call GitLab — it only records the reference.",
    inputSchema: {
      ref:            z.string().regex(/^\d+$/).describe("MR iid (numeric string)."),
      url:            z.string().min(1).describe("MR URL."),
      branch:         z.string().min(1).describe("Source branch of the MR."),
      storyIds:       z.array(z.string().regex(/^US-\d+$/)).optional().describe("User story ids (US-…) this MR implements."),
      requirementIds: z.array(z.string().regex(/^REQ-\d+$/)).optional().describe("Requirement ids (REQ-…) this MR relates to."),
      targetBranch:   z.string().optional().describe("Target branch of the MR."),
      state:          VcsRefState.optional().describe("MR state. Defaults to 'opened'."),
      component:      z.string().optional().describe("Component id this MR relates to."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const storyIds: string[] = args.storyIds ?? [];
    const requirementIds: string[] = args.requirementIds ?? [];
    const bad = await validateVcsLinks(store, storyIds, requirementIds);
    if (bad) return bad;

    const id = `MR-${args.ref}`;
    const existing = await store.getVcsRef(id);
    const ts = now();
    const ref: VcsRef = {
      id,
      kind: "mr",
      ref: args.ref,
      url: args.url,
      branch: args.branch,
      targetBranch: args.targetBranch,
      component: args.component,
      storyIds,
      requirementIds,
      state: args.state ?? "opened",
      mergeCommit: existing?.mergeCommit,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    await store.writeVcsRef(ref);
    return json(ref);
  },
);

tool(
  "update_merge_request",
  {
    title: "Update a merge request reference state",
    description:
      "Update the state (and optional mergeCommit) of a recorded MR reference, found by its `ref` (MR iid). Bumps updatedAt. Fails if no MR reference with that ref exists.",
    inputSchema: {
      ref:         z.string().regex(/^\d+$/).describe("MR iid (numeric string)."),
      state:       VcsRefState.describe("New MR state."),
      mergeCommit: z.string().optional().describe("Merge commit SHA (when merged)."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const refs = await store.listVcsRefs();
    const target = refs.find((r) => r.kind === "mr" && r.ref === args.ref);
    if (!target) return fail(`No merge request reference found for ref '${args.ref}'.`);
    const patch: Partial<VcsRef> = { state: args.state, updatedAt: now() };
    if (args.mergeCommit !== undefined) patch.mergeCommit = args.mergeCommit;
    const updated = await store.updateVcsRef(target.id, patch);
    if (!updated) return fail(`Merge request reference ${target.id} not found.`);
    return json(updated);
  },
);

tool(
  "list_vcs_refs",
  {
    title: "List VCS references",
    description: "List recorded VCS references (branches and MRs), optionally filtered by kind, component, state, or linked storyId.",
    inputSchema: {
      kind:      VcsRefKind.optional(),
      component: z.string().optional(),
      state:     z.string().optional(),
      storyId:   z.string().optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    let refs = await store.listVcsRefs();
    if (args.kind)      refs = refs.filter((r) => r.kind === args.kind);
    if (args.component) refs = refs.filter((r) => r.component === args.component);
    if (args.state)     refs = refs.filter((r) => r.state === args.state);
    if (args.storyId)   refs = refs.filter((r) => r.storyIds.includes(args.storyId));
    return json(refs);
  },
);

// ===========================================================================
// Export / Import
// ===========================================================================

tool(
  "export_project",
  {
    title: "Export project",
    description:
      "Export all project data (requirements, stories, phases, executions, components, VCS refs) as a JSON string. Pass the result to import_project on another instance to migrate or copy data.",
    inputSchema: {},
  },
  async (_args, store) => {
    await ensureInit(store);
    const payload = await buildExport(store);
    return json(JSON.stringify(payload, null, 2));
  },
);

tool(
  "import_project",
  {
    title: "Import project",
    description:
      "Import project data from a JSON string produced by export_project. Existing records (same ID) are skipped and reported. Returns a summary of what was imported and what was skipped.",
    inputSchema: {
      data: z.string().describe("JSON string produced by export_project"),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    let payload: unknown;
    try {
      payload = JSON.parse(args.data);
    } catch {
      return fail("data is not valid JSON");
    }
    const parsed = ExportPayload.safeParse(payload);
    if (!parsed.success) {
      return fail(`Invalid export format: ${parsed.error.message}`);
    }
    const report = await applyImport(store, parsed.data);
    return json(report);
  },
);

function renderMarkdown(report: ReturnType<typeof buildReport> & { byComponent: Array<{ component: string; componentName?: string; domainTags?: string[]; requirements: number; verified: number; verifiedPct: number }> }, phaseName: string): string {
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
    for (const c of report.byComponent) {
      const label = c.componentName && c.componentName !== c.component ? `${c.component} (${c.componentName})` : c.component;
      const tags  = c.domainTags?.length ? ` [${c.domainTags.join(", ")}]` : "";
      lines.push(`- **${label}**${tags} — verified ${c.verified}/${c.requirements} (${c.verifiedPct}%)`);
    }
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
    const mr = st.mergedMr
      ? st.mergedMr.state === "merged"
        ? ` — verified + merged (MR ${st.mergedMr.ref})`
        : ` — MR ${st.mergedMr.ref} (${st.mergedMr.state})`
      : "";
    lines.push(`- ${mark} **${st.id}** ${st.title} — ${st.passing}/${st.scenarios.length} scenarios pass (${st.status})${mr}`);
    for (const sc of st.scenarios) {
      const cm = sc.status === "pass" ? "✓" : sc.status === "fail" ? "✗" : "·";
      lines.push(`  - ${cm} ${sc.feature} :: ${sc.name} — ${sc.status}`);
    }
    if (!st.tested) lines.push(`  - _(no scenarios tagged @${st.id})_`);
  }
  return lines.join("\n");
}

// ===========================================================================
// HTTP server (REQU_TRANSPORT=http)
// ===========================================================================

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

async function startHttpServer(): Promise<void> {
  const { createServer: createHttpServer } = await import("node:http");
  const { randomUUID }   = await import("node:crypto");
  const { StreamableHTTPServerTransport } =
    await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { handleWebRequest } = await import("./web-api.js");

  const port = parseInt(process.env.REQU_PORT ?? "8788", 10);
  const host = process.env.REQU_HOST ?? "0.0.0.0";

  const sessions = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();
  if (process.env.REQU_PG_URL) initPgPool(process.env.REQU_PG_URL);
  loadProjectsFromEnv();

  const httpServer = createHttpServer(async (req, res) => {
    // Web dashboard routes (REST API + static files)
    if (await handleWebRequest(req, res, _stores)) return;

    if (!req.url?.includes("/mcp")) {
      res.writeHead(404).end("Not Found");
      return;
    }
    try {
      const bodyStr = req.method === "POST" ? await readBody(req) : "{}";
      const body    = bodyStr.trim() ? JSON.parse(bodyStr) : undefined;
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      let transport: InstanceType<typeof StreamableHTTPServerTransport>;

      if (sessionId && sessions.has(sessionId)) {
        transport = sessions.get(sessionId)!;
      } else {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => { sessions.set(id, transport); },
        });
        (transport as any).onclose = () => {
          const sid = (transport as any).sessionId as string | undefined;
          if (sid) sessions.delete(sid);
        };
        // Fresh McpServer per session — an McpServer cannot be connected to two transports.
        const sessionServer = createServer();
        await sessionServer.connect(transport);
      }

      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    }
  });

  httpServer.listen(port, host, () => {
    const loadedCount = _stores.size;
    const pgUrl = process.env.REQU_PG_URL;
    const dbInfo = pgUrl
      ? `postgres=yes  projects=${loadedCount}`
      : loadedCount > 0
        ? `projects=${loadedCount}`
        : `db=${process.env.REQU_ROOT ?? process.cwd()}/.requ/requ.db`;
    console.error(`requ-mcp HTTP → http://${host}:${port}/mcp  ${dbInfo}`);
  });
}

// ===========================================================================
// Boot
// ===========================================================================

async function main() {
  if (process.env.REQU_TRANSPORT === "http") {
    await startHttpServer();
  } else {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("requ-mcp running (stdio, YAML storage, per-call project resolution).");
  }
}

main().catch((err) => {
  console.error("requ-mcp fatal:", err);
  process.exit(1);
});
