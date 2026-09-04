/**
 * Version diffing.
 *
 * Answers "what changed between two baselines?" per entity type, at field level.
 * Drives the `diff_versions` tool, the REST endpoint and the dashboard's Versions
 * tab. Tombstones are what make removals visible here: a soft-deleted entity is
 * still a row, so it can be reported as `removed` rather than silently vanishing.
 */

import type { SqliteStore } from "./sqlite-store.js";
import type { PostgresStore } from "./postgres-store.js";
import { VERSIONED_ENTITIES, type VersionedEntity } from "./schema.js";
import { deepEqual } from "./versioning.js";

type AnyStore = SqliteStore | PostgresStore;

/** Bookkeeping that would otherwise make every touched entity look modified. */
const IGNORED_FIELDS = new Set(["createdAt", "updatedAt", "removed"]);

export type FieldChange = {
  field: string;
  from: unknown;
  to: unknown;
};

export type EntityDiff = {
  id: string;
  /** Best-effort human label, so a report reads without a second lookup. */
  title?: string;
  changes?: FieldChange[];
};

export type TypeDiff = {
  added: EntityDiff[];
  removed: EntityDiff[];
  modified: EntityDiff[];
  unchanged: number;
};

export type VersionDiff = {
  from: string;
  to: string;
  /** True when nothing at all differs between the two versions. */
  identical: boolean;
  summary: Record<string, { added: number; removed: number; modified: number; unchanged: number }>;
  entities: Record<string, TypeDiff>;
};

type Row = Record<string, unknown> & { id?: string };

/** Read every row of an entity type in a version, tombstones included. */
async function readAll(store: AnyStore, entity: VersionedEntity): Promise<Map<string, Row>> {
  const opts = { includeRemoved: true } as const;
  const rows: Row[] =
    entity === "components"   ? await store.listComponents(opts)
    : entity === "requirements" ? await store.listRequirements(opts)
    : entity === "stories"      ? await store.listStories(opts)
    : entity === "phases"       ? await store.listPhases(opts)
    : entity === "screens"      ? await store.listScreens(opts)
    :                             await store.listAdrs(opts);
  return new Map(rows.map((r) => [String(r.id), r]));
}

function labelOf(row: Row): string | undefined {
  const v = row.title ?? row.name;
  return typeof v === "string" ? v : undefined;
}

/** Field-level changes between two revisions of the same entity. */
export function fieldChanges(before: Row, after: Row): FieldChange[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: FieldChange[] = [];
  for (const field of keys) {
    if (IGNORED_FIELDS.has(field)) continue;
    if (!deepEqual(before[field], after[field])) {
      out.push({ field, from: before[field], to: after[field] });
    }
  }
  return out.sort((a, b) => a.field.localeCompare(b.field));
}

/**
 * Compare two versions of one project.
 *
 * An entity counts as `removed` when it is absent from `to`, or present but
 * tombstoned there while it was live in `from`.
 */
export async function diffVersions(
  store: AnyStore,
  from: string,
  to: string,
  opts: { includeFieldChanges?: boolean } = {},
): Promise<VersionDiff> {
  const withFields = opts.includeFieldChanges !== false;
  const entities: Record<string, TypeDiff> = {};
  const summary: VersionDiff["summary"] = {};
  let identical = true;

  for (const entity of VERSIONED_ENTITIES) {
    const before = await readAll(store.at(from) as AnyStore, entity);
    const after  = await readAll(store.at(to) as AnyStore, entity);

    const diff: TypeDiff = { added: [], removed: [], modified: [], unchanged: 0 };

    for (const [id, a] of after) {
      const b = before.get(id);
      const aLive = a.removed !== true;
      const bLive = b !== undefined && b.removed !== true;

      if (!bLive && aLive) {
        diff.added.push({ id, title: labelOf(a) });
        continue;
      }
      if (bLive && !aLive) {
        diff.removed.push({ id, title: labelOf(a) });
        continue;
      }
      if (!bLive && !aLive) continue; // tombstoned in both — not a change

      const changes = fieldChanges(b!, a);
      if (changes.length) {
        diff.modified.push({ id, title: labelOf(a), ...(withFields ? { changes } : {}) });
      } else {
        diff.unchanged++;
      }
    }

    // Live in `from` but with no row at all in `to`: a hard removal, which
    // happens when `to` is an unrelated version rather than a descendant.
    for (const [id, b] of before) {
      if (after.has(id) || b.removed === true) continue;
      diff.removed.push({ id, title: labelOf(b) });
    }

    diff.added.sort((x, y) => x.id.localeCompare(y.id));
    diff.removed.sort((x, y) => x.id.localeCompare(y.id));
    diff.modified.sort((x, y) => x.id.localeCompare(y.id));

    entities[entity] = diff;
    summary[entity] = {
      added: diff.added.length,
      removed: diff.removed.length,
      modified: diff.modified.length,
      unchanged: diff.unchanged,
    };
    if (diff.added.length || diff.removed.length || diff.modified.length) identical = false;
  }

  return { from, to, identical, summary, entities };
}
