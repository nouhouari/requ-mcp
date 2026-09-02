import {
  ElementRole,
  type CoverageMode,
  type Phase,
  type Requirement,
  type Screen,
  type ScreenElement,
  type ScreenPlatform,
  type UserStory,
} from "./schema.js";
import { inScope, requirementPhaseMap, storyInScope } from "./coverage.js";

/**
 * Executable consistency checks over the UI traceability graph (screens ↔ stories).
 *
 * These check COHERENCE only — that every story of the phase is materialized, on
 * every platform it targets, with elements that trace back to a story, and that
 * no screen has drifted from the spec it was generated from. Business RELEVANCE
 * ("does this flow match the real field work?") stays a human validation: QA then
 * Operations, before any code is written.
 *
 * Severity: `error` marks a real traceability hole; `warning` marks a heuristic
 * finding (text matching, field naming) that a human should confirm.
 */

export interface UiIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  screen?: string;
  story?: string;
  element?: string;
}

export interface StoryUiRow {
  id: string;
  title: string;
  platforms: ScreenPlatform[];
  missingPlatforms: ScreenPlatform[];
  screens: { id: string; name: string; platform?: ScreenPlatform; role: string; stale: boolean }[];
}

export interface StaleScreen {
  id: string;
  name: string;
  /** Stories that changed since the screen was generated. */
  stories: string[];
  reason: string;
}

export interface UiCoverageReport {
  phase: string | null;
  mode: CoverageMode;
  ok: boolean;
  summary: {
    screens: number;
    components: number;
    storiesInScope: number;
    storiesWithScreen: number;
    storiesWithoutScreen: number;
    screensWithoutStory: number;
    staleScreens: number;
    elements: number;
    errors: number;
    warnings: number;
  };
  byStory: StoryUiRow[];
  staleScreens: StaleScreen[];
  issues: UiIssue[];
}

/**
 * Words that mark an acceptance criterion as describing an error/edge state.
 * Deliberately bilingual (en/fr): these match the project's own criterion text,
 * which authors may write in either language — they are not UI copy.
 */
const ERROR_HINTS =
  /\b(erreur|erreurs|invalide|invalides|indisponible|indisponibles|refus\w*|échec|echec|impossible|interdit|expiré|expire[er]?|error|errors|invalid|unavailable|reject\w*|denied|fail\w*|forbidden|expired|not found|introuvable)\b/i;

/** Normalized form used to match a story data field against an element id. */
function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Every element a screen exposes: its own, plus those of the shared components it
 * uses (recursively, cycle-guarded), tagged with the component they came from.
 */
export function resolveElements(
  screen: Screen,
  screenById: Map<string, Screen>,
  seen: Set<string> = new Set(),
): ScreenElement[] {
  if (seen.has(screen.id)) return [];
  seen.add(screen.id);
  const out: ScreenElement[] = [...screen.elements];
  for (const id of screen.uses) {
    const comp = screenById.get(id);
    if (!comp) continue;
    for (const el of resolveElements(comp, screenById, seen)) {
      out.push({ ...el, from: el.from ?? comp.id });
    }
  }
  return out;
}

/** Screen ids reachable from this screen: explicit exits + `data-req-target`. */
export function screenExits(screen: Screen, screenById: Map<string, Screen>): string[] {
  const out = [...screen.exits];
  for (const el of resolveElements(screen, screenById)) {
    if (el.target && !out.includes(el.target)) out.push(el.target);
  }
  return out;
}

/** Linked stories whose current `updatedAt` differs from the generation snapshot. */
export function driftedStories(screen: Screen, storyById: Map<string, UserStory>): string[] {
  const out: string[] = [];
  for (const link of screen.stories) {
    const story = storyById.get(link.id);
    if (!story) continue;
    if (screen.storyVersions[link.id] !== story.updatedAt) out.push(link.id);
  }
  return out;
}

/** A screen is stale when a story it materializes changed after its generation. */
export function isStale(screen: Screen, storyById: Map<string, UserStory>): boolean {
  return driftedStories(screen, storyById).length > 0;
}

export function staleScreens(screens: Screen[], stories: UserStory[]): StaleScreen[] {
  const storyById = new Map(stories.map((s) => [s.id, s]));
  const out: StaleScreen[] = [];
  for (const screen of screens) {
    const drifted = driftedStories(screen, storyById);
    if (!drifted.length) continue;
    out.push({
      id: screen.id,
      name: screen.name,
      stories: drifted,
      reason: `Linked story/stories ${drifted.join(", ")} changed since this screen was generated — regenerate the mockup.`,
    });
  }
  return out;
}

