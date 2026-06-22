/**
 * Web dashboard REST API + static file serving layer.
 *
 * Export: handleWebRequest — drop-in handler for the HTTP server in index.ts.
 * Returns true when the request was handled; false to fall through to MCP routing.
 */

import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { promises as fsp, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SqliteStore } from "./sqlite-store.js";
import { PostgresStore } from "./postgres-store.js";

type AnyHttpStore = SqliteStore | PostgresStore;
import { stringify as yamlStringify } from "yaml";
import { indexConductor, scenariosByStory, validateTestRef } from "./conductor.js";
import {
  buildReport,
  buildTrend,
  findGaps,
  resolveStatuses,
  resolveScenariosByStory,
  filterScenarios,
  countsByPhase,
  requirementIdsForScenario,
  type ScenariosByStory,
  type ScenarioFilter,
} from "./coverage.js";
import { ExportPayload, testKey, type CoverageMode, type Scenario, type TestStatus, type UserStory } from "./schema.js";
import { buildExport, applyImport } from "./export-import.js";
import { buildOpenApiDocument } from "./openapi.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

const SERVER_VERSION: string = (JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8")
) as { version: string }).version;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json",
  ".ico":  "image/x-icon",
  ".svg":  "image/svg+xml",
};

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setHeaders(res: ServerResponse, headers: Record<string, string>): void {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
}

