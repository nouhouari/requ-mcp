/**
 * End-to-end smoke test for architecture decisions (ADRs): create/link/update,
 * the requirement + component edges, supersession, the markdown body kept out of
 * list/detail responses, import from a repo `docs/adr/` folder, and the
 * export/import round-trip.
 *
 * Drives the built server over HTTP, exactly like scripts/smoke.ts.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness, slugFor } from "./lib/http-harness.js";
import { SqliteStore } from "../src/sqlite-store.js";
import type { Adr } from "../src/schema.js";


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

/** A decision record in the architect agent's format, with two mermaid diagrams. */
const cqrsMd = `# Use a modular monolith

## Status

Accepted

## Context

The team is five people. Independent deployability is not yet worth the
operational cost of separate services.

## Decision

Ship a modular monolith with enforced module seams.

\`\`\`mermaid
C4Context
  title System context
  Person(user, "Operator")
  System(app, "Booking app")
  Rel(user, app, "books slots")
\`\`\`

The booking flow crosses two modules:

\`\`\`mermaid
sequenceDiagram
  Operator->>API: POST /bookings
  API->>Store: reserve slot
  Store-->>API: ok
\`\`\`

## Consequences

Positive: one deploy, in-process calls, no distributed transactions.
Negative: a single scaling unit; seams must be policed in review.

## Alternatives considered

Microservices — rejected: the team cannot yet operate them.
`;