/** Screens linked to a story, in declaration order. */
export function screensForStory(screens: Screen[], storyId: string): Screen[] {
  return screens.filter((sc) => sc.stories.some((l) => l.id === storyId));
}

/** Platforms a story must be materialized on: its own, else the project default. */
export function targetPlatforms(story: UserStory, defaults: ScreenPlatform[]): ScreenPlatform[] {
  return story.platforms.length ? story.platforms : defaults;
}

export interface UiCheckInput {
  screens: Screen[];
  stories: UserStory[];
  requirements: Requirement[];
  phases: Phase[];
  /** Target phase, or null for "all phases". */
  phase: string | null;
  mode: CoverageMode;
  /** config.uiPlatforms — applies to stories that don't declare their own. */
  defaultPlatforms: ScreenPlatform[];
}

export function checkUiCoverage(input: UiCheckInput): UiCoverageReport {
  const { screens, stories, requirements, phases, phase, mode, defaultPlatforms } = input;

  const screenById = new Map(screens.map((s) => [s.id, s]));
  const storyById = new Map(stories.map((s) => [s.id, s]));
  const reqPhaseById = requirementPhaseMap(requirements);

  const issues: UiIssue[] = [];
  const add = (i: UiIssue) => issues.push(i);

  // Screens are scoped by their own phase; stories inherit scope from their
  // requirements (a story has no phase of its own).
  const scopedScreens = screens.filter((sc) => inScope(sc.phase, phase, phases, mode));
  const scopedStories = stories.filter((s) => storyInScope(s, phase, reqPhaseById, phases, mode));

  // --- Functional + platform coverage (per story) ---------------------------
  const byStory: StoryUiRow[] = [];
  for (const story of scopedStories) {
    const linked = screensForStory(screens, story.id);
    const wanted = targetPlatforms(story, defaultPlatforms);
    const covered = new Set(linked.map((sc) => sc.platform).filter(Boolean) as ScreenPlatform[]);
    const missingPlatforms = wanted.filter((p) => !covered.has(p));

    if (linked.length === 0) {
      add({
        code: "story_without_screen",
        severity: "error",
        story: story.id,
        message: `${story.id} has no screen — the UI spec for this story is missing.`,
      });
    } else {
      for (const p of missingPlatforms) {
        add({
          code: "platform_gap",
          severity: "error",
          story: story.id,
          message: `${story.id} targets ${p} but has no ${p} screen.`,
        });
      }
    }

    // Data-model fields the story touches must surface somewhere in its screens.
    const fieldsSeen = new Set<string>();
    for (const sc of linked) {
      for (const el of resolveElements(sc, screenById)) {
        if (el.field) fieldsSeen.add(norm(el.field));
        fieldsSeen.add(norm(el.el));
      }
    }
    for (const field of story.dataFields) {
      const n = norm(field);
      const found = [...fieldsSeen].some((seen) => seen === n || seen.includes(n));
      if (!found) {
        add({
          code: "data_field_gap",
          severity: "warning",
          story: story.id,
          message: `Field "${field}" of ${story.id} appears in no linked screen (no data-req-field or matching data-req-el).`,
        });
      }
    }

    // Every error state described in the criteria needs somewhere to show it.
    const errorCriteria = story.acceptanceCriteria.filter((c) => ERROR_HINTS.test(c.text));
    if (errorCriteria.length && linked.length) {
      const hasFeedback = linked.some((sc) =>
        resolveElements(sc, screenById).some((el) => el.role === "feedback"),
      );
      if (!hasFeedback) {
        add({
          code: "error_feedback_gap",
          severity: "warning",
          story: story.id,
          message:
            `${story.id} describes ${errorCriteria.length} error/edge criterion(s) ` +
            `(${errorCriteria.map((c) => c.id).join(", ")}) but none of its screens has a data-req-role="feedback" element.`,
        });
      }
    }

    byStory.push({
      id: story.id,
      title: story.title,
      platforms: wanted,
      missingPlatforms: linked.length ? missingPlatforms : wanted,
      screens: linked.map((sc) => ({
        id: sc.id,
        name: sc.name,
        platform: sc.platform,
        role: sc.stories.find((l) => l.id === story.id)?.role ?? "primary",
        stale: isStale(sc, storyById),
      })),
    });
  }

  // --- Structural checks (per screen) ---------------------------------------
  const validRoles = new Set<string>(ElementRole.options);
  let elementCount = 0;

  for (const sc of scopedScreens) {
    const isComponent = sc.kind === "component";

    if (sc.stories.length === 0) {
      add({
        code: "screen_without_story",
        severity: "error",
        screen: sc.id,
        message: `${sc.id} references no story — it materializes nothing traceable.`,
      });
    }
    for (const link of sc.stories) {
      if (!storyById.has(link.id)) {
        add({
          code: "unknown_story_link",
          severity: "error",
          screen: sc.id,
          story: link.id,
          message: `${sc.id} is linked to ${link.id}, which does not exist.`,
        });
      }
    }
    if (!sc.html.trim() && !sc.mockupPath) {
      add({
        code: "missing_mockup",
        severity: "error",
        screen: sc.id,
        message: `${sc.id} has neither inline HTML nor a mockupPath.`,
      });
    }
    if (sc.kind === "screen" && !sc.platform) {
      add({
        code: "missing_platform",
        severity: "error",
        screen: sc.id,
        message: `${sc.id} declares no platform.`,
      });
    }
    for (const used of sc.uses) {
      const comp = screenById.get(used);
      if (!comp) {
        add({
          code: "unknown_component",
          severity: "error",
          screen: sc.id,
          message: `${sc.id} references shared component ${used}, which does not exist.`,
        });
      } else if (comp.kind !== "component") {
        add({
          code: "not_a_component",
          severity: "warning",
          screen: sc.id,
          message: `${sc.id} embeds ${used}, which is registered as a ${comp.kind}, not a shared component.`,
        });
      }
    }

    const elements = resolveElements(sc, screenById);
    elementCount += elements.length;
    const linkedStoryIds = new Set(sc.stories.map((l) => l.id));
    const seenEls = new Set<string>();

    for (const el of elements) {
      if (seenEls.has(el.el)) {
        add({
          code: "duplicate_element_id",
          severity: "error",
          screen: sc.id,
          element: el.el,
          message: `data-req-el="${el.el}" appears more than once in ${sc.id} — element ids must be unique per screen.`,
        });
      }
      seenEls.add(el.el);

      if (el.stories.length === 0) {
        add({
          code: "element_without_story",
          severity: "warning",
          screen: sc.id,
          element: el.el,
          message: `${el.el} carries no data-req-stories — potential gold plating.`,
        });
      }
      for (const sid of el.stories) {
        if (!storyById.has(sid)) {
          add({
            code: "unknown_element_story",
            severity: "error",
            screen: sc.id,
            element: el.el,
            story: sid,
            message: `${el.el} references story ${sid}, which does not exist.`,
          });
        } else if (!linkedStoryIds.has(sid) && !el.from) {
          add({
            code: "element_story_not_linked",
            severity: "warning",
            screen: sc.id,
            element: el.el,
            story: sid,
            message: `${el.el} references ${sid}, but ${sc.id} is not linked to that story (link_story_screen).`,
          });
        }
      }
      if (el.role && !validRoles.has(el.role)) {
        add({
          code: "invalid_element_role",
          severity: "warning",
          screen: sc.id,
          element: el.el,
          message: `${el.el} has data-req-role="${el.role}"; expected one of ${ElementRole.options.join(", ")}.`,
        });
      } else if (!el.role) {
        add({
          code: "missing_element_role",
          severity: "warning",
          screen: sc.id,
          element: el.el,
          message: `${el.el} has no data-req-role — the test agent cannot choose an assertion type.`,
        });
      }
    }

    // Navigation: no dead ends, and every exit points at a real screen.
    const exits = screenExits(sc, screenById);
    if (!isComponent && !sc.terminal && exits.length === 0) {
      add({
        code: "dead_end",
        severity: "warning",
        screen: sc.id,
        message: `${sc.id} has no exit (no data-req-target, no exits[]) and is not marked terminal.`,
      });
    }
    for (const target of exits) {
      if (!screenById.has(target)) {
        add({
          code: "unknown_exit",
          severity: "error",
          screen: sc.id,
          message: `${sc.id} navigates to ${target}, which is not a known screen.`,
        });
      }
    }
  }

  // --- Drift ----------------------------------------------------------------
  const stale = staleScreens(scopedScreens, stories);
  for (const s of stale) {
    add({ code: "stale_screen", severity: "warning", screen: s.id, message: s.reason });
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  const storiesWithScreen = byStory.filter((s) => s.screens.length > 0).length;

  return {
    phase,
    mode,
    ok: errors === 0,
    summary: {
      screens: scopedScreens.filter((s) => s.kind === "screen").length,
      components: scopedScreens.filter((s) => s.kind === "component").length,
      storiesInScope: scopedStories.length,
      storiesWithScreen,
      storiesWithoutScreen: scopedStories.length - storiesWithScreen,
      screensWithoutStory: scopedScreens.filter((s) => s.stories.length === 0).length,
      staleScreens: stale.length,
      elements: elementCount,
      errors,
      warnings,
    },
    byStory,
    staleScreens: stale,
    issues,
  };
}
