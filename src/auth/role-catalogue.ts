/**
 * The role catalogue.
 *
 * A role is a named set of permissions. Which roles exist is a property of the
 * deployment, not of this code: a team that works in product owners,
 * requirements analysts and QA engineers should be able to say so, rather than
 * translating those jobs into a fixed ladder of viewer/contributor/maintainer.
 *
 * Two scopes:
 *  - **shared** (`projectId: null`) — defined once for the server and assignable
 *    on any project. "QA" means the same thing everywhere, and editing it fixes
 *    every project at once.
 *  - **project** (`projectId: "checkout"`) — owned by one project, for the roles
 *    that genuinely only make sense there.
 *
 * The presets below are seeded on first boot and marked `builtIn`. They can be
 * edited — a team's idea of what QA may do is theirs — but not deleted, because
 * existing grants and `REQU_LDAP_ROLE_MAP` entries point at them.
 */

import { normalisePermissions, type Permission, type Role } from "./model.js";
import { authStore } from "./store.js";
import type { AuthConfig } from "./config.js";

export type RoleDefinition = {
  id: Role;
  name: string;
  description: string;
  permissions: Permission[];
  /** Null for a shared role; a project id for one owned by that project. */
  projectId: string | null;
  /** Seeded by requ. Editable, but not removable. */
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
};

/** A role as it is defined, before the store fills in its bookkeeping. */
export type RoleDraft = {
  id: Role;
  name: string;
  description: string;
  permissions: Permission[];
  projectId: string | null;
};

const READS: Permission[] = ["spec:read", "history:read"];

/**
 * The roles every deployment starts with.
 *
 * The first four keep the names the previous fixed ladder used, so existing
 * grants, tokens and `REQU_LDAP_ROLE_MAP` entries keep meaning what they meant.
 * The rest describe the jobs a requirements team actually has.
 */
export const PRESET_ROLES: readonly Omit<RoleDraft, "projectId">[] = [
  {
    id: "viewer",
    name: "Viewer",
    description: "Reads the specification and its history. Changes nothing.",
    permissions: [...READS, "project:export"],
  },
  {
    id: "contributor",
    name: "Contributor",
    description: "Reads everything and reports delivery progress, but does not change scope.",
    permissions: [...READS, "project:export", "execution:write", "vcs:write"],
  },
  {
    id: "maintainer",
    name: "Maintainer",
    description: "Edits the whole specification and manages versions.",
    permissions: [
      ...READS, "project:export", "audit:read",
      "requirement:write", "story:write", "scenario:write", "screen:write", "adr:write",
      "component:write", "phase:write",
      "execution:write", "vcs:write",
      "version:manage", "project:manage", "project:import",
    ],
  },
  {
    id: "admin",
    name: "Administrator",
    description: "Everything, including who may reach the project and the server's own settings.",
    permissions: [
      ...READS, "audit:read", "project:export", "project:import",
      "requirement:write", "story:write", "scenario:write", "screen:write", "adr:write",
      "component:write", "phase:write",
      "execution:write", "vcs:write",
      "version:manage", "project:manage",
      "project:members", "admin:users",
    ],
  },
  {
    id: "product-owner",
    name: "Product Owner",
    description:
      "Owns scope and release planning: requirements, stories, phases and the version baselines. " +
      "Does not write tests or record their results.",
    permissions: [
      ...READS, "project:export", "audit:read",
      "requirement:write", "story:write", "phase:write", "component:write", "adr:write",
      "version:manage",
    ],
  },
  {
    id: "requirements-analyst",
    name: "Requirements Analyst",
    description:
      "Writes the specification — requirements, stories, screens and decisions — but does not " +
      "freeze a baseline or report on delivery.",
    permissions: [
      ...READS, "project:export",
      "requirement:write", "story:write", "screen:write", "adr:write", "component:write",
    ],
  },
  {
    id: "qa",
    name: "QA Engineer",
    description:
      "Owns verification: writes the scenarios and records their results. Reads the requirements " +
      "being tested without being able to rewrite them.",
    permissions: [...READS, "project:export", "scenario:write", "execution:write"],
  },
  {
    id: "developer",
    name: "Developer",
    description:
      "Implements the stories: writes scenarios, records runs, and links branches and merge requests.",
    permissions: [...READS, "project:export", "scenario:write", "execution:write", "vcs:write"],
  },
];

export class RoleError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = "ROLE_ERROR") {
    super(message);
    this.name = "RoleError";
    this.status = status;
    this.code = code;
  }
}

const now = (): string => new Date().toISOString();

