/**
 * Resolving a user's effective roles for one project.
 *
 * Three sources, unioned:
 *   1. `REQU_AUTH_ADMINS` — usernames that are always admin, so a fresh install
 *      has a way in before anyone can grant anything.
 *   2. `REQU_LDAP_ROLE_MAP` — directory group → role. The directory stays the
 *      source of truth for who is on the team.
 *   3. `auth_role_bindings` — grants made in requ itself, either globally (`*`)
 *      or on one project, for the cases the directory cannot express.
 *
 * A user matched by none of them gets `REQU_AUTH_DEFAULT_ROLE` (viewer by
 * default), or is refused entirely when that is set to `none`.
 *
 * What each role *grants* is not decided here — that is the catalogue's job, so
 * a deployment can define its own roles. This module only answers "which role
 * names apply to this person, on this project, and why".
 */

import { rdnValue } from "./ldap.js";
import { permissionsForRoles } from "./role-catalogue.js";
import type { Permission, Role } from "./model.js";
import type { AuthConfig } from "./config.js";
import type { RoleBinding } from "./types.js";

/** Grant on every project. */
export const ALL_PROJECTS = "*";

/**
 * Roles a set of directory groups maps to. Both the full DN and its RDN value
 * are matched, so `REQU_LDAP_ROLE_MAP` may be written either way.
 */
export function rolesFromGroups(groups: readonly string[], map: Map<string, Role>): Role[] {
  if (map.size === 0) return [];
  const out = new Set<Role>();
  for (const g of groups) {
    const lower = g.toLowerCase();
    const direct = map.get(lower);
    if (direct) out.add(direct);
    const rdn = rdnValue(g);
    if (rdn) {
      const byRdn = map.get(rdn.toLowerCase());
      if (byRdn) out.add(byRdn);
    }
  }
  return [...out];
}

export type RoleResolution = {
  roles: Role[];
  /** Where each role came from, for the "why can I do this?" question. */
  sources: Array<{ role: Role; source: "bootstrap" | "group" | "binding" | "default" }>;
};

/**
 * Effective roles for `username` on `projectId`.
 *
 * `projectId` is the project key. Pass `null` for a decision that is not about
 * one project (listing projects, managing your own tokens): only global grants
 * count then.
 */
export function resolveRoles(args: {
  cfg: AuthConfig;
  username: string;
  groups: readonly string[];
  bindings: readonly RoleBinding[];
  projectId: string | null;
}): RoleResolution {
  const { cfg, username, groups, bindings, projectId } = args;
  const sources: RoleResolution["sources"] = [];
  const roles = new Set<Role>();

  if (cfg.bootstrapAdmins.includes(username.toLowerCase())) {
    roles.add("admin");
    sources.push({ role: "admin", source: "bootstrap" });
  }

  for (const r of rolesFromGroups(groups, cfg.roleMap)) {
    roles.add(r);
    sources.push({ role: r, source: "group" });
  }

  for (const b of bindings) {
    const applies = b.projectId === ALL_PROJECTS || (projectId !== null && b.projectId === projectId);
    if (!applies) continue;
    roles.add(b.role);
    sources.push({ role: b.role, source: "binding" });
  }

  if (roles.size === 0 && cfg.defaultRole) {
    roles.add(cfg.defaultRole);
    sources.push({ role: cfg.defaultRole, source: "default" });
  }

  return { roles: [...roles], sources };
}

/**
 * The permissions a role set grants, capped by a ceiling role.
 *
 * Capping is an intersection, not a comparison. When roles were a fixed ladder a
 * ceiling could be "anything at or below maintainer"; a catalogue of custom
 * roles has no total order — is "QA" above or below "Requirements Analyst"? —
 * so a capped token gets exactly the permissions both its owner and the ceiling
 * role hold. That keeps the guarantee that matters: a token can never do more
 * than its owner, nor more than the role it was capped to.
 */
export async function effectivePermissions(args: {
  roles: readonly Role[];
  projectId: string | null;
  ceiling: Role | null;
}): Promise<Set<Permission>> {
  const granted = await permissionsForRoles(args.roles, args.projectId);
  if (!args.ceiling) return granted;
  const allowed = await permissionsForRoles([args.ceiling], args.projectId);
  const out = new Set<Permission>();
  for (const p of granted) if (allowed.has(p)) out.add(p);
  return out;
}