/** A superseding decision, in the inline "Status: …" style. */
const eventsMd = `# 2. Adopt an outbox for cross-module events

Status: Proposed

## Context

Direct calls between modules are becoming a coupling problem.
`;

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "requ-smoke-adrs-"));
  await fs.mkdir(path.join(tmp, "features"), { recursive: true });
  await fs.mkdir(path.join(tmp, "docs", "adr"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, "features", "booking.feature"),
    ["Feature: Booking", "", "  @US-001", "  Scenario: Book a slot", "    Given the app is open"].join("\n"),
  );
  // Two ADR files as the architect agent would leave them on disk.
  await fs.writeFile(path.join(tmp, "docs", "adr", "0001-modular-monolith.md"), cqrsMd);
  await fs.writeFile(path.join(tmp, "docs", "adr", "0002-outbox.md"), eventsMd);

  // The import target is a second project; projects are declared to the server
  // at startup, so its folder has to exist before the harness boots.
  const other = path.join(tmp, "copy");
  await fs.mkdir(path.join(other, "features"), { recursive: true });
  await fs.writeFile(
    path.join(other, "features", "booking.feature"),
    ["Feature: Booking", "", "  Scenario: Book a slot", "    Given the app is open"].join("\n"),
  );
  const otherKey = slugFor(other);

  const h = await startHarness([tmp, other], "smoke-adrs");
  const call = h.call;

  try {
    await call("init_project", { name: "AdrSmoke", conductorPath: ".", initialPhase: "v1.0" });
    await call("create_component", { id: "booking", name: "Booking" });
    await call("create_requirement", { title: "Guests can book a slot", id: "REQ-001", components: ["booking"] });
    await call("create_user_story", { title: "Book a slot", requirements: ["REQ-001"], id: "US-001" });

    // --- create -------------------------------------------------------------
    const created = await call("create_adr", {
      title: "Use a modular monolith",
      content: cqrsMd,
      status: "accepted",
      requirements: ["REQ-001"],
      components: ["booking"],
    });
    check("create_adr auto-ids ADR-001", created.data.id === "ADR-001", created.data);
    check("create_adr records status + links", created.data.status === "accepted" && created.data.requirements.includes("REQ-001") && created.data.components.includes("booking"), created.data);
    const phases = await call("list_phases");
    const activePhaseId = phases.data.activePhase;
    check("create_adr assigns the active phase", created.data.phase === activePhaseId, { got: created.data.phase, want: activePhaseId });
    check("create_adr hashes the content", typeof created.data.version === "string" && created.data.version.length > 0, created.data);
    check("create_adr omits the body, flags hasContent", created.data.content === undefined && created.data.hasContent === true, created.data);

    // unknown links are rejected
    const badReq = await call("create_adr", { title: "Bad", requirements: ["REQ-999"] });
    check("create_adr rejects an unknown requirement", badReq.isError === true, badReq.data);
    const badComp = await call("create_adr", { title: "Bad", components: ["nope"] });
    check("create_adr rejects an unknown component", badComp.isError === true, badComp.data);

    // --- content fetch ------------------------------------------------------
    const body = await call("get_adr_content", { id: "ADR-001" });
    check("get_adr_content returns the markdown", body.data.content === cqrsMd, { len: body.data.content?.length });
    check("get_adr_content reports source=stored", body.data.source === "stored", body.data);
    check("content keeps the mermaid fences", (body.data.content.match(/```mermaid/g) || []).length === 2, body.data.content?.slice(0, 60));

    // --- list / get ---------------------------------------------------------
    const list = await call("list_adrs");
    check("list_adrs returns 1", list.data.total === 1, list.data);
    check("list_adrs omits the body by default", list.data.adrs[0].content === undefined && list.data.adrs[0].hasContent === true, list.data.adrs[0]);
    const listFull = await call("list_adrs", { includeContent: true });
    check("list_adrs includeContent returns the body", listFull.data.adrs[0].content === cqrsMd, { len: listFull.data.adrs[0].content?.length });
    const byReq = await call("list_adrs", { requirement: "REQ-001" });
    check("list_adrs filters by requirement", byReq.data.total === 1, byReq.data);
    const byComp = await call("list_adrs", { component: "booking", status: "accepted" });
    check("list_adrs filters by component + status", byComp.data.total === 1, byComp.data);
    const byMiss = await call("list_adrs", { status: "proposed" });
    check("list_adrs status filter excludes non-matches", byMiss.data.total === 0, byMiss.data);

    const got = await call("get_adr", { id: "ADR-001" });
    check("get_adr resolves requirement titles", got.data.requirements[0].title === "Guests can book a slot" && got.data.requirements[0].exists === true, got.data.requirements);
    const missing = await call("get_adr", { id: "ADR-404" });
    check("get_adr fails on unknown id", missing.isError === true, missing.data);

    // --- search -------------------------------------------------------------
    const found = await call("search_adrs", { query: "modular monolith" });
    check("search_adrs matches the title", found.data.total === 1 && found.data.adrs[0].id === "ADR-001", found.data);
    const foundBody = await call("search_adrs", { query: "distributed transactions" });
    check("search_adrs matches the body", foundBody.data.total === 1, foundBody.data);
    const notFound = await call("search_adrs", { query: "kubernetes" });
    check("search_adrs returns nothing for a miss", notFound.data.total === 0, notFound.data);

    // --- update + supersession ---------------------------------------------
    const replacement = await call("create_adr", { title: "Extract the booking service", status: "proposed" });
    check("second ADR gets ADR-002", replacement.data.id === "ADR-002", replacement.data);

    const before = created.data.version;
    const superseded = await call("update_adr", { id: "ADR-001", status: "superseded", supersededBy: "ADR-002" });
    check("update_adr sets status=superseded", superseded.data.status === "superseded", superseded.data);
    check("update_adr records supersededBy", superseded.data.supersededBy === "ADR-002", superseded.data);
    check("update_adr leaves the version alone when the body is untouched", superseded.data.version === before, { before, after: superseded.data.version });

    const rewritten = await call("update_adr", { id: "ADR-002", content: "# Extract the booking service\n\nStatus: Proposed\n" });
    check("update_adr refreshes the version when the body changes", rewritten.data.version !== replacement.data.version, { before: replacement.data.version, after: rewritten.data.version });

    const reverse = await call("get_adr", { id: "ADR-002" });
    check("get_adr reports the reverse supersedes edge", reverse.data.supersedes.includes("ADR-001"), reverse.data);

    const badSuper = await call("update_adr", { id: "ADR-002", supersededBy: "ADR-999" });
    check("update_adr rejects an unknown supersededBy", badSuper.isError === true, badSuper.data);
    const badUpdate = await call("update_adr", { id: "ADR-404", title: "x" });
    check("update_adr fails on unknown id", badUpdate.isError === true, badUpdate.data);

    // --- import from docs/adr ----------------------------------------------
    const dry = await call("import_adrs_from_files", { dryRun: true });
    check("import dryRun scans both files", dry.data.scanned === 2 && dry.data.dryRun === true, dry.data);
    const listAfterDry = await call("list_adrs");
    check("import dryRun writes nothing", listAfterDry.data.total === 2, listAfterDry.data.total);

    // ADR-001/002 are taken, so both files are skipped by id collision.
    const collide = await call("import_adrs_from_files");
    check("import skips ids that already exist", collide.data.imported === 0 && collide.data.skipped.length === 2, collide.data);

    // A folder whose numbering does not collide imports cleanly.
    await fs.mkdir(path.join(tmp, "docs", "adr2"), { recursive: true });
    await fs.writeFile(path.join(tmp, "docs", "adr2", "0007-modular-monolith.md"), cqrsMd);
    await fs.writeFile(path.join(tmp, "docs", "adr2", "0008-outbox.md"), eventsMd);
    const imported = await call("import_adrs_from_files", { dir: "docs/adr2" });
    check("import maps 0007-… to ADR-007", imported.data.ids.includes("ADR-007"), imported.data);
    check("import brings in both files", imported.data.imported === 2, imported.data);

    const imp1 = await call("get_adr", { id: "ADR-007" });
    check("import parses the '# ' title", imp1.data.title === "Use a modular monolith", imp1.data);
    check("import parses a '## Status' section", imp1.data.status === "accepted", imp1.data);
    check("import records sourcePath", imp1.data.sourcePath === "docs/adr2/0007-modular-monolith.md", imp1.data);

    const imp2 = await call("get_adr", { id: "ADR-008" });
    check("import parses an inline 'Status:' line", imp2.data.status === "proposed", imp2.data);
    check("import strips the leading number from the title", imp2.data.title === "Adopt an outbox for cross-module events", imp2.data);

    // sourcePath makes the live file win over the snapshot
    const fromFile = await call("get_adr_content", { id: "ADR-007" });
    check("get_adr_content prefers the live file when sourcePath is set", fromFile.data.source === "file", fromFile.data);

    const reimport = await call("import_adrs_from_files", { dir: "docs/adr2" });
    check("re-import is idempotent (already imported)", reimport.data.imported === 0 && reimport.data.skipped.length === 2, reimport.data);

    const badDir = await call("import_adrs_from_files", { dir: "docs/nope" });
    check("import fails clearly on a missing folder", badDir.isError === true, badDir.data);

    // --- body vs metadata separation ----------------------------------------
    // (This replaced an on-disk YAML+.md sidecar check when the YAML store was
    //  removed; what matters is that the body round-trips while list/detail
    //  responses keep omitting it.)
    const stored = await call("get_adr_content", { id: "ADR-001" });
    check("decision body round-trips through the store", stored.data.content === cqrsMd, { len: stored.data.content?.length });
    const listed = await call("list_adrs");
    check("list responses carry no decision bodies", listed.data.adrs.every((a: any) => a.content === undefined && typeof a.hasContent === "boolean"), listed.data.adrs[0]);

    // --- export / import round-trip ----------------------------------------
    // export_project returns the payload as a JSON *string*, so parse twice.
    const exported = await call("export_project");
    const payload = JSON.parse(exported.data);
    check("export includes adrs", Array.isArray(payload.data?.adrs) && payload.data.adrs.length === 4, payload.data?.adrs?.length);
    check("exported adr carries its content", payload.data.adrs.find((a: any) => a.id === "ADR-001")?.content === cqrsMd, "ADR-001");

    // Import into a second, empty project and confirm the decisions land.
    const initCopy = await h.callOn(otherKey, "init_project", { name: "AdrSmokeCopy", conductorPath: "." });
    check("second project initialises", initCopy.isError === false, initCopy.data);
    const importedProject = await h.callOn(otherKey, "import_project", { data: exported.data });
    check("import_project reports imported adrs", importedProject.data.imported?.adrs === 4, importedProject.data);
    const copied = await h.callOn(otherKey, "list_adrs");
    check("imported project has the 4 decisions", copied.data.total === 4, copied.data.total);
    const copiedBody = await h.callOn(otherKey, "get_adr_content", { id: "ADR-001" });
    check("imported adr keeps its markdown body", copiedBody.data.content === cqrsMd, { len: copiedBody.data.content?.length });
    const reimported = await h.callOn(otherKey, "import_project", { data: exported.data });
    check("re-import skips existing adrs", (reimported.data.skipped?.adrs || []).length === 4, reimported.data.skipped);

    // --- delete -------------------------------------------------------------
    const deleted = await call("delete_adr", { id: "ADR-008" });
    check("delete_adr removes the decision", deleted.data.deleted === true, deleted.data);
    const gone = await call("get_adr", { id: "ADR-008" });
    check("deleted adr is gone", gone.isError === true, gone.data);
    const goneBody = await call("get_adr_content", { id: "ADR-008" });
    check("delete_adr removes the body too", goneBody.isError === true, goneBody.data);
    const deletedAgain = await call("delete_adr", { id: "ADR-008" });
    check("delete_adr is idempotent", deletedAgain.data.deleted === false, deletedAgain.data);
  } finally {
    await h.stop();
  }

  // --- SqliteStore round-trip (HTTP-mode backend) ---------------------------
  console.log("\n  [SqliteStore backend]");
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "requ-smoke-adrs-db-"));
  try {
    const store = new SqliteStore(dbDir, path.join(dbDir, "requ.db"));
    await store.init({ name: "sqlite adrs", conductorPath: "." } as any);
    const ts = new Date().toISOString();
    const adr: Adr = {
      id: "ADR-001",
      title: "Use a modular monolith",
      status: "accepted",
      content: cqrsMd,
      requirements: ["REQ-001"],
      components: ["booking"],
      version: "abc123",
      createdAt: ts,
      updatedAt: ts,
    };
    await store.writeAdr(adr);
    const back = await store.getAdr("ADR-001");
    check("sqlite: getAdr round-trips the body", back?.content === cqrsMd, { len: back?.content?.length });
    check("sqlite: getAdr round-trips array fields", back?.requirements[0] === "REQ-001" && back?.components[0] === "booking", back);
    await store.writeAdr({ ...adr, status: "superseded", supersededBy: "ADR-002" });
    const updated = await store.getAdr("ADR-001");
    check("sqlite: writeAdr upserts in place", updated?.status === "superseded" && updated?.supersededBy === "ADR-002", updated);
    check("sqlite: listAdrs returns 1", (await store.listAdrs()).length === 1);
    check("sqlite: deleteAdr removes the row", (await store.deleteAdr("ADR-001")) === true);
    check("sqlite: deleteAdr returns false for an unknown id", (await store.deleteAdr("ADR-404")) === false);
  } finally {
    await fs.rm(dbDir, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
