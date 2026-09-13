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
 */

import { rdnValue } from "./ldap.js";
import { ROLE_RANK, type Role } from "./model.js";
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
 * Cap a role set at `ceiling`, dropping anything stronger.
 *
 * A token may be issued weaker than its owner — "read-only token for CI" — and
 * must stay weaker even if the owner is later promoted. Roles at or below the
 * ceiling are kept as they are; a user with no role at or below it gets the
 * ceiling itself only when they hold something stronger, so a viewer issuing a
 * maintainer-capped token still ends up a viewer.
 */
export function capRoles(roles: readonly Role[], ceiling: Role | null): Role[] {
  if (!ceiling) return [...roles];
  const limit = ROLE_RANK[ceiling];
  const kept = roles.filter((r) => ROLE_RANK[r] <= limit);
  const hasStronger = roles.some((r) => ROLE_RANK[r] > limit);
  if (hasStronger && !kept.includes(ceiling)) kept.push(ceiling);
  return kept;
}
