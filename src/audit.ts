/**
 * Audit trail and per-entity change history.
 *
 * Two records, answering two different questions:
 *
 *  - **audit log** — "who did what, when, and were they allowed to?" One row per
 *    tool call or API request, denials included. This is the compliance record.
 *  - **change history** — "what changed on REQ-014?" One row per entity write,
 *    with the fields that actually differed. This is the Jira-style
 *    "History" panel on a requirement, story, screen or scenario.
 *
 * The change history is produced by wrapping the store rather than by editing
 * sixty tool handlers: `recordingStore()` intercepts every write and delete,
 * reads the prior value, and diffs it. One hook covers the MCP tools and the
 * REST API at once, and a tool added later is recorded without being told to.
 */

import { authConfig } from "./auth/config.js";
import { currentContext, currentPrincipal } from "./auth/context.js";
import { authStore } from "./auth/store.js";
import type {
  AuditEntry,
  AuditOutcome,
  AuditSource,
  ChangeAction,
  EntityChange,
  FieldChange,
} from "./auth/types.js";
import { testKey } from "./schema.js";

const now = (): string => new Date().toISOString();

export function auditEnabled(): boolean {
  try {
    return authConfig().auditEnabled;
  } catch {
    // A configuration error is reported by the boot path; audit simply stays off
    // rather than turning every request into a second, confusing failure.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type AuditInput = {
  action: string;
  outcome: AuditOutcome;
  source?: AuditSource;
  projectId?: string | null;
  version?: string | null;
  permission?: string | null;
  detail?: Record<string, unknown> | null;
};

/**
 * Append one audit entry for the running request.
 *
 * Deliberately fire-and-forget at the call site: a full disk or a slow database
 * must not turn a successful edit into a failed one. The write failing is
 * logged to stderr, which is where a deployment's log shipper is looking.
 */
export function audit(input: AuditInput): void {
  if (!auditEnabled()) return;
  const ctx = currentContext();
  const principal = currentPrincipal();
  const entry: AuditEntry = {
    at: now(),
    actorId: principal.userId,
    actorName: principal.displayName || principal.username,
    actorKind: principal.kind,
    source: input.source ?? ctx?.source ?? "system",
    action: input.action,
    projectId: input.projectId ?? ctx?.projectKey ?? null,
    version: input.version ?? ctx?.version ?? null,
    outcome: input.outcome,
    permission: input.permission ?? null,
    detail: input.detail ?? null,
    ip: ctx?.ip ?? null,
    tokenId: principal.tokenId ?? null,
  };
  authStore()
    .appendAudit(entry)
    .catch((err) => console.error("[requ-mcp] audit write failed:", (err as Error).message));
}

/** Await the audit write — for paths that must not lose the record (login). */
export async function auditSync(input: AuditInput): Promise<void> {
  if (!auditEnabled()) return;
  const ctx = currentContext();
  const principal = currentPrincipal();
  try {
    await authStore().appendAudit({
      at: now(),
      actorId: principal.userId,
      actorName: principal.displayName || principal.username,
      actorKind: principal.kind,
      source: input.source ?? ctx?.source ?? "system",
      action: input.action,
      projectId: input.projectId ?? ctx?.projectKey ?? null,
      version: input.version ?? ctx?.version ?? null,
      outcome: input.outcome,
      permission: input.permission ?? null,
      detail: input.detail ?? null,
      ip: ctx?.ip ?? null,
      tokenId: principal.tokenId ?? null,
    });
  } catch (err) {
    console.error("[requ-mcp] audit write failed:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

/**
 * Fields the history row already states in another form, so listing them again
 * only buries the field the user actually edited:
 *   updatedAt / createdAt — the row carries its own timestamp;
 *   id                    — the row is addressed by that id;
 *   removed               — the tombstone the row's action already names
 *                           ("deleted" / "restored").
 */
const NOISE_FIELDS = new Set(["updatedAt", "createdAt", "id", "removed"]);

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

/**
 * Absent, null, "", [] and {} all mean "nothing here". Treating them as one
 * value keeps a creation's history row down to the fields that were actually
 * filled in, instead of listing every optional field as `— → —`.
 */
function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isEmpty(a) && isEmpty(b)) return true;
  return stable(a) === stable(b);
}

/** Top-level field diff between two entity snapshots. */
export function diffEntities(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): FieldChange[] {
  const out: FieldChange[] = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of [...keys].sort()) {
    if (NOISE_FIELDS.has(key)) continue;
    const from = before ? before[key] : undefined;
    const to = after ? after[key] : undefined;
    if (sameValue(from, to)) continue;
    out.push({ field: key, from: from ?? null, to: to ?? null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Change recording
// ---------------------------------------------------------------------------

/**
 * Queue a change on the running request. The HTTP layer flushes the queue when
 * the request finishes, so a tool that writes five entities costs one insert.
 */
export function recordChange(change: Omit<EntityChange, "at" | "actorId" | "actorName" | "source">): void {
  if (!auditEnabled()) return;
  const ctx = currentContext();
  const principal = currentPrincipal();
  const full: EntityChange = {
    ...change,
    at: now(),
    actorId: principal.userId,
    actorName: principal.displayName || principal.username,
    source: ctx?.source ?? "system",
  };
  if (ctx) {
    ctx.changes.push(full);
  } else {
    authStore()
      .appendChanges([full])
      .catch((err) => console.error("[requ-mcp] change history write failed:", (err as Error).message));
  }
}

/** Write out everything queued on a request. Never throws. */
export async function flushChanges(changes: EntityChange[]): Promise<void> {
  if (changes.length === 0) return;
  try {
    await authStore().appendChanges(changes);
  } catch (err) {
    console.error("[requ-mcp] change history write failed:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// The recording store proxy
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

/** How to record one store write: which entity it is, and how to read it back. */
type WriteSpec = {
  entity: string;
  /** Id of the entity being written, from the method's first argument. */
  idOf: (arg: any) => string;
  /** Reader used to capture the prior state. */
  getter: string;
  /** Argument the getter takes, from the write's first argument. */
  getterArg: (arg: any) => unknown;
};

const WRITES: Record<string, WriteSpec> = {
  writeComponent:   { entity: "component",   idOf: (c) => c.id,          getter: "getComponent",   getterArg: (c) => c.id },
  writeRequirement: { entity: "requirement", idOf: (r) => r.id,          getter: "getRequirement", getterArg: (r) => r.id },
  writeStory:       { entity: "story",       idOf: (s) => s.id,          getter: "getStory",       getterArg: (s) => s.id },
  writePhase:       { entity: "phase",       idOf: (p) => p.id,          getter: "getPhase",       getterArg: (p) => p.id },
  writeScreen:      { entity: "screen",      idOf: (s) => s.id,          getter: "getScreen",      getterArg: (s) => s.id },
  writeAdr:         { entity: "adr",         idOf: (a) => a.id,          getter: "getAdr",         getterArg: (a) => a.id },
  writeVcsRef:      { entity: "vcsRef",      idOf: (v) => v.id,          getter: "getVcsRef",      getterArg: (v) => v.id },
  writeScenario:    { entity: "scenario",    idOf: (s) => testKey(s),    getter: "getScenario",    getterArg: (s) => testKey(s) },
  writeVersion:     { entity: "version",     idOf: (v) => v.version,     getter: "getVersion",     getterArg: (v) => v.version },
};

type DeleteSpec = { entity: string; getter: string };

const DELETES: Record<string, DeleteSpec> = {
  deleteComponent:   { entity: "component",   getter: "getComponent" },
  deleteRequirement: { entity: "requirement", getter: "getRequirement" },
  deleteStory:       { entity: "story",       getter: "getStory" },
  deletePhase:       { entity: "phase",       getter: "getPhase" },
  deleteScreen:      { entity: "screen",      getter: "getScreen" },
  deleteAdr:         { entity: "adr",         getter: "getAdr" },
  deleteScenario:    { entity: "scenario",    getter: "getScenario" },
};

/**
 * A write can flip a tombstone back on or off. That reads better in a history
 * panel as "restored" / "deleted" than as `removed: true → false`.
 */
function actionFor(before: AnyRecord | null, after: AnyRecord | null): ChangeAction {
  if (!before) return "created";
  if (!after) return "deleted";
  const wasRemoved = before.removed === true;
  const isRemoved = after.removed === true;
  if (!wasRemoved && isRemoved) return "deleted";
  if (wasRemoved && !isRemoved) return "restored";
  return "updated";
}

/** Executions written in one batch beyond this are summarised, not enumerated. */
const EXECUTION_DETAIL_CAP = 200;

/**
 * Wrap a store so every write it performs lands in the change history.
 *
 * Implemented with a Proxy so it stays correct as the store grows: an
 * unrecognised method passes straight through, and `at(version)` returns a
 * store that is wrapped the same way, which matters because version binding
 * happens after this wrapper is applied.
 */
export function recordingStore<S extends object>(store: S, projectId: string): S {
  if (!auditEnabled()) return store;

  const handler: ProxyHandler<any> = {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;

      // A re-bound store must keep recording.
      if (prop === "at") {
        return (version: string) => recordingStore(value.call(target, version), projectId);
      }

      const writeSpec = WRITES[prop];
      if (writeSpec) {
        return async (...args: any[]) => {
          const arg = args[0];
          const id = safeId(() => writeSpec.idOf(arg));
          let before: AnyRecord | null = null;
          if (id !== null) before = await safeRead(target, writeSpec.getter, writeSpec.getterArg(arg));
          const result = await value.apply(target, args);
          if (id !== null) {
            const after = (arg ?? null) as AnyRecord | null;
            const changes = diffEntities(before, after);
            if (changes.length > 0 || before === null) {
              recordChange({
                projectId,
                version: await currentVersion(target),
                entity: writeSpec.entity,
                entityId: id,
                action: actionFor(before, after),
                changes,
              });
            }
          }
          return result;
        };
      }

      const deleteSpec = DELETES[prop];
      if (deleteSpec) {
        return async (...args: any[]) => {
          const id = typeof args[0] === "string" ? args[0] : null;
          const before = id === null ? null : await safeRead(target, deleteSpec.getter, id);
          const result = await value.apply(target, args);
          if (id !== null && result !== false) {
            recordChange({
              projectId,
              version: await currentVersion(target),
              entity: deleteSpec.entity,
              entityId: id,
              action: "deleted",
              changes: before ? diffEntities(before, null) : [],
            });
          }
          return result;
        };
      }

      if (prop === "updateVcsRef") {
        return async (...args: any[]) => {
          const id = args[0] as string;
          const before = await safeRead(target, "getVcsRef", id);
          const after = (await value.apply(target, args)) as AnyRecord | null;
          if (after) {
            const changes = diffEntities(before, after);
            if (changes.length > 0) {
              recordChange({
                projectId,
                version: await currentVersion(target),
                entity: "vcsRef",
                entityId: id,
                action: actionFor(before, after),
                changes,
              });
            }
          }
          return after;
        };
      }

      if (prop === "writeConfig") {
        return async (...args: any[]) => {
          const before = await safeRead(target, "readConfig", undefined);
          const result = await value.apply(target, args);
          const changes = diffEntities(before, (args[0] ?? null) as AnyRecord | null);
          if (changes.length > 0) {
            recordChange({
              projectId,
              version: await currentVersion(target),
              entity: "project",
              entityId: projectId,
              action: "updated",
              changes,
            });
          }
          return result;
        };
      }

      if (prop === "appendExecutions") {
        return async (...args: any[]) => {
          const result = await value.apply(target, args);
          const runs = (args[1] ?? []) as Array<{ feature: string; name: string; status: string; phase?: string }>;
          const version = await currentVersion(target);
          if (runs.length > EXECUTION_DETAIL_CAP) {
            // A cucumber import can carry thousands of results; one summary row
            // keeps the history readable and the insert cheap.
            recordChange({
              projectId,
              version,
              entity: "execution",
              entityId: String(args[0] ?? ""),
              action: "created",
              changes: [{ field: "results", from: null, to: `${runs.length} scenario results recorded` }],
            });
          } else {
            for (const run of runs) {
              recordChange({
                projectId,
                version,
                entity: "execution",
                entityId: testKey(run),
                action: "created",
                changes: [{ field: "status", from: null, to: run.status }],
              });
            }
          }
          return result;
        };
      }

      // Anything else — reads, helpers — is the store's own behaviour.
      return value.bind(target);
    },
  };

  return new Proxy(store, handler) as S;
}

function safeId(fn: () => unknown): string | null {
  try {
    const v = fn();
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

async function safeRead(target: any, method: string, arg: unknown): Promise<AnyRecord | null> {
  const fn = target[method];
  if (typeof fn !== "function") return null;
  try {
    const v = arg === undefined ? await fn.call(target) : await fn.call(target, arg);
    return (v ?? null) as AnyRecord | null;
  } catch {
    // An uninitialised project has nothing to read back; the write is still
    // recorded, as a creation.
    return null;
  }
}

async function currentVersion(target: any): Promise<string | null> {
  try {
    return typeof target.version === "function" ? await target.version() : null;
  } catch {
    return null;
  }
}
