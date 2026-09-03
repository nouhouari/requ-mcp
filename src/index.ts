#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { nextId } from "./ids.js";
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
  SCREEN_ID_RE,
  kindFromScreenId,
  ScreenKind,
  ScreenLinkRole,
  ScreenPlatform,
  ScreenStatus,
  StoryStatus,
  TestStatus,
  testKey,
  storiesFromTags,
  AdrStatus,
  INITIAL_VERSION,
  ProjectVersion,
  VERSIONED_ENTITIES,
  VcsRefKind,
  VcsRefState,
  VcsType,
  type AcceptanceCriterion,
  type Adr as TAdr,
  type ProjectVersion as TProjectVersion,
  type VersionedEntity,
  type Component as TComponent,
  type Execution,
  type Phase,
  type Requirement,
  type Scenario as TScenario,
  type Screen as TScreen,
  type ScreenStoryLink,
  type UserStory,
  type VcsRef,
} from "./schema.js";
import { SEMVER_RE } from "./schema.js";
import { bumpSemver, compareSemver } from "./versioning.js";
import { diffVersions } from "./version-diff.js";
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
import { htmlVersion, parseScreenHtml } from "./screen-html.js";
import {
  checkUiCoverage,
  isStale,
  resolveElements,
  screenExits,
  screensForStory,
  staleScreens,
} from "./screen-coverage.js";
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

/** Server version, read from package.json so it cannot drift. */
const PKG_VERSION: string = (JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string }).version;

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

type AnyStore = SqliteStore | PostgresStore;

// ===========================================================================
// Project resolution
// ===========================================================================

/**
 * Projects are addressed by `key` only. There is deliberately no filesystem
 * resolution: requ-mcp is a server, and guessing a project from the server's
 * cwd or workspace roots is how a caller silently ends up on the wrong store.
 */

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

async function getStore(_server: McpServer, explicit?: string, allowCreate = false): Promise<AnyStore> {
  {
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
      // SQLite HTTP (no Postgres): projects are addressed by key/slug, resolved
      // against the pre-loaded registry above. A key is never a filesystem path,
      // so an unknown selector cannot mint a new store here.
      throw new Error(
        `Unknown project '${explicit}'. Known: [${[..._stores.keys()].join(", ")}]. ` +
          `Key-based project creation requires Postgres (set REQU_PG_URL).`,
      );
    }

    // No explicit selector.
    if (usePg) await attachAllDbProjects();
    if (_stores.size === 1) return [..._stores.values()][0];
    if (_stores.size === 0) {
      // Never derive a project from cwd or a workspace root — that mints a
      // phantom project named after the server's directory. Require a key.
      throw new Error(
        usePg
          ? "No requ project exists; run init_project with an explicit `key`."
          : "No projects configured. Set REQU_PROJECTS to the project root(s), or use Postgres (REQU_PG_URL) for key-based projects.",
      );
    }
    throw new Error(
      `Multiple projects loaded; pass \`key\` to select one. Known: [${[..._stores.keys()].join(", ")}]. ` +
        "(`projectPath` was removed in 1.0 — projects are addressed by key.)",
    );
  }
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
  return null;
}

const keySchema = z
  .string()
  .optional()
  .describe(
    "Project key identifying the target project (HTTP mode). In HTTP mode the server is the store, so projects are addressed by this key instead of a filesystem path.",
  );

/**
 * Resolve the project selector to pass to getStore for a given tool call.
 *
 * There is no local filesystem to resolve against: the project is identified by
 * its `key`, never by a path, so a stale or auto-detected path can never
 * silently clobber the wrong project.
 */
function selectorFor(toolName: string, args: any): string | undefined {
  if (toolName === "init_project" && !args.key) {
    throw new Error(
      "init_project requires a `key` to identify the project. " +
        "(`projectPath` was removed in 1.0 — requ-mcp is an HTTP server and never resolves projects from the filesystem.)",
    );
  }
  return args.key;
}

const versionSchema = z
  .string()
  .optional()
  .describe(
    "Specification version to address, e.g. '1.2.0'. Omit to use the project's " +
      "default: the open draft for specification edits, the current locked baseline " +
      "for reads and for recording progress.",
  );

/**
 * Resolve which version a tool call targets, and return a store bound to it.
 *
 * Precedence: an explicit `version` argument, then the project pointer that suits
 * the tool (`draftVersion` for specification edits, `currentVersion` otherwise),
 * then the initial version. Every read and write below this point is confined to
 * that one baseline.
 */
async function bindVersion(
  store: AnyStore,
  explicit: string | undefined,
  mutates: Mutates | undefined,
  toolName: string,
): Promise<AnyStore> {
  // init_project creates the project (and its first version), so there is nothing
  // to resolve against yet.
  if (toolName === "init_project") return store;

  let cfg: Awaited<ReturnType<AnyStore["readConfig"]>> | null = null;
  try {
    cfg = await store.readConfig();
  } catch {
    return store; // uninitialized — the tool itself will report that
  }

  const target =
    explicit ??
    (mutates === "spec"
      ? cfg.draftVersion ?? cfg.currentVersion
      : cfg.currentVersion ?? cfg.draftVersion) ??
    INITIAL_VERSION;

  const known = await store.listVersions();
  if (known.length && !known.some((v) => v.version === target)) {
    throw new Error(
      `Unknown version '${target}'. Known: [${known.map((v) => v.version).join(", ")}].`,
    );
  }

  // A specification edit aimed at a locked baseline is almost always a mistake:
  // say so here rather than letting the store reject each field one at a time.
  // lock_version is exempt: locking an already-locked version is a no-op it
  // reports for itself, not an error.
  if (mutates === "spec" && !explicit && toolName !== "lock_version") {
    const row = known.find((v) => v.version === target);
    if (row?.status === "locked") {
      throw new Error(
        `Version ${target} is locked and no draft is open. ` +
          `Run create_version to start the next version, then retry.`,
      );
    }
  }

  return store.at(target) as AnyStore;
}

/** Sole open draft of a project, if there is one. */
async function openDraft(store: AnyStore): Promise<TProjectVersion | null> {
  const versions = await store.listVersions();
  return versions.find((v) => v.status === "draft") ?? null;
}

type Handler = (args: any, store: AnyStore) => Promise<unknown>;

/**
 * What a tool does to the data, which decides the version it defaults to.
 *
 *  - `spec`     — edits the specification. Defaults to the open draft, because
 *                 that is where new scope is written.
 *  - `progress` — records how far delivery has got (test runs, VCS links).
 *                 Defaults to the *current* baseline: the team reports progress
 *                 against the version they are building, which is usually locked.
 *  - undefined  — a read. Defaults to the current baseline.
 */
type Mutates = "spec" | "progress";

type ToolDef = {
  name: string;
  config: { title?: string; description?: string; inputSchema?: Record<string, z.ZodTypeAny> };
  handler: Handler;
  mutates?: Mutates;
};

/**
 * All tool definitions, collected once at module load. They are registered onto a
 * fresh `McpServer` by `createServer()` — one server instance per stdio process or
 * per HTTP session — so a single server is never connected to two transports.
 */
const toolDefs: ToolDef[] = [];

/** Collect a tool definition that auto-injects `key` and resolves the store. */
function tool(
  name: string,
  config: { title?: string; description?: string; inputSchema?: Record<string, z.ZodTypeAny> },
  handler: Handler,
  mutates?: Mutates,
) {
  toolDefs.push({ name, config, handler, mutates });
}

