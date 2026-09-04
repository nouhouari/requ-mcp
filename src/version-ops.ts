/**
 * Version lifecycle operations, shared by the MCP tools and the REST API.
 *
 * Creating, locking and unlocking a baseline all have invariants worth stating
 * once — exactly one open draft, a new version must be greater than its parent,
 * the config pointers must follow — so both entry points call these functions
 * rather than each re-deriving the rules.
 *
 * Each returns a discriminated result instead of throwing, because the two
 * callers report failure differently (an MCP error payload vs. an HTTP status).
 */

import { SEMVER_RE, type ProjectVersion, type Config } from "./schema.js";
import { bumpSemver, compareSemver } from "./versioning.js";

export type OpResult<T> = { ok: true; data: T } | { ok: false; error: string };

const fail = (error: string): OpResult<never> => ({ ok: false, error });

/** Store surface these operations need, kept structural to avoid an import cycle. */
export type VersionStore = {
  version(): Promise<string>;
  readConfig(): Promise<Config>;
  writeConfig(config: Config): Promise<void>;
  listVersions(): Promise<ProjectVersion[]>;
  getVersion(version: string): Promise<ProjectVersion | null>;
  writeVersion(v: ProjectVersion): Promise<void>;
  copyVersion(from: string, to: string): Promise<Record<string, number>>;
  dropVersion(version: string): Promise<void>;
};

const now = () => new Date().toISOString();

export type CreateVersionInput = {
  from?: string;
  version?: string;
  bump?: "major" | "minor" | "patch";
  label?: string;
  actor?: string;
  reason?: string;
  setDraft?: boolean;
};

export async function createVersion(
  store: VersionStore,
  input: CreateVersionInput,
): Promise<OpResult<Record<string, unknown>>> {
  const cfg = await store.readConfig();
  const existing = await store.listVersions();

  const draft = existing.find((v) => v.status === "draft");
  if (draft) {
    return fail(
      `Version ${draft.version} is still an open draft. Lock it before creating the next version, ` +
        `so exactly one version is editable at a time.`,
    );
  }

  const from = input.from ?? cfg.currentVersion ?? cfg.draftVersion ?? "1.0.0";
  if (existing.length && !existing.some((v) => v.version === from)) {
    return fail(`Unknown source version '${from}'. Known: [${existing.map((v) => v.version).join(", ")}].`);
  }

  let target: string;
  if (input.version) {
    if (!SEMVER_RE.test(input.version)) return fail(`'${input.version}' is not a semver like 1.2.0.`);
    target = input.version;
  } else {
    target = bumpSemver(from, input.bump ?? "minor");
  }
  if (existing.some((v) => v.version === target)) return fail(`Version ${target} already exists.`);
  if (compareSemver(target, from) <= 0) {
    return fail(`New version ${target} must be greater than its parent ${from}.`);
  }

  // Copy first, register second: a half-copied version missing from the registry
  // is invisible, whereas a registered empty one would look like a valid baseline.
  let copied: Record<string, number>;
  try {
    copied = await store.copyVersion(from, target);
    await store.writeVersion({
      version: target,
      status: "draft",
      label: input.label ?? "",
      parent: from,
      createdAt: now(),
      actor: input.actor,
      reason: input.reason,
    });
  } catch (e) {
    await store.dropVersion(target).catch(() => {});
    return fail(`Could not create version ${target}: ${(e as Error).message}`);
  }

  const setDraft = input.setDraft !== false;
  if (setDraft) await store.writeConfig({ ...cfg, draftVersion: target });

  return {
    ok: true,
    data: {
      created: target,
      from,
      status: "draft",
      copied,
      draftVersion: setDraft ? target : (cfg.draftVersion ?? null),
      currentVersion: cfg.currentVersion ?? null,
    },
  };
}

export async function lockVersion(
  store: VersionStore,
  target: string,
  input: { actor?: string; reason?: string; setCurrent?: boolean } = {},
): Promise<OpResult<Record<string, unknown>>> {
  const row = await store.getVersion(target);
  if (!row) return fail(`Version ${target} is not registered. List the versions to see what exists.`);
  if (row.status === "locked") {
    return { ok: true, data: { version: target, status: "locked", alreadyLocked: true } };
  }

  await store.writeVersion({
    ...row,
    status: "locked",
    lockedAt: now(),
    actor: input.actor ?? row.actor,
    reason: input.reason ?? row.reason,
  });

  const cfg = await store.readConfig();
  const next = { ...cfg };
  if (input.setCurrent !== false) next.currentVersion = target;
  // The draft pointer has nowhere left to go; createVersion reopens one.
  if (cfg.draftVersion === target) next.draftVersion = undefined;
  await store.writeConfig(next);

  return {
    ok: true,
    data: {
      version: target,
      status: "locked",
      currentVersion: next.currentVersion ?? null,
      draftVersion: next.draftVersion ?? null,
      hint: "Specification edits now require a new version.",
    },
  };
}

export async function unlockVersion(
  store: VersionStore,
  target: string,
  input: { force?: boolean; actor?: string; reason?: string } = {},
): Promise<OpResult<Record<string, unknown>>> {
  const row = await store.getVersion(target);
  if (!row) return fail(`Version ${target} is not registered.`);
  if (row.status !== "locked") {
    return { ok: true, data: { version: target, status: row.status, alreadyOpen: true } };
  }
  if (input.force !== true) {
    return fail(
      `Unlocking ${target} changes a baseline a team may already be building against. ` +
        `Prefer creating the next version and making the change there. Pass force to unlock anyway.`,
    );
  }

  const other = (await store.listVersions()).find((v) => v.status === "draft");
  if (other) {
    return fail(`Version ${other.version} is already an open draft. Only one version may be editable at a time.`);
  }

  await store.writeVersion({
    ...row,
    status: "draft",
    unlockedAt: now(),
    actor: input.actor ?? row.actor,
    reason: input.reason ?? row.reason,
  });

  const cfg = await store.readConfig();
  await store.writeConfig({ ...cfg, draftVersion: target });

  return { ok: true, data: { version: target, status: "draft", draftVersion: target, forced: true } };
}

export async function setActiveVersion(
  store: VersionStore,
  input: { current?: string; draft?: string },
): Promise<OpResult<Record<string, unknown>>> {
  if (!input.current && !input.draft) return fail("Give current, draft, or both.");
  const known = await store.listVersions();
  const byId = new Map(known.map((v) => [v.version, v]));

  for (const [field, value] of [["current", input.current], ["draft", input.draft]] as const) {
    if (value && known.length && !byId.has(value)) {
      return fail(`Unknown version '${value}' for ${field}. Known: [${known.map((v) => v.version).join(", ")}].`);
    }
  }
  if (input.draft && byId.get(input.draft)?.status === "locked") {
    return fail(`Version ${input.draft} is locked and cannot be the draft. Unlock it or create a new version.`);
  }

  const cfg = await store.readConfig();
  const next = {
    ...cfg,
    currentVersion: input.current ?? cfg.currentVersion,
    draftVersion: input.draft ?? cfg.draftVersion,
  };
  await store.writeConfig(next);
  return { ok: true, data: { currentVersion: next.currentVersion ?? null, draftVersion: next.draftVersion ?? null } };
}
