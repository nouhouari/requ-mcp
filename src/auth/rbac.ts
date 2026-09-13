/**
 * Mapping actions to permissions.
 *
 * Most MCP tools already declare what they do to the data (`mutates: "spec" |
 * "progress" | undefined`), and that maps one-to-one onto a permission, so the
 * default derivation covers the whole tool surface without annotating sixty call
 * sites. Only the tools that are *not* ordinary data edits — version lifecycle,
 * import/export, project creation — need naming here, and a tool added later
 * gets a sensible permission for free.
 *
 * The REST API is derived the same way from method and path, so the dashboard
 * and an MCP client are held to the same rules.
 */

import type { Permission } from "./model.js";

/** What a tool does to the data; mirrors the `Mutates` type in index.ts. */
export type MutateKind = "spec" | "progress" | undefined;

/**
 * Tools whose permission is not simply "does it write specification data".
 * Everything absent from this map falls back to `permissionForMutates`.
 */
const TOOL_PERMISSIONS: Record<string, Permission> = {
  // Project lifecycle
  init_project: "project:manage",
  set_repo: "project:manage",

  // Specification versions
  create_version: "version:manage",
  lock_version: "version:manage",
  unlock_version: "version:manage",
  set_active_version: "version:manage",

  // Bulk data movement
  export_project: "project:export",
  import_project: "project:import",
};

export function permissionForMutates(mutates: MutateKind): Permission {
  if (mutates === "spec") return "spec:write";
  if (mutates === "progress") return "progress:write";
  return "spec:read";
}

/** The permission a named MCP tool requires. */
export function permissionForTool(toolName: string, mutates: MutateKind): Permission {
  return TOOL_PERMISSIONS[toolName] ?? permissionForMutates(mutates);
}

/**
 * REST routes whose permission does not follow from the HTTP method.
 * Matched on `METHOD /path`, with `:param` segments as written in web-api.ts.
 */
const ROUTE_PERMISSIONS: Array<{ method: string; pattern: RegExp; permission: Permission }> = [
  { method: "POST",  pattern: /^\/api\/init$/,                    permission: "project:manage" },
  { method: "PATCH", pattern: /^\/api\/config$/,                  permission: "project:manage" },
  { method: "POST",  pattern: /^\/api\/import$/,                  permission: "project:import" },
  { method: "GET",   pattern: /^\/api\/export$/,                  permission: "project:export" },
  { method: "POST",  pattern: /^\/api\/versions$/,                permission: "version:manage" },
  { method: "POST",  pattern: /^\/api\/versions\/[^/]+\/lock$/,   permission: "version:manage" },
  { method: "POST",  pattern: /^\/api\/versions\/[^/]+\/unlock$/, permission: "version:manage" },
  { method: "POST",  pattern: /^\/api\/versions\/[^/]+\/activate$/, permission: "version:manage" },
  { method: "POST",  pattern: /^\/api\/scenarios\/execute$/,      permission: "progress:write" },
  { method: "POST",  pattern: /^\/api\/executions$/,              permission: "progress:write" },
  { method: "GET",   pattern: /^\/api\/audit$/,                   permission: "audit:read" },
  { method: "GET",   pattern: /^\/api\/history$/,                 permission: "history:read" },
  { method: "GET",   pattern: /^\/api\/history\/[^/]+\/[^/]+$/,   permission: "history:read" },
];

/**
 * Routes served before a principal exists, or that are about the caller's own
 * identity. They authenticate themselves; the blanket guard must let them past.
 */
const PUBLIC_ROUTES: Array<{ method: string; pattern: RegExp }> = [
  { method: "GET",  pattern: /^\/api\/auth\/config$/ },
  { method: "POST", pattern: /^\/api\/auth\/login$/ },
  // The second half of sign-in: the caller holds a challenge, not a session,
  // so there is no principal to check a permission against yet.
  { method: "POST", pattern: /^\/api\/auth\/2fa\/verify$/ },
  { method: "POST", pattern: /^\/api\/auth\/2fa\/enrol$/ },
  { method: "POST", pattern: /^\/api\/auth\/logout$/ },
  { method: "GET",  pattern: /^\/api\/auth\/me$/ },
  { method: "GET",  pattern: /^\/api\/version$/ },
  { method: "GET",  pattern: /^\/api\/openapi\.(json|yaml)$/ },
];

export function isPublicRoute(method: string, pathname: string): boolean {
  return PUBLIC_ROUTES.some((r) => r.method === method.toUpperCase() && r.pattern.test(pathname));
}

/**
 * The permission a REST request requires.
 *
 * Reads need `spec:read`; anything that changes data needs `spec:write` unless
 * the table above says otherwise. `/api/auth/tokens` is exempt — managing your
 * own tokens is part of being logged in, and the handler enforces that you only
 * touch your own.
 */
export function permissionForRoute(method: string, pathname: string): Permission | null {
  const m = method.toUpperCase();
  if (isPublicRoute(m, pathname)) return null;
  if (/^\/api\/auth\/tokens(\/|$)/.test(pathname)) return null;
  // Managing your own second factor is part of being signed in, not a
  // permission someone grants you; the handler enforces that it is your own.
  if (/^\/api\/auth\/2fa(\/|$)/.test(pathname)) return null;
  // Membership routes authorise themselves against the project named in the
  // URL. A blanket check here could only ask about the project the *request*
  // was authenticated for, which is a different question.
  if (/^\/api\/projects\/[^/]+\/members(\/|$)/.test(pathname)) return null;
  if (/^\/api\/admin\//.test(pathname)) return "admin:users";

  const explicit = ROUTE_PERMISSIONS.find((r) => r.method === m && r.pattern.test(pathname));
  if (explicit) return explicit.permission;

  // The Allure report is a rendering of the project's test results.
  if (/^\/allure(\/|$)/.test(pathname)) return "spec:read";

  return m === "GET" || m === "HEAD" ? "spec:read" : "spec:write";
}