/** Build a fresh McpServer with every collected tool registered on it. */
function createServer(): McpServer {
  const server = new McpServer({ name: "requ-mcp", version: PKG_VERSION });
  for (const { name, config, handler, mutates } of toolDefs) {
    const base = config.inputSchema ?? {};
    const inputSchema: Record<string, z.ZodTypeAny> = { ...base };
    // Every tool accepts `key` as the HTTP-mode project identifier. Tools that
    // already declare their own `key` (e.g. init_project) keep their definition.
    if (!("key" in inputSchema)) inputSchema.key = keySchema;
    // …and `version` to address a specification baseline. Omitted, it resolves to
    // the project's draft (for specification edits) or current version (otherwise).
    if (!("version" in inputSchema)) inputSchema.version = versionSchema;
    server.registerTool(
      name,
      { title: config.title, description: config.description, inputSchema },
      async (args: any) => {
        try {
          const selector = selectorFor(name, args);
          const store = await getStore(server, selector, name === "init_project");
          const bound = await bindVersion(store, args.version, mutates, name);
          return (await handler(args, bound)) as ReturnType<typeof json>;
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
      `requ project not initialized. Run \`init_project\` first with the project's \`key\`.`,
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

/**
 * The server reads feature files, mockups and reports from its OWN disk, so a
 * path the server cannot see must fail loudly. Returning an empty result reads
 * as "there is nothing there", which is indistinguishable from a missing mount
 * and is exactly the kind of silence that sends callers down the wrong path.
 */
async function unreadablePath(p: string, what: string) {
  try {
    await fs.access(p);
    return null;
  } catch {
    return fail(`${what} is not readable by the server at '${p}'.`, {
      resolvedPath: p,
      hint: "requ-mcp reads this from its own filesystem. Check the path is correct and, when running in a container, that the workspace is mounted and the configured path is the one the container sees.",
    });
  }
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
      uiPlatforms: z.array(ScreenPlatform).optional().describe("Platforms every story is expected to be materialized on (mobile/web/desktop/tablet), unless the story overrides them. Drives the per-platform screen coverage check."),
      force: z.boolean().optional().describe("Initialize even if the Conductor folder is missing or not a Conductor project."),
    },
  },
  async (args, store) => {
    const existing = (await store.isInitialized()) ? await store.readConfig() : null;
    const conductorPath = args.conductorPath ?? existing?.conductorPath ?? ".";

    // DB-native HTTP projects have no filesystem Conductor folder; skip the hard check.
    const isHttpPg = !!process.env.REQU_PG_URL;
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
      uiPlatforms: args.uiPlatforms ?? existing?.uiPlatforms,
      // A new project opens on an editable 1.0.0; both pointers aim at it until
      // it is locked and a successor is created.
      currentVersion: existing?.currentVersion ?? INITIAL_VERSION,
      draftVersion:   existing?.draftVersion   ?? INITIAL_VERSION,
    };
    await store.init(config);
    if (!(await store.getVersion(config.draftVersion))) {
      await store.writeVersion({
        version: config.draftVersion,
        status: "draft",
        label: "Initial version",
        createdAt: now(),
      });
    }
    let phase: Phase | undefined;
    if (args.initialPhase) {
      phase = {
        id: "P1",
        name: args.initialPhase,
        order: 1,
        status: "active",
        description: "",
        removed: false,
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
// Versions
// ===========================================================================

tool(
  "list_versions",
  {
    title: "List Specification Versions",
    description:
      "List every specification version (baseline) of the project, oldest first, " +
      "with its lock state, label, parent and audit trail. Also reports which " +
      "version reads default to (current) and which specification edits go to (draft).",
    inputSchema: {},
  },
  async (_args, store) => {
    const versions = await store.listVersions();
    const cfg = await store.readConfig();
    return json({
      currentVersion: cfg.currentVersion ?? null,
      draftVersion: cfg.draftVersion ?? null,
      versions,
    });
  },
);

tool(
  "create_version",
  {
    title: "Create the Next Specification Version",
    description:
      "Branch a new, editable specification version from an existing one, copying " +
      "every requirement, story, screen, ADR, component and phase. Use this after " +
      "locking a baseline so the BA can prepare the next scope without disturbing " +
      "the version a team is currently building. Only one draft may be open at a " +
      "time: lock the open draft first. Give either an explicit version or a bump.",
    inputSchema: {
      from: z.string().optional().describe("Version to branch from. Defaults to the current baseline."),
      version: z.string().optional().describe("Explicit semver for the new version, e.g. '2.0.0'."),
      bump: z.enum(["major", "minor", "patch"]).optional().describe("Derive the new version from 'from' by bumping this part. Defaults to 'minor'."),
      label: z.string().optional().describe("Human label, e.g. 'Q3 scope'."),
      actor: z.string().optional().describe("Who is creating this version, recorded for traceability."),
      reason: z.string().optional().describe("Why this version is being created."),
      setDraft: z.boolean().optional().describe("Point the project's draft pointer at the new version. Default true."),
    },
  },
  async (args, store) => {
    const cfg = await store.readConfig();
    const existing = await store.listVersions();

    const draft = existing.find((v) => v.status === "draft");
    if (draft) {
      return fail(
        `Version ${draft.version} is still an open draft. Lock it before creating the next version, ` +
          `so exactly one version is editable at a time.`,
      );
    }

    const from = args.from ?? cfg.currentVersion ?? cfg.draftVersion ?? INITIAL_VERSION;
    const parent = existing.find((v) => v.version === from);
    if (existing.length && !parent) {
      return fail(`Unknown source version '${from}'. Known: [${existing.map((v) => v.version).join(", ")}].`);
    }

    let target: string;
    if (args.version) {
      if (!SEMVER_RE.test(args.version)) return fail(`'${args.version}' is not a semver like 1.2.0.`);
      target = args.version;
    } else {
      target = bumpSemver(from, args.bump ?? "minor");
    }
    if (existing.some((v) => v.version === target)) return fail(`Version ${target} already exists.`);
    if (compareSemver(target, from) <= 0) {
      return fail(`New version ${target} must be greater than its parent ${from}.`);
    }

    // Copy first, register second: a half-copied version that is not in the
    // registry is invisible, whereas a registered empty one would look valid.
    let counts: Record<string, number>;
    try {
      counts = await store.copyVersion(from, target);
      await store.writeVersion({
        version: target,
        status: "draft",
        label: args.label ?? "",
        parent: from,
        createdAt: now(),
        actor: args.actor,
        reason: args.reason,
      });
    } catch (e) {
      await store.dropVersion(target).catch(() => {});
      return fail(`Could not create version ${target}: ${(e as Error).message}`);
    }

    if (args.setDraft !== false) {
      await store.writeConfig({ ...cfg, draftVersion: target });
    }

    return json({
      created: target,
      from,
      status: "draft",
      copied: counts,
      draftVersion: args.setDraft !== false ? target : (cfg.draftVersion ?? null),
      currentVersion: cfg.currentVersion ?? null,
    });
  },
);

tool(
  "lock_version",
  {
    title: "Lock a Specification Version",
    description:
      "Freeze a version's specification so a team can build against a stable " +
      "baseline. Once locked, requirements, stories, screens, ADRs, components and " +
      "phases can no longer be edited in it — only progress fields (statuses, " +
      "ADR supersession) stay writable, along with test executions and VCS links. " +
      "Locking also makes this version the project's current baseline for reads.",
    inputSchema: {
      actor: z.string().optional().describe("Who is locking, recorded for traceability."),
      reason: z.string().optional().describe("Why this baseline is being frozen."),
      setCurrent: z.boolean().optional().describe("Make this the current baseline for reads. Default true."),
    },
  },
  async (args, store) => {
    const target = await store.version();
    const row = await store.getVersion(target);
    if (!row) return fail(`Version ${target} is not registered. Run list_versions to see what exists.`);
    if (row.status === "locked") return json({ version: target, status: "locked", alreadyLocked: true });

    await store.writeVersion({ ...row, status: "locked", lockedAt: now(), actor: args.actor ?? row.actor, reason: args.reason ?? row.reason });

    const cfg = await store.readConfig();
    const next = { ...cfg };
    if (args.setCurrent !== false) next.currentVersion = target;
    // The draft pointer no longer has anywhere to go: create_version reopens one.
    if (cfg.draftVersion === target) next.draftVersion = undefined;
    await store.writeConfig(next);

    return json({
      version: target,
      status: "locked",
      currentVersion: next.currentVersion ?? null,
      draftVersion: next.draftVersion ?? null,
      hint: "Specification edits now require a new version — run create_version.",
    });
  },
  "spec",
);

tool(
  "unlock_version",
  {
    title: "Unlock a Specification Version",
    description:
      "Reopen a locked version for editing. This is an escape hatch for correcting " +
      "a mistake in a freshly locked baseline: anyone already building against it " +
      "will see the specification change underneath them, so prefer create_version. " +
      "Requires force:true, and the reason is recorded in the version's audit trail.",
    inputSchema: {
      force: z.boolean().optional().describe("Must be true — confirms you accept that a published baseline will change."),
      actor: z.string().optional().describe("Who is unlocking, recorded for traceability."),
      reason: z.string().optional().describe("Why the baseline is being reopened."),
    },
  },
  async (args, store) => {
    const target = await store.version();
    const row = await store.getVersion(target);
    if (!row) return fail(`Version ${target} is not registered.`);
    if (row.status !== "locked") return json({ version: target, status: row.status, alreadyOpen: true });
    if (args.force !== true) {
      return fail(
        `Unlocking ${target} changes a baseline a team may already be building against. ` +
          `Prefer create_version to put the change in the next version. Pass force:true to unlock anyway.`,
      );
    }

    const other = (await store.listVersions()).find((v) => v.status === "draft");
    if (other) {
      return fail(
        `Version ${other.version} is already an open draft. Only one version may be editable at a time.`,
      );
    }

    await store.writeVersion({
      ...row,
      status: "draft",
      unlockedAt: now(),
      actor: args.actor ?? row.actor,
      reason: args.reason ?? row.reason,
    });

    const cfg = await store.readConfig();
    await store.writeConfig({ ...cfg, draftVersion: target });

    return json({ version: target, status: "draft", draftVersion: target, forced: true });
  },
);

tool(
  "set_active_version",
  {
    title: "Set the Active Version",
    description:
      "Change which version the project defaults to. 'current' is what reads and " +
      "progress updates target; 'draft' is where specification edits go. Individual " +
      "tool calls can still override this with their own version parameter.",
    inputSchema: {
      current: z.string().optional().describe("Version reads default to."),
      draft: z.string().optional().describe("Version specification edits default to. Must be an unlocked version."),
    },
  },
  async (args, store) => {
    if (!args.current && !args.draft) return fail("Give current, draft, or both.");
    const known = await store.listVersions();
    const byId = new Map(known.map((v) => [v.version, v]));

    for (const [field, value] of [["current", args.current], ["draft", args.draft]] as const) {
      if (value && known.length && !byId.has(value)) {
        return fail(`Unknown version '${value}' for ${field}. Known: [${known.map((v) => v.version).join(", ")}].`);
      }
    }
    if (args.draft && byId.get(args.draft)?.status === "locked") {
      return fail(`Version ${args.draft} is locked and cannot be the draft. Unlock it or create a new version.`);
    }

    const cfg = await store.readConfig();
    const next = {
      ...cfg,
      currentVersion: args.current ?? cfg.currentVersion,
      draftVersion: args.draft ?? cfg.draftVersion,
    };
    await store.writeConfig(next);
    return json({ currentVersion: next.currentVersion ?? null, draftVersion: next.draftVersion ?? null });
  },
);

tool(
  "diff_versions",
  {
    title: "Diff Two Specification Versions",
    description:
      "Compare two versions and report what was added, removed and modified per " +
      "entity type, down to individual fields. Use it to review the scope change " +
      "between the baseline a team is building and the next one being prepared.",
    inputSchema: {
      from: z.string().describe("Baseline version, e.g. '1.0.0'."),
      to: z.string().optional().describe("Version to compare against. Defaults to the open draft, or the current baseline."),
      entity: z.enum(VERSIONED_ENTITIES).optional().describe("Restrict the report to one entity type."),
      fields: z.boolean().optional().describe("Include field-level before/after values for modified entities. Default true."),
    },
  },
  async (args, store) => {
    const known = await store.listVersions();
    const cfg = await store.readConfig();
    const to = args.to ?? cfg.draftVersion ?? cfg.currentVersion ?? (await store.version());
    for (const v of [args.from, to]) {
      if (known.length && !known.some((k) => k.version === v)) {
        return fail(`Unknown version '${v}'. Known: [${known.map((k) => k.version).join(", ")}].`);
      }
    }
    if (args.from === to) return fail(`from and to are both '${to}'.`);

    const diff = await diffVersions(store, args.from, to, { includeFieldChanges: args.fields !== false });
    if (!args.entity) return json(diff);
    return json({
      from: diff.from,
      to: diff.to,
      identical: diff.summary[args.entity].added === 0 && diff.summary[args.entity].removed === 0 && diff.summary[args.entity].modified === 0,
      summary: { [args.entity]: diff.summary[args.entity] },
      entities: { [args.entity]: diff.entities[args.entity] },
    });
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
      removed:     false,
      createdAt:   now(),
      updatedAt:   now(),
    };
    await store.writeComponent(comp);
    return json(comp);
  },
  "spec",
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
  "spec",
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
    // Ids are allocated across every version, so REQ-060 never means two things.
    const id = args.id ?? nextId("REQ", await store.idsAcrossVersions("requirements"));
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
      removed: false,
      ...(phase.value ? { phase: phase.value } : {}),
      createdAt: now(),
      updatedAt: now(),
    };
    await store.writeRequirement(req);
    return json(req);
  },
  "spec",
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
  "spec",
);

tool(
  "assign_requirements_to_phase",
  {
    title: "Assign requirements to a phase in bulk",
    description:
      "Move many requirements onto one phase in a single call. Select them either explicitly by `ids`, or by a filter (status / component / tag / current phase) — exactly one of the two. Pass phase '' to clear the assignment. Reports what moved and what was already there; nothing is written when any explicit id is unknown.",
    inputSchema: {
      phase: z.string().describe("Target phase id (e.g. 'P1'). Pass '' to unassign."),
      ids: z.array(z.string().regex(/^REQ-\d+$/)).optional()
        .describe("Explicit requirement ids. Mutually exclusive with the filter fields."),
      status: RequirementStatus.optional().describe("Filter: only requirements with this status."),
      component: z.string().optional().describe("Filter: only requirements listing this component."),
      tag: z.string().optional().describe("Filter: only requirements carrying this tag."),
      fromPhase: z.string().optional()
        .describe("Filter: only requirements currently on this phase. Pass '' for the unassigned ones."),
      dryRun: z.boolean().optional().describe("Report what would change without writing."),
    },
  },
  async (args, store) => {
    await ensureInit(store);

    const hasFilter = args.status !== undefined || args.component !== undefined
      || args.tag !== undefined || args.fromPhase !== undefined;
    if (args.ids && hasFilter) {
      return fail("Pass either `ids` or the filter fields, not both.");
    }
    if (!args.ids && !hasFilter) {
      return fail("Nothing selected. Pass `ids`, or at least one of status / component / tag / fromPhase.", {
        hint: "To sweep up the unassigned requirements, pass fromPhase: ''.",
      });
    }

    // Validate the target phase once, up front.
    if (args.phase !== "") {
      const error = await phaseError(store, args.phase);
      if (error) return error;
    }

    const all = await store.listRequirements();
    let targets: Requirement[];
    if (args.ids) {
      const byId = new Map(all.map((r) => [r.id, r]));
      const missing = args.ids.filter((id: string) => !byId.has(id));
      // All-or-nothing on explicit ids: a typo should not half-apply a bulk move.
      if (missing.length) return fail(`Unknown requirement id(s): ${missing.join(", ")}`);
      targets = args.ids.map((id: string) => byId.get(id)!);
    } else {
      targets = all.filter((r) => {
        if (args.status    !== undefined && r.status !== args.status) return false;
        if (args.component !== undefined && !r.components.includes(args.component)) return false;
        if (args.tag       !== undefined && !r.tags.includes(args.tag)) return false;
        if (args.fromPhase !== undefined && (r.phase ?? "") !== args.fromPhase) return false;
        return true;
      });
    }

    const next = args.phase === "" ? undefined : args.phase;
    const moved: string[] = [];
    let unchanged = 0;
    for (const req of targets) {
      if ((req.phase ?? undefined) === next) { unchanged++; continue; }
      moved.push(req.id);
      if (args.dryRun) continue;
      req.phase = next;
      req.updatedAt = now();
      await store.writeRequirement(req);
    }

    return json({
      phase: next ?? null,
      selected: targets.length,
      moved: moved.length,
      unchanged,
      movedIds: moved,
      dryRun: !!args.dryRun,
    });
  },
  "spec",
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
      platforms: z.array(ScreenPlatform).optional().describe("UI platforms this story must be materialized on (mobile/web/desktop/tablet). Drives the per-platform screen coverage check; defaults to config.uiPlatforms."),
      dataFields: z.array(z.string()).optional().describe("Data-model fields the story touches, e.g. ['guestCount']. Each must surface in at least one linked screen."),
      id: z.string().regex(/^US-\d+$/).optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const missing: string[] = [];
    for (const reqId of args.requirements) if (!(await store.getRequirement(reqId))) missing.push(reqId);
    if (missing.length) return fail(`Unknown requirement(s): ${missing.join(", ")}`);

    const existing = await store.listStories();
    const id = args.id ?? nextId("US", await store.idsAcrossVersions("stories"));
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
      platforms: args.platforms ?? [],
      dataFields: args.dataFields ?? [],
      removed: false,
      createdAt: now(),
      updatedAt: now(),
    };
    await store.writeStory(story);
    return json({ ...story, hint: `Tag scenarios with @${id} in your feature files to link tests to this story.` });
  },
  "spec",
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
    const screens = screensForStory(await store.listScreens(), args.id);
    return json({
      ...story,
      statusPhase: phaseId,
      screens: screens.map((sc) => ({
        id: sc.id,
        name: sc.name,
        platform: sc.platform,
        kind: sc.kind,
        role: sc.stories.find((l) => l.id === args.id)?.role ?? "primary",
        status: sc.status,
        stale: isStale(sc, new Map([[story.id, story]])),
      })),
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
      platforms: z.array(ScreenPlatform).optional().describe("UI platforms this story must be materialized on."),
      dataFields: z.array(z.string()).optional().describe("Data-model fields the story touches."),
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
    if (args.platforms !== undefined) story.platforms = args.platforms;
    if (args.dataFields !== undefined) story.dataFields = args.dataFields;
    story.updatedAt = now();
    await store.writeStory(story);
    return json(story);
  },
  "spec",
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
  "spec",
);

tool(
  "delete_acceptance_criterion",
  {
    title: "Delete acceptance criterion",
    description:
      "Remove an acceptance criterion from a story by its criterion id (e.g. 'AC-2'). " +
      "Remaining criteria keep their ids — they are never renumbered — so a later " +
      "`add_acceptance_criterion` still allocates the next unused number.",
    inputSchema: {
      storyId: z.string().regex(/^US-\d+$/),
      criterionId: z.string().regex(/^AC-\d+$/).describe("Criterion id to remove, e.g. 'AC-2'."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const story = await store.getStory(args.storyId);
    if (!story) return fail(`Story ${args.storyId} not found.`);
    const idx = story.acceptanceCriteria.findIndex((c) => c.id === args.criterionId);
    if (idx === -1) {
      return fail(`Criterion ${args.criterionId} not found on ${args.storyId}.`, {
        knownCriteria: story.acceptanceCriteria.map((c) => c.id),
      });
    }
    const [removed] = story.acceptanceCriteria.splice(idx, 1);
    story.updatedAt = now();
    await store.writeStory(story);
    return json({ deleted: true, storyId: args.storyId, criterion: removed, remaining: story.acceptanceCriteria });
  },
  "spec",
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
      removed:     false,
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
  "spec",
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
  "spec",
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
  "progress",
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

    // Legacy: scan feature files on disk. Reached only when no scenarios are
    // stored, so an unreadable folder here is the whole answer — say so.
    const conductorRoot = await store.conductorRoot();
    const unreadable = await unreadablePath(conductorRoot, "The Conductor folder");
    if (unreadable) return unreadable;
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
    const conductorRoot = await store.conductorRoot();
    const unreadable = await unreadablePath(conductorRoot, "The Conductor folder");
    if (unreadable) return unreadable;
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
  "spec",
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
  "spec",
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
  "spec",
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
  "spec",
);

// ===========================================================================
// Screens (UI specifications / HTML mockups)
// ===========================================================================

/** Read a mockup file from the repo, resolved against the project root. */
async function readMockupFile(store: AnyStore, mockupPath: string): Promise<string | null> {
  try {
    return await fs.readFile(store.resolvePath(mockupPath), "utf8");
  } catch {
    return null;
  }
}

/** Story ids referenced by a screen's links that don't exist. */
async function unknownScreenStories(store: AnyStore, ids: string[]): Promise<string[]> {
  const known = new Set((await store.listStories()).map((s) => s.id));
  return ids.filter((id) => !known.has(id));
}

/** Screen view without the (potentially large) mockup body. */
function screenSummary(sc: TScreen, storyById: Map<string, UserStory>, screenById: Map<string, TScreen>) {
  const { html, elements, ...meta } = sc;
  return {
    ...meta,
    elementCount: resolveElements(sc, screenById).length,
    exits: screenExits(sc, screenById),
    stale: isStale(sc, storyById),
    hasHtml: html.length > 0,
  };
}

tool(
  "create_or_update_screen",
  {
    title: "Create / update a screen",
    description:
      "Publish or regenerate a UI specification: a self-contained static HTML mockup plus its metadata, linked to the " +
      "user stories it materializes. Upserts by id (SCR-… for a screen, UIC-… for a shared component). Pass `html` " +
      "inline, or `mockupPath` to read the file from the repo. The `data-req-*` attributes are parsed into traceable " +
      "elements on every write, and the linked stories' versions are snapshotted so later spec changes mark the screen stale.",
    inputSchema: {
      id:          z.string().describe("Stable, readable id — e.g. 'SCR-BOOK-DETAIL-MOB' (screen) or 'UIC-BOOKING-CARD' (shared component)."),
      name:        z.string().min(1).optional().describe("Functional name of the screen. Required on creation."),
      kind:        ScreenKind.optional().describe("'screen' or 'component' (shared, referenced by screens). Defaults from the id prefix."),
      platform:    ScreenPlatform.optional().describe("mobile | web | desktop | tablet. Required for a screen."),
      phase:       z.string().optional().describe("Delivery phase (e.g. 'P1'). Defaults to the active phase; pass '' to leave unassigned."),
      description: z.string().optional().describe("Intent of the screen and its usage context."),
      html:        z.string().optional().describe("Full static HTML of the mockup (self-contained: inline CSS, no build)."),
      mockupPath:  z.string().optional().describe("Repo path of the mockup file. Read at write time; re-read by get_screen_html."),
      version:     z.string().optional().describe("Semver or hash. Defaults to a content hash of the HTML."),
      status:      ScreenStatus.optional().describe("draft | reviewed_qa | validated_ops | obsolete."),
      stories:     z.array(z.object({
                     id:   z.string().regex(/^US-\d+$/),
                     role: ScreenLinkRole.optional().describe("primary | secondary | entry | confirmation."),
                   })).optional().describe("Stories this screen materializes. Replaces the existing link set."),
      uses:        z.array(z.string()).optional().describe("Shared component ids embedded by this screen (merged with data-req-component refs)."),
      exits:       z.array(z.string()).optional().describe("Screen ids reachable from here (merged with data-req-target refs)."),
      terminal:    z.boolean().optional().describe("Marks an intentional end of flow, exempt from the dead-end check."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    if (!SCREEN_ID_RE.test(args.id)) {
      return fail(
        `Invalid screen id '${args.id}'. Use SCR-… for a screen or UIC-… for a shared component, uppercase, e.g. 'SCR-BOOK-DETAIL-MOB'.`,
      );
    }
    const existing = await store.getScreen(args.id);
    if (!existing && !args.name) return fail(`'name' is required when creating screen ${args.id}.`);

    // Resolve the mockup body: inline html wins, else read the repo file.
    let html = existing?.html ?? "";
    let regenerated = false;
    if (args.html !== undefined) {
      html = args.html;
      regenerated = true;
    } else if (args.mockupPath !== undefined) {
      const fromFile = await readMockupFile(store, args.mockupPath);
      if (fromFile === null) {
        if (!existing) {
          return fail(`Cannot read mockup file '${args.mockupPath}' — the server resolved it to '${store.resolvePath(args.mockupPath)}' and cannot read it.`, {
            resolvedPath: store.resolvePath(args.mockupPath),
            hint: "requ-mcp reads this from its own filesystem (check the container mount), or pass `html` inline instead.",
          });
        }
      } else {
        html = fromFile;
        regenerated = true;
      }
    }

    // undefined → active phase for a new screen, but an existing screen keeps what
    // it has (including "unassigned", which must not drift onto the active phase).
    const phaseInput = args.phase !== undefined ? args.phase : existing ? (existing.phase ?? "") : undefined;
    const phase = await resolveAssignedPhase(store, phaseInput);
    if (phase.error) return phase.error;

    // Links: an explicit list replaces the set; otherwise keep what's stored.
    const links: ScreenStoryLink[] = args.stories
      ? args.stories.map((l: { id: string; role?: ScreenStoryLink["role"] }) => ({ id: l.id, role: l.role ?? "primary" }))
      : (existing?.stories ?? []);
    const unknown = await unknownScreenStories(store, links.map((l) => l.id));
    if (unknown.length) {
      return fail(`Unknown story/stories: ${unknown.join(", ")}. Create them first with create_user_story.`);
    }

    const parsed = parseScreenHtml(html);
    const uses = [...new Set([...(args.uses ?? existing?.uses ?? []), ...parsed.componentRefs])];
    const exits = [...new Set([...(args.exits ?? existing?.exits ?? []), ...parsed.targets])];

    // Snapshot the linked stories' versions: a full snapshot when the mockup was
    // (re)generated, otherwise only for links added by this call — so a metadata
    // edit (e.g. a status change) never silently clears a real staleness flag.
    const stories = await store.listStories();
    const storyById = new Map(stories.map((s) => [s.id, s]));
    const storyVersions: Record<string, string> = {};
    for (const link of links) {
      const previous = existing?.storyVersions?.[link.id];
      storyVersions[link.id] =
        (!regenerated && previous !== undefined ? previous : storyById.get(link.id)?.updatedAt) ?? "";
    }

    const ts = now();
    const screen: TScreen = {
      id: args.id,
      kind: args.kind ?? existing?.kind ?? kindFromScreenId(args.id),
      name: args.name ?? existing!.name,
      platform: args.platform ?? existing?.platform,
      phase: phase.value,
      description: args.description ?? existing?.description ?? "",
      mockupPath: args.mockupPath ?? existing?.mockupPath,
      html,
      version: args.version ?? (regenerated || !existing ? htmlVersion(html) : existing.version),
      status: args.status ?? existing?.status ?? "draft",
      stories: links,
      uses,
      exits,
      terminal: args.terminal ?? existing?.terminal ?? false,
      elements: parsed.elements,
      storyVersions,
      removed: existing?.removed ?? false,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    await store.writeScreen(screen);

    const screenById = new Map((await store.listScreens()).map((s) => [s.id, s]));
    return json({
      screen: screenSummary(screen, storyById, screenById),
      elements: parsed.elements,
      warnings: {
        duplicateElementIds: parsed.duplicates,
        untracedElements: parsed.elements.filter((e) => e.stories.length === 0).map((e) => e.el),
        unknownComponents: uses.filter((id) => !screenById.has(id)),
        noElements: parsed.elements.length === 0,
      },
      hint: "Run check_ui_coverage to validate the UI traceability graph for this phase.",
    });
  },
  "spec",
);

tool(
  "list_screens",
  {
    title: "List screens",
    description:
      "List screens and shared components with their linked stories, element counts and staleness. " +
      "Filters combine with AND. The mockup body is omitted unless includeHtml=true.",
    inputSchema: {
      phase:    z.string().optional().describe("Phase id (exact match on the screen's own phase)."),
      platform: ScreenPlatform.optional(),
      status:   ScreenStatus.optional(),
      kind:     ScreenKind.optional(),
      story:    z.string().regex(/^US-\d+$/).optional().describe("Only screens linked to this story."),
      stale:    z.boolean().optional().describe("Only screens whose linked stories changed since generation (or only fresh ones)."),
      q:        z.string().optional().describe("Case-insensitive substring over id, name and description."),
      includeHtml: z.boolean().optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const [screens, stories] = await Promise.all([store.listScreens(), store.listStories()]);
    const storyById = new Map(stories.map((s) => [s.id, s]));
    const screenById = new Map(screens.map((s) => [s.id, s]));
    const q = args.q?.toLowerCase();

    const rows = screens
      .filter((sc) => {
        if (args.phase && sc.phase !== args.phase) return false;
        if (args.platform && sc.platform !== args.platform) return false;
        if (args.status && sc.status !== args.status) return false;
        if (args.kind && sc.kind !== args.kind) return false;
        if (args.story && !sc.stories.some((l) => l.id === args.story)) return false;
        if (args.stale !== undefined && isStale(sc, storyById) !== args.stale) return false;
        if (q && !`${sc.id}\n${sc.name}\n${sc.description}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .map((sc) => ({
        ...screenSummary(sc, storyById, screenById),
        ...(args.includeHtml ? { html: sc.html } : {}),
      }));
    return json(rows);
  },
);

tool(
  "get_screen",
  {
    title: "Get a screen",
    description:
      "Fetch one screen with its resolved elements (its own plus those of the shared components it embeds), its exits, " +
      "the stories it materializes, and whether it has drifted from its specs. Use get_screen_html for the mockup body.",
    inputSchema: {
      id: z.string().describe("Screen id, e.g. 'SCR-BOOK-DETAIL-MOB'."),
      includeHtml: z.boolean().optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const sc = await store.getScreen(args.id);
    if (!sc) return fail(`Screen ${args.id} not found.`);
    const [screens, stories] = await Promise.all([store.listScreens(), store.listStories()]);
    const storyById = new Map(stories.map((s) => [s.id, s]));
    const screenById = new Map(screens.map((s) => [s.id, s]));
    return json({
      ...screenSummary(sc, storyById, screenById),
      elements: resolveElements(sc, screenById),
      stories: sc.stories.map((l) => ({
        id: l.id,
        role: l.role,
        title: storyById.get(l.id)?.title ?? null,
        exists: storyById.has(l.id),
        drifted: storyById.get(l.id) ? sc.storyVersions[l.id] !== storyById.get(l.id)!.updatedAt : false,
      })),
      usedBy: screens.filter((s) => s.uses.includes(sc.id)).map((s) => s.id),
      ...(args.includeHtml ? { html: sc.html } : {}),
    });
  },
);

tool(
  "get_screen_html",
  {
    title: "Get a screen's mockup HTML",
    description:
      "Return the mockup body of a screen, for an agent to derive step definitions from (bind steps to `data-req-el`, " +
      "never to CSS selectors or visible text). Re-reads the file when the screen has a mockupPath and it is readable, " +
      "otherwise returns the copy stored in requ.",
    inputSchema: { id: z.string(), elements: z.boolean().optional().describe("Also return the parsed traced elements.") },
  },
  async (args, store) => {
    await ensureInit(store);
    const sc = await store.getScreen(args.id);
    if (!sc) return fail(`Screen ${args.id} not found.`);
    let html = sc.html;
    let source: "file" | "stored" = "stored";
    if (sc.mockupPath) {
      const fromFile = await readMockupFile(store, sc.mockupPath);
      if (fromFile !== null) { html = fromFile; source = "file"; }
    }
    const screenById = new Map((await store.listScreens()).map((s) => [s.id, s]));
    return json({
      id: sc.id,
      name: sc.name,
      platform: sc.platform,
      version: sc.version,
      status: sc.status,
      source,
      mockupPath: sc.mockupPath ?? null,
      html,
      ...(args.elements ? { elements: resolveElements(sc, screenById) } : {}),
    });
  },
);

tool(
  "get_screens_for_story",
  {
    title: "Get the screens of a story",
    description:
      "The reference screens that materialize a story, grouped by platform — what a test agent reads alongside the " +
      "acceptance criteria before generating scenarios and step definitions.",
    inputSchema: {
      story_id: z.string().regex(/^US-\d+$/),
      includeHtml: z.boolean().optional(),
      includeElements: z.boolean().optional().describe("Include each screen's traced elements (default true)."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const story = await store.getStory(args.story_id);
    if (!story) return fail(`Story ${args.story_id} not found.`);
    const screens = await store.listScreens();
    const screenById = new Map(screens.map((s) => [s.id, s]));
    const linked = screensForStory(screens, args.story_id);
    const withElements = args.includeElements !== false;

    const byPlatform: Record<string, unknown[]> = {};
    for (const sc of linked) {
      const key = sc.platform ?? "unspecified";
      (byPlatform[key] ??= []).push({
        id: sc.id,
        name: sc.name,
        kind: sc.kind,
        role: sc.stories.find((l) => l.id === args.story_id)?.role ?? "primary",
        version: sc.version,
        status: sc.status,
        phase: sc.phase ?? null,
        exits: screenExits(sc, screenById),
        stale: isStale(sc, new Map([[story.id, story]])),
        ...(withElements ? { elements: resolveElements(sc, screenById) } : {}),
        ...(args.includeHtml ? { html: sc.html } : {}),
      });
    }
    return json({
      story: { id: story.id, title: story.title, platforms: story.platforms, dataFields: story.dataFields },
      total: linked.length,
      byPlatform,
      missingPlatforms: story.platforms.filter((p) => !linked.some((sc) => sc.platform === p)),
    });
  },
);

tool(
  "get_stories_for_screen",
  {
    title: "Get the stories of a screen",
    description:
      "Reverse impact analysis: which stories a screen covers, with their requirements and the scenarios tagged to them. " +
      "Use it before changing a screen to see what else it affects.",
    inputSchema: { screen_id: z.string() },
  },
  async (args, store) => {
    await ensureInit(store);
    const sc = await store.getScreen(args.screen_id);
    if (!sc) return fail(`Screen ${args.screen_id} not found.`);
    const byStory = await resolveScenariosByStory(store);
    const stories = await store.listStories();
    const storyById = new Map(stories.map((s) => [s.id, s]));
    return json({
      screen: { id: sc.id, name: sc.name, platform: sc.platform, kind: sc.kind, version: sc.version, status: sc.status },
      stories: sc.stories.map((l) => {
        const story = storyById.get(l.id);
        return {
          id: l.id,
          role: l.role,
          title: story?.title ?? null,
          exists: !!story,
          requirements: story?.requirements ?? [],
          drifted: story ? sc.storyVersions[l.id] !== story.updatedAt : false,
          scenarios: (byStory.get(l.id) ?? []).map((s) => testKey(s)),
        };
      }),
      elementStories: [...new Set(sc.elements.flatMap((e) => e.stories))],
    });
  },
);

tool(
  "link_story_screen",
  {
    title: "Link a story to a screen",
    description:
      "Establish (or re-role) the traceability edge between a user story and a screen. Many-to-many: a story can span " +
      "several screens and platforms, a screen can serve several stories. Linking snapshots the story's current version, " +
      "so later edits to the story mark the screen stale.",
    inputSchema: {
      story_id:  z.string().regex(/^US-\d+$/),
      screen_id: z.string(),
      role:      ScreenLinkRole.optional().describe("primary | secondary | entry | confirmation. Default primary."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const [story, screen] = await Promise.all([store.getStory(args.story_id), store.getScreen(args.screen_id)]);
    if (!story) return fail(`Story ${args.story_id} not found.`);
    if (!screen) return fail(`Screen ${args.screen_id} not found.`);

    const role = args.role ?? "primary";
    const link = screen.stories.find((l) => l.id === args.story_id);
    if (link) link.role = role;
    else screen.stories.push({ id: args.story_id, role });
    screen.storyVersions[args.story_id] = story.updatedAt;
    screen.updatedAt = now();
    await store.writeScreen(screen);
    return json({ linked: true, story: args.story_id, screen: args.screen_id, role, stories: screen.stories });
  },
  "spec",
);

tool(
  "unlink_story_screen",
  {
    title: "Unlink a story from a screen",
    description: "Remove the traceability edge between a story and a screen.",
    inputSchema: { story_id: z.string().regex(/^US-\d+$/), screen_id: z.string() },
  },
  async (args, store) => {
    await ensureInit(store);
    const screen = await store.getScreen(args.screen_id);
    if (!screen) return fail(`Screen ${args.screen_id} not found.`);
    const before = screen.stories.length;
    screen.stories = screen.stories.filter((l) => l.id !== args.story_id);
    delete screen.storyVersions[args.story_id];
    if (screen.stories.length === before) return json({ unlinked: false, reason: `${args.screen_id} was not linked to ${args.story_id}.` });
    screen.updatedAt = now();
    await store.writeScreen(screen);
    return json({ unlinked: true, story: args.story_id, screen: args.screen_id, stories: screen.stories });
  },
  "spec",
);

tool(
  "check_ui_coverage",
  {
    title: "Check UI coverage",
    description:
      "Run the executable consistency checks over the screens ↔ stories graph for a phase: every in-scope story has a " +
      "screen on every platform it targets, every screen traces to a story, element ids are unique and carry stories " +
      "and roles, the story's data fields and error states surface somewhere, no navigation dead-end, and no screen has " +
      "drifted from its specs. Errors are real traceability holes; warnings are heuristics for a human to confirm. " +
      "Business relevance stays a human validation (QA then Operations).",
    inputSchema: {
      phase: z.string().optional().describe("Phase id. Defaults to the active phase; pass '' to check every phase."),
      mode:  CoverageMode.optional().describe("Phase resolution mode (default cumulative)."),
      severity: z.enum(["error", "warning"]).optional().describe("Only return issues of this severity."),
      code: z.string().optional().describe("Only return issues with this code, e.g. 'story_without_screen'."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const phaseId = args.phase === "" ? null : await store.resolvePhaseId(args.phase);
    if (phaseId) {
      const error = await phaseError(store, phaseId);
      if (error) return error;
    }
    const [screens, stories, requirements, phases, config] = await Promise.all([
      store.listScreens(),
      store.listStories(),
      store.listRequirements(),
      store.listPhases(),
      store.readConfig(),
    ]);
    const report = checkUiCoverage({
      screens,
      stories,
      requirements,
      phases,
      phase: phaseId,
      mode: args.mode ?? "cumulative",
      defaultPlatforms: config.uiPlatforms ?? [],
    });
    const issues = report.issues.filter(
      (i) => (!args.severity || i.severity === args.severity) && (!args.code || i.code === args.code),
    );
    return json({ ...report, issues });
  },
);

tool(
  "get_stale_screens",
  {
    title: "Get stale screens",
    description:
      "Screens whose linked stories changed after the mockup was generated — the regeneration worklist after a spec " +
      "update. Regenerate with create_or_update_screen to clear the flag.",
    inputSchema: { phase: z.string().optional().describe("Restrict to screens assigned to this phase.") },
  },
  async (args, store) => {
    await ensureInit(store);
    const [screens, stories] = await Promise.all([store.listScreens(), store.listStories()]);
    const scoped = args.phase ? screens.filter((sc) => sc.phase === args.phase) : screens;
    const stale = staleScreens(scoped, stories);
    return json({ phase: args.phase ?? null, total: stale.length, screens: stale });
  },
);

tool(
  "delete_screen",
  {
    title: "Delete a screen",
    description: "Remove a screen (or shared component) and its stored mockup.",
    inputSchema: { id: z.string() },
  },
  async (args, store) => {
    await ensureInit(store);
    const deleted = await store.deleteScreen(args.id);
    return json({ deleted, id: args.id });
  },
  "spec",
);

// ===========================================================================
// Architecture decisions (ADRs)
//
// The durable record of *why* the system is shaped the way it is. requ owns the
// markdown — mermaid diagrams included — so decisions are queryable, linked to
// the requirements that drove them, and readable without repo access.
// ===========================================================================

/** Adr view without the (potentially large) decision body. */
function adrSummary(adr: TAdr) {
  const { content, ...meta } = adr;
  return { ...meta, hasContent: content.length > 0 };
}

/** Validate the requirement/component ids an ADR links to; fail on unknown. */
async function validateAdrLinks(store: AnyStore, requirements: string[], components: string[]) {
  const missingReqs: string[] = [];
  for (const id of requirements) if (!(await store.getRequirement(id))) missingReqs.push(id);
  if (missingReqs.length) {
    return fail(`Unknown requirement id(s): ${missingReqs.join(", ")}`, {
      hint: "Create them with create_requirement, or drop them from `requirements`.",
    });
  }
  const known = await store.listComponents();
  if (known.length) {
    const ids = new Set(known.map((c) => c.id));
    const missing = components.filter((c) => !ids.has(c));
    if (missing.length) {
      return fail(`Unknown component(s): ${missing.join(", ")}`, { knownComponents: known.map((c) => c.id) });
    }
  }
  return null;
}

/** Pull the title and status out of an ADR markdown file. */
function parseAdrMarkdown(md: string): { title: string | null; status: TAdr["status"] } {
  const lines = md.split(/\r?\n/);
  let title: string | null = null;
  for (const line of lines) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    // Strip a leading "0004." / "4 -" numbering so the title reads cleanly.
    if (m) { title = m[1].replace(/^\d+[.)\-]?\s+/, "").trim(); break; }
  }
  let status: TAdr["status"] = "proposed";
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(/^\s*(?:\*\*)?Status(?:\*\*)?\s*[:\-]\s*(.+?)\s*$/i);
    let raw = inline?.[1];
    if (!raw && /^#{2,}\s+Status\s*$/i.test(lines[i])) {
      raw = lines.slice(i + 1).find((l) => l.trim())?.trim();
    }
    if (!raw) continue;
    const word = raw.toLowerCase().replace(/[^a-z]/g, "");
    const hit = AdrStatus.options.find((o) => word.startsWith(o));
    if (hit) { status = hit; break; }
  }
  return { title, status };
}

tool(
  "create_adr",
  {
    title: "Create an architecture decision record",
    description:
      "Record an architecture decision (ADR) — markdown, mermaid diagrams included — linked to the requirements it is driven by and the components it applies to. Auto-ids 'ADR-001' unless `id` is given. Referenced requirement/component ids must exist.",
    inputSchema: {
      id:           z.string().regex(/^ADR-\d+$/).optional().describe("Explicit id (ADR-…). Auto-assigned when omitted."),
      title:        z.string().min(1).describe("Short decision title, e.g. 'Use a modular monolith'."),
      content:      z.string().optional().describe("The decision record in markdown: Context · Decision · Consequences · Alternatives. ```mermaid fences render as diagrams in the dashboard."),
      status:       AdrStatus.optional().describe("Defaults to 'proposed'."),
      requirements: z.array(z.string().regex(/^REQ-\d+$/)).optional().describe("Requirement ids (REQ-…) this decision is driven by or constrains."),
      components:   z.array(z.string()).optional().describe("Component ids this decision applies to."),
      supersededBy: z.string().regex(/^ADR-\d+$/).optional().describe("The ADR that replaced this one."),
      sourcePath:   z.string().optional().describe("Origin file path, when the decision came from a repo file."),
      phase:        z.string().optional().describe("Phase id. Defaults to the active phase; pass '' to leave unassigned."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const requirements: string[] = args.requirements ?? [];
    const components: string[] = args.components ?? [];
    const bad = await validateAdrLinks(store, requirements, components);
    if (bad) return bad;

    const phase = await resolveAssignedPhase(store, args.phase);
    if (phase.error) return phase.error;

    const existing = await store.listAdrs();
    const id = args.id ?? nextId("ADR", await store.idsAcrossVersions("adrs"));
    if (existing.some((a) => a.id === id)) return fail(`Adr ${id} already exists. Use update_adr.`);

    const content = args.content ?? "";
    const ts = now();
    const adr: TAdr = {
      id,
      title: args.title,
      status: args.status ?? "proposed",
      content,
      requirements,
      components,
      supersededBy: args.supersededBy,
      sourcePath: args.sourcePath,
      phase: phase.value,
      version: htmlVersion(content),
      removed: false,
      createdAt: ts,
      updatedAt: ts,
    };
    await store.writeAdr(adr);
    return json({ ...adrSummary(adr), hint: "Fetch the body with get_adr_content." });
  },
  "spec",
);

tool(
  "list_adrs",
  {
    title: "List architecture decisions",
    description:
      "List recorded ADRs, optionally filtered by status, linked requirement, component, or phase. The decision body is omitted unless `includeContent` is true.",
    inputSchema: {
      status:         AdrStatus.optional(),
      requirement:    z.string().optional().describe("Only ADRs linked to this requirement id."),
      component:      z.string().optional().describe("Only ADRs linked to this component id."),
      phase:          z.string().optional().describe("Only ADRs assigned to this phase."),
      q:              z.string().optional().describe("Substring match over id, title and content."),
      includeContent: z.boolean().optional().describe("Include the markdown body. Off by default."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    let adrs = await store.listAdrs();
    if (args.status)      adrs = adrs.filter((a) => a.status === args.status);
    if (args.requirement) adrs = adrs.filter((a) => a.requirements.includes(args.requirement));
    if (args.component)   adrs = adrs.filter((a) => a.components.includes(args.component));
    if (args.phase)       adrs = adrs.filter((a) => a.phase === args.phase);
    if (args.q) {
      const q = args.q.toLowerCase();
      adrs = adrs.filter((a) => `${a.id}\n${a.title}\n${a.content}`.toLowerCase().includes(q));
    }
    return json({
      total: adrs.length,
      adrs: adrs.map((a) => ({ ...adrSummary(a), ...(args.includeContent ? { content: a.content } : {}) })),
    });
  },
);

tool(
  "get_adr",
  {
    title: "Get an architecture decision",
    description:
      "Return one ADR with its linked requirement titles and the decisions it supersedes. Use get_adr_content for the markdown body.",
    inputSchema: { id: z.string().describe("Adr id (ADR-…).") },
  },
  async (args, store) => {
    await ensureInit(store);
    const adr = await store.getAdr(args.id);
    if (!adr) return fail(`Adr ${args.id} not found.`);
    const requirements = [];
    for (const rid of adr.requirements) {
      const req = await store.getRequirement(rid);
      requirements.push({ id: rid, title: req?.title ?? null, exists: !!req });
    }
    // Reverse edge: the decisions this one replaced.
    const supersedes = (await store.listAdrs()).filter((a) => a.supersededBy === adr.id).map((a) => a.id);
    return json({ ...adrSummary(adr), requirements, supersedes });
  },
);

tool(
  "get_adr_content",
  {
    title: "Get an architecture decision's markdown",
    description:
      "Return the decision body. When the ADR records a `sourcePath` the live file is preferred over requ's snapshot; `source` says which you got.",
    inputSchema: { id: z.string().describe("Adr id (ADR-…).") },
  },
  async (args, store) => {
    await ensureInit(store);
    const adr = await store.getAdr(args.id);
    if (!adr) return fail(`Adr ${args.id} not found.`);
    let content = adr.content;
    let source: "file" | "stored" = "stored";
    if (adr.sourcePath) {
      try {
        content = await fs.readFile(store.resolvePath(adr.sourcePath), "utf8");
        source = "file";
      } catch { /* fall back to the stored snapshot */ }
    }
    return json({ id: adr.id, title: adr.title, status: adr.status, version: adr.version, source, sourcePath: adr.sourcePath, content });
  },
);

tool(
  "update_adr",
  {
    title: "Update an architecture decision",
    description:
      "Update an ADR's fields. Only what you pass changes. Bumps updatedAt, and refreshes the content hash when the body changes. A decision is normally superseded rather than rewritten: set status='superseded' and supersededBy to the replacement.",
    inputSchema: {
      id:           z.string().describe("Adr id (ADR-…)."),
      title:        z.string().min(1).optional(),
      content:      z.string().optional(),
      status:       AdrStatus.optional(),
      requirements: z.array(z.string().regex(/^REQ-\d+$/)).optional().describe("Replaces the existing set."),
      components:   z.array(z.string()).optional().describe("Replaces the existing set."),
      supersededBy: z.string().regex(/^ADR-\d+$/).optional(),
      sourcePath:   z.string().optional(),
      phase:        z.string().optional().describe("Pass '' to clear the phase assignment."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const adr = await store.getAdr(args.id);
    if (!adr) return fail(`Adr ${args.id} not found.`);

    if (args.requirements !== undefined || args.components !== undefined) {
      const bad = await validateAdrLinks(store, args.requirements ?? adr.requirements, args.components ?? adr.components);
      if (bad) return bad;
    }
    if (args.supersededBy !== undefined && !(await store.getAdr(args.supersededBy))) {
      return fail(`Unknown adr id: ${args.supersededBy}`);
    }
    if (args.phase !== undefined) {
      const phase = await resolveAssignedPhase(store, args.phase);
      if (phase.error) return phase.error;
      adr.phase = phase.value;
    }
    for (const k of ["title", "status", "requirements", "components", "supersededBy", "sourcePath"] as const) {
      if (args[k] !== undefined) (adr as Record<string, unknown>)[k] = args[k];
    }
    if (args.content !== undefined && args.content !== adr.content) {
      adr.content = args.content;
      adr.version = htmlVersion(args.content);
    }
    adr.updatedAt = now();
    await store.writeAdr(adr);
    return json(adrSummary(adr));
  },
  "spec",
);

tool(
  "search_adrs",
  {
    title: "Search architecture decisions",
    description: "Substring search over ADR ids, titles and decision bodies.",
    inputSchema: {
      query:  z.string().min(1).describe("Search text (case-insensitive)."),
      status: AdrStatus.optional(),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const q = args.query.toLowerCase();
    let adrs = await store.listAdrs();
    if (args.status) adrs = adrs.filter((a) => a.status === args.status);
    adrs = adrs.filter((a) => `${a.id}\n${a.title}\n${a.content}`.toLowerCase().includes(q));
    return json({ query: args.query, total: adrs.length, adrs: adrs.map(adrSummary) });
  },
);

tool(
  "import_adrs_from_files",
  {
    title: "Import ADRs from repo markdown files",
    description:
      "Scan a folder of ADR markdown files (default 'docs/adr') and import each as an ADR: id from the filename's leading number (0004-… → ADR-004), title from the first '# ' heading, status from a 'Status' section. Existing ids are skipped, never overwritten.",
    inputSchema: {
      dir:     z.string().optional().describe("Folder to scan, relative to the project root. Defaults to 'docs/adr'."),
      dryRun:  z.boolean().optional().describe("Report what would be imported without writing."),
    },
  },
  async (args, store) => {
    await ensureInit(store);
    const rel = args.dir ?? "docs/adr";
    const dir = store.resolvePath(rel);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return fail(`Folder not found: ${rel}`, { hint: "Pass `dir` to point at the project's ADR folder." });
    }
    const files = names.filter((n) => n.toLowerCase().endsWith(".md")).sort();
    const existing = await store.listAdrs();
    const takenIds = new Set(await store.idsAcrossVersions("adrs"));
    const bySourcePath = new Map(existing.filter((a) => a.sourcePath).map((a) => [a.sourcePath as string, a.id]));

    const imported: string[] = [];
    const skipped: { file: string; reason: string }[] = [];
    for (const file of files) {
      const sourcePath = path.posix.join(rel, file);
      if (bySourcePath.has(sourcePath)) { skipped.push({ file, reason: `already imported as ${bySourcePath.get(sourcePath)}` }); continue; }
      const md = await fs.readFile(path.join(dir, file), "utf8");
      const { title, status } = parseAdrMarkdown(md);
      const num = file.match(/^(\d+)/)?.[1];
      const id = num ? `ADR-${String(parseInt(num, 10)).padStart(3, "0")}` : nextId("ADR", [...takenIds]);
      if (takenIds.has(id)) { skipped.push({ file, reason: `${id} already exists` }); continue; }
      takenIds.add(id);
      if (!args.dryRun) {
        const ts = now();
        await store.writeAdr({
          id,
          title: title || file.replace(/\.md$/i, ""),
          status,
          content: md,
          requirements: [],
          components: [],
          sourcePath,
          version: htmlVersion(md),
          removed: false,
          createdAt: ts,
          updatedAt: ts,
        } as TAdr);
      }
      imported.push(id);
    }
    return json({
      dir: rel, scanned: files.length, imported: imported.length, ids: imported, skipped,
      dryRun: !!args.dryRun,
      hint: imported.length ? "Link them to requirements with update_adr." : undefined,
    });
  },
  "spec",
);

tool(
  "delete_adr",
  {
    title: "Delete an architecture decision",
    description: "Remove an ADR and its stored markdown. Prefer superseding a decision over deleting it — deletion loses the history.",
    inputSchema: { id: z.string() },
  },
  async (args, store) => {
    await ensureInit(store);
    const deleted = await store.deleteAdr(args.id);
    return json({ deleted, id: args.id });
  },
  "spec",
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
  "progress",
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
  "progress",
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
// VCS references (branches / merge or pull requests)
//
// requ-mcp NEVER calls the VCS provider and holds NO token. These tools only
// record references that nodes report, for traceability. "Merge request" is
// used as the provider-neutral term: GitLab MRs, GitHub PRs and Bitbucket PRs
// are all recorded the same way.
// ===========================================================================

tool(
  "set_repo",
  {
    title: "Set VCS repository reference",
    description:
      "Record the project's VCS repository reference (repoUrl, defaultBranch, vcsType) in config. requ-mcp never calls the VCS provider — it only stores these references for traceability.",
    inputSchema: {
      repoUrl:       z.string().describe("Repository URL, e.g. 'https://gitlab.com/group/project' or 'https://bitbucket.org/team/repo'."),
      defaultBranch: z.string().optional().describe("Default branch name. Defaults to 'main'."),
      vcsType:       VcsType.optional().describe("VCS provider type. 'bitbucket' covers both Bitbucket Cloud and Server/Data Center."),
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
  "progress",
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
    const id = dup?.id ?? nextId("BR", existing.map((r) => r.id));
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
  "progress",
);

tool(
  "link_merge_request",
  {
    title: "Link a VCS merge request reference",
    description:
      "Record (or upsert) a reference to a merge request (kind='mr'), keyed by `ref` (the MR iid / PR number), id 'MR-<ref>'. 'mr' is the provider-neutral kind: GitLab MRs, GitHub PRs and Bitbucket PRs all use it. Referenced storyIds/requirementIds must exist (fails if unknown). requ-mcp does not call the VCS provider — it only records the reference.",
    inputSchema: {
      ref:            z.string().regex(/^\d+$/).describe("MR iid (GitLab) or PR number (GitHub, Bitbucket) — numeric string."),
      url:            z.string().min(1).describe("MR/PR URL."),
      branch:         z.string().min(1).describe("Source branch of the MR/PR."),
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
  "progress",
);

tool(
  "update_merge_request",
  {
    title: "Update a merge request reference state",
    description:
      "Update the state (and optional mergeCommit) of a recorded MR reference, found by its `ref` (MR iid / PR number). Bumps updatedAt. Fails if no MR reference with that ref exists. States are provider-neutral: Bitbucket DECLINED/SUPERSEDED and GitHub closed-unmerged PRs all map to 'closed'.",
    inputSchema: {
      ref:         z.string().regex(/^\d+$/).describe("MR iid (GitLab) or PR number (GitHub, Bitbucket) — numeric string."),
      state:       VcsRefState.describe("New MR/PR state ('closed' covers Bitbucket DECLINED/SUPERSEDED)."),
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
  "progress",
);

tool(
  "list_vcs_refs",
  {
    title: "List VCS references",
    description: "List recorded VCS references (branches and MRs/PRs), optionally filtered by kind, component, state, or linked storyId.",
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
      "Export all project data (components, requirements, stories, scenarios, screens, architecture decisions, phases, executions, VCS refs) as a JSON string. Pass the result to import_project on another instance to migrate or copy data.",
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
  "spec",
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
// HTTP server — the only transport
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
        : "no projects configured (set REQU_PROJECTS or REQU_PG_URL)";
    console.error(`requ-mcp HTTP → http://${host}:${port}/mcp  ${dbInfo}`);
  });
}

// ===========================================================================
// Boot
// ===========================================================================

async function main() {
  await startHttpServer();
}

main().catch((err) => {
  console.error("requ-mcp fatal:", err);
  process.exit(1);
});
