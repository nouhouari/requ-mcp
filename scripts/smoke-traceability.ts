/**
 * Smoke test for the traceability chain behind the dashboard's Traceability tab:
 * GET /api/traceability — requirement → story → scenario → latest result, with
 * the gap at every broken link made explicit (no story, no scenario, never run,
 * failing, dangling @US tag). Seeds through the MCP tools, asserts over REST,
 * and checks parity with /api/coverage and /api/coverage/gaps.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness } from "./lib/http-harness.js";

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

const gherkin = (name: string) => `Scenario: ${name}\n  Given a precondition\n  When something happens\n  Then it is observed`;

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "requ-smoke-trace-"));
  // init_project checks the Conductor folder looks real (has features/).
  await fs.mkdir(path.join(tmp, "features"), { recursive: true });
  await fs.writeFile(path.join(tmp, "features", "placeholder.feature"), "Feature: Placeholder\n");

  const h = await startHarness([tmp], "smoke-traceability");
  const { call } = h;
  const api = async (p: string, init?: RequestInit) => {
    const res = await fetch(`${h.base}${p}`, init);
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  try {
    await call("init_project", { name: "Trace Smoke", conductorPath: ".", initialPhase: "P1" });

    // --- Fixture -----------------------------------------------------------------
    //   REQ-001 ── US-001 ── Login::Valid login       pass
    //          │          └─ Login::Wrong password    fail
    //          └─ US-002 ── (no scenario)
    //   REQ-002 ── (no story)
    //   REQ-003 ── US-003 ── Report::Export           never run
    //   (unknown US-999) ── Orphan::Ghost             dangling tag
    //   Misc::Untagged                                 not part of the chain
    await call("create_requirement", { id: "REQ-001", title: "Users can sign in", phase: "P1" });
    await call("create_requirement", { id: "REQ-002", title: "Users can reset their password", phase: "P1" });
    await call("create_requirement", { id: "REQ-003", title: "Managers can export reports", phase: "P1" });
    await call("create_user_story", { id: "US-001", title: "Sign in with email", requirements: ["REQ-001"] });
    await call("create_user_story", { id: "US-002", title: "Sign in with SSO", requirements: ["REQ-001"] });
    await call("create_user_story", { id: "US-003", title: "Export CSV", requirements: ["REQ-003"] });

    await call("create_scenario", { feature: "Login", name: "Valid login", content: gherkin("Valid login"), tags: ["@US-001"] });
    await call("create_scenario", { feature: "Login", name: "Wrong password", content: gherkin("Wrong password"), tags: ["@US-001"] });
    await call("create_scenario", { feature: "Report", name: "Export", content: gherkin("Export"), tags: ["@US-003"] });
    await call("create_scenario", { feature: "Orphan", name: "Ghost", content: gherkin("Ghost"), tags: ["@US-999"] });
    await call("create_scenario", { feature: "Misc", name: "Untagged", content: gherkin("Untagged"), tags: ["@smoke"] });

    const recPass = await call("record_execution", { feature: "Login", name: "Valid login", status: "pass" });
    check("execution recorded into P1", recPass.data?.phase === "P1", recPass.data);
    await call("record_execution", { feature: "Login", name: "Wrong password", status: "fail" });

    // --- The chain -----------------------------------------------------------------
    const t = await api("/api/traceability");
    check("GET /api/traceability responds 200", t.status === 200, t.body);
    const b = t.body;
    check("defaults to the active phase, strict", b.phase === "P1" && b.mode === "strict", { phase: b.phase, mode: b.mode });
    check("summary counts every requirement and story", b.summary.requirementsTotal === 3 && b.summary.storiesTotal === 3, b.summary);

    const req = (id: string) => b.requirements.find((r: any) => r.id === id);
    const story = (id: string) => b.stories.find((s: any) => s.id === id);
    const scenario = (id: string) => b.scenarios.find((s: any) => s.id === id);

    // requirement → story
    check("REQ-002 has no story", req("REQ-002")?.hasStory === false, req("REQ-002"));
    check("REQ-001 links both of its stories", ["US-001", "US-002"].every((id) => req("REQ-001")?.storyIds.includes(id)), req("REQ-001"));
    check("REQ-001 carries its phase", req("REQ-001")?.phase === "P1", req("REQ-001"));
    check("summary: one requirement without story", b.summary.requirementsWithoutStory === 1, b.summary);
    check("nothing is verified yet", b.summary.requirementsVerified === 0 && req("REQ-001")?.verified === false, b.summary);

    // story → scenario
    check("US-002 is untested", story("US-002")?.tested === false && story("US-002")?.scenarioIds.length === 0, story("US-002"));
    check("US-001 has two scenarios but is not covered", story("US-001")?.scenarioIds.length === 2 && story("US-001")?.covered === false, story("US-001"));
    check("US-001 points back at REQ-001", story("US-001")?.requirementIds.includes("REQ-001"), story("US-001"));
    check("summary: one story without scenario", b.summary.storiesWithoutScenario === 1, b.summary);
    check("summary: two stories tested but not covered (US-001 fails, US-003 never ran)", b.summary.storiesNotCovered === 2, b.summary);

    // scenario → latest result
    const valid = scenario("Login::Valid login");
    check("Valid login passed", valid?.status === "pass", valid);
    check("…with its last run in P1", valid?.lastRun?.phase === "P1" && typeof valid?.lastRun?.ranAt === "string" && valid?.lastRun?.source === "manual", valid?.lastRun);
    check("Wrong password failed", scenario("Login::Wrong password")?.status === "fail", scenario("Login::Wrong password"));
    check("Export was never run (not 'pending')", scenario("Report::Export")?.status === "never_run" && scenario("Report::Export")?.lastRun === null, scenario("Report::Export"));
    check("scenarios link back to their stories", scenario("Report::Export")?.storyIds.join() === "US-003", scenario("Report::Export"));
    check("summary: two never run (Export + the dangling Ghost), one failing, one passing", b.summary.scenariosNeverRun === 2 && b.summary.scenariosFailing === 1 && b.summary.scenariosPassing === 1, b.summary);

    // dangling tags and the untagged scenario
    check("the dangling @US-999 tag is reported", JSON.stringify(b.dangling) === JSON.stringify([{ scenarioId: "Orphan::Ghost", storyId: "US-999" }]), b.dangling);
    check("summary: one dangling tag", b.summary.danglingTags === 1, b.summary);
    check("the dangling scenario is in the chain, pointing at the unknown story", scenario("Orphan::Ghost")?.storyIds.join() === "US-999", scenario("Orphan::Ghost"));
    check("an untagged scenario is not part of the chain", scenario("Misc::Untagged") === undefined, b.scenarios.map((s: any) => s.id));
    check("summary: four scenarios in the chain", b.summary.scenariosTotal === 4, b.summary);

    // --- Query parameters ----------------------------------------------------------
    const all = await api("/api/traceability?phase=");
    check("?phase= (empty) means all phases", all.body?.phase === null && all.body?.summary.requirementsTotal === 3, all.body?.summary);
    const cumulative = await api("/api/traceability?mode=cumulative");
    check("?mode=cumulative is accepted", cumulative.status === 200 && cumulative.body?.mode === "cumulative", cumulative.body);
    const bogusMode = await api("/api/traceability?mode=bogus");
    check("?mode=bogus → 400", bogusMode.status === 400, bogusMode);
    const badVersion = await api("/api/traceability?version=9.9.9");
    check("?version=9.9.9 → 404", badVersion.status === 404, badVersion);

    const unknownPhase = await api("/api/traceability?phase=NOPE");
    const unknownCoverage = await api("/api/coverage?phase=NOPE");
    check(
      "an unknown phase behaves like /api/coverage",
      unknownPhase.status === 200 &&
        unknownPhase.body.requirements.length === unknownCoverage.body.requirements.length &&
        unknownPhase.body.scenarios.every((s: any) => s.status === "never_run"),
      { trace: unknownPhase.body?.summary, coverage: unknownCoverage.body?.summary },
    );

    // --- Parity with the coverage endpoints ----------------------------------------
    const cov = await api("/api/coverage?mode=strict");
    const gaps = await api("/api/coverage/gaps?mode=strict");
    check("verified count matches /api/coverage", b.summary.requirementsVerified === cov.body.summary.requirementsVerified, { trace: b.summary, coverage: cov.body.summary });
    check("requirements without story match /api/coverage/gaps", b.summary.requirementsWithoutStory === gaps.body.requirementsWithoutStory.length, gaps.body);
    check("stories without scenario match /api/coverage/gaps", b.summary.storiesWithoutScenario === gaps.body.storiesWithoutScenario.length, gaps.body);
    check("scenarios linked match /api/coverage (dangling ones excluded there)", cov.body.summary.scenariosLinked === b.summary.scenariosTotal - b.summary.danglingTags, { trace: b.summary, coverage: cov.body.summary });

    // --- A later run flips the result ------------------------------------------------
    await call("record_execution", { feature: "Login", name: "Wrong password", status: "pass" });
    await call("record_execution", { feature: "Report", name: "Export", status: "pass" });
    const after = (await api("/api/traceability")).body;
    check("the latest run wins", after.scenarios.find((s: any) => s.id === "Login::Wrong password")?.status === "pass", after.summary);
    check("US-001 becomes covered", after.stories.find((s: any) => s.id === "US-001")?.covered === true, after.stories);
    check("REQ-003 becomes verified once Export passes", after.requirements.find((r: any) => r.id === "REQ-003")?.verified === true, after.requirements);
    check("REQ-001 stays unverified while US-002 has no scenario", after.requirements.find((r: any) => r.id === "REQ-001")?.verified === false, after.requirements);
  } finally {
    await h.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
