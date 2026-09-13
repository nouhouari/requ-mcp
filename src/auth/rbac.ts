/**
 * Mapping actions to permissions.
 *
 * Permissions are split by entity, so this is where a tool or a route says which
 * entity it is about. Most tools are named after theirs — `create_requirement`,
 * `delete_screen` — so the mapping is a table keyed by tool name, with a
 * suffix-based fallback for anything added later that follows the convention.
 *
 * The alternative, annotating sixty call sites in index.ts, spreads the policy
 * across the file it governs and makes "what can a QA engineer do?" unanswerable
 * without reading all of it.
 */

import type { Permission } from "./model.js";

/** What a tool does to the data; mirrors the `Mutates` type in index.ts. */
export type MutateKind = "spec" | "progress" | undefined;

/**
 * Tool name → the permission it needs.
 *
 * Read-only tools are absent: they fall through to `spec:read`.
 */
const TOOL_PERMISSIONS: Record<string, Permission> = {
  // --- requirements ---
  create_requirement: "requirement:write",
  update_requirement: "requirement:write",
  assign_requirements_to_phase: "requirement:write",

  // --- user stories ---
  create_user_story: "story:write",
  update_user_story: "story:write",
  add_acceptance_criterion: "story:write",
  delete_acceptance_criterion: "story:write",

  // --- scenarios ---
  create_scenario: "scenario:write",
  update_scenario: "scenario:write",
  delete_scenario: "scenario:write",
  import_scenarios_from_features: "scenario:write",

  // --- screens ---
  create_or_update_screen: "screen:write",
  delete_screen: "screen:write",
  link_story_screen: "screen:write",
  unlink_story_screen: "screen:write",

  // --- architecture decisions ---
  create_adr: "adr:write",
  update_adr: "adr:write",
  delete_adr: "adr:write",
  import_adrs_from_files: "adr:write",

  // --- components and phases ---
  create_component: "component:write",
  update_component: "component:write",
  create_phase: "phase:write",
  update_phase: "phase:write",
  set_active_phase: "phase:write",

  // --- delivery progress ---
  record_execution: "execution:write",
  import_execution_report: "execution:write",
  link_branch: "vcs:write",
  link_merge_request: "vcs:write",
  update_merge_request: "vcs:write",

  // --- project lifecycle ---
  init_project: "project:manage",
  set_repo: "project:manage",
  create_version: "version:manage",
  lock_version: "version:manage",
  unlock_version: "version:manage",
  set_active_version: "version:manage",
  export_project: "project:export",
  import_project: "project:import",
};

/**
 * Fallback for a tool the table does not name, keyed on how its name ends.
 *
 * Ordered longest-first so `_user_story` is matched before `_story` would be,
 * and checked only for tools that declare they mutate something — a read is a
 * read whatever it is called.
 */
const SUFFIX_PERMISSIONS: Array<[RegExp, Permission]> = [
  [/_requirements?$/, "requirement:write"],
  [/_user_story$|_stories$|_story$/, "story:write"],
  [/_scenarios?$/, "scenario:write"],
  [/_screens?$/, "screen:write"],
  [/_adrs?$/, "adr:write"],
  [/_components?$/, "component:write"],
  [/_phases?$/, "phase:write"],
  [/_executions?$/, "execution:write"],
  [/_version$/, "version:manage"],
];

export function permissionForMutates(mutates: MutateKind): Permission {
  if (mutates === "progress") return "execution:write";
  // A `spec` tool that named no entity is still a specification edit; requiring
  // the broadest specification permission is the safe reading, and the table
  // above means it is not the one that actually answers for anything real.
  if (mutates === "spec") return "requirement:write";
  return "spec:read";
}

/** The permission a named MCP tool requires. */
export function permissionForTool(toolName: string, mutates: MutateKind): Permission {
  const explicit = TOOL_PERMISSIONS[toolName];
  if (explicit) return explicit;
  if (mutates === undefined) return "spec:read";
  for (const [pattern, permission] of SUFFIX_PERMISSIONS) {
    if (pattern.test(toolName)) return permission;
  }
  return permissionForMutates(mutates);
}

/**
 * REST routes whose permission does not follow from the HTTP method.
 * Matched on `METHOD /path`, with `:param` segments as written in web-api.ts.
 */
