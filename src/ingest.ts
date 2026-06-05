import type { TestStatus } from "./schema.js";

/**
 * Parser for Conductor's run output — the cucumber-js JSON report
 * (`cucumber-js --format json`).
 *
 * Shape (abbreviated):
 *   [ { name: "<feature>", elements: [ { name: "<scenario>", type, steps: [ { result: { status } } ] } ] } ]
 *
 * Each scenario's overall status is derived from its steps.
 */

export interface ParsedScenarioResult {
  feature: string;
  name: string;
  status: TestStatus;
  /** Raw cucumber statuses seen, for debugging. */
  rawStatuses: string[];
}

interface CucumberStep {
  result?: { status?: string };
}
interface CucumberElement {
  name?: string;
  type?: string;
  keyword?: string;
  steps?: CucumberStep[];
}
interface CucumberFeature {
  name?: string;
  uri?: string;
  elements?: CucumberElement[];
}

/** Map cucumber step statuses for one scenario to our pass/fail/pending. */
function deriveStatus(stepStatuses: string[]): TestStatus {
  const s = stepStatuses.map((x) => x.toLowerCase());
  // A broken or unrunnable step fails the scenario.
  if (s.some((x) => x === "failed" || x === "undefined" || x === "ambiguous")) return "fail";
  if (s.length > 0 && s.every((x) => x === "passed")) return "pass";
  // Some pending/skipped, nothing failed → not yet proven.
  return "pending";
}

/** Parse a cucumber-js JSON report into per-scenario results. */
export function parseCucumberJson(content: string): ParsedScenarioResult[] {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err) {
    throw new Error(`Not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(data)) {
    throw new Error("Expected a cucumber-js JSON report (top-level array of features).");
  }

  const results: ParsedScenarioResult[] = [];
  for (const feature of data as CucumberFeature[]) {
    const featureName = feature.name ?? feature.uri ?? "";
    for (const el of feature.elements ?? []) {
      // Skip backgrounds; only real scenarios carry a name worth linking.
      if (el.type && el.type !== "scenario") continue;
      const name = el.name?.trim();
      if (!name) continue;
      const rawStatuses = (el.steps ?? [])
        .map((st) => st.result?.status)
        .filter((x): x is string => typeof x === "string");
      results.push({
        feature: featureName,
        name,
        status: deriveStatus(rawStatuses),
        rawStatuses,
      });
    }
  }
  return results;
}
