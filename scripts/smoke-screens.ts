/**
 * End-to-end smoke test for the UI specification chain: Screen artifacts, the
 * story ↔ screen link table, `data-req-*` element extraction, the executable UI
 * coverage checks, and drift detection after a spec change.
 *
 * Drives the built server over HTTP, exactly like scripts/smoke.ts.
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

/** A booking detail mockup: traced elements, a navigation exit, an error feedback. */
const detailHtml = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><style>body{font-family:sans-serif}</style></head>
<body>
  <div class="device">
    <h1 data-req-el="title-booking" data-req-stories="US-001" data-req-role="display">Réserver un créneau</h1>
    <input data-req-el="field-guest-count" data-req-stories="US-001" data-req-role="input" data-req-field="guestCount" />
    <div data-req-component="UIC-SLOT-PICKER"></div>
    <div data-req-el="msg-slot-unavailable" data-req-stories="US-001" data-req-role="feedback">Ce créneau n'est plus disponible</div>
    <button data-req-el="btn-confirm-booking" data-req-stories="US-001" data-req-role="action"
            data-req-target="SCR-BOOK-CONFIRM-MOB">Confirmer la réservation</button>
    <span data-req-el="badge-promo" data-req-role="display">Promo</span>
  </div>
</body></html>`;

/** The shared slot picker component, with its own traced elements. */
const pickerHtml = `<div class="slot-picker">
  <ul data-req-el="list-slots" data-req-stories="US-001" data-req-role="display"><li>18:00</li></ul>
</div>`;

/** The confirmation screen — an explicit end of flow. */
const confirmHtml = `<!doctype html><html><body>
  <p data-req-el="msg-booking-confirmed" data-req-stories="US-001" data-req-role="display">Réservation confirmée</p>
