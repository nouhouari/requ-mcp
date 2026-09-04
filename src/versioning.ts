/**
 * Version lifecycle rules.
 *
 * A project's specification lives in one or more versions. Exactly one is an
 * open `draft` (the BA's working copy); the rest are `locked` baselines that a
 * delivery team can build against without the ground moving under it.
 *
 * Locking is deliberately *partial*: it freezes what a thing IS (its
 * specification) but not how far along it is (its progress). Otherwise a locked
 * baseline would be useless — the team could not mark a story done or accept an
 * ADR while implementing it.
 */

import type { VersionedEntity } from "./schema.js";
import { SEMVER_RE } from "./schema.js";

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------

export type SemverParts = { major: number; minor: number; patch: number };

export function parseSemver(v: string): SemverParts {
  if (!SEMVER_RE.test(v)) {
    throw new Error(`Invalid version '${v}': expected semver like 1.2.0.`);
  }
  const [major, minor, patch] = v.split(".").map((n) => parseInt(n, 10));
  return { major, minor, patch };
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

export type Bump = "major" | "minor" | "patch";

export function bumpSemver(v: string, bump: Bump): string {
  const { major, minor, patch } = parseSemver(v);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Sort ascending by semver precedence. Does not mutate the input. */
export function sortVersions(versions: string[]): string[] {
  return [...versions].sort(compareSemver);
}

// ---------------------------------------------------------------------------
// Freeze matrix
// ---------------------------------------------------------------------------

/**
 * Fields that remain writable once a version is locked, per entity type.
 * Everything else is specification and is rejected.
 *
 * `updatedAt` is excluded on purpose: it is bookkeeping, bumped by every write,
 * so comparing it would make every edit look like a change.
 */
export const MUTABLE_WHILE_LOCKED: Record<VersionedEntity, readonly string[]> = {
  // A requirement is pure specification — nothing about it is progress.
  requirements: [],
  // Delivery progress of the story.
  stories: ["status"],
  // Review lifecycle: draft → reviewed_qa → validated_ops.
  screens: ["status"],
  // A decision may be accepted or superseded while implementing the baseline.
  adrs: ["status", "supersededBy"],
  // Components describe the system's shape — specification.
  components: [],
  // Phase execution progress: planned → active → completed.
  phases: ["status"],
};

/** Never compared: bookkeeping that changes on every write. */
const IGNORED_FIELDS = new Set(["updatedAt"]);

/**
 * Fields carrying a schema default, and the default they carry.
 *
 * A row written before the field existed has no key for it, while the value
 * being written has been through zod and therefore holds the default. Without
 * this normalisation that gap reads as a change and would freeze rows in
 * migrated projects — including edits the freeze matrix explicitly permits.
 */
const DEFAULTED_FIELDS: Record<string, unknown> = { removed: false };

function normalize(key: string, value: unknown): unknown {
  return value === undefined && key in DEFAULTED_FIELDS ? DEFAULTED_FIELDS[key] : value;
}

export type WritableCheck = { ok: true } | { ok: false; frozen: string[] };

/**
 * Decide whether a write is allowed against a locked version.
 *
 * `before` is null for a creation. Creating or soft-deleting an entity is always
 * a specification change, so both are rejected outright in a locked version —
 * only field-level edits confined to the mutable allowlist get through.
 */
export function checkWritable(
  entity: VersionedEntity,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): WritableCheck {
  if (before === null) return { ok: false, frozen: ["<create>"] };

  const allowed = new Set(MUTABLE_WHILE_LOCKED[entity]);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const frozen: string[] = [];

  for (const key of keys) {
    if (IGNORED_FIELDS.has(key) || allowed.has(key)) continue;
    if (!deepEqual(normalize(key, before[key]), normalize(key, after[key]))) frozen.push(key);
  }

  return frozen.length ? { ok: false, frozen: frozen.sort() } : { ok: true };
}

/** Throwing wrapper used by the stores, so every write path reports identically. */
export function assertWritable(
  entity: VersionedEntity,
  version: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): void {
  const check = checkWritable(entity, before, after);
  if (check.ok) return;

  const mutable = MUTABLE_WHILE_LOCKED[entity];
  const what =
    check.frozen[0] === "<create>"
      ? `Cannot create or remove a ${singular(entity)}`
      : `Cannot change frozen field(s) [${check.frozen.join(", ")}] of a ${singular(entity)}`;
  const hint = mutable.length
    ? `Only [${mutable.join(", ")}] stay writable while locked.`
    : `No field of a ${singular(entity)} is writable while locked.`;

  throw new Error(
    `${what} in locked version ${version}. ${hint} ` +
      `Create the next version (create_version) and make the change there, ` +
      `or reopen this one with unlock_version({ force: true }).`,
  );
}

function singular(entity: VersionedEntity): string {
  return entity === "phases" ? "phase" : entity.replace(/ies$/, "y").replace(/s$/, "");
}

/** Structural equality for JSON-shaped values (the entity payloads are JSON). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    // Treat undefined and a missing key as the same absence.
    return (a ?? null) === (b ?? null);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) if (!deepEqual(ao[k], bo[k])) return false;
  return true;
}

export { deepEqual };
