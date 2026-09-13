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
import { spawn } from "node:child_process";
import { Pool } from "pg";
import { PostgresStore, initPgPool } from "../src/postgres-store.js";
import { buildExport, applyImport } from "../src/export-import.js";
import { createVersion, lockVersion } from "../src/version-ops.js";
import { diffVersions } from "../src/version-diff.js";
import type { Component, Requirement, UserStory, Phase, Execution, VcsRef, Config, Scenario } from "../src/schema.js";

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
    for (const t of ["config", "components", "requirements", "stories", "scenarios", "phases", "vcs_refs"]) {
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

    // --- scenarios ---
    console.log("\n  [scenarios]");
    const sc1: Scenario = {
      feature: "Login", name: "Valid login", testKey: "Login::Valid login",
      content: "Scenario: Valid login\n  When they log in\n  Then ok",
      background: "Background:\n  Given a registered user",
      tags: ["@US-001", "@smoke"], stories: ["US-001"], source: "manual", valid: true,
      createdAt: ts(), updatedAt: ts(),
    };
    await storeA.writeScenario(sc1);
    check("listScenarios returns 1", (await storeA.listScenarios()).length === 1);
    const gotSc = await storeA.getScenario("Login::Valid login");
    check("getScenario round-trips content + tags", gotSc?.content.includes("When they log in") === true && gotSc?.tags.includes("@smoke") === true);
    check("getScenario round-trips background", gotSc?.background.includes("Given a registered user") === true, gotSc?.background);
    check("getScenario null for missing", await storeA.getScenario("Nope::Nope") === null);
    await storeA.writeScenario({ ...sc1, valid: false });
    check("writeScenario upserts (valid=false)", (await storeA.getScenario("Login::Valid login"))?.valid === false);
    check("listProjectIds includes this project", (await PostgresStore.listProjectIds()).includes(pidA));
    check("deleteScenario removes the row", await storeA.deleteScenario("Login::Valid login") === true);
    check("deleteScenario false for missing", await storeA.deleteScenario("Login::Valid login") === false);
    // Restore one scenario for the export round-trip + HTTP checks below.
    await storeA.writeScenario(sc1);
    check("scenario isolated from project B", (await storeB.listScenarios()).length === 0);

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
    // --- versioning (copy-on-write baselines) -------------------------------
    console.log("\n  [versions]");
    const pidV = `${runId}-v`;
    const storeV = new PostgresStore(root, pidV);
    await storeV.init({ name: "PG Versions", key: "PGVER", conductorPath: ".", currentVersion: "1.0.0", draftVersion: "1.0.0" });
    await storeV.writeVersion({ version: "1.0.0", status: "draft", label: "Initial", createdAt: ts() });

    await storeV.writeRequirement({
      id: "REQ-001", title: "Guests can book", description: "", status: "active",
      components: [], tags: [], removed: false, createdAt: ts(), updatedAt: ts(),
    } as Requirement);
    await storeV.writeStory({
      id: "US-001", title: "Book a slot", description: "", status: "draft",
      requirements: ["REQ-001"], acceptanceCriteria: [], removed: false,
      createdAt: ts(), updatedAt: ts(),
    } as UserStory);

    const lockRes = await lockVersion(storeV, "1.0.0", { actor: "ba", reason: "baseline" });
    check("lockVersion succeeds", lockRes.ok === true, lockRes);
    check("locked version is reported as locked", await storeV.isLocked() === true);

    let rejected = false;
    try {
      const r = (await storeV.getRequirement("REQ-001"))!;
      await storeV.writeRequirement({ ...r, title: "Changed", updatedAt: ts() });
    } catch { rejected = true; }
    check("locked version rejects a requirement edit", rejected);

    const progressed = (await storeV.getStory("US-001"))!;
    await storeV.writeStory({ ...progressed, status: "done", updatedAt: ts() });
    check("locked version allows a status change", (await storeV.getStory("US-001"))!.status === "done");

    const createRes = await createVersion(storeV, { bump: "minor", label: "Next", actor: "ba" });
    check("createVersion opens 1.1.0", createRes.ok === true && (createRes as any).data.created === "1.1.0", createRes);

    const v11 = storeV.at("1.1.0") as PostgresStore;
    check("the copy carries the requirement", (await v11.listRequirements()).length === 1);
    const copied = (await v11.getRequirement("REQ-001"))!;
    await v11.writeRequirement({ ...copied, title: "Guests can book online", updatedAt: ts() });
    check("1.1.0 takes the edit", (await v11.getRequirement("REQ-001"))!.title === "Guests can book online");
    check("1.0.0 is untouched", (await (storeV.at("1.0.0") as PostgresStore).getRequirement("REQ-001"))!.title === "Guests can book");

    await v11.deleteRequirement("REQ-001");
    check("soft delete hides the row", (await v11.listRequirements()).length === 0);
    check("…but includeRemoved surfaces the tombstone", (await v11.listRequirements({ includeRemoved: true })).length === 1);
    check("…and the locked baseline still has it", (await (storeV.at("1.0.0") as PostgresStore).listRequirements()).length === 1);

    const pgDiff = await diffVersions(storeV, "1.0.0", "1.1.0");
    check("diff reports the removal", pgDiff.entities.requirements.removed.some((e) => e.id === "REQ-001"), pgDiff.summary.requirements);
    check("ids are allocated across versions", (await storeV.idsAcrossVersions("requirements")).includes("REQ-001"));

    await cleanup(cleanupPool, pidV);
    await cleanupPool.query("DELETE FROM versions WHERE project_id = $1", [pidV]);
    for (const t of ["screens", "adrs"]) {
      await cleanupPool.query(`DELETE FROM ${t} WHERE project_id = $1`, [pidV]);
    }

    console.log("\n  [export / import]");
    // B needs the same phases for executions to import
    await storeB.writePhase(p1);
    await storeB.writePhase(p2);

    const payload = await buildExport(storeA);
    check("buildExport includes source name", payload.source?.name === "PG Smoke", payload.source);
    check("buildExport has requirements", payload.data.requirements.length === 1);
    check("buildExport has stories", payload.data.stories.length === 1);
    check("buildExport has scenarios", payload.data.scenarios.length === 1, payload.data.scenarios);
    check("buildExport has executions for P1", payload.data.executions["P1"]?.length === 2);

    const report = await applyImport(storeB, payload);
    check("applyImport imports 1 requirement", report.imported.requirements === 1, report);
    check("applyImport imports 1 story", report.imported.stories === 1, report);
    check("applyImport imports 1 scenario", report.imported.scenarios === 1, report);
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

    // --- HTTP mode without a filesystem root + scenario REST API + OpenAPI ---
    console.log("\n  [http / db-native / rest api]");
    const port = 8788 + (Date.now() % 1000);
    const child = spawn(process.execPath, [path.join(repoRoot, "dist", "index.js")], {
      env: { ...process.env, REQU_TRANSPORT: "http", REQU_PG_URL: PG_URL, REQU_PORT: String(port), REQU_PROJECTS: "", REQU_ROOT: "" },
      stdio: "ignore",
    });
    const base = `http://127.0.0.1:${port}`;
    try {
      // Wait for the server to accept connections (no filesystem project configured).
      let up = false;
      for (let i = 0; i < 50; i++) {
        try { const v = await fetch(`${base}/api/version`); if (v.ok) { up = true; break; } } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      check("http server starts with no project root", up);

      if (up) {
        const projects = await (await fetch(`${base}/api/projects`)).json();
        check("GET /api/projects discovers DB-native projects", Array.isArray(projects) && projects.some((p: any) => p.slug === pidA), projects);

        const list = await (await fetch(`${base}/api/scenarios?project=${pidA}`)).json();
        check("GET /api/scenarios returns stored scenario", list.total === 1 && list.scenarios[0].id === "Login::Valid login", list);

        const smokeRes = await (await fetch(`${base}/api/scenarios?project=${pidA}&tags=${encodeURIComponent("@smoke and not @wip")}`)).json();
        check("GET /api/scenarios tag expression filters", smokeRes.total === 1, smokeRes);

        const withContent = await (await fetch(`${base}/api/scenarios?project=${pidA}&content=true`)).json();
        check("GET /api/scenarios content=true inlines gherkin + background", typeof withContent.scenarios[0].content === "string" && withContent.scenarios[0].content.includes("When they log in") && withContent.scenarios[0].background.includes("Given a registered user"), withContent.scenarios[0]);

        const single = await (await fetch(`${base}/api/scenarios/${encodeURIComponent("Login::Valid login")}?project=${pidA}`)).json();
        check("GET /api/scenarios/:id returns content", single.id === "Login::Valid login" && single.content.includes("When they log in"), single);
        check("GET /api/scenarios/:id returns background block", typeof single.background === "string" && single.background.includes("Given a registered user"), single.background);

        const badReq = await fetch(`${base}/api/scenarios?project=${pidA}&tags=${encodeURIComponent("@a and")}`);
        check("GET /api/scenarios 400 on invalid tag expression", badReq.status === 400, badReq.status);

        const tagsRes = await (await fetch(`${base}/api/tags?project=${pidA}`)).json();
        check("GET /api/tags lists tags with counts", Array.isArray(tagsRes) && tagsRes.some((t: any) => t.tag === "@smoke"), tagsRes);

        const yamlText = await (await fetch(`${base}/api/openapi.yaml`)).text();
        check("GET /api/openapi.yaml serves the OpenAPI 3.1 contract", yamlText.includes("openapi: 3.1") && yamlText.includes("/api/scenarios"), yamlText.slice(0, 40));
      }
    } finally {
      child.kill("SIGKILL");
    }

  } finally {
    await cleanup(cleanupPool, pidA, pidB);
    await cleanupPool.end();
  }

  await authStoreChecks();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

/**
 * The auth, audit and change-history tables on PostgreSQL.
 *
 * These share requ's own database, and their SQL differs from the SQLite
 * variant in every place that matters — JSONB round-tripping, BIGSERIAL ids
 * coming back as strings, `$n` placeholders built up by the query filters. The
 * SQLite path is covered by `npm run smoke:auth`; this is the other half.
 */
async function authStoreChecks(): Promise<void> {
  console.log("\n— auth, audit and change history on PostgreSQL —");
  process.env.REQU_AUTH_SECRET ??= "smoke-pg-secret-smoke-pg-secret-0123456789";
  process.env.REQU_AUTH_MODE = "disabled";

  const { authStore } = await import("../src/auth/store.js");
  const { mintToken } = await import("../src/auth/tokens.js");

  // A unique project id per run, so repeated runs never see each other's rows.
  const pid = `pgauth-${Date.now()}`;
  const uid = `pgauth-${Date.now()}`;
  const store = authStore();
  await store.init();

  const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();
  const pool = new Pool({ connectionString: PG_URL });

  try {
    // --- users ---
    await store.upsertUser({
      id: uid, username: uid, displayName: "PG User", email: "pg@example.test",
      dn: "uid=pg,ou=people", groups: ["cn=devs,ou=groups"], disabled: false, lastLoginAt: iso(),
    });
    const user = await store.getUser(uid);
    check("pg: a user round-trips with its groups", user?.displayName === "PG User" && user?.groups[0] === "cn=devs,ou=groups", user);
    check("pg: listUsers finds it", (await store.listUsers()).some((u) => u.id === uid));

    await store.upsertUser({ id: uid, username: uid, displayName: "Renamed", email: null, dn: null, groups: [], disabled: false });
    check("pg: a second sign-in updates in place", (await store.getUser(uid))?.displayName === "Renamed");
    check("pg: it keeps the recorded last sign-in", (await store.getUser(uid))?.lastLoginAt !== null);

    // --- role bindings ---
    await store.grantRole({ userId: uid, projectId: "*", role: "maintainer", grantedBy: "smoke", grantedAt: iso() });
    await store.grantRole({ userId: uid, projectId: pid, role: "admin", grantedBy: "smoke", grantedAt: iso() });
    check("pg: role bindings round-trip", (await store.listBindings(uid)).length === 2);
    check("pg: granting the same role twice is idempotent", await (async () => {
      await store.grantRole({ userId: uid, projectId: "*", role: "maintainer", grantedBy: "smoke", grantedAt: iso() });
      return (await store.listBindings(uid)).length === 2;
    })());
    check("pg: a binding can be revoked", (await store.revokeRole(uid, pid, "admin")) && (await store.listBindings(uid)).length === 1);

    // --- tokens ---
    const minted = mintToken(process.env.REQU_AUTH_SECRET!);
    await store.createToken({
      id: minted.id, userId: uid, name: "scoped", tokenHash: minted.hash, createdAt: iso(),
      expiresAt: null, lastUsedAt: null, revokedAt: null, revokedBy: null,
      maxRole: "viewer", projects: ["alpha", "beta"],
    });
    const tok = await store.getTokenWithHash(minted.id);
    check("pg: a token round-trips with its ceiling and project scope",
      tok?.maxRole === "viewer" && JSON.stringify(tok?.projects) === JSON.stringify(["alpha", "beta"]), tok);
    check("pg: the stored hash is the peppered one", tok?.tokenHash === minted.hash);
    await store.touchToken(minted.id, iso());
    check("pg: last use is recorded", (await store.getTokenWithHash(minted.id))?.lastUsedAt !== null);
    check("pg: revoking works once", (await store.revokeToken(minted.id, "smoke")) === true);
    check("pg: revoking again is a no-op", (await store.revokeToken(minted.id, "smoke")) === false);

    const unscoped = mintToken(process.env.REQU_AUTH_SECRET!);
    await store.createToken({
      id: unscoped.id, userId: uid, name: "unscoped", tokenHash: unscoped.hash, createdAt: iso(),
      expiresAt: null, lastUsedAt: null, revokedAt: null, revokedBy: null, maxRole: null, projects: null,
    });
    check("pg: an unscoped token keeps a null project list", (await store.getTokenWithHash(unscoped.id))?.projects === null);
    check("pg: listTokens returns both", (await store.listTokens(uid)).length === 2);

    // --- sessions ---
    const session = {
      id: `sess-${pid}`, userId: uid, createdAt: iso(), expiresAt: iso(3_600_000),
      revokedAt: null, ip: "127.0.0.1", userAgent: "smoke", pendingTotp: false,
    };
    await store.createSession(session);
    check("pg: a session round-trips", (await store.getSession(session.id))?.userId === uid);
    check("pg: revoking a session works", (await store.revokeSession(session.id)) === true);
    check("pg: revoking it again is a no-op", (await store.revokeSession(session.id)) === false);
    await store.createSession({ ...session, id: `${session.id}-2` });
    check("pg: every session of a user can be revoked at once", (await store.revokeSessionsForUser(uid)) === 1);

    // --- audit log ---
    for (const [i, outcome] of (["ok", "denied", "error"] as const).entries()) {
      await store.appendAudit({
        at: iso(i), actorId: uid, actorName: "PG User", actorKind: "token", source: "mcp",
        action: "create_requirement", projectId: pid, version: "1.0.0", outcome,
        permission: "spec:write", detail: { title: "Audited", n: i }, ip: "127.0.0.1", tokenId: minted.id,
      });
    }
    const audited = await store.queryAudit({ projectId: pid });
    check("pg: audit rows round-trip", audited.total === 3 && audited.entries.length === 3, audited.total);
    check("pg: audit detail survives as JSONB", audited.entries[0].detail?.title === "Audited", audited.entries[0].detail);
    check("pg: the audit log reads newest first", audited.entries[0].outcome === "error", audited.entries.map((e) => e.outcome));
    check("pg: filtering by outcome works", (await store.queryAudit({ projectId: pid, outcome: "denied" })).total === 1);
    check("pg: filtering by action works", (await store.queryAudit({ projectId: pid, action: "create_requirement" })).total === 3);
    check("pg: filtering by source works", (await store.queryAudit({ projectId: pid, source: "web" })).total === 0);
    check("pg: filtering by actor works", (await store.queryAudit({ projectId: pid, actorId: "nobody" })).total === 0);
    const page = await store.queryAudit({ projectId: pid, limit: 2, offset: 1 });
    check("pg: audit pagination works", page.entries.length === 2 && page.total === 3, page.entries.length);

    // --- change history ---
    await store.appendChanges([
      { at: iso(), projectId: pid, version: "1.0.0", entity: "requirement", entityId: "REQ-001", action: "created", actorId: uid, actorName: "PG User", source: "mcp", changes: [{ field: "title", from: null, to: "A" }] },
      { at: iso(1), projectId: pid, version: "1.0.0", entity: "requirement", entityId: "REQ-001", action: "updated", actorId: uid, actorName: "PG User", source: "web", changes: [{ field: "title", from: "A", to: "B" }] },
      { at: iso(), projectId: pid, version: "1.0.0", entity: "story", entityId: "US-001", action: "created", actorId: uid, actorName: "PG User", source: "mcp", changes: [] },
    ]);
    const history = await store.queryChanges({ projectId: pid, entity: "requirement", entityId: "REQ-001" });
    check("pg: an entity's history round-trips", history.total === 2, history.total);
    check("pg: history reads newest first", history.changes[0].action === "updated", history.changes.map((c) => c.action));
    check("pg: field diffs survive as JSONB",
      history.changes[0].changes[0].from === "A" && history.changes[0].changes[0].to === "B", history.changes[0].changes);
    check("pg: the project-wide stream returns every entity", (await store.queryChanges({ projectId: pid })).total === 3);
    check("pg: a change with no field diff round-trips",
      (await store.queryChanges({ projectId: pid, entity: "story" })).changes[0].changes.length === 0);

    // --- second factor ---
    const { sealSecret, openSecret } = await import("../src/auth/secret-box.js");
    const { generateSecret, generateRecoveryCodes, hashRecoveryCode } = await import("../src/auth/totp.js");
    const seed = generateSecret();
    const secretPepper = process.env.REQU_AUTH_SECRET!;
    const codes = generateRecoveryCodes();
    await store.putTotp({
      userId: uid,
      secretSealed: sealSecret(seed, secretPepper),
      confirmedAt: iso(),
      createdAt: iso(),
      lastStep: null,
      recoveryHashes: codes.map((c) => hashRecoveryCode(c, secretPepper)),
    });
    const totpRow = await store.getTotp(uid);
    check("pg: an enrolment round-trips", totpRow?.confirmedAt !== null && totpRow?.recoveryHashes.length === 10, totpRow?.recoveryHashes.length);
    check("pg: the seed is stored sealed, not in the clear", !JSON.stringify(totpRow).includes(seed));
    check("pg: and opens back to the original", openSecret(totpRow!.secretSealed, secretPepper) === seed);
    check("pg: a confirmed enrolment is listed", (await store.listTotpUserIds()).includes(uid));

    await store.setTotpLastStep(uid, 100);
    check("pg: the replay watermark is recorded", (await store.getTotp(uid))?.lastStep === 100);
    await store.setTotpLastStep(uid, 50);
    check("pg: and never moves backwards", (await store.getTotp(uid))?.lastStep === 100, (await store.getTotp(uid))?.lastStep);

    await store.setRecoveryHashes(uid, totpRow!.recoveryHashes.slice(1));
    check("pg: spending a recovery code shortens the list", (await store.getTotp(uid))?.recoveryHashes.length === 9);

    const pending = { ...session, id: `${session.id}-pending`, pendingTotp: true };
    await store.createSession(pending);
    check("pg: a session can be stored pending its second factor", (await store.getSession(pending.id))?.pendingTotp === true);
    check("pg: clearing the flag promotes it", (await store.clearSessionPending(pending.id)) === true);
    check("pg: and it is now an ordinary session", (await store.getSession(pending.id))?.pendingTotp === false);
    check("pg: clearing an already-promoted session is a no-op", (await store.clearSessionPending(pending.id)) === false);
    check("pg: an enrolment can be deleted", (await store.deleteTotp(uid)) === true);

    check("pg: disabling a user persists", await (async () => {
      await store.setUserDisabled(uid, true);
      return (await store.getUser(uid))?.disabled === true;
    })());
  } finally {
    await pool.query("DELETE FROM audit_log WHERE project_id = $1", [pid]);
    await pool.query("DELETE FROM entity_changes WHERE project_id = $1", [pid]);
    await pool.query("DELETE FROM auth_tokens WHERE user_id = $1", [uid]);
    await pool.query("DELETE FROM auth_sessions WHERE user_id = $1", [uid]);
    await pool.query("DELETE FROM auth_totp WHERE user_id = $1", [uid]);
    await pool.query("DELETE FROM auth_role_bindings WHERE user_id = $1", [uid]);
    await pool.query("DELETE FROM auth_users WHERE id = $1", [uid]);
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