let seeded: Promise<void> | null = null;

/** Write the presets on first use. Idempotent; never overwrites an edited role. */
export function ensureSeeded(): Promise<void> {
  seeded ??= (async () => {
    const store = authStore();
    const existing = new Set((await store.listRoles()).map((r) => roleKey(r.id, r.projectId)));
    for (const preset of PRESET_ROLES) {
      if (existing.has(roleKey(preset.id, null))) continue;
      await store.putRole({
        ...preset,
        permissions: normalisePermissions(preset.permissions),
        projectId: null,
        builtIn: true,
        createdAt: now(),
        updatedAt: now(),
        createdBy: null,
      });
    }
  })().catch((e) => {
    // A failed seed must not be cached, or the catalogue stays empty for the
    // life of the process and every role resolves to nothing.
    seeded = null;
    throw e;
  });
  return seeded;
}

/** For tests, which swap the store underneath. */
export function resetSeed(): void {
  seeded = null;
}

export function roleKey(id: Role, projectId: string | null): string {
  return `${projectId ?? "*"}/${id}`;
}

/**
 * Every role assignable on a project: the shared ones, plus the project's own.
 *
 * A project-scoped role shadows a shared role of the same id, so a project can
 * say "QA means something else here" without renaming anything.
 */
export async function rolesFor(projectId: string | null): Promise<RoleDefinition[]> {
  await ensureSeeded();
  const all = await authStore().listRoles();
  const shared = all.filter((r) => r.projectId === null);
  const own = projectId === null ? [] : all.filter((r) => r.projectId === projectId);
  const byId = new Map<string, RoleDefinition>();
  for (const r of shared) byId.set(r.id, r);
  for (const r of own) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One role as it applies on a project, or null when no such role exists there. */
export async function roleFor(id: Role, projectId: string | null): Promise<RoleDefinition | null> {
  const roles = await rolesFor(projectId);
  return roles.find((r) => r.id === id) ?? null;
}

/**
 * The permissions a set of role ids grants on a project.
 *
 * An unknown id contributes nothing rather than throwing: a role deleted while
 * someone held it should cost them that access, not break every request they
 * make.
 */
export async function permissionsForRoles(
  roleIds: readonly Role[],
  projectId: string | null,
): Promise<Set<Permission>> {
  if (roleIds.length === 0) return new Set();
  const roles = await rolesFor(projectId);
  const byId = new Map(roles.map((r) => [r.id, r]));
  const out = new Set<Permission>();
  for (const id of roleIds) {
    for (const p of byId.get(id)?.permissions ?? []) out.add(p);
  }
  return out;
}

/** Does this role id exist, shared or on the project? */
export async function roleExists(id: Role, projectId: string | null): Promise<boolean> {
  return (await roleFor(id, projectId)) !== null;
}

/**
 * Configured role ids that name no role, reported once at startup.
 *
 * `REQU_LDAP_ROLE_MAP`, `REQU_AUTH_DEFAULT_ROLE` and `REQU_2FA_REQUIRED_ROLES`
 * are read before the database is necessarily reachable, so `config.ts` can only
 * check that an id is well formed. This closes the gap once the catalogue is
 * there. It is a warning rather than a failure because a deployment may define
 * its roles after configuring the directory map — but it must be said out loud,
 * since a typo here grants nothing and looks from the inside exactly like a
 * permissions bug.
 */
export async function warnUnknownConfiguredRoles(
  cfg: AuthConfig,
  log: (message: string) => void = console.error,
): Promise<string[]> {
  const configured = new Map<string, string[]>();
  const note = (role: Role, where: string): void => {
    configured.set(role, [...(configured.get(role) ?? []), where]);
  };
  for (const [group, role] of cfg.roleMap) note(role, `REQU_LDAP_ROLE_MAP (${group})`);
  if (cfg.defaultRole) note(cfg.defaultRole, "REQU_AUTH_DEFAULT_ROLE");
  for (const role of cfg.twoFactorRequiredRoles) note(role, "REQU_2FA_REQUIRED_ROLES");
  if (configured.size === 0) return [];

  const known = new Set((await rolesFor(null)).map((r) => r.id));
  const unknown = [...configured.keys()].filter((r) => !known.has(r)).sort();
  for (const role of unknown) {
    log(
      `requ-mcp: warning — role '${role}' is configured in ${configured.get(role)!.join(", ")} ` +
        `but no such shared role exists; it grants nothing. Known: ${[...known].sort().join(", ")}.`,
    );
  }
  return unknown;
}
