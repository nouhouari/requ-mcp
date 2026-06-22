/**
 * End-to-end smoke test for the tag-derived, story-level model. Spawns the
 * built MCP server over stdio and drives the full lifecycle: requirements (with
 * components), stories, @US-xxx tag discovery, manual + imported executions,
 * phase/mode-aware story-level coverage, and the trend across two releases
 * (including a regression).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

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

/** Cucumber-js JSON report for the Login feature. */
function loginReport(valid: "passed" | "failed", wrongPw: "passed" | "failed") {
  return JSON.stringify([
    {
      name: "Login",
      uri: "features/login.feature",
      elements: [
        { name: "Successful login with valid credentials", type: "scenario", tags: [{ name: "@US-001" }], steps: [{ result: { status: valid } }] },
        { name: "Login fails with wrong password", type: "scenario", tags: [{ name: "@US-001" }], steps: [{ result: { status: wrongPw } }] },
      ],
    },
  ]);
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "requ-smoke-"));
  await fs.mkdir(path.join(tmp, "features"), { recursive: true });
  await fs.mkdir(path.join(tmp, "reports"), { recursive: true });

  // Feature files carry the links as @US-xxx tags.
  await fs.writeFile(
    path.join(tmp, "features", "login.feature"),
    [
      "@auth",
      "Feature: Login",
      "",
      "  @US-001",
      "  Scenario: Successful login with valid credentials",
      "    Given a registered user",
      "",
      "  @US-001",
      "  Scenario: Login fails with wrong password",
      "    Given a registered user",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(tmp, "features", "checkout.feature"),
    [
      "Feature: Checkout",
      "",
      "  @US-002",
      "  Scenario: Checkout completes on mobile",
      "    Given the app is open",
      "",
      "  @US-999", // tag pointing at a story that doesn't exist -> dangling
      "  Scenario: Orphan scenario",
      "    Given something",
    ].join("\n"),
  );

  const client = new Client({ name: "smoke", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "dist", "index.js")],
    env: { ...process.env, REQU_ROOT: tmp },
  });
  await client.connect(transport);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    const txt = res.content?.[0]?.text ?? "{}";
    let parsed: any = txt;
    try {
      parsed = JSON.parse(txt);
    } catch {
      /* markdown */
    }
    return { isError: !!res.isError, data: parsed, raw: txt };
  };

  try {
    // check_conductor inspects the folder without writing anything.
    const pre = await call("check_conductor", { conductorPath: "." });
    check("check_conductor detects a Conductor project (2 features)", pre.data.isConductorProject === true && pre.data.featureFiles === 2, pre.data);

    // init refuses when the Conductor folder is missing.
    const bad = await call("init_project", { conductorPath: "no-such-conductor" });
    check("init refuses a missing Conductor folder", bad.isError === true, bad.data);

    const init = await call("init_project", { name: "Smoke", conductorPath: ".", initialPhase: "v1.0" });
    check("init creates active phase v1.0", init.data.phase?.id === "P1", init.data);
    check("init reports the Conductor name + feature count", init.data.conductor?.featureFiles === 2 && typeof init.data.conductor?.name === "string", init.data.conductor);

    // Explicit projectPath argument resolves the same project.
    const viaPath = await call("list_phases", { projectPath: tmp });
    check("explicit projectPath resolves project", viaPath.data.activePhase === "P1", viaPath.data);

    // Requirements with components.
    await call("create_requirement", { title: "User can log in", components: ["auth"], priority: "high" });
    await call("create_requirement", { title: "User can checkout on mobile", components: ["checkout", "mobile"] });
    await call("create_requirement", { title: "User can see reports", components: ["reports"] });

    // Stories (acceptance criteria are descriptive only).
    await call("create_user_story", { title: "Log in", requirements: ["REQ-001"], acceptanceCriteria: ["Valid creds reach dashboard", "Wrong password errors"] });
    await call("create_user_story", { title: "Mobile checkout", requirements: ["REQ-002"] });
    await call("create_user_story", { title: "Reports dashboard", requirements: ["REQ-003"] }); // no tagged scenarios

    // --- links are derived from feature-file tags ---
    const links = await call("list_links");
    const us001 = links.data.links.find((l: any) => l.story === "US-001");
    check("US-001 has 2 tagged scenarios", us001?.scenarios.length === 2, us001);
    check("US-002 has 1 tagged scenario", links.data.links.find((l: any) => l.story === "US-002")?.scenarios.length === 1);
    check("US-003 has no tagged scenarios", links.data.storiesWithoutScenario.includes("US-003"), links.data.storiesWithoutScenario);
    check("dangling @US-999 tag surfaced", links.data.danglingTags.some((d: any) => d.story === "US-999"), links.data.danglingTags);

    // --- before any runs: nothing covered ---
    let rep = await call("coverage_report", { mode: "cumulative" });
    check("0 stories covered before runs", rep.data.summary.storiesCovered === 0, rep.data.summary);

    // --- v1.0 results: import login, record checkout manually ---
    await fs.writeFile(path.join(tmp, "reports", "v10.json"), loginReport("passed", "passed"));
    const imp = await call("import_execution_report", { filePath: "reports/v10.json", runId: "ci-100" });
    check("import parses 2 login scenarios", imp.data.scenariosParsed === 2, imp.data);
    check("both imported scenarios are tagged to a story", imp.data.taggedToAStory === 2, imp.data);
    const rec = await call("record_execution", { feature: "Checkout", name: "Checkout completes on mobile", status: "pass" });
    check("manual execution recorded into active phase", rec.data.phase === "P1", rec.data);

    // --- v1.0 coverage ---
    rep = await call("coverage_report", { phase: "P1", mode: "cumulative" });
    check("v1.0: REQ-001 & REQ-002 verified (2/3)", rep.data.summary.requirementsVerified === 2 && rep.data.summary.requirementsTotal === 3, rep.data.summary);
    check("v1.0: stories covered 2/3", rep.data.summary.storiesCovered === 2, rep.data.summary);
    check("v1.0: scenarios passing 3/3", rep.data.summary.scenariosPassing === 3 && rep.data.summary.scenariosLinked === 3, rep.data.summary);
    check("v1.0: auth component 100% verified", rep.data.byComponent.some((c: any) => c.component === "auth" && c.verifiedPct === 100), rep.data.byComponent);

    // --- new phase v1.1 ---
    await call("create_phase", { id: "P2", name: "v1.1", activate: true });
    let strict = await call("coverage_report", { phase: "P2", mode: "strict" });
    check("strict v1.1: 0 covered before its own runs", strict.data.summary.storiesCovered === 0, strict.data.summary);
    let cum = await call("coverage_report", { phase: "P2", mode: "cumulative" });
    check("cumulative v1.1: carries forward 2 covered", cum.data.summary.storiesCovered === 2, cum.data.summary);

    // --- regression: valid-login fails in v1.1 ---
    await fs.writeFile(path.join(tmp, "reports", "v11.json"), loginReport("failed", "passed"));
    await call("import_execution_report", { filePath: "reports/v11.json", runId: "ci-110" });

    cum = await call("coverage_report", { phase: "P2", mode: "cumulative" });
    check("v1.1 regression: only 1 requirement verified", cum.data.summary.requirementsVerified === 1, cum.data.summary);
    check("v1.1: US-001 no longer covered", cum.data.stories.find((s: any) => s.id === "US-001")?.covered === false, cum.data.stories);
    check("v1.1: scenarios passing 2/3", cum.data.summary.scenariosPassing === 2, cum.data.summary);

    // --- gaps ---
    const gaps = await call("find_gaps", { phase: "P2", mode: "cumulative" });
    check("gap: US-003 has no tagged scenario", gaps.data.storiesWithoutScenario.some((s: any) => s.id === "US-003"), gaps.data);
    check("gap: US-001 not covered, failing scenario listed", gaps.data.storiesNotCovered.some((g: any) => g.id === "US-001" && g.failing.includes("Successful login with valid credentials")), gaps.data.storiesNotCovered);

    // --- evolution ---
    const trend = await call("coverage_trend", { mode: "cumulative" });
    const v10 = trend.data.points.find((p: any) => p.phase === "P1");
    const v11 = trend.data.points.find((p: any) => p.phase === "P2");
    check("trend shows verified 2 -> 1", v10.summary.requirementsVerified === 2 && v11.summary.requirementsVerified === 1, { v10: v10?.summary.requirementsVerified, v11: v11?.summary.requirementsVerified });

    // --- story view shows derived scenarios + status ---
    const story = await call("get_user_story", { id: "US-001" });
    check("get_user_story lists 2 linked scenarios", story.data.linkedScenarios?.length === 2, story.data.linkedScenarios);

    const md = await call("coverage_report", { phase: "P2", mode: "cumulative", format: "markdown" });
    check("markdown renders", md.raw.includes("Requirements Coverage — v1.1"));
    console.log("\n--- v1.1 cumulative report ---\n" + md.raw + "\n");

    console.log("--- trend ---");
    for (const p of trend.data.points)
      console.log(`  ${p.phaseName}: verified ${p.summary.requirementsVerified}/${p.summary.requirementsTotal}, stories covered ${p.summary.storiesCovered}/${p.summary.storiesTotal}`);

    // --- phase assignment & scoping ---
    // Items created earlier defaulted to the active phase at creation time (P1).
    const reqByPhase = await call("list_requirements", { phase: "P1" });
    check("create defaults requirement to active phase", reqByPhase.data.length === 3 && reqByPhase.data.every((r: any) => r.phase === "P1"), reqByPhase.data);
    // A story has no phase of its own; its phase is derived from its requirements.
    // All 3 stories link a P1 requirement, so the P1 filter returns all 3.
    const storyByPhase = await call("list_user_stories", { phase: "P1" });
    check("story phase derived from requirements (3 in P1)", storyByPhase.data.length === 3 && storyByPhase.data.every((s: any) => s.phase === undefined), storyByPhase.data);

    // A requirement explicitly planned for v1.1 (P2), plus an unassigned one.
    await call("create_requirement", { title: "v1.1 only feature", phase: "P2" }); // REQ-004
    await call("create_requirement", { title: "Unscoped feature", phase: "" });           // REQ-005

    const filt = await call("list_requirements", { phase: "P2" });
    check("list filter by phase returns only REQ-004", filt.data.length === 1 && filt.data[0].id === "REQ-004", filt.data);

    const badPhase = await call("create_requirement", { title: "bad", phase: "NOPE" });
    check("create rejects an unknown phase", badPhase.isError === true, badPhase.data);

    // A selected phase excludes both other-phase AND unassigned items.
    // strict P1: only the 3 P1 reqs (REQ-004=P2 and unassigned REQ-005 both excluded) => 3 total.
    const strictP1 = await call("coverage_report", { phase: "P1", mode: "strict" });
    check("strict P1 excludes v1.1 req and unassigned (3 total)", strictP1.data.summary.requirementsTotal === 3, strictP1.data.summary);
    check("strict P1 does not list REQ-004", !strictP1.data.requirements.some((r: any) => r.id === "REQ-004"), strictP1.data.requirements.map((r: any) => r.id));
    check("strict P1 does not list unassigned REQ-005", !strictP1.data.requirements.some((r: any) => r.id === "REQ-005"), strictP1.data.requirements.map((r: any) => r.id));

    // cumulative P2: P1 carries forward (3) + P2 (REQ-004) => 4 total; unassigned REQ-005 still excluded.
    const cumP2 = await call("coverage_report", { phase: "P2", mode: "cumulative" });
    check("cumulative P2 includes earlier + this phase, excludes unassigned (4 total)", cumP2.data.summary.requirementsTotal === 4, cumP2.data.summary);

    // Clearing a req's phase makes it unassigned → excluded whenever a phase is selected.
    await call("update_requirement", { id: "REQ-004", phase: "" });
    const strictP1b = await call("coverage_report", { phase: "P1", mode: "strict" });
    check("clearing a phase drops the req from a phase-scoped report (3 total)", strictP1b.data.summary.requirementsTotal === 3, strictP1b.data.summary);

    // =====================================================================
    // Scenarios: requ-owned gherkin content, validation, tag/story/req filters
    // (run last — storing scenarios switches coverage to DB-native precedence)
    // =====================================================================
    const goodGherkin =
      "Scenario: Successful login with valid credentials\n" +
      "  Given a registered user\n" +
      "  When they submit valid credentials\n" +
      "  Then they reach the dashboard";

    const vgood = await call("validate_scenario", { content: goodGherkin });
    check("validate_scenario accepts good gherkin", vgood.data.ok === true, vgood.data);
    const vbad = await call("validate_scenario", { content: "Scenario: a\n Given x\nScenario: b\n Given y" });
    check("validate_scenario rejects multi-scenario content with errors", vbad.data.ok === false && vbad.data.errors.length > 0, vbad.data);

    const badCreate = await call("create_scenario", { feature: "Login", name: "Broken", content: "Scenario: a\n Given x\nScenario: b" });
    check("create_scenario rejects invalid gherkin", badCreate.isError === true, badCreate.data);
    const forced = await call("create_scenario", { feature: "Login", name: "Broken", content: "Scenario: a\n Given x\nScenario: b", force: true });
    check("create_scenario force stores invalid (valid=false)", forced.data.scenario?.valid === false, forced.data);
    const del = await call("delete_scenario", { feature: "Login", name: "Broken" });
    check("delete_scenario removes the row", del.data.deleted === true, del.data);

    await call("create_scenario", { feature: "Login", name: "Successful login with valid credentials", content: goodGherkin, tags: ["@US-001", "@smoke"] });
    await call("create_scenario", {
      feature: "Login",
      name: "Login fails with wrong password",
      content: "Scenario: Login fails with wrong password\n  Given a registered user\n  When they submit a wrong password\n  Then they see an error",
      tags: ["@US-001", "@wip"],
    });

    const listAll = await call("list_scenarios", {});
    check("list_scenarios returns the 2 stored scenarios", Array.isArray(listAll.data) && listAll.data.length === 2, listAll.data);

    const linksStore = await call("list_links");
    check("list_links reports source=store once scenarios are stored", linksStore.data.source === "store", linksStore.data);

    const smoke = await call("list_scenarios", { tags: "@smoke and not @wip" });
    check("tag expression filters to the @smoke scenario", smoke.data.length === 1 && smoke.data[0].name === "Successful login with valid credentials", smoke.data);

    const badExpr = await call("list_scenarios", { tags: "@a and" });
    check("invalid tag expression errors", badExpr.isError === true, badExpr.data);

    const byStory = await call("list_scenarios", { story: "US-001" });
    check("filter by story US-001 returns both", byStory.data.length === 2, byStory.data);
    const byReq = await call("list_scenarios", { requirement: "REQ-001" });
    check("filter by requirement REQ-001 returns both (via US-001)", byReq.data.length === 2, byReq.data);

    const getSc = await call("get_scenario", { feature: "Login", name: "Successful login with valid credentials" });
    check("get_scenario returns content + tags", typeof getSc.data.content === "string" && getSc.data.content.includes("Given a registered user") && getSc.data.tags.includes("@smoke"), getSc.data);

    // DB precedence: coverage now derives from stored scenarios (US-001 keeps its 2).
    const repStore = await call("coverage_report", { phase: "P1", mode: "cumulative" });
    check("coverage derives from stored scenarios (US-001 has 2)", repStore.data.stories.find((s: any) => s.id === "US-001")?.scenarios.length === 2, repStore.data.stories);

    // import_scenarios_from_features on a fresh project populates content from disk.
    const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), "requ-smoke-import-"));
    await fs.mkdir(path.join(tmp2, "features"), { recursive: true });
    await fs.writeFile(
      path.join(tmp2, "features", "search.feature"),
      [
        "Feature: Search",
        "",
        "  Background:",
        "    Given the catalog is loaded",
        "",
        "  @US-1",
        "  Scenario: Find a product by name",
        "    When I search for a product",
        "    Then I see matching results",
      ].join("\n"),
    );
    await call("init_project", { projectPath: tmp2, name: "ImportSmoke", conductorPath: "." });
    const importRes = await call("import_scenarios_from_features", { projectPath: tmp2 });
    check("import_scenarios_from_features imports disk scenarios", importRes.data.scenariosParsed === 1 && importRes.data.imported === 1, importRes.data);
    const imported = await call("list_scenarios", { projectPath: tmp2 });
    check("imported scenario has content populated", imported.data.length === 1 && imported.data[0].content.includes("When I search for a product"), imported.data);
    check("imported scenario captures the Background block", imported.data[0].background.includes("Given the catalog is loaded"), imported.data[0].background);
    await fs.rm(tmp2, { recursive: true, force: true });
  } finally {
    await client.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
