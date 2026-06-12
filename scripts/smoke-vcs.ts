/**
 * Smoke test for the VCS-reference tools. Spawns the built MCP server over
 * stdio against a TEMP REQU_ROOT and drives: set_repo/get_repo, link_branch,
 * link_merge_request (opened), list_vcs_refs, update_merge_request (merged),
 * and asserts the state transitions + merged-MR surfacing in coverage_report.
 *
 * requ-mcp never calls a VCS provider — these tools only record references.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { SqliteStore } from "../src/sqlite-store.js";
import type { VcsRef } from "../src/schema.js";

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

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "requ-vcs-"));
  await fs.mkdir(path.join(tmp, "features"), { recursive: true });

  // One feature with a scenario tagged to US-001, so coverage can mark it merged.
  await fs.writeFile(
    path.join(tmp, "features", "login.feature"),
    [
      "Feature: Login",
      "",
      "  @US-001",
      "  Scenario: Successful login",
      "    Given a registered user",
    ].join("\n"),
  );

  const client = new Client({ name: "smoke-vcs", version: "0.0.0" });
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
    try { parsed = JSON.parse(txt); } catch { /* markdown */ }
    return { isError: !!res.isError, data: parsed, raw: txt };
  };

  try {
    await call("init_project", { name: "VCS Smoke", conductorPath: ".", initialPhase: "v1.0" });
    await call("create_requirement", { title: "User can log in", id: "REQ-001" });
    await call("create_user_story", { title: "Log in", requirements: ["REQ-001"], id: "US-001" });

    // --- set_repo / get_repo ---
    const setRepo = await call("set_repo", { repoUrl: "https://gitlab.com/acme/app", vcsType: "gitlab" });
    check("set_repo records repoUrl", setRepo.data.repoUrl === "https://gitlab.com/acme/app", setRepo.data);
    check("set_repo defaults branch to main", setRepo.data.defaultBranch === "main", setRepo.data);

    const setRepo2 = await call("set_repo", { repoUrl: "https://gitlab.com/acme/app", defaultBranch: "develop", vcsType: "gitlab" });
    check("set_repo honors explicit defaultBranch", setRepo2.data.defaultBranch === "develop", setRepo2.data);

    const getRepo = await call("get_repo");
    check("get_repo returns repoUrl + branch + vcsType", getRepo.data.repoUrl === "https://gitlab.com/acme/app" && getRepo.data.defaultBranch === "develop" && getRepo.data.vcsType === "gitlab", getRepo.data);

    // --- link_branch ---
    const br = await call("link_branch", { branch: "feature/login", storyIds: ["US-001"], requirementIds: ["REQ-001"], component: "auth", url: "https://gitlab.com/acme/app/-/tree/feature/login" });
    check("link_branch creates BR-001 (kind=branch, opened)", br.data.id === "BR-001" && br.data.kind === "branch" && br.data.state === "opened", br.data);
    check("link_branch stores story/req links", br.data.storyIds?.includes("US-001") && br.data.requirementIds?.includes("REQ-001"), br.data);

    // link_branch fails on unknown story id
    const badBr = await call("link_branch", { branch: "feature/x", storyIds: ["US-999"] });
    check("link_branch fails on unknown story id", badBr.isError === true, badBr.data);

    // link_branch is idempotent by branch name: retry yields ONE ref (same id)
    const brDup = await call("link_branch", { branch: "feature/login", storyIds: ["US-001"], requirementIds: ["REQ-001"], component: "auth" });
    check("link_branch upserts same branch (same BR-001 id)", brDup.data.id === br.data.id && brDup.data.id === "BR-001", brDup.data);
    const branchRefs = await call("list_vcs_refs", { kind: "branch" });
    check("link_branch retry does NOT double-record (exactly 1 branch ref)", branchRefs.data.length === 1 && branchRefs.data[0].id === "BR-001", branchRefs.data);

    // --- link_merge_request (opened) ---
    const mr = await call("link_merge_request", { ref: "5", url: "https://gitlab.com/acme/app/-/merge_requests/5", branch: "feature/login", targetBranch: "main", storyIds: ["US-001"], component: "auth" });
    check("link_merge_request creates MR-5 (kind=mr, opened)", mr.data.id === "MR-5" && mr.data.kind === "mr" && mr.data.state === "opened", mr.data);
    check("link_merge_request stores targetBranch", mr.data.targetBranch === "main", mr.data);

    // upsert by ref keeps id, updates fields
    const mrUpsert = await call("link_merge_request", { ref: "5", url: "https://gitlab.com/acme/app/-/merge_requests/5", branch: "feature/login", state: "opened", storyIds: ["US-001"] });
    check("link_merge_request upserts the same MR-5 id", mrUpsert.data.id === "MR-5", mrUpsert.data);

    // --- list_vcs_refs ---
    const all = await call("list_vcs_refs");
    check("list_vcs_refs returns 2 refs", Array.isArray(all.data) && all.data.length === 2, all.data);
    const onlyMr = await call("list_vcs_refs", { kind: "mr" });
    check("list_vcs_refs kind=mr returns 1", onlyMr.data.length === 1 && onlyMr.data[0].id === "MR-5", onlyMr.data);
    const byStory = await call("list_vcs_refs", { storyId: "US-001" });
    check("list_vcs_refs storyId=US-001 returns both", byStory.data.length === 2, byStory.data);
    const byComp = await call("list_vcs_refs", { component: "auth", kind: "branch" });
    check("list_vcs_refs component+kind filter works", byComp.data.length === 1 && byComp.data[0].id === "BR-001", byComp.data);

    // coverage: MR still opened -> mergedMr present but not merged
    const repBefore = await call("coverage_report", { mode: "cumulative" });
    const storyBefore = repBefore.data.stories.find((s: any) => s.id === "US-001");
    check("coverage: mergedMr present (opened) before merge", storyBefore?.mergedMr?.ref === "5" && storyBefore?.mergedMr?.state === "opened", storyBefore?.mergedMr);

    // --- update_merge_request (merged) ---
    const upd = await call("update_merge_request", { ref: "5", state: "merged", mergeCommit: "abc123" });
    check("update_merge_request transitions opened -> merged", upd.data.state === "merged", upd.data);
    check("update_merge_request records mergeCommit", upd.data.mergeCommit === "abc123", upd.data);

    // fail when ref unknown
    const badUpd = await call("update_merge_request", { ref: "999", state: "closed" });
    check("update_merge_request fails on unknown ref", badUpd.isError === true, badUpd.data);

    // security: non-numeric ref (path-traversal attempt) is REJECTED by zod validation
    const traversalMr = await call("link_merge_request", { ref: "../x", url: "u", branch: "feature/login" });
    check("link_merge_request rejects non-numeric ref ('../x')", traversalMr.isError === true, traversalMr.data);
    const traversalUpd = await call("update_merge_request", { ref: "../x", state: "merged" });
    check("update_merge_request rejects non-numeric ref ('../x')", traversalUpd.isError === true, traversalUpd.data);

    // list reflects merged state
    const mergedList = await call("list_vcs_refs", { state: "merged" });
    check("list_vcs_refs state=merged returns MR-5", mergedList.data.length === 1 && mergedList.data[0].id === "MR-5", mergedList.data);

    // coverage now reports merged (covered boolean unchanged: scenario still pending)
    const repAfter = await call("coverage_report", { mode: "cumulative" });
    const storyAfter = repAfter.data.stories.find((s: any) => s.id === "US-001");
    check("coverage: mergedMr.state=merged after merge", storyAfter?.mergedMr?.state === "merged", storyAfter?.mergedMr);
    check("coverage: covered unchanged (scenario not run -> false)", storyAfter?.covered === false, storyAfter);

    const md = await call("coverage_report", { mode: "cumulative", format: "markdown" });
    check("markdown surfaces 'verified + merged'", md.raw.includes("verified + merged"), md.raw);
  } finally {
    await client.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }

  // --- SqliteStore (HTTP-mode backend) direct exercise ---
  console.log("\n  [SqliteStore backend]");
  const sqTmp = await fs.mkdtemp(path.join(os.tmpdir(), "requ-vcs-sql-"));
  try {
    const store = new SqliteStore(sqTmp);
    const ts = new Date().toISOString();
    const branch: VcsRef = {
      id: "BR-001", kind: "branch", ref: "feature/x", url: "", branch: "feature/x",
      storyIds: ["US-001"], requirementIds: ["REQ-001"], state: "opened", createdAt: ts, updatedAt: ts,
    };
    await store.writeVcsRef(branch);
    const mr: VcsRef = {
      id: "MR-5", kind: "mr", ref: "5", url: "u", branch: "feature/x", targetBranch: "main",
      storyIds: ["US-001"], requirementIds: [], state: "opened", createdAt: ts, updatedAt: ts,
    };
    await store.writeVcsRef(mr);

    const all = await store.listVcsRefs();
    check("sqlite: listVcsRefs returns 2", all.length === 2, all.map((r) => r.id));
    const got = await store.getVcsRef("MR-5");
    check("sqlite: getVcsRef round-trips array fields", got?.storyIds.includes("US-001") === true, got);

    const updated = await store.updateVcsRef("MR-5", { state: "merged", mergeCommit: "deadbeef", updatedAt: new Date().toISOString() });
    check("sqlite: updateVcsRef sets state=merged", updated?.state === "merged" && updated?.mergeCommit === "deadbeef", updated);

    const missing = await store.updateVcsRef("MR-999", { state: "closed" });
    check("sqlite: updateVcsRef returns null for unknown id", missing === null, missing);
  } finally {
    await fs.rm(sqTmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