const ROUTE_PERMISSIONS: Array<{ method: string; pattern: RegExp; permission: Permission }> = [
  { method: "POST",  pattern: /^\/api\/init$/,                      permission: "project:manage" },
  { method: "PATCH", pattern: /^\/api\/config$/,                    permission: "project:manage" },
  { method: "POST",  pattern: /^\/api\/import$/,                    permission: "project:import" },
  { method: "GET",   pattern: /^\/api\/export$/,                    permission: "project:export" },
  { method: "POST",  pattern: /^\/api\/versions$/,                  permission: "version:manage" },
  { method: "POST",  pattern: /^\/api\/versions\/[^/]+\/lock$/,     permission: "version:manage" },
  { method: "POST",  pattern: /^\/api\/versions\/[^/]+\/unlock$/,   permission: "version:manage" },
  { method: "POST",  pattern: /^\/api\/versions\/[^/]+\/activate$/, permission: "version:manage" },
  { method: "POST",  pattern: /^\/api\/scenarios\/execute$/,        permission: "execution:write" },
  { method: "POST",  pattern: /^\/api\/executions$/,                permission: "execution:write" },
  { method: "GET",   pattern: /^\/api\/audit$/,                     permission: "audit:read" },
  { method: "GET",   pattern: /^\/api\/history$/,                   permission: "history:read" },
  { method: "GET",   pattern: /^\/api\/history\/[^/]+\/[^/]+$/,     permission: "history:read" },
  // Writes to an entity collection need that entity's permission.
  { method: "POST",  pattern: /^\/api\/requirements(\/|$)/,         permission: "requirement:write" },
  { method: "PATCH", pattern: /^\/api\/requirements(\/|$)/,         permission: "requirement:write" },
  { method: "POST",  pattern: /^\/api\/stories(\/|$)/,              permission: "story:write" },
  { method: "PATCH", pattern: /^\/api\/stories(\/|$)/,              permission: "story:write" },
  { method: "POST",  pattern: /^\/api\/scenarios(\/|$)/,            permission: "scenario:write" },
  { method: "PATCH", pattern: /^\/api\/scenarios(\/|$)/,            permission: "scenario:write" },
  { method: "POST",  pattern: /^\/api\/screens(\/|$)/,              permission: "screen:write" },
  { method: "PATCH", pattern: /^\/api\/screens(\/|$)/,              permission: "screen:write" },
  { method: "POST",  pattern: /^\/api\/adrs(\/|$)/,                 permission: "adr:write" },
  { method: "PATCH", pattern: /^\/api\/adrs(\/|$)/,                 permission: "adr:write" },
  { method: "POST",  pattern: /^\/api\/components(\/|$)/,           permission: "component:write" },
  { method: "PATCH", pattern: /^\/api\/components(\/|$)/,           permission: "component:write" },
  { method: "POST",  pattern: /^\/api\/phases(\/|$)/,               permission: "phase:write" },
  { method: "PATCH", pattern: /^\/api\/phases(\/|$)/,               permission: "phase:write" },
  { method: "POST",  pattern: /^\/api\/vcs(\/|$)/,                  permission: "vcs:write" },
  { method: "PATCH", pattern: /^\/api\/vcs(\/|$)/,                  permission: "vcs:write" },
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
 * Reads need `spec:read`; a write needs its entity's permission, falling back to
 * `requirement:write` for a collection the table does not name — the safe
 * reading for an unrecognised write. `/api/auth/*` and the membership and role
 * routes are exempt because they authorise themselves against a scope a blanket
 * check here could not name.
 */
export function permissionForRoute(method: string, pathname: string): Permission | null {
  const m = method.toUpperCase();
  if (isPublicRoute(m, pathname)) return null;
  if (/^\/api\/auth\/tokens(\/|$)/.test(pathname)) return null;
  // Managing your own second factor is part of being signed in, not a
  // permission someone grants you; the handler enforces that it is your own.
  if (/^\/api\/auth\/2fa(\/|$)/.test(pathname)) return null;
  // Membership and role routes authorise themselves against the project named
  // in the URL. A blanket check here could only ask about the project the
  // *request* was authenticated for, which is a different question.
  if (/^\/api\/projects\/[^/]+\/(members|roles)(\/|$)/.test(pathname)) return null;
  if (/^\/api\/roles(\/|$)/.test(pathname)) return null;
  if (/^\/api\/admin\//.test(pathname)) return "admin:users";

  const explicit = ROUTE_PERMISSIONS.find((r) => r.method === m && r.pattern.test(pathname));
  if (explicit) return explicit.permission;

  // The Allure report is a rendering of the project's test results.
  if (/^\/allure(\/|$)/.test(pathname)) return "spec:read";

  return m === "GET" || m === "HEAD" ? "spec:read" : "requirement:write";
}