function jsonOk(res: ServerResponse, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(200, {
    ...CORS_HEADERS,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function jsonError(res: ServerResponse, status: number, message: string, code?: string): void {
  const body = JSON.stringify({ error: message, ...(code ? { code } : {}) });
  res.writeHead(status, {
    ...CORS_HEADERS,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function collectBody(req: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { req.resume(); reject(new Error("Payload too large")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Minimal route matcher. Supports `:param` segments.
 * Returns a params object on match, null otherwise.
 */
function matchRoute(
  url: string,
  method: string,
  pattern: string,
  expectedMethod: string,
): Record<string, string> | null {
  if (method.toUpperCase() !== expectedMethod.toUpperCase()) return null;
  // Strip query string from URL.
  const pathname = url.split("?")[0];
  const patParts = pattern.split("/");
  const urlParts = pathname.split("/");
  if (patParts.length !== urlParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patParts.length; i++) {
    const pp = patParts[i];
    const up = urlParts[i];
    if (pp.startsWith(":")) {
      params[pp.slice(1)] = decodeURIComponent(up);
    } else if (pp !== up) {
      return null;
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

async function serveStatic(res: ServerResponse, filePath: string): Promise<void> {
  // Path traversal guard.
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== PUBLIC_DIR) {
    jsonError(res, 403, "Forbidden");
    return;
  }
  try {
    const content = await fsp.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    const isHtml = ext === ".html";
    res.writeHead(200, {
      ...CORS_HEADERS,
      "Content-Type": mime,
      "Cache-Control": "no-cache",
      "Content-Length": content.length,
    });
    res.end(content);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      jsonError(res, 404, "Not found");
    } else {
      console.error("[requ-mcp] serveStatic error:", err);
      jsonError(res, 500, "Internal server error");
    }
  }
}

async function serveIndexHtml(res: ServerResponse): Promise<void> {
  // Inject the version as a cache-busting query string on static asset references,
  // so browsers always load the correct JS/CSS when the server version changes.
  const filePath = path.join(PUBLIC_DIR, "index.html");
  try {
    let html = await fsp.readFile(filePath, "utf-8");
    html = html.replace(/(\/public\/(?:app|style)\.[a-z]+)"/g, `$1?v=${SERVER_VERSION}"`);
    const buf = Buffer.from(html, "utf-8");
    res.writeHead(200, {
      ...CORS_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      "Content-Length": buf.length,
    });
    res.end(buf);
  } catch {
    jsonError(res, 500, "Internal server error");
  }
}

// ---------------------------------------------------------------------------
// Summary helper (shared by GET /api/summary and SSE)
// ---------------------------------------------------------------------------

async function computeSummary(store: AnyHttpStore): Promise<Record<string, unknown>> {
  const [requirements, stories, components, phases, scenarios] = await Promise.all([
    store.listRequirements(),
    store.listStories(),
    store.listComponents(),
    store.listPhases(),
    store.listScenarios(),
  ]);

  const activePhase = await store.resolvePhaseId();
  const executionsByPhase = await store.readAllExecutions();

  // Stored scenarios win; disk feature files are the legacy fallback.
  const storyMap: ScenariosByStory = await resolveScenariosByStory(store);

  const vcsRefs = await store.listVcsRefs();

  const statusStrict = resolveStatuses(executionsByPhase, phases, activePhase, "strict");
  const reportStrict = buildReport(requirements, stories, storyMap, statusStrict, activePhase, "strict", vcsRefs, phases);

  const statusCumulative = resolveStatuses(executionsByPhase, phases, activePhase, "cumulative");
  const reportCumulative = buildReport(requirements, stories, storyMap, statusCumulative, activePhase, "cumulative", vcsRefs, phases);

  return {
    requirements: requirements.length,
    stories: stories.length,
    components: components.length,
    phases: phases.length,
    vcsRefs: vcsRefs.length,
    scenariosTotal: scenarios.length,
    // Raw counts partitioned across phases (each item counted once, earliest phase).
    byPhase: countsByPhase(requirements, stories, scenarios, phases),
    scenariosPassing: reportStrict.summary.scenariosPassing,
    scenariosLinked:  reportStrict.summary.scenariosLinked,
    verifiedPct:                reportStrict.summary.verifiedPct,
    storyCoveragePct:           reportStrict.summary.storyCoveragePct,
    verifiedPctCumulative:      reportCumulative.summary.verifiedPct,
    storyCoveragePctCumulative: reportCumulative.summary.storyCoveragePct,
    activePhase,
  };
}

// ---------------------------------------------------------------------------
// Coverage helper (builds index + story map, catches ENOENT)
// ---------------------------------------------------------------------------

async function buildCoverageData(store: AnyHttpStore): Promise<{
  requirements: import("./schema.js").Requirement[];
  stories: import("./schema.js").UserStory[];
  phases: import("./schema.js").Phase[];
  executionsByPhase: Map<string, import("./schema.js").Execution[]>;
  storyMap: ScenariosByStory;
  vcsRefs: import("./schema.js").VcsRef[];
}> {
  const [requirements, stories, phases, executionsByPhase, vcsRefs, storyMap] = await Promise.all([
    store.listRequirements(),
    store.listStories(),
    store.listPhases(),
    store.readAllExecutions(),
    store.listVcsRefs(),
    resolveScenariosByStory(store),
  ]);

  return { requirements, stories, phases, executionsByPhase, storyMap, vcsRefs };
}

// ---------------------------------------------------------------------------
// Scenario API helpers
// ---------------------------------------------------------------------------

function splitCsv(v: string | null): string[] | undefined {
  if (!v) return undefined;
  const out = v.split(",").map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

function intParam(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function scenarioSummary(
  sc: Scenario,
  storyById: Map<string, UserStory>,
  status?: TestStatus,
  includeContent = false,
): Record<string, unknown> {
  return {
    id: sc.testKey,
    feature: sc.feature,
    name: sc.name,
    tags: sc.tags,
    storyIds: sc.stories,
    requirementIds: requirementIdsForScenario(sc, storyById),
    valid: sc.valid,
    hasContent: sc.content.trim().length > 0,
    hasBackground: sc.background.trim().length > 0,
    ...(status ? { status } : {}),
    ...(includeContent ? { content: sc.content, background: sc.background } : {}),
  };
}

/** Discover DB-native Postgres projects and attach them to the shared store map. */
async function ensureDbProjects(stores: Map<string, AnyHttpStore>): Promise<void> {
  if (!process.env.REQU_PG_URL) return;
  let ids: string[];
  try { ids = await PostgresStore.listProjectIds(); } catch { return; }
  for (const id of ids) {
    if (stores.has(id)) continue;
    if ([...stores.values()].some((s) => s instanceof PostgresStore && s.projectId === id)) continue;
    stores.set(id, new PostgresStore(path.join(os.tmpdir(), "requ", id), id));
  }
}

// ---------------------------------------------------------------------------
// NOT_INITIALIZED guard
// ---------------------------------------------------------------------------

function notInitialized(res: ServerResponse): true {
  jsonError(res, 503, "Project not initialized. Run init_project first.", "NOT_INITIALIZED");
  return true;
}

// ---------------------------------------------------------------------------
// Coverage mode validation
// ---------------------------------------------------------------------------

const VALID_MODES: ReadonlySet<string> = new Set(["cumulative", "strict"]);

function parseCoverageMode(
  searchParams: URLSearchParams,
  res: ServerResponse,
): CoverageMode | null {
  const raw = searchParams.get("mode");
  if (raw !== null && !VALID_MODES.has(raw)) {
    jsonError(res, 400, `Invalid mode "${raw}". Accepted values: "cumulative", "strict".`);
    return null;
  }
  return (raw ?? "strict") as CoverageMode;
}

// ---------------------------------------------------------------------------
// Multi-project store resolution
// ---------------------------------------------------------------------------

type StoreResult =
  | { status: "ok"; store: AnyHttpStore }
  | { status: "not_initialized" }
  | { status: "ambiguous"; available: string[] }
  | { status: "unknown_project"; slug: string };

function resolveStore(
  stores: Map<string, AnyHttpStore>,
  searchParams: URLSearchParams,
): StoreResult {
  if (stores.size === 0) return { status: "not_initialized" };
  if (stores.size === 1) return { status: "ok", store: [...stores.values()][0] };
  const slug = searchParams.get("project");
  if (!slug) return { status: "ambiguous", available: [...stores.keys()] };
  const store = stores.get(slug);
  if (!store) return { status: "unknown_project", slug };
  return { status: "ok", store };
}

function handleStoreResult(
  res: ServerResponse,
  result: StoreResult,
): result is { status: "ok"; store: AnyHttpStore } {
  if (result.status === "ok") return true;
  if (result.status === "not_initialized") {
    notInitialized(res);
  } else if (result.status === "ambiguous") {
    const body = JSON.stringify({
      error: "Multiple projects loaded; specify ?project=<slug>",
      available: result.available,
    });
    res.writeHead(400, { ...CORS_HEADERS, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  } else {
    jsonError(res, 404, `Unknown project: ${result.slug}`);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function handleWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  stores: Map<string, AnyHttpStore>,
): Promise<boolean> {
  const rawUrl = req.url ?? "/";
  const method = req.method ?? "GET";

  // Handle CORS preflight.
  if (method === "OPTIONS") {
    setHeaders(res, CORS_HEADERS);
    res.writeHead(204).end();
    return true;
  }

  // Discover DB-native projects so the dashboard/API see them without env preload.
  if (rawUrl.startsWith("/api/") || rawUrl === "/events" || rawUrl.startsWith("/events?")) {
    await ensureDbProjects(stores);
  }

  // -------------------------------------------------------------------------
  // SSE — GET /events
  // -------------------------------------------------------------------------
  if (rawUrl === "/events" || rawUrl.startsWith("/events?")) {
    const sseResult = resolveStore(stores, new URL(rawUrl, "http://localhost").searchParams);
    if (!handleStoreResult(res, sseResult)) return true;
    const store = sseResult.store;

    res.writeHead(200, {
      ...CORS_HEADERS,
      "Content-Type":      "text/event-stream",
      "Cache-Control":     "no-cache",
      "Connection":        "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Helper to send one SSE data event.
    let closed = false;
    const sendSummary = async (): Promise<void> => {
      if (closed) return;
      try {
        const summary = await computeSummary(store);
        if (!closed) res.write(`data: ${JSON.stringify(summary)}\n\n`);
      } catch {
        // Don't crash the SSE loop on transient errors.
      }
    };

    // Send current snapshot immediately.
    await sendSummary();

    const dataTimer = setInterval(() => { void sendSummary(); }, 5_000);
    const keepAliveTimer = setInterval(() => { if (!closed) res.write(": keepalive\n\n"); }, 25_000);

    req.on("close", () => {
      closed = true;
      clearInterval(dataTimer);
      clearInterval(keepAliveTimer);
    });

    return true;
  }

  // -------------------------------------------------------------------------
  // REST API — /api/*
  // -------------------------------------------------------------------------
  // Catch `/api` (no trailing slash) before the prefix check so it doesn't
  // fall through to the SPA fallback and return 200 + HTML.
  if (rawUrl === "/api" || rawUrl.startsWith("/api?")) {
    jsonError(res, 404, "Unknown API route");
    return true;
  }

  if (rawUrl.startsWith("/api/")) {
    // Extract pathname once; all matchRoute calls below receive a clean path.
    const pathname = rawUrl.split("?")[0];
    const searchParams = new URL(rawUrl, "http://localhost").searchParams;

    // --- GET /api/version --- (no store needed)
    if (matchRoute(pathname, method, "/api/version", "GET") !== null) {
      jsonOk(res, { version: SERVER_VERSION });
      return true;
    }

    // --- GET /api/projects --- (no store needed)
    if (matchRoute(pathname, method, "/api/projects", "GET") !== null) {
      const list = await Promise.all(
        [...stores.entries()].map(async ([slug, s]) => {
          let key: string | null = null;
          let name: string | null = null;
          try { const cfg = await s.readConfig(); key = cfg.key ?? null; name = cfg.name; } catch { /* uninitialized */ }
          return { slug, key, name, root: s.root };
        }),
      );
      jsonOk(res, list);
      return true;
    }

    // --- GET /api/openapi.json --- (no store needed; the scenario API contract)
    if (matchRoute(pathname, method, "/api/openapi.json", "GET") !== null) {
      jsonOk(res, buildOpenApiDocument(SERVER_VERSION));
      return true;
    }

    // --- GET /api/openapi.yaml ---
    if (matchRoute(pathname, method, "/api/openapi.yaml", "GET") !== null) {
      const body = yamlStringify(buildOpenApiDocument(SERVER_VERSION));
      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/yaml; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
      return true;
    }

    // --- POST /api/init --- (must work before project is initialized)
    if (matchRoute(pathname, method, "/api/init", "POST") !== null) {
      try {
        // Store resolution without handleStoreResult — project may not be initialized yet.
        let store: AnyHttpStore;
        if (stores.size === 0) {
          jsonError(res, 503, "No project root configured on this server");
          return true;
        } else if (stores.size > 1) {
          const slug = searchParams.get("project");
          if (!slug) {
            jsonError(res, 400, "Multiple projects loaded — pass ?project=<slug>");
            return true;
          }
          const found = stores.get(slug);
          if (!found) {
            jsonError(res, 404, `Unknown project: ${slug}`);
            return true;
          }
          store = found;
        } else {
          store = [...stores.values()][0];
        }

        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await collectBody(req));
        } catch {
          jsonError(res, 400, "Request body is not valid JSON");
          return true;
        }

        // Derive / validate key.
        let key: string;
        if (typeof body.key === "string" && body.key.trim()) {
          if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(body.key)) {
            jsonError(res, 400, "key must be 1–20 uppercase alphanumeric/hyphen/underscore characters starting with a letter or digit");
            return true;
          }
          key = body.key;
        } else {
          key = (
            (typeof body.name === "string" ? body.name : path.basename(store.root))
              .replace(/[^A-Z0-9]/gi, "")
              .toUpperCase()
              .slice(0, 10)
          ) || "PROJECT";
        }

        // Uniqueness check across all stores.
        for (const s of stores.values()) {
          try {
            const cfg = await s.readConfig();
            if (cfg.key === key && s !== store) {
              jsonError(res, 409, `Project key '${key}' is already used by another project`);
              return true;
            }
          } catch { /* skip uninitialized stores */ }
        }

        const config = {
          name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : path.basename(store.root),
          key,
          brief: typeof body.brief === "string" ? body.brief : undefined,
          conductorPath: ".",
        };

        await store.init(config);

        if (typeof body.initialPhase === "string" && body.initialPhase.trim()) {
          const phase = {
            id: "P1",
            name: body.initialPhase,
            order: 1,
            status: "active" as const,
            description: "",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          await store.writePhase(phase);
          await store.writeConfig({ ...config, activePhase: "P1" });
        }

        jsonOk(res, { initialized: true, config: await store.readConfig() });
      } catch (err) {
        jsonError(res, 500, (err as Error).message);
      }
      return true;
    }

    // --- GET /api/summary ---
    if (matchRoute(pathname, method, "/api/summary", "GET") !== null) {
      const r = resolveStore(stores, searchParams);
      if (!handleStoreResult(res, r)) return true;
      try {
        if (!await r.store.isInitialized()) return notInitialized(res);
        const summary = await computeSummary(r.store);
        jsonOk(res, summary);
      } catch (err) {
        jsonError(res, 500, String(err));
      }
      return true;
    }

    // --- GET /api/global ---
    if (matchRoute(pathname, method, "/api/global", "GET") !== null) {
      if (stores.size === 0) { jsonOk(res, []); return true; }
      try {
        const results = await Promise.all(
          [...stores.entries()].map(async ([slug, store]) => {
            try {
              // readConfig & computeSummary both throw on uninitialised DBs.
              // Fall back gracefully so partially-initialised projects still appear.
              const [config, summary] = await Promise.all([
                store.readConfig().catch(() => ({ name: slug, activePhase: undefined as string | undefined })),
                computeSummary(store).catch(async () => {
                  // Conductor / phase resolution not available — count entities directly.
                  const [reqs, stories] = await Promise.all([
                    store.listRequirements(),
                    store.listStories(),
                  ]);
                  return { requirements: reqs.length, stories: stories.length,
                           verifiedPct: 0, storyCoveragePct: 0, activePhase: undefined as string | undefined };
                }),
              ]);
              return {
                slug,
                name: config.name,
                activePhase: (summary.activePhase as string) ?? null,
                requirements: summary.requirements as number,
                stories:      summary.stories as number,
                verifiedPct:  summary.verifiedPct as number,
                storyCoveragePct: summary.storyCoveragePct as number,
              };
            } catch { return null; }   // truly broken store (no schema) — skip silently
          })
        );
        jsonOk(res, results.filter(Boolean));
      } catch (err) { jsonError(res, 500, String(err)); }
      return true;
    }

    // --- GET /api/requirements ---
    if (matchRoute(pathname, method, "/api/requirements", "GET") !== null) {
      const r = resolveStore(stores, searchParams);
      if (!handleStoreResult(res, r)) return true;
      try {
        jsonOk(res, await r.store.listRequirements());
      } catch (err) {
        jsonError(res, 500, String(err));
      }
      return true;
    }

    // --- GET /api/requirements/:id ---
    {
      const params = matchRoute(pathname, method, "/api/requirements/:id", "GET");
      if (params !== null) {
        const r = resolveStore(stores, searchParams);
        if (!handleStoreResult(res, r)) return true;
        try {
          const req_ = await r.store.getRequirement(params.id);
          if (!req_) { jsonError(res, 404, `Requirement ${params.id} not found`); return true; }
          // Augment with linked story IDs.
          const stories = await r.store.listStories();
          const linkedStoryIds = stories
            .filter((s) => s.requirements.includes(params.id))
            .map((s) => s.id);
          jsonOk(res, { ...req_, linkedStoryIds });
        } catch (err) {
          jsonError(res, 500, String(err));
        }
        return true;
      }
    }

    // --- GET /api/stories ---
    if (matchRoute(pathname, method, "/api/stories", "GET") !== null) {
      const r = resolveStore(stores, searchParams);
      if (!handleStoreResult(res, r)) return true;
      try {
        jsonOk(res, await r.store.listStories());
      } catch (err) {
        jsonError(res, 500, String(err));
      }
      return true;
    }

    // --- GET /api/stories/:id ---
    {
      const params = matchRoute(pathname, method, "/api/stories/:id", "GET");
      if (params !== null) {
        const r = resolveStore(stores, searchParams);
        if (!handleStoreResult(res, r)) return true;
        try {
          const story = await r.store.getStory(params.id);
          if (!story) { jsonError(res, 404, `Story ${params.id} not found`); return true; }
          jsonOk(res, story);
        } catch (err) {
          jsonError(res, 500, String(err));
        }
        return true;
      }
    }

    // --- GET /api/stories/:id/scenarios --- (batch, with gherkin content)
    {
      const params = matchRoute(pathname, method, "/api/stories/:id/scenarios", "GET");
      if (params !== null) {
        const r = resolveStore(stores, searchParams);
        if (!handleStoreResult(res, r)) return true;
        try {
          const [scenarios, stories] = await Promise.all([r.store.listScenarios(), r.store.listStories()]);
          const storyById = new Map(stories.map((s) => [s.id, s]));
          const list = scenarios
            .filter((sc) => sc.stories.includes(params.id))
            .map((sc) => scenarioSummary(sc, storyById, undefined, true));
          jsonOk(res, list);
        } catch (err) {
          jsonError(res, 500, String(err));
        }
        return true;
      }
    }

    // --- GET /api/components ---
    if (matchRoute(pathname, method, "/api/components", "GET") !== null) {
      const r = resolveStore(stores, searchParams);
      if (!handleStoreResult(res, r)) return true;
      try {
        jsonOk(res, await r.store.listComponents());
      } catch (err) {
        jsonError(res, 500, String(err));
      }
      return true;
    }

    // --- GET /api/phases ---
    if (matchRoute(pathname, method, "/api/phases", "GET") !== null) {
      const r = resolveStore(stores, searchParams);
      if (!handleStoreResult(res, r)) return true;
      try {
        jsonOk(res, await r.store.listPhases());
      } catch (err) {
        jsonError(res, 500, String(err));
      }
      return true;
    }

    // --- GET /api/config ---
    if (matchRoute(pathname, method, "/api/config", "GET") !== null) {
      const r = resolveStore(stores, searchParams);
      if (!handleStoreResult(res, r)) return true;
      try {
        if (!await r.store.isInitialized()) return notInitialized(res);
        jsonOk(res, await r.store.readConfig());
      } catch (err) {
        jsonError(res, 500, String(err));
      }
      return true;
    }

    // --- PATCH /api/config ---
    if (matchRoute(pathname, method, "/api/config", "PATCH") !== null) {
      const r = resolveStore(stores, searchParams);
      if (!handleStoreResult(res, r)) return true;
      try {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await collectBody(req));
        } catch {
          jsonError(res, 400, "Request body is not valid JSON");
          return true;
        }
        const cfg = await r.store.readConfig();
        const updated = { ...cfg };
        if (typeof body.name === "string" && body.name.trim()) updated.name = body.name.trim();
        if (typeof body.brief === "string") updated.brief = body.brief;
        await r.store.writeConfig(updated);
        jsonOk(res, await r.store.readConfig());
      } catch (err) {
        jsonError(res, 500, String(err));
      }
      return true;
    }

    // --- GET /api/vcs ---
    if (matchRoute(pathname, method, "/api/vcs", "GET") !== null) {
      const r = resolveStore(stores, searchParams);
      if (!handleStoreResult(res, r)) return true;
      try {
        jsonOk(res, await r.store.listVcsRefs());
      } catch (err) {
        jsonError(res, 500, String(err));
      }
      return true;
    }

    // --- GET /api/coverage/trend ---
    if (matchRoute(pathname, method, "/api/coverage/trend", "GET") !== null) {
      const r = resolveStore(stores, searchParams);
      if (!handleStoreResult(res, r)) return true;
      try {
        const mode = parseCoverageMode(searchParams, res);
        if (mode === null) return true;
        const { requirements, stories, phases, executionsByPhase, storyMap } = await buildCoverageData(r.store);
        const trend = buildTrend(requirements, stories, storyMap, executionsByPhase, phases, mode);
        jsonOk(res, trend);
      } catch (err) {
        jsonError(res, 500, String(err));
      }
      return true;
    }

    // --- GET /api/coverage/gaps ---
    if (matchRoute(pathname, method, "/api/coverage/gaps", "GET") !== null) {
      const r = resolveStore(stores, searchParams);
      if (!handleStoreResult(res, r)) return true;
      try {
        const mode = parseCoverageMode(searchParams, res);
        if (mode === null) return true;
        const { requirements, stories, phases, executionsByPhase, storyMap } = await buildCoverageData(r.store);
        const phaseParam = searchParams.get("phase");
        // Absent param → default to the active/resolved phase (API back-compat).
        // Explicit empty (?phase=) → null = "All phases" (the web UI sends this).
        const phaseId =
          phaseParam === null ? await r.store.resolvePhaseId() : phaseParam || null;
        const status = resolveStatuses(executionsByPhase, phases, phaseId, mode);
        const gaps = findGaps(requirements, stories, storyMap, status, phaseId, mode, phases);
        jsonOk(res, gaps);
      } catch (err) {
        jsonError(res, 500, String(err));
      }
      return true;
    }

    // --- GET /api/coverage ---
    if (matchRoute(pathname, method, "/api/coverage", "GET") !== null) {
      const r = resolveStore(stores, searchParams);
      if (!handleStoreResult(res, r)) return true;
      try {
        const mode = parseCoverageMode(searchParams, res);
        if (mode === null) return true;
        const { requirements, stories, phases, executionsByPhase, storyMap, vcsRefs } = await buildCoverageData(r.store);
        const phaseParam = searchParams.get("phase");
        // Absent param → default to the active/resolved phase (API back-compat).
        // Explicit empty (?phase=) → null = "All phases" (the web UI sends this).
        const phaseId =
          phaseParam === null ? await r.store.resolvePhaseId() : phaseParam || null;
        const status = resolveStatuses(executionsByPhase, phases, phaseId, mode);
        const report = buildReport(requirements, stories, storyMap, status, phaseId, mode, vcsRefs, phases);
        // Enrich scenario entries with id (testKey) + hasContent so the UI knows
        // whether a readable gherkin body exists, without inlining content here.
        const storedByKey = new Map((await r.store.listScenarios()).map((s) => [s.testKey, s]));
        const enriched = {
          ...report,
          stories: report.stories.map((st) => ({
            ...st,
            scenarios: st.scenarios.map((scv) => {
              const tk = testKey({ feature: scv.feature, name: scv.name });
              const stored = storedByKey.get(tk);
              return { ...scv, id: tk, hasContent: !!stored && stored.content.trim().length > 0 };
            }),
          })),
        };
        jsonOk(res, enriched);
      } catch (err) {
        jsonError(res, 500, String(err));
      }
      return true;
    }

    // --- GET /api/scenarios --- (query by story/requirement/phase/tags/feature/q/valid)
    if (matchRoute(pathname, method, "/api/scenarios", "GET") !== null) {
      const r = resolveStore(stores, searchParams);
      if (!handleStoreResult(res, r)) return true;
      try {
        const [scenarios, stories, phases, requirements] = await Promise.all([
          r.store.listScenarios(),
          r.store.listStories(),
          r.store.listPhases(),
          r.store.listRequirements(),
        ]);
        const validParam = searchParams.get("valid");
        const filter: ScenarioFilter = {
          story:       splitCsv(searchParams.get("story")),
          requirement: splitCsv(searchParams.get("requirement")),
          phase:       searchParams.get("phase") ?? undefined,
          mode:        (searchParams.get("mode") as CoverageMode | null) ?? undefined,
          feature:     searchParams.get("feature") ?? undefined,
          q:           searchParams.get("q") ?? undefined,
          valid:       validParam === null ? undefined : validParam === "true",
          tags:        searchParams.get("tags") ?? undefined,
        };
        let filtered: Scenario[];
        try {
          filtered = filterScenarios(scenarios, stories, phases, requirements, filter);
        } catch (e) {
          jsonError(res, 400, `Invalid filter: ${(e as Error).message}`);
          return true;
        }

        const storyById = new Map(stories.map((s) => [s.id, s]));
        let statusMap: Map<string, TestStatus> | null = null;
        const phaseParam = searchParams.get("phase");
        if (phaseParam) {
          const execByPhase = await r.store.readAllExecutions();
          statusMap = resolveStatuses(execByPhase, phases, phaseParam, filter.mode ?? "cumulative");
        }
        const includeContent = searchParams.get("content") === "true";
        const offset = intParam(searchParams.get("offset")) ?? 0;
        const limit = intParam(searchParams.get("limit"));
        const total = filtered.length;
        const page = limit != null ? filtered.slice(offset, offset + limit) : filtered.slice(offset);
        jsonOk(res, {
          total,
          scenarios: page.map((sc) => scenarioSummary(sc, storyById, statusMap?.get(sc.testKey), includeContent)),
        });
      } catch (err) {
        jsonError(res, 500, String(err));
      }
      return true;
    }

    // --- GET /api/scenarios/:id --- (single scenario by testKey, with content)
    {
      const params = matchRoute(pathname, method, "/api/scenarios/:id", "GET");
      if (params !== null) {
        const r = resolveStore(stores, searchParams);
        if (!handleStoreResult(res, r)) return true;
        try {
          const sc = await r.store.getScenario(params.id);
          if (!sc) { jsonError(res, 404, `Scenario ${params.id} not found`); return true; }
          jsonOk(res, {
            id: sc.testKey,
            feature: sc.feature,
            name: sc.name,
            content: sc.content,
            background: sc.background,
            tags: sc.tags,
            storyIds: sc.stories,
            valid: sc.valid,
            file: sc.file ?? null,
            source: sc.source,
          });
        } catch (err) {
          jsonError(res, 500, String(err));
        }
        return true;
      }
    }

    // --- GET /api/tags --- (distinct tags with counts)
    if (matchRoute(pathname, method, "/api/tags", "GET") !== null) {
      const r = resolveStore(stores, searchParams);
      if (!handleStoreResult(res, r)) return true;
      try {
        const scenarios = await r.store.listScenarios();
        const counts = new Map<string, number>();
        for (const sc of scenarios) for (const t of sc.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
        const list = [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag));
        jsonOk(res, list);
      } catch (err) {
        jsonError(res, 500, String(err));
      }
      return true;
    }

    // --- GET /api/export ---
    if (matchRoute(pathname, method, "/api/export", "GET") !== null) {
      const r = resolveStore(stores, searchParams);
      if (!handleStoreResult(res, r)) return true;
      try {
        const payload = await buildExport(r.store);
        const body = JSON.stringify(payload, null, 2);
        // Strip to a safe allowlist before reflecting into a response header.
        const rawSlug = searchParams.get("project") ?? "project";
        const safeSlug = rawSlug.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64) || "project";
        res.writeHead(200, {
          ...CORS_HEADERS,
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="requ-export-${safeSlug}.json"`,
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
      } catch (err) {
        jsonError(res, 500, String(err));
      }
      return true;
    }

    // --- POST /api/import ---
    if (matchRoute(pathname, method, "/api/import", "POST") !== null) {
      const r = resolveStore(stores, searchParams);
      if (!handleStoreResult(res, r)) return true;
      try {
        const bodyText = await collectBody(req);
        let parsed: unknown;
        try { parsed = JSON.parse(bodyText); }
        catch { jsonError(res, 400, "Request body is not valid JSON"); return true; }
        const result = ExportPayload.safeParse(parsed);
        if (!result.success) {
          jsonError(res, 400, `Invalid export format: ${result.error.message}`);
          return true;
        }
        const report = await applyImport(r.store, result.data);
        jsonOk(res, report);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg === "Payload too large") { jsonError(res, 413, msg); }
        else { jsonError(res, 500, msg); }
      }
      return true;
    }

    // --- GET /api/scenarios ---
    if (matchRoute(pathname, method, "/api/scenarios", "GET") !== null) {
      const r = resolveStore(stores, searchParams);
      if (!handleStoreResult(res, r)) return true;
      try {
        if (!await r.store.isInitialized()) return notInitialized(res);
        const page     = Math.max(1, parseInt(searchParams.get("page")     ?? "1",  10) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(searchParams.get("pageSize") ?? "25", 10) || 25));
        const q   = (searchParams.get("q")   ?? "").toLowerCase().trim();
        const tag = (searchParams.get("tag") ?? "").toLowerCase().trim();

        let allScenarios: import("./conductor.js").ConductorScenario[] = [];
        try {
          const conductorRoot = await r.store.conductorRoot();
          const index = await indexConductor(conductorRoot);
          allScenarios = index.scenarios;
        } catch { /* Conductor not available — return empty list */ }

        const [phases, execByPhase] = await Promise.all([
          r.store.listPhases(),
          r.store.readAllExecutions(),
        ]);
        const activePhase = await r.store.resolvePhaseId();
        const statusMap = resolveStatuses(execByPhase, phases, activePhase, "cumulative");

        let filtered = allScenarios;
        if (q)   filtered = filtered.filter((sc) => sc.feature.toLowerCase().includes(q) || sc.name.toLowerCase().includes(q));
        if (tag) filtered = filtered.filter((sc) => sc.tags.some((t) => t.toLowerCase().includes(tag)));

        const total = filtered.length;
        const slice = filtered.slice((page - 1) * pageSize, page * pageSize);

        jsonOk(res, {
          total,
          page,
          pageSize,
          scenarios: slice.map((sc) => ({
            feature: sc.feature,
            name:    sc.name,
            file:    sc.file,
            tags:    sc.tags,
            stories: sc.stories,
            status:  statusMap.get(testKey(sc)) ?? null,
          })),
        });
      } catch (err) {
        jsonError(res, 500, String(err));
      }
      return true;
    }

    // --- POST /api/scenarios/execute ---
    if (matchRoute(pathname, method, "/api/scenarios/execute", "POST") !== null) {
      const r = resolveStore(stores, searchParams);
      if (!handleStoreResult(res, r)) return true;
      try {
        if (!await r.store.isInitialized()) return notInitialized(res);
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await collectBody(req));
        } catch {
          jsonError(res, 400, "Request body is not valid JSON");
          return true;
        }
        const feature = typeof body.feature === "string" ? body.feature.trim() : "";
        const name    = typeof body.name    === "string" ? body.name.trim()    : "";
        const status  = typeof body.status  === "string" ? body.status.trim()  : "";
        if (!feature || !name) {
          jsonError(res, 400, "feature and name are required");
          return true;
        }
        if (status !== "pass" && status !== "fail" && status !== "pending") {
          jsonError(res, 400, `status must be "pass", "fail", or "pending"`);
          return true;
        }
        const phaseId = await r.store.resolvePhaseId(
          typeof body.phase === "string" && body.phase ? body.phase : undefined,
        );
        if (!phaseId) {
          jsonError(res, 400, "No active phase — create a phase first");
          return true;
        }
        let conductorRoot: string;
        try {
          conductorRoot = await r.store.conductorRoot();
        } catch {
          jsonError(res, 400, "Conductor project not configured");
          return true;
        }
        const index = await indexConductor(conductorRoot);
        const check = validateTestRef({ feature, name }, index);
        if (!check.ok) {
          jsonError(res, 400, check.reason ?? "Scenario not found in conductor project");
          return true;
        }
        const exec = {
          feature,
          name,
          status: status as "pass" | "fail" | "pending",
          ranAt:  new Date().toISOString(),
          source: "manual" as const,
          note:   typeof body.note === "string" && body.note ? body.note : undefined,
        };
        await r.store.appendExecutions(phaseId, [exec]);
        jsonOk(res, { phase: phaseId, recorded: exec });
      } catch (err) {
        jsonError(res, 500, String(err));
      }
      return true;
    }

    // Unknown /api/* route.
    jsonError(res, 404, "Unknown API route");
    return true;
  }

  // -------------------------------------------------------------------------
  // Static files — only for GET requests that are NOT MCP or /events
  // -------------------------------------------------------------------------
  if (method !== "GET") return false;
  if (rawUrl.includes("/mcp")) return false;

  // GET / → index.html
  const pathname = rawUrl.split("?")[0];

  if (pathname === "/") {
    await serveIndexHtml(res);
    return true;
  }

  // GET /public/* → file from public dir
  if (pathname.startsWith("/public/")) {
    const rel = pathname.slice("/public/".length);
    await serveStatic(res, path.join(PUBLIC_DIR, rel));
    return true;
  }

  // SPA fallback: any other GET that is not /api/* and not /events
  // (those were already handled above or returned false)
  await serveIndexHtml(res);
  return true;
}
