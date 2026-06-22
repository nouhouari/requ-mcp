import parseTagExpression from "@cucumber/tag-expressions";

/**
 * Cucumber-style tag-expression matching (e.g. `@smoke and not @wip`,
 * `(@ui or @api) and @P1`). A bare single tag (`@smoke`) is also a valid
 * expression, so simple and complex filters share one path.
 */

/** Normalize a tag to include a leading `@`. */
function normalizeTag(t: string): string {
  return t.startsWith("@") ? t : `@${t}`;
}

/**
 * Whether `tags` satisfy the given cucumber tag expression.
 * Empty/undefined expression matches everything. Throws on an invalid expression.
 */
export function matchTags(expression: string | undefined, tags: string[]): boolean {
  const expr = expression?.trim();
  if (!expr) return true;
  const node = parseTagExpression(expr);
  return node.evaluate(tags.map(normalizeTag));
}

/** Parse a tag expression once for reuse, surfacing a clear error message. */
export function compileTagExpression(expression: string): (tags: string[]) => boolean {
  const node = parseTagExpression(expression);
  return (tags: string[]) => node.evaluate(tags.map(normalizeTag));
}
