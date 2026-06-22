import { Parser, AstBuilder, GherkinClassicTokenMatcher } from "@cucumber/gherkin";
import { IdGenerator } from "@cucumber/messages";

/**
 * Gherkin syntax validation using the official @cucumber/gherkin parser.
 *
 * Stored scenario `content` is a single scenario block (no `Feature:` header), so
 * when it lacks one we wrap it in a synthetic `Feature:` before parsing and offset
 * reported line numbers back. A document that parses but contains anything other
 * than exactly one scenario/scenario-outline is rejected too.
 */

export interface GherkinError {
  message: string;
  line?: number;
  column?: number;
}

export interface GherkinValidation {
  ok: boolean;
  errors: GherkinError[];
}

const WRAP_HEADER = "Feature: _validation_\n";
const WRAP_LINES = WRAP_HEADER.split("\n").length - 1; // lines added before content

interface ParserErrorLike {
  message?: string;
  location?: { line?: number; column?: number };
}

function newParser(): Parser<unknown> {
  return new Parser(new AstBuilder(IdGenerator.incrementing()), new GherkinClassicTokenMatcher());
}

/** Validate a single scenario's gherkin content. Empty content is considered valid. */
export function validateGherkin(content: string): GherkinValidation {
  const trimmed = content.trim();
  if (trimmed === "") return { ok: true, errors: [] };

  // Wrap unless the content is already a full Feature document.
  const startsWithFeature = /^\s*Feature:/.test(content);
  const source = startsWithFeature ? content : WRAP_HEADER + content;
  const offset = startsWithFeature ? 0 : WRAP_LINES;

  const errors: GherkinError[] = [];
  let scenarioCount = 0;
  try {
    const doc = newParser().parse(source) as { feature?: { children?: Array<{ scenario?: unknown }> } };
    const children = doc.feature?.children ?? [];
    scenarioCount = children.filter((c) => c.scenario).length;
  } catch (err) {
    const composite = err as { errors?: ParserErrorLike[] } & ParserErrorLike;
    const list: ParserErrorLike[] = composite.errors ?? [composite];
    for (const e of list) {
      const line = e.location?.line;
      errors.push({
        message: e.message ?? String(err),
        line: typeof line === "number" ? Math.max(1, line - offset) : undefined,
        column: e.location?.column,
      });
    }
  }

  if (errors.length === 0 && scenarioCount !== 1) {
    errors.push({
      message:
        scenarioCount === 0
          ? "No scenario found. Content must contain exactly one Scenario or Scenario Outline."
          : `Expected exactly one scenario, found ${scenarioCount}.`,
    });
  }

  return { ok: errors.length === 0, errors };
}
