/**
 * Smoke tests for search_requirements, search_user_stories, and search_tests.
 * Spawns the built MCP server over stdio, creates a minimal project, then
 * verifies substring matching, case-insensitivity, filter combinations, empty
 * results, and the shape of each tool's response.
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

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "requ-smoke-search-"));
  await fs.mkdir(path.join(tmp, "features"), { recursive: true });

  await fs.writeFile(
    path.join(tmp, "features", "auth.feature"),
    [
      "Feature: Authentication",
      "",
      "  @US-001",
      "  Scenario: Login with valid credentials",
      "    Given a registered user",
      "",
      "  @US-001",
      "  Scenario: Login fails with wrong password",
      "    Given an incorrect password",
    ].join("\n"),
  );

  await fs.writeFile(
    path.join(tmp, "features", "payment.feature"),
    [
      "Feature: Payment",
      "",
      "  @US-002",
      "  Scenario: Pay with credit card",
      "    Given a cart with items",
      "",
      "  @US-003",
      "  Scenario: Refund request is processed",
      "    Given a completed order",
    ].join("\n"),
  );

  const client = new Client({ name: "smoke-search", version: "0.0.0" });
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
    try { parsed = JSON.parse(txt); } catch { /* not JSON */ }
    return { isError: !!res.isError, data: parsed };
  };

  try {
    await call("init_project", { name: "Search Smoke", conductorPath: ".", initialPhase: "v1" });

    await call("create_requirement", {
      title: "User authentication",
      description: "Support OAuth and password login flows",
      tags: ["security", "auth"],
    }); // REQ-001
    await call("create_requirement", {
      title: "Payment processing",
      description: "Handle credit card and PayPal transactions",
      source: "billing-spec-v2",
    }); // REQ-002
    await call("create_requirement", {
      title: "Refund management",
      description: "Allow users to request refunds",
    }); // REQ-003

    await call("create_user_story", {
      title: "Login with credentials",
      requirements: ["REQ-001"],
      description: "As a user I want to log in securely",
      acceptanceCriteria: ["Valid credentials grant access", "Invalid credentials show an error message"],
    }); // US-001
    await call("create_user_story", {
      title: "Pay by credit card",
      requirements: ["REQ-002"],
      description: "As a shopper I want to complete payment",
      acceptanceCriteria: ["Card number is validated before submission"],
    }); // US-002
    await call("create_user_story", {
      title: "Request a refund",
      requirements: ["REQ-003"],
      description: "As a customer I want to get money back",
      acceptanceCriteria: ["Refund eligibility window is 30 days"],
    }); // US-003

    // -------------------------------------------------------------------------
    console.log("\nsearch_requirements");
    // -------------------------------------------------------------------------

    const r1 = await call("search_requirements", { query: "auth" });
    check("'auth' matches REQ-001 via title and tag", r1.data.total === 1 && r1.data.requirements[0]?.id === "REQ-001", r1.data);

    const r2 = await call("search_requirements", { query: "security" });
    check("'security' matches REQ-001 via tag", r2.data.total === 1 && r2.data.requirements[0]?.id === "REQ-001", r2.data);

    const r3 = await call("search_requirements", { query: "credit" });
    check("'credit' matches REQ-002 via description", r3.data.total === 1 && r3.data.requirements[0]?.id === "REQ-002", r3.data);

    const r4 = await call("search_requirements", { query: "billing-spec" });
    check("'billing-spec' matches REQ-002 via source", r4.data.total === 1 && r4.data.requirements[0]?.id === "REQ-002", r4.data);

    const r5 = await call("search_requirements", { query: "refund" });
    check("'refund' matches REQ-003 via title and description", r5.data.total === 1 && r5.data.requirements[0]?.id === "REQ-003", r5.data);

    const r6 = await call("search_requirements", { query: "PAYMENT" });
    check("case-insensitive 'PAYMENT' matches REQ-002", r6.data.total === 1 && r6.data.requirements[0]?.id === "REQ-002", r6.data);

    const r7 = await call("search_requirements", { query: "user" });
    check("'user' matches REQ-001 (title) and REQ-003 (description)", r7.data.total === 2, r7.data);

    const r8 = await call("search_requirements", { query: "xyzzy-no-match" });
    check("no match returns total=0 and empty array", r8.data.total === 0 && r8.data.requirements.length === 0, r8.data);

    // -------------------------------------------------------------------------
    console.log("\nsearch_user_stories");
    // -------------------------------------------------------------------------

    const s1 = await call("search_user_stories", { query: "credentials" });
    check("'credentials' matches US-001 via title and acceptance criteria", s1.data.total === 1 && s1.data.stories[0]?.id === "US-001", s1.data);

    const s2 = await call("search_user_stories", { query: "error message" });
    check("'error message' matches US-001 via acceptance criterion", s2.data.total === 1 && s2.data.stories[0]?.id === "US-001", s2.data);

    const s3 = await call("search_user_stories", { query: "30 days" });
    check("'30 days' matches US-003 via acceptance criterion", s3.data.total === 1 && s3.data.stories[0]?.id === "US-003", s3.data);

    const s4 = await call("search_user_stories", { query: "REFUND" });
    check("case-insensitive 'REFUND' matches US-003", s4.data.total === 1 && s4.data.stories[0]?.id === "US-003", s4.data);

    const s5 = await call("search_user_stories", { query: "shopper" });
    check("'shopper' matches US-002 via description", s5.data.total === 1 && s5.data.stories[0]?.id === "US-002", s5.data);

    const s6 = await call("search_user_stories", { query: "xyzzy-no-match" });
    check("no match returns total=0 and empty array", s6.data.total === 0 && s6.data.stories.length === 0, s6.data);

    const s7 = await call("search_user_stories", { query: "card", status: "draft" });
    check("'card' + status=draft narrows to US-002", s7.data.total === 1 && s7.data.stories[0]?.id === "US-002", s7.data);

    const s8 = await call("search_user_stories", { query: "card", requirement: "REQ-003" });
    check("'card' + requirement=REQ-003 yields no match (card belongs to US-002)", s8.data.total === 0, s8.data);

    // -------------------------------------------------------------------------
    console.log("\nsearch_tests");
    // -------------------------------------------------------------------------

    const t1 = await call("search_tests", { query: "login" });
    check("'login' matches 2 scenarios in auth.feature", t1.data.total === 2, t1.data);

    const t2 = await call("search_tests", { query: "payment" });
    check("'payment' matches both payment scenarios via feature name", t2.data.total === 2, t2.data);

    const t3 = await call("search_tests", { query: "credit card" });
    check("'credit card' matches 1 scenario by name", t3.data.total === 1 && t3.data.scenarios[0]?.name === "Pay with credit card", t3.data);

    const t4 = await call("search_tests", { query: "refund" });
    check("'refund' matches 1 scenario by name", t4.data.total === 1, t4.data);

    const t5 = await call("search_tests", { query: "xyzzy-no-match" });
    check("no match returns total=0 and empty array", t5.data.total === 0 && t5.data.scenarios.length === 0, t5.data);

    const t6 = await call("search_tests", { query: "login", storyId: "US-001" });
    check("storyId filter + 'login' → 2 scenarios tagged @US-001", t6.data.total === 2 && t6.data.scenarios.every((sc: any) => sc.stories.includes("US-001")), t6.data);

    const t7 = await call("search_tests", { query: "payment", storyId: "US-002" });
    check("storyId filter + 'payment' → 1 scenario (US-002 is in Payment feature)", t7.data.total === 1, t7.data);

    const t8 = await call("search_tests", { query: "CREDIT" });
    check("case-insensitive 'CREDIT' matches credit card scenario", t8.data.total === 1, t8.data);

    // Verify response shape
    const sc0 = t1.data.scenarios[0];
    check(
      "scenario result has feature, name, file, tags, stories fields",
      typeof sc0?.feature === "string" &&
      typeof sc0?.name === "string" &&
      typeof sc0?.file === "string" &&
      Array.isArray(sc0?.tags) &&
      Array.isArray(sc0?.stories),
      sc0,
    );
    check("conductorRoot is present in search_tests response", typeof t1.data.conductorRoot === "string", t1.data);
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
