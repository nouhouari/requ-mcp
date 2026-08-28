/**
 * Sequential entity ids.
 *
 * Lives on its own so every store can share it: it used to be a static on the
 * YAML `Store`, which the SQLite and Postgres stores re-exported purely to get
 * at this function.
 */

/** Next numeric id for a prefix, e.g. nextId("REQ", existing) -> "REQ-003". */
export function nextId(prefix: string, existing: string[]): string {
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const id of existing) {
    const m = id.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}
