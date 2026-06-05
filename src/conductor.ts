import { promises as fs } from "node:fs";
import path from "node:path";
import { STORY_TAG_RE, testKey } from "./schema.js";

/**
 * Reads the Conductor project's feature files directly off disk — no runtime
 * coupling to the Conductor MCP server.
 *
 * A test is a cucumber scenario (feature name + scenario name) in
 * features/**\/*.feature. Scenario → user-story links are declared as `@US-xxx`
 * tags on the scenario and derived here; the feature files are the single
 * source of truth for linkage.
 */

export interface ConductorScenario {
  feature: string;
  name: string;
  file: string;
  /** All tags on the scenario (incl. inherited feature-level tags), e.g. "@US-007". */
  tags: string[];
  /** Story ids parsed from tags, e.g. ["US-007"]. */
  stories: string[];
}

export interface ConductorIndex {
  scenarios: ConductorScenario[];
}

async function walk(dir: string, match: (f: string) => boolean): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      out.push(...(await walk(full, match)));
    } else if (match(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function parseTags(line: string): string[] {
  return line.split(/\s+/).filter((t) => t.startsWith("@"));
}

function storiesFromTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const m = t.match(STORY_TAG_RE);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Lightweight gherkin scan: pull the Feature name, each Scenario name, and the
 * tags attached to each (tag lines immediately above the Scenario, plus
 * feature-level tags above the `Feature:` line, which apply to all scenarios).
 */
function parseFeatureFile(content: string, file: string): ConductorScenario[] {
  let feature = path.basename(file, ".feature");
  let featureTags: string[] = [];
  let pendingTags: string[] = [];
  const scenarios: ConductorScenario[] = [];

  for (const lineRaw of content.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (line === "" || line.startsWith("#")) continue;

    if (line.startsWith("@")) {
      pendingTags.push(...parseTags(line));
      continue;
    }
    const fm = line.match(/^Feature:\s*(.+)$/);
    if (fm) {
      feature = fm[1].trim();
      featureTags = pendingTags;
      pendingTags = [];
      continue;
    }
    const sm = line.match(/^Scenario(?:\s+Outline)?:\s*(.+)$/);
    if (sm) {
      const tags = [...featureTags, ...pendingTags];
      scenarios.push({
        feature,
        name: sm[1].trim(),
        file,
        tags,
        stories: storiesFromTags(tags),
      });
      pendingTags = [];
      continue;
    }
    // Any other content line (steps, Background, Examples) ends a tag block.
    pendingTags = [];
  }
  return scenarios;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

const CUCUMBER_CONFIGS = [
  "cucumber.js",
  "cucumber.cjs",
  "cucumber.mjs",
  "cucumber.json",
  "cucumber.yaml",
  "cucumber.yml",
];

export interface ConductorInfo {
  path: string;
  exists: boolean;
  /** Looks like a Conductor/cucumber project: has features/ or a cucumber config. */
  isConductorProject: boolean;
  hasFeaturesDir: boolean;
  /** The cucumber config file found at the root, if any. */
  cucumberConfig: string | null;
  /** Project name: package.json "name" if present, else the folder name. */
  name: string;
  featureFiles: number;
}

/** Inspect a candidate Conductor project directory without modifying anything. */
export async function inspectConductorProject(root: string): Promise<ConductorInfo> {
  const exists = await dirExists(root);
  const hasFeaturesDir = exists && (await dirExists(path.join(root, "features")));

  let cucumberConfig: string | null = null;
  if (exists) {
    for (const c of CUCUMBER_CONFIGS) {
      if (await fileExists(path.join(root, c))) {
        cucumberConfig = c;
        break;
      }
    }
  }

  let name = path.basename(root);
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    if (pkg && typeof pkg.name === "string" && pkg.name) name = pkg.name;
  } catch {
    // no package.json — keep folder name
  }

  let featureFiles = 0;
  if (hasFeaturesDir) {
    featureFiles = (await walk(path.join(root, "features"), (f) => f.endsWith(".feature"))).length;
  }

  return {
    path: root,
    exists,
    isConductorProject: exists && (hasFeaturesDir || cucumberConfig !== null),
    hasFeaturesDir,
    cucumberConfig,
    name,
    featureFiles,
  };
}

/** Build an index of all scenarios in a Conductor project. */
export async function indexConductor(conductorRoot: string): Promise<ConductorIndex> {
  const featureFiles = await walk(path.join(conductorRoot, "features"), (f) => f.endsWith(".feature"));
  const scenarios: ConductorScenario[] = [];
  for (const file of featureFiles) {
    scenarios.push(...parseFeatureFile(await fs.readFile(file, "utf8"), file));
  }
  return { scenarios };
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  suggestions?: string[];
}

/** Check that a test ref resolves to a real Conductor scenario. */
export function validateTestRef(ref: { feature: string; name: string }, index: ConductorIndex): ValidationResult {
  const matches = index.scenarios.filter((s) => s.name === ref.name && s.feature === ref.feature);
  if (matches.length > 0) return { ok: true };
  // Fall back to a name-only match to produce a precise hint.
  const byName = index.scenarios.filter((s) => s.name === ref.name);
  if (byName.length > 0) {
    return {
      ok: false,
      reason: `Scenario "${ref.name}" exists, but not in feature "${ref.feature}".`,
      suggestions: byName.map((s) => `${s.feature} :: ${s.name}`),
    };
  }
  return {
    ok: false,
    reason: `No scenario "${ref.name}" found in feature "${ref.feature}".`,
    suggestions: closest(ref.name, index.scenarios.map((s) => `${s.feature} :: ${s.name}`)),
  };
}

/** Cheap fuzzy match for helpful "did you mean" suggestions. */
function closest(target: string, pool: string[], limit = 5): string[] {
  const t = target.toLowerCase();
  return pool
    .map((c) => ({ c, d: levenshtein(t, c.toLowerCase()) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.c);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// ---------------------------------------------------------------------------
// Tag-derived linkage
// ---------------------------------------------------------------------------

/** Map of story id → the scenarios tagged with it. */
export function scenariosByStory(index: ConductorIndex): Map<string, ConductorScenario[]> {
  const map = new Map<string, ConductorScenario[]>();
  for (const sc of index.scenarios) {
    for (const story of sc.stories) {
      const arr = map.get(story) ?? [];
      arr.push(sc);
      map.set(story, arr);
    }
  }
  return map;
}

/** testKeys of every scenario that carries at least one @US-xxx tag. */
export function linkedScenarioKeys(index: ConductorIndex): Set<string> {
  const set = new Set<string>();
  for (const sc of index.scenarios) if (sc.stories.length) set.add(testKey(sc));
  return set;
}

/** Scenario tags that reference a story id not present in `knownStoryIds`. */
export function danglingStoryTags(
  index: ConductorIndex,
  knownStoryIds: Set<string>,
): { feature: string; name: string; file: string; story: string }[] {
  const out: { feature: string; name: string; file: string; story: string }[] = [];
  for (const sc of index.scenarios) {
    for (const story of sc.stories) {
      if (!knownStoryIds.has(story)) out.push({ feature: sc.feature, name: sc.name, file: sc.file, story });
    }
  }
  return out;
}

export { testKey };