</body></html>`;

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "requ-smoke-screens-"));
  await fs.mkdir(path.join(tmp, "features"), { recursive: true });
  await fs.mkdir(path.join(tmp, "mockups"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, "features", "booking.feature"),
    ["Feature: Booking", "", "  @US-001", "  Scenario: Book a slot", "    Given the app is open"].join("\n"),
  );
  // A mockup that lives as a file in the repo, published by path.
  await fs.writeFile(path.join(tmp, "mockups", "confirm.html"), confirmHtml);

  const h = await startHarness([tmp], "smoke-screens");
  const call = h.call;

  try {
    await call("init_project", {
      name: "ScreenSmoke",
      conductorPath: ".",
      initialPhase: "v1.0",
      uiPlatforms: ["mobile"],
    });
    await call("create_requirement", { title: "Guests can book a slot", components: ["booking"] });
    await call("create_user_story", {
      title: "Book a slot",
      requirements: ["REQ-001"],
      acceptanceCriteria: [
        "A guest picks a slot and confirms",
        "An unavailable slot shows an error",
      ],
      platforms: ["mobile", "web"],
      dataFields: ["guestCount"],
    });
    await call("create_user_story", { title: "Cancel a booking", requirements: ["REQ-001"] });

    // --- publish a shared component + a screen ------------------------------
    const comp = await call("create_or_update_screen", {
      id: "UIC-SLOT-PICKER",
      name: "Slot picker",
      html: pickerHtml,
      stories: [{ id: "US-001", role: "secondary" }],
    });
    check("component kind derived from the UIC- prefix", comp.data.screen?.kind === "component", comp.data.screen);

    const bad = await call("create_or_update_screen", { id: "book-detail", name: "Nope", html: "<p></p>" });
    check("malformed screen id rejected", bad.isError === true, bad.data);

    const detail = await call("create_or_update_screen", {
      id: "SCR-BOOK-DETAIL-MOB",
      name: "Booking detail (mobile)",
      platform: "mobile",
      description: "Pick a slot and confirm",
      html: detailHtml,
      stories: [{ id: "US-001", role: "primary" }],
    });
    check("screen stores 5 own traced elements", detail.data.elements?.length === 5, detail.data.elements?.map((e: any) => e.el));
    check("version defaults to a content hash", /^[0-9a-f]{12}$/.test(detail.data.screen?.version), detail.data.screen?.version);
    check("untraced element flagged as gold plating", detail.data.warnings?.untracedElements?.includes("badge-promo"), detail.data.warnings);
    check("data-req-component ref recorded in uses[]", detail.data.screen?.uses?.includes("UIC-SLOT-PICKER"), detail.data.screen?.uses);
    check("data-req-target recorded as an exit", detail.data.screen?.exits?.includes("SCR-BOOK-CONFIRM-MOB"), detail.data.screen?.exits);

    const el = detail.data.elements?.find((e: any) => e.el === "btn-confirm-booking");
    check("element attributes parsed (role/stories/tag/text)",
      el?.role === "action" && el?.stories?.[0] === "US-001" && el?.tag === "button" && el?.text?.includes("Confirmer"), el);
    const field = detail.data.elements?.find((e: any) => e.el === "field-guest-count");
    check("data-req-field parsed on a void element", field?.field === "guestCount" && field?.text === "", field);

    // --- unknown story link is refused -------------------------------------
    const orphanLink = await call("create_or_update_screen", {
      id: "SCR-BOOK-DETAIL-MOB",
      stories: [{ id: "US-404" }],
    });
    check("link to a non-existent story refused", orphanLink.isError === true, orphanLink.data);

    // --- a screen published from a repo file --------------------------------
    const confirm = await call("create_or_update_screen", {
      id: "SCR-BOOK-CONFIRM-MOB",
      name: "Booking confirmed (mobile)",
      platform: "mobile",
      mockupPath: "mockups/confirm.html",
      terminal: true,
    });
    check("mockupPath is read from the repo", confirm.data.elements?.length === 1, confirm.data.elements);
    await call("link_story_screen", { story_id: "US-001", screen_id: "SCR-BOOK-CONFIRM-MOB", role: "confirmation" });

    const htmlRes = await call("get_screen_html", { id: "SCR-BOOK-CONFIRM-MOB" });
    check("get_screen_html re-reads the file", htmlRes.data.source === "file" && htmlRes.data.html.includes("msg-booking-confirmed"), htmlRes.data.source);

    // --- navigation both ways ----------------------------------------------
    const forStory = await call("get_screens_for_story", { story_id: "US-001" });
    check("screens grouped by platform", forStory.data.byPlatform?.mobile?.length === 2, Object.keys(forStory.data.byPlatform ?? {}));
    check("web platform reported as missing", forStory.data.missingPlatforms?.includes("web"), forStory.data.missingPlatforms);
    const primary = forStory.data.byPlatform?.mobile?.find((s: any) => s.id === "SCR-BOOK-DETAIL-MOB");
    check("component elements resolved into the screen", primary?.elements?.some((e: any) => e.el === "list-slots" && e.from === "UIC-SLOT-PICKER"), primary?.elements?.map((e: any) => e.el));

    const forScreen = await call("get_stories_for_screen", { screen_id: "SCR-BOOK-DETAIL-MOB" });
    check("reverse lookup lists the story and its scenarios",
      forScreen.data.stories?.[0]?.id === "US-001" && forScreen.data.stories?.[0]?.requirements?.includes("REQ-001"), forScreen.data.stories);

    const story = await call("get_user_story", { id: "US-001" });
    check("get_user_story surfaces its screens (2 screens + the shared component)", story.data.screens?.length === 3, story.data.screens);

    // --- coverage checks ----------------------------------------------------
    let cov = await call("check_ui_coverage", {});
    const codes = (cov.data.issues ?? []).map((i: any) => i.code);
    check("platform gap detected (no web screen)", codes.includes("platform_gap"), codes);
    check("story without any screen detected", cov.data.issues.some((i: any) => i.code === "story_without_screen" && i.story === "US-002"), cov.data.issues);
    check("gold-plated element reported", cov.data.issues.some((i: any) => i.code === "element_without_story" && i.element === "badge-promo"), codes);
    check("dead end not reported for the terminal screen", !cov.data.issues.some((i: any) => i.code === "dead_end" && i.screen === "SCR-BOOK-CONFIRM-MOB"), codes);
    check("no data_field_gap: guestCount is on a screen", !codes.includes("data_field_gap"), codes);
    check("no error_feedback_gap: the error criterion has a feedback element", !codes.includes("error_feedback_gap"), codes);
    check("summary counts screens and components apart", cov.data.summary?.screens === 2 && cov.data.summary?.components === 1, cov.data.summary);
    check("report is not ok while errors remain", cov.data.ok === false, cov.data.summary);

    // A screen with a broken exit and no story.
    await call("create_or_update_screen", {
      id: "SCR-ORPHAN-WEB",
      name: "Orphan",
      platform: "web",
      html: '<div data-req-el="x" data-req-role="display" data-req-target="SCR-GHOST">x</div>',
    });
    cov = await call("check_ui_coverage", {});
    check("screen without story reported", cov.data.issues.some((i: any) => i.code === "screen_without_story" && i.screen === "SCR-ORPHAN-WEB"), cov.data.issues.map((i: any) => i.code));
    check("exit to an unknown screen reported", cov.data.issues.some((i: any) => i.code === "unknown_exit"), cov.data.issues.map((i: any) => i.code));
    const onlyErrors = await call("check_ui_coverage", { severity: "error" });
    check("issues filterable by severity", onlyErrors.data.issues.every((i: any) => i.severity === "error"), onlyErrors.data.issues);

    // --- drift --------------------------------------------------------------
    let stale = await call("get_stale_screens");
    check("nothing stale right after generation", stale.data.total === 0, stale.data);

    await call("add_acceptance_criterion", { storyId: "US-001", text: "A guest can add a note to the booking" });
    stale = await call("get_stale_screens");
    check("every artifact linked to the story goes stale when it changes", stale.data.total === 3, stale.data.screens);
    check("stale entry names the drifted story", stale.data.screens?.[0]?.stories?.includes("US-001"), stale.data.screens?.[0]);

    const statusOnly = await call("create_or_update_screen", { id: "SCR-BOOK-DETAIL-MOB", status: "reviewed_qa" });
    check("a metadata-only edit does not clear staleness", statusOnly.data.screen?.stale === true, statusOnly.data.screen);

    const regenerated = await call("create_or_update_screen", {
      id: "SCR-BOOK-DETAIL-MOB",
      html: detailHtml.replace("</div>\n</body>", '<textarea data-req-el="field-note" data-req-stories="US-001" data-req-role="input"></textarea></div>\n</body>'),
    });
    check("regenerating clears the stale flag", regenerated.data.screen?.stale === false, regenerated.data.screen);
    stale = await call("get_stale_screens");
    check("only the un-regenerated artifacts stay stale",
      stale.data.total === 2 && !stale.data.screens.some((s: any) => s.id === "SCR-BOOK-DETAIL-MOB"), stale.data.screens);

    // --- listing / filtering ------------------------------------------------
    const mobiles = await call("list_screens", { platform: "mobile" });
    check("list_screens filters by platform", mobiles.data.length === 2, mobiles.data.map((s: any) => s.id));
    const staleOnly = await call("list_screens", { stale: true });
    check("list_screens filters by staleness", staleOnly.data.length === 2, staleOnly.data.map((s: any) => s.id));
    check("list omits the mockup body by default", mobiles.data[0].html === undefined && mobiles.data[0].hasHtml === true, mobiles.data[0]);

    // --- storage round-trip: the body survives, separate from the metadata ---
    // (This replaced an on-disk YAML+.html layout check when the YAML store was
    //  removed; the property that matters is that the body round-trips intact
    //  while list/detail responses keep omitting it.)
    // The screen was regenerated above, so compare against that revision.
    const expectedHtml = detailHtml.replace("</div>\n</body>", '<textarea data-req-el="field-note" data-req-stories="US-001" data-req-role="input"></textarea></div>\n</body>');
    const body = await call("get_screen_html", { id: "SCR-BOOK-DETAIL-MOB" });
    check("mockup body round-trips through the store", body.data.html === expectedHtml, { len: body.data.html?.length });
    const meta = await call("get_screen", { id: "SCR-BOOK-DETAIL-MOB" });
    check("get_screen omits the body but flags it present", meta.data.html === undefined && meta.data.hasHtml === true, meta.data);

    // --- export / import round-trip -----------------------------------------
    const exported = await call("export_project");
    const payload = JSON.parse(exported.data);
    check("export carries the screens", payload.data.screens?.length === 4, payload.data.screens?.map((s: any) => s.id));

    // --- unlink + delete ----------------------------------------------------
    const unlinked = await call("unlink_story_screen", { story_id: "US-001", screen_id: "SCR-BOOK-CONFIRM-MOB" });
    check("unlink removes the edge", unlinked.data.unlinked === true && unlinked.data.stories.length === 0, unlinked.data);
    const deleted = await call("delete_screen", { id: "SCR-ORPHAN-WEB" });
    check("delete_screen removes the screen", deleted.data.deleted === true, deleted.data);
    const left = await call("list_screens");
    check("3 screens left after delete", left.data.length === 3, left.data.map((s: any) => s.id));
  } finally {
    await h.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
