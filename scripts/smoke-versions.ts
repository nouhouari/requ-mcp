/**
 * End-to-end smoke test for specification versioning.
 *
 * Exercises the whole baseline lifecycle the way a BA and a delivery team would:
 * build 1.0.0, lock it, watch specification edits get rejected while progress
 * updates still land, open 1.1.0, change scope there without disturbing the
 * locked baseline, diff the two, and confirm coverage carries over only for
 * entities that did not change.
 *
 * Drives the built server over HTTP, exactly like scripts/smoke.ts.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness } from "./lib/http-harness.js";
import { checkWritable } from "../src/versioning.js";

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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "requ-smoke-versions-"));
  await fs.mkdir(path.join(tmp, "features"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, "features", "booking.feature"),
    [
      "Feature: Booking",
      "",
      "  @US-001",
      "  Scenario: Book a slot",
      "    Given the app is open",
      "",
      "  @US-002",
      "  Scenario: Cancel a booking",
      "    Given a booking exists",
    ].join("\n"),
  );

  const h = await startHarness([tmp], "smoke-versions");
  const call = h.call;

  try {
    // --- freeze matrix, including pre-versioning rows ------------------------
    // A row written before `removed` existed has no such key, while the value
    // being written carries the schema default. That gap must not read as a
    // change, or migrated projects freeze edits the matrix permits.
    const legacy = { id: "US-001", title: "T", status: "draft" };
    check(
      "a status-only edit is allowed on a locked row that predates `removed`",
      checkWritable("stories", legacy, { ...legacy, status: "done", removed: false }).ok === true,
      checkWritable("stories", legacy, { ...legacy, status: "done", removed: false }),
    );
    check(
      "a real title change is still frozen on such a row",
      checkWritable("stories", legacy, { ...legacy, title: "X", removed: false }).ok === false,
    );
    check(
      "an actual soft delete is still frozen",
      checkWritable("stories", { ...legacy, removed: false }, { ...legacy, removed: true }).ok === false,
    );

    // --- 1.0.0 exists from the start ----------------------------------------
    await call("init_project", { name: "VersionSmoke", conductorPath: ".", initialPhase: "v1.0" });

    let versions = await call("list_versions");
    check("init_project registers 1.0.0", versions.data.versions.length === 1 && versions.data.versions[0].version === "1.0.0", versions.data);
    check("1.0.0 starts as a draft", versions.data.versions[0].status === "draft", versions.data.versions[0]);
    check("both pointers aim at 1.0.0", versions.data.currentVersion === "1.0.0" && versions.data.draftVersion === "1.0.0", versions.data);

    await call("create_component", { id: "booking", name: "Booking" });
    await call("create_requirement", { title: "Guests can book a slot", id: "REQ-001", components: ["booking"] });
    await call("create_requirement", { title: "Guests can cancel", id: "REQ-002", components: ["booking"] });
    await call("create_user_story", { title: "Book a slot", requirements: ["REQ-001"], id: "US-001" });
    await call("create_user_story", { title: "Cancel a booking", requirements: ["REQ-002"], id: "US-002" });
    await call("create_adr", { title: "Store bookings in Postgres", id: "ADR-001", content: "# Store bookings in Postgres\n\n## Status\n\nAccepted\n", requirements: ["REQ-001"] });

    // Both stories pass in 1.0.0, so their results are candidates for carry-over.
    await call("record_execution", { feature: "Booking", name: "Book a slot", status: "pass" });
    await call("record_execution", { feature: "Booking", name: "Cancel a booking", status: "pass" });
    const base = await call("coverage_report", { mode: "cumulative" });
    check("1.0.0 covers both stories", base.data.summary.storiesCovered === 2, base.data.summary);

    // --- locking -------------------------------------------------------------
    const locked = await call("lock_version", { actor: "ba@example.com", reason: "Sprint 1 baseline" });
    check("lock_version locks the draft", locked.data.version === "1.0.0" && locked.data.status === "locked", locked.data);
    check("lock_version makes it current", locked.data.currentVersion === "1.0.0", locked.data);
    check("lock_version clears the draft pointer", locked.data.draftVersion === null, locked.data);

    // --- specification is frozen ---------------------------------------------
    const frozenEdit = await call("update_requirement", { id: "REQ-001", title: "Changed my mind", version: "1.0.0" });
    check("locked version rejects a requirement edit", frozenEdit.isError === true, frozenEdit.data);

    const frozenCreate = await call("create_requirement", { title: "Late arrival", version: "1.0.0" });
    check("locked version rejects a new requirement", frozenCreate.isError === true, frozenCreate.data);

    const frozenTitle = await call("update_user_story", { id: "US-001", title: "Renamed", version: "1.0.0" });
    check("locked version rejects a story title change", frozenTitle.isError === true, frozenTitle.data);

    const frozenDelete = await call("delete_adr", { id: "ADR-001", version: "1.0.0" });
    check("locked version rejects a deletion", frozenDelete.isError === true, frozenDelete.data);

    // …but progress is not.
    const progress = await call("update_user_story", { id: "US-001", status: "in_progress", version: "1.0.0" });
    check("locked version allows a status change", progress.isError === false && progress.data.status === "in_progress", progress.data);

    // An unqualified specification edit points nowhere useful and says so.
    const noDraft = await call("create_requirement", { title: "Nowhere to go" });
    check("spec edit with no open draft is refused", noDraft.isError === true, noDraft.data);
    check("…and the message points at create_version", /create_version/.test(noDraft.raw), noDraft.raw?.slice(0, 200));

    // --- the next version -----------------------------------------------------
    const next = await call("create_version", { bump: "minor", label: "Sprint 2 scope", actor: "ba@example.com" });
    check("create_version opens 1.1.0", next.data.created === "1.1.0" && next.data.status === "draft", next.data);
    check("create_version copies the requirements", next.data.copied.requirements === 2, next.data.copied);
    check("create_version copies the stories", next.data.copied.stories === 2, next.data.copied);
    check("create_version moves the draft pointer", next.data.draftVersion === "1.1.0", next.data);
    check("create_version leaves reads on 1.0.0", next.data.currentVersion === "1.0.0", next.data);

    const secondDraft = await call("create_version", { bump: "minor" });
    check("only one draft may be open", secondDraft.isError === true, secondDraft.data);

    // --- editing the new version leaves the baseline alone --------------------
    const edited = await call("update_requirement", { id: "REQ-001", title: "Guests can book a slot online" });
    check("spec edit lands in the open draft", edited.isError === false, edited.data);

    const inDraft = await call("get_requirement", { id: "REQ-001", version: "1.1.0" });
    check("1.1.0 has the new title", inDraft.data.title === "Guests can book a slot online", inDraft.data);
    const inBaseline = await call("get_requirement", { id: "REQ-001", version: "1.0.0" });
    check("1.0.0 keeps the old title", inBaseline.data.title === "Guests can book a slot", inBaseline.data);

    await call("create_requirement", { title: "Guests can reschedule", id: "REQ-003" });
    const onlyInDraft = await call("list_requirements", { version: "1.0.0" });
    check("a requirement added in 1.1.0 is absent from 1.0.0", !JSON.stringify(onlyInDraft.data).includes("REQ-003"), onlyInDraft.data);

    const removed = await call("delete_adr", { id: "ADR-001" });
    check("deletion in a draft succeeds", removed.isError === false && removed.data.deleted === true, removed.data);
    const afterDelete = await call("list_adrs", { version: "1.1.0" });
    const draftIds = (afterDelete.data.adrs ?? afterDelete.data).map((r: any) => r.id);
    check("a removed ADR is hidden in 1.1.0", !draftIds.includes("ADR-001"), draftIds);
    const stillThere = await call("list_adrs", { version: "1.0.0" });
    const baseIds = (stillThere.data.adrs ?? stillThere.data).map((r: any) => r.id);
    check("…but still present in the locked 1.0.0", baseIds.includes("ADR-001"), baseIds);

    // --- diff -----------------------------------------------------------------
    const diff = await call("diff_versions", { from: "1.0.0", to: "1.1.0" });
    check("diff is not identical", diff.data.identical === false, diff.data.summary);
    check("diff reports the added requirement", diff.data.entities.requirements.added.some((e: any) => e.id === "REQ-003"), diff.data.entities.requirements.added);
    check("diff reports the removed ADR", diff.data.entities.adrs.removed.some((e: any) => e.id === "ADR-001"), diff.data.entities.adrs.removed);
    const modified = diff.data.entities.requirements.modified.find((e: any) => e.id === "REQ-001");
    check("diff reports the modified requirement", !!modified, diff.data.entities.requirements.modified);
    check("diff reports the changed field", !!modified?.changes?.some((c: any) => c.field === "title"), modified?.changes);
    check("diff counts unchanged stories", diff.data.summary.stories.unchanged === 2, diff.data.summary.stories);

    const scoped = await call("diff_versions", { from: "1.0.0", to: "1.1.0", entity: "stories" });
    check("diff_versions can be scoped to one entity", Object.keys(scoped.data.entities).length === 1 && !!scoped.data.entities.stories, scoped.data);

    // --- coverage carries over only for unchanged stories ---------------------
    // US-002's scope changed in 1.1.0, so its 1.0.0 pass no longer counts.
    const reworded = await call("update_user_story", { id: "US-002", title: "Cancel a confirmed booking" });
    check("story reworded in the draft", reworded.isError === false, reworded.data);

    const carried = await call("coverage_report", { mode: "cumulative", version: "1.1.0" });
    check("1.1.0 carries over the unchanged story", carried.data.summary.storiesCovered === 1, carried.data.summary);
    const stillLocked = await call("coverage_report", { mode: "cumulative", version: "1.0.0" });
    check("the locked baseline still reports both covered", stillLocked.data.summary.storiesCovered === 2, stillLocked.data.summary);

    // Re-running against 1.1.0 restores it.
    await call("record_execution", { feature: "Booking", name: "Cancel a booking", status: "pass", version: "1.1.0" });
    const rerun = await call("coverage_report", { mode: "cumulative", version: "1.1.0" });
    check("re-running against 1.1.0 restores coverage", rerun.data.summary.storiesCovered === 2, rerun.data.summary);

    // --- ids never collide across versions ------------------------------------
    const reallocated = await call("create_requirement", { title: "Another one" });
    check("ids are allocated across every version", reallocated.data.id === "REQ-004", reallocated.data);

    // --- pointers -------------------------------------------------------------
    const pointed = await call("set_active_version", { current: "1.1.0" });
    check("set_active_version moves the read pointer", pointed.data.currentVersion === "1.1.0", pointed.data);
    const badPointer = await call("set_active_version", { draft: "1.0.0" });
    check("a locked version cannot be the draft", badPointer.isError === true, badPointer.data);
    await call("set_active_version", { current: "1.0.0" });

    // --- unlocking is guarded --------------------------------------------------
    const unguarded = await call("unlock_version", { version: "1.0.0" });
    check("unlock_version requires force", unguarded.isError === true, unguarded.data);
    const blocked = await call("unlock_version", { version: "1.0.0", force: true });
    check("unlock is refused while another draft is open", blocked.isError === true, blocked.data);

    await call("lock_version", { version: "1.1.0", actor: "ba@example.com", reason: "Sprint 2 baseline" });
    const reopened = await call("unlock_version", { version: "1.1.0", force: true, actor: "ba@example.com", reason: "typo in AC" });
    check("unlock_version reopens a locked baseline with force", reopened.data.status === "draft", reopened.data);
    check("…and records it as the draft", reopened.data.draftVersion === "1.1.0", reopened.data);

    // --- export / import round-trip ---------------------------------------------
    const oneVersion = await call("export_project", { version: "1.0.0" });
    const onePayload = JSON.parse(oneVersion.data);
    check("export defaults to a single version", onePayload.projectVersion === "1.0.0" && Object.keys(onePayload.versionedData).length === 0, { pv: onePayload.projectVersion, keys: Object.keys(onePayload.versionedData) });
    check("a single-version export omits REQ-003", !onePayload.data.requirements.some((r: any) => r.id === "REQ-003"), onePayload.data.requirements.map((r: any) => r.id));

    const full = await call("export_project", { allVersions: true });
    const fullPayload = JSON.parse(full.data);
    check("allVersions export carries the registry", fullPayload.versions.length === 2, fullPayload.versions);
    check("allVersions export carries the other version", Object.keys(fullPayload.versionedData).length === 1, Object.keys(fullPayload.versionedData));

    const restored = await call("import_project", { data: full.data, key: h.key });
    check("re-importing the history is a no-op", restored.isError === false, restored.data);
    const afterImport = await call("list_versions");
    check("re-import does not duplicate versions", afterImport.data.versions.length === 2, afterImport.data.versions.map((v: any) => v.version));
    check("re-import preserves the lock state", afterImport.data.versions.find((v: any) => v.version === "1.0.0").status === "locked", afterImport.data.versions);

    // --- REST parity -----------------------------------------------------------
    const api = async (p: string, init?: RequestInit) => {
      const res = await fetch(`${h.base}${p}`, init);
      return { status: res.status, body: await res.json().catch(() => null) as any };
    };

    const restVersions = await api("/api/versions");
    check("GET /api/versions lists the history", restVersions.body.versions.length === 2, restVersions.body);
    // 1.1.0 became current when it was locked a few lines above, then reopened.
    check("GET /api/versions reports the pointers", restVersions.body.currentVersion === "1.1.0" && restVersions.body.draftVersion === "1.1.0", restVersions.body);

    const restBaseline = await api("/api/requirements?version=1.0.0");
    check("?version= scopes a read route", !JSON.stringify(restBaseline.body).includes("REQ-003"), restBaseline.body?.length);
    const restDraft = await api("/api/requirements?version=1.1.0");
    check("?version= reaches the draft", JSON.stringify(restDraft.body).includes("REQ-003"), restDraft.body?.length);

    const restDiff = await api("/api/versions/diff?from=1.0.0&to=1.1.0");
    check("GET /api/versions/diff matches the tool", restDiff.body.summary.requirements.added === 2, restDiff.body.summary);
    const restBadDiff = await api("/api/versions/diff?from=9.9.9&to=1.1.0");
    check("GET /api/versions/diff 404s an unknown version", restBadDiff.status === 404, restBadDiff.body);
    const restNoFrom = await api("/api/versions/diff");
    check("GET /api/versions/diff 400s without from", restNoFrom.status === 400, restNoFrom.body);

    const restConflict = await api("/api/versions", { method: "POST", body: JSON.stringify({ bump: "minor" }) });
    check("POST /api/versions 409s while a draft is open", restConflict.status === 409, restConflict.body);

    const history = await call("list_versions");
    const v11 = history.data.versions.find((v: any) => v.version === "1.1.0");
    check("the audit trail keeps the lock timestamps", !!v11.lockedAt && !!v11.unlockedAt, v11);
    check("the audit trail keeps actor and reason", v11.actor === "ba@example.com" && v11.reason === "typo in AC", v11);
    check("versions record their parent", v11.parent === "1.0.0", v11);

    // --- progress updates reach a locked baseline -------------------------------
    // A status-only call on a dual-purpose spec tool is progress, so it must land
    // on the version the team is delivering — the locked one — not on the draft.
    await call("lock_version", { version: "1.1.0", actor: "ba@example.com" });
    const beforeDraft = await call("list_versions");
    check("no draft is open after the second lock", !beforeDraft.data.draftVersion, beforeDraft.data);

    const done = await call("update_user_story", { id: "US-001", status: "done" });
    check("a status-only story update succeeds on a locked baseline", done.isError !== true, done);
    const onBaseline = await call("get_user_story", { id: "US-001", version: "1.1.0" });
    check("…and lands on the locked baseline", onBaseline.data.status === "done", onBaseline.data);

    const retitle = await call("update_user_story", { id: "US-001", title: "Reworded" });
    check("…while a title change is still refused", retitle.isError === true, retitle);

    await call("create_version", { bump: "minor" });
    const done2 = await call("update_user_story", { id: "US-002", status: "done" });
    check("a status update still targets the baseline once a draft exists", done2.isError !== true, done2);
    const notDraft = await call("get_user_story", { id: "US-002", version: "1.2.0" });
    check("…and not the open draft", notDraft.data.status !== "done", notDraft.data);

    // --- an unknown ?version= is rejected, not silently created ------------------
    const phantom = await api("/api/requirements?version=9.9.9");
    check("GET with an unknown ?version= 404s", phantom.status === 404, phantom.body);

    // --- import refuses to reopen a locked baseline -----------------------------
    const exported = await call("export_project", { allVersions: true });
    const reimport = await call("import_project", { data: exported.data, allVersions: true });
    check(
      "import leaves an existing locked version untouched",
      JSON.stringify(reimport.data?.errors ?? reimport).includes("locked"),
      reimport.data,
    );
    const lockedAfterReimport = await call("list_versions");
    check(
      "…and it is still locked afterwards",
      lockedAfterReimport.data.versions.find((v: any) => v.version === "1.1.0").status === "locked",
      lockedAfterReimport.data.versions,
    );

    // --- a tool's own `version` field is content, not addressing ----------------
    // create_version names the version it makes; a screen's version is a content
    // hash. Neither may be swallowed by the injected addressing parameter.
    await call("lock_version", { atVersion: "1.2.0", actor: "ba@example.com" });
    const named = await call("create_version", { version: "2.0.0", label: "Explicit" });
    check("create_version accepts an explicit version", named.isError !== true, named);
    const afterNamed = await call("list_versions");
    check(
      "…and it appears in the registry",
      afterNamed.data.versions.some((v: any) => v.version === "2.0.0"),
      afterNamed.data.versions.map((v: any) => v.version),
    );

    const scr = await call("create_or_update_screen", {
      id: "SCR-V", name: "Versioned", platform: "web",
      html: "<main>hello</main>", version: "1.0.0",
    });
    check("a screen keeps its own version field", scr.isError !== true, scr);
    const scrRead = await call("get_screen", { id: "SCR-V", version: "2.0.0" });
    check("…stored in the draft, not the version it names", scrRead.isError !== true, scrRead);
    check("…with its content version intact", scrRead.data?.version === "1.0.0", scrRead.data);

    // --- REST import targets the draft, not the locked baseline -----------------
    const payload = await call("export_project", { version: "2.0.0" });
    const imported = await api("/api/import", {
      method: "POST",
      body: JSON.stringify(JSON.parse(payload.data)),
    });
    check("POST /api/import succeeds with a locked baseline present", imported.status === 200, imported.body);
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
