/**
 * Per-request context.
 *
 * The MCP tool handlers sit several layers below the HTTP handler — the
 * transport owns the call stack — so threading a `principal` argument through
 * would mean touching every one of them. An `AsyncLocalStorage` carries it
 * instead: the HTTP layer establishes the context, and anything running inside
 * that request (a permission check, an audit record, the change recorder) reads
 * it wherever it happens to be.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { devPrincipal, type Principal } from "./model.js";
import type { AuditSource } from "./types.js";

export type RequestContext = {
  principal: Principal;
  source: AuditSource;
  ip: string | null;
  userAgent: string | null;
  /** Project key the call is about, once it is known. */
  projectKey: string | null;
  /** Specification version the call resolved to, once it is known. */
  version: string | null;
  /**
   * Change records collected while the request ran. The recorder appends here
   * and the HTTP layer flushes them in one write when the request finishes.
   */
  changes: import("./types.js").EntityChange[];
};

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The principal for the running request.
 *
 * Falls back to the development principal when there is no context: background
 * work (the schema migration, a smoke script calling a module directly) has no
 * request behind it and must not be blocked by a permission check that has no
 * user to check against.
 */
export function currentPrincipal(): Principal {
  return storage.getStore()?.principal ?? devPrincipal();
}

/** Record which project and version the running request settled on. */
export function noteTarget(projectKey: string | null, version: string | null): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  if (projectKey) ctx.projectKey = projectKey;
  if (version) ctx.version = version;
}

export function newContext(init: Partial<RequestContext> & { principal: Principal; source: AuditSource }): RequestContext {
  return {
    ip: null,
    userAgent: null,
    projectKey: null,
    version: null,
    changes: [],
    ...init,
  };
}
