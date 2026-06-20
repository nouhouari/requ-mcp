/**
 * Smoke test for the PostgresStore backend.
 *
 * Requires a live PostgreSQL instance. Set REQU_PG_URL to the connection
 * string (defaults to postgresql://localhost/requ_mcp_test).
 *
 * Each run uses a unique project_id so multiple runs never collide.
 * All test rows are deleted in a finally block.
 */
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { Pool } from "pg";
import { PostgresStore, initPgPool } from "../src/postgres-store.js";
import { buildExport, applyImport } from "../src/export-import.js";
import type { Component, Requirement, UserStory, Phase, Execution, VcsRef, Config } from "../src/schema.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const PG_URL = process.env.REQU_PG_URL ?? "postgresql://localhost/requ_mcp_test";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

const ts = () => new Date().toISOString();

async function cleanup(pool: Pool, ...projectIds: string[]): Promise<void> {
  for (const pid of projectIds) {
    await pool.query("DELETE FROM executions WHERE project_id = $1", [pid]);
    for (const t of ["config", "components", "requirements", "stories", "phases", "vcs_refs"]) {
      await pool.query(`DELETE FROM ${t} WHERE project_id = $1`, [pid]);
    }
  }
}

async function main() {
  const runId = `smoke-pg-${Date.now()}`;
  const pidA  = `${runId}-a`;
  const pidB  = `${runId}-b`;
  const root  = path.join(os.tmpdir(), runId);

  console.log(`\nRequ-MCP PostgresStore smoke test`);
  console.log(`  PG_URL   : ${PG_URL.replace(/:\/\/[^@]*@/, "://<redacted>@")}`);
  console.log(`  projectId: ${pidA} / ${pidB}\n`);

  initPgPool(PG_URL);

  // Grab the internal pool for cleanup — initPgPool stores it in module scope.
  // We create a second pool here only for the cleanup queries.
  const cleanupPool = new Pool({ connectionString: PG_URL });

  const storeA = new PostgresStore(root, pidA);
  const storeB = new PostgresStore(root, pidB);

  try {
    // --- isInitialized / init / readConfig / writeConfig ---
    console.log("  [config]");
    check("isInitialized false before init", await storeA.isInitialized() === false);

    const cfg: Config = {
      name: "PG Smoke",
      key: "PGSMOKE",
      conductorPath: ".",
      activePhase: "P1",
    };
    await storeA.init(cfg);
    check("isInitialized true after init", await storeA.isInitialized() === true);

    const got = await storeA.readConfig();
    check("readConfig round-trips name+key", got.name === "PG Smoke" && got.key === "PGSMOKE", got);

    // upsert: write again with updated brief
    await storeA.writeConfig({ ...cfg, brief: "updated" });
    const got2 = await storeA.readConfig();
    check("writeConfig upserts (brief updated)", got2.brief === "updated", got2);

    // --- components ---
    console.log("\n  [components]");
    const comp: Component = { id: "C-auth", name: "Auth", description: "Auth subsystem", domainTags: ["auth"], status: "active", createdAt: ts(), updatedAt: ts() };
    await storeA.writeComponent(comp);

    const comps = await storeA.listComponents();
    check("listComponents returns 1", comps.length === 1 && comps[0].id === "C-auth", comps.map(c => c.id));

    const gotComp = await storeA.getComponent("C-auth");
    check("getComponent round-trips domainTags", gotComp?.domainTags?.includes("auth") === true, gotComp);

    check("getComponent null for missing", await storeA.getComponent("C-missing") === null);

    // upsert: write same id with updated name
    await storeA.writeComponent({ ...comp, name: "Authentication" });
    check("writeComponent upserts", (await storeA.getComponent("C-auth"))?.name === "Authentication");

    // --- requirements ---
    console.log("\n  [requirements]");
    const req: Requirement = { id: "REQ-001", title: "User can log in", description: "", source: "", priority: "high", components: ["C-auth"], tags: [], status: "active", createdAt: ts(), updatedAt: ts() };
    await storeA.writeRequirement(req);
    const reqs = await storeA.listRequirements();
    check("listRequirements returns 1", reqs.length === 1 && reqs[0].id === "REQ-001", reqs.map(r => r.id));
    const gotReq = await storeA.getRequirement("REQ-001");
    check("getRequirement round-trips priority + components", gotReq?.priority === "high" && gotReq?.components?.includes("C-auth"), gotReq);
    check("getRequirement null for missing", await storeA.getRequirement("REQ-999") === null);

    // --- stories ---
    console.log("\n  [stories]");
    const story: UserStory = {
      id: "US-001", title: "Log in", description: "", requirements: ["REQ-001"],
      acceptanceCriteria: [{ id: "AC-1", text: "Valid creds reach dashboard" }],
      status: "draft", createdAt: ts(), updatedAt: ts(),
    };
    await storeA.writeStory(story);
    const stories = await storeA.listStories();
    check("listStories returns 1", stories.length === 1 && stories[0].id === "US-001");
    const gotStory = await storeA.getStory("US-001");
    check("getStory round-trips acceptanceCriteria", gotStory?.acceptanceCriteria?.[0]?.text === "Valid creds reach dashboard", gotStory);
    check("getStory null for missing", await storeA.getStory("US-999") === null);

    // --- phases ---
    console.log("\n  [phases]");
    const p1: Phase = { id: "P1", name: "v1.0", order: 1, status: "active",  description: "", createdAt: ts(), updatedAt: ts() };
    const p2: Phase = { id: "P2", name: "v1.1", order: 2, status: "planned", description: "", createdAt: ts(), updatedAt: ts() };
    await storeA.writePhase(p2); // intentionally write P2 first to check ORDER BY sort_order
    await storeA.writePhase(p1);

    const phases = await storeA.listPhases();
    check("listPhases ordered by sort_order (P1 first)", phases[0]?.id === "P1" && phases[1]?.id === "P2", phases.map(p => p.id));
    check("getPhase round-trips status", (await storeA.getPhase("P2"))?.status === "planned");
    check("getPhase null for missing", await storeA.getPhase("NOPE") === null);

    // resolvePhaseId: explicit > config.activePhase > latest
    check("resolvePhaseId explicit", await storeA.resolvePhaseId("P2") === "P2");
    check("resolvePhaseId from config.activePhase", await storeA.resolvePhaseId() === "P1");

    // clear activePhase, should fall back to last phase by order (P2)
    await storeA.writeConfig({ ...cfg, brief: "updated", activePhase: undefined });
    check("resolvePhaseId fallback to latest (P2)", await storeA.resolvePhaseId() === "P2");
    // restore
    await storeA.writeConfig({ ...cfg, brief: "updated", activePhase: "P1" });

    // upsert phase
    await storeA.writePhase({ ...p1, name: "v1.0 GA" });
    check("writePhase upserts (name updated)", (await storeA.getPhase("P1"))?.name === "v1.0 GA");

    // --- executions ---
    console.log("\n  [executions]");
    const execs: Execution[] = [
      { feature: "Login", name: "Valid login", status: "pass", ranAt: ts(), runId: "ci-1", source: "cucumber-json" },
      { feature: "Login", name: "Wrong password", status: "fail", ranAt: ts(), source: "manual", note: "flaky" },
    ];
    await storeA.appendExecutions("P1", execs);
    const log = await storeA.readExecutionLog("P1");
    check("readExecutionLog returns 2 rows", log.length === 2, log.length);
    check("readExecutionLog round-trips runId", log[0]?.runId === "ci-1", log[0]);
    check("readExecutionLog coerces null note to undefined", log[0]?.note === undefined, log[0]?.note);
    check("readExecutionLog preserves note", log[1]?.note === "flaky", log[1]?.note);

    // additional batch in P2
    await storeA.appendExecutions("P2", [{ feature: "Checkout", name: "Happy path", status: "pass", ranAt: ts(), source: "manual" }]);
    const all = await storeA.readAllExecutions();
    check("readAllExecutions covers both phases", all.get("P1")?.length === 2 && all.get("P2")?.length === 1, { p1: all.get("P1")?.length, p2: all.get("P2")?.length });

    // --- vcs refs ---
    console.log("\n  [vcs refs]");
    const br: VcsRef = { id: "BR-001", kind: "branch", ref: "feature/login", url: "", branch: "feature/login", storyIds: ["US-001"], requirementIds: ["REQ-001"], state: "opened", createdAt: ts(), updatedAt: ts() };
    const mr: VcsRef = { id: "MR-5", kind: "mr", ref: "5", url: "https://gl.com/-/5", branch: "feature/login", targetBranch: "main", storyIds: ["US-001"], requirementIds: [], state: "opened", createdAt: ts(), updatedAt: ts() };
    await storeA.writeVcsRef(br);
    await storeA.writeVcsRef(mr);

    const allRefs = await storeA.listVcsRefs();
    check("listVcsRefs returns 2", allRefs.length === 2, allRefs.map(r => r.id));
    check("getVcsRef round-trips storyIds", (await storeA.getVcsRef("MR-5"))?.storyIds?.includes("US-001") === true);
    check("getVcsRef null for missing", await storeA.getVcsRef("MR-999") === null);

    const updated = await storeA.updateVcsRef("MR-5", { state: "merged", mergeCommit: "abc123", updatedAt: ts() });
    check("updateVcsRef sets state=merged", updated?.state === "merged" && updated?.mergeCommit === "abc123", updated);

    const missing = await storeA.updateVcsRef("MR-999", { state: "closed" });
    check("updateVcsRef returns null for unknown id", missing === null);

    // --- static nextId ---
    console.log("\n  [nextId]");
    check("nextId REQ-001 from empty", PostgresStore.nextId("REQ", []) === "REQ-001");
    check("nextId REQ-003 from [REQ-001,REQ-002]", PostgresStore.nextId("REQ", ["REQ-001", "REQ-002"]) === "REQ-003");
    check("nextId BR-002 from [BR-001]", PostgresStore.nextId("BR", ["BR-001"]) === "BR-002");

    // --- multi-project isolation ---
    console.log("\n  [multi-project isolation]");
    await storeB.init({ name: "Project B", key: "PROJB", conductorPath: "." });
    check("project B isInitialized independently", await storeB.isInitialized() === true);
    check("project B has empty requirements", (await storeB.listRequirements()).length === 0);
    check("project B has empty stories", (await storeB.listStories()).length === 0);
    check("project A requirements unaffected by B", (await storeA.listRequirements()).length === 1);

    // --- export / import round-trip (A → B) ---
    console.log("\n  [export / import]");
    // B needs the same phases for executions to import
    await storeB.writePhase(p1);
    await storeB.writePhase(p2);

    const payload = await buildExport(storeA);
    check("buildExport includes source name", payload.source?.name === "PG Smoke", payload.source);
    check("buildExport has requirements", payload.data.requirements.length === 1);
    check("buildExport has stories", payload.data.stories.length === 1);
    check("buildExport has executions for P1", payload.data.executions["P1"]?.length === 2);

    const report = await applyImport(storeB, payload);
    check("applyImport imports 1 requirement", report.imported.requirements === 1, report);
    check("applyImport imports 1 story", report.imported.stories === 1, report);
    check("applyImport imports 1 component", report.imported.components === 1, report);
    check("applyImport imports executions", (report.imported.executions ?? 0) > 0, report);
    check("applyImport skips existing phases (B already has P1,P2)", (report.skipped.phases?.length ?? 0) === 2, report.skipped.phases);

    // Re-import: everything skipped
    const report2 = await applyImport(storeB, payload);
    check("re-import skips all requirements", report2.skipped.requirements?.length === 1, report2.skipped);
    check("re-import skips all stories", report2.skipped.stories?.length === 1, report2.skipped);

    // Verify B now has the imported data
    check("B has requirement after import", (await storeB.listRequirements()).length === 1);
    check("B has story after import", (await storeB.listStories()).length === 1);

  } finally {
    await cleanup(cleanupPool, pidA, pidB);
    await cleanupPool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
