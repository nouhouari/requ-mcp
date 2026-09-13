/**
 * Project membership.
 *
 * "Who can reach this project, and with what role?" is a different question
 * from "who has an account?", because a role can arrive three ways: from a
 * directory group, from a grant that applies to every project, or from a grant
 * made on this project alone. A membership list that showed only the last of
 * those would be quietly wrong — it would omit the people who actually have
 * access — so each member carries the origin of their role.
 *
 * Only the third kind is editable here. The other two are decided by the
 * directory and by server administrators, and the UI says so rather than
 * offering a remove button that could not work.
 */

import { authConfig } from "./config.js";
import { highestRole, isRole, ROLE_RANK, type Role } from "./model.js";
import { ALL_PROJECTS, resolveRoles } from "./roles.js";
import { authStore } from "./store.js";
import type { AuthUser, RoleBinding } from "./types.js";

const now = (): string => new Date().toISOString();

/** Where a member's role came from, in the order the UI should explain it. */
export type MemberSource = "bootstrap" | "group" | "global" | "project" | "default";

export type ProjectMember = {
  userId: string;
  username: string;
  displayName: string;
  email: string | null;
  disabled: boolean;
  /** Null until they sign in for the first time. */
  lastLoginAt: string | null;
  /** True when they were added here but have never signed in. */
  invited: boolean;
  /** Every role that applies to them on this project. */
  roles: Role[];
  /** The strongest of them — what the UI shows as "their role". */
  effectiveRole: Role | null;
  /** The role granted on this project specifically, if any. Editable. */
  projectRole: Role | null;
  /** Roles that reach this project from elsewhere, and where from. */
  inherited: Array<{ role: Role; source: MemberSource }>;
  /** False when the member's access comes entirely from elsewhere. */
  removable: boolean;
};

export class MemberError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "MemberError";
    this.status = status;
  }
}

function inheritedFor(bindings: RoleBinding[], groupRoles: Role[], isBootstrap: boolean, defaultRole: Role | null):
  Array<{ role: Role; source: MemberSource }> {
  const out: Array<{ role: Role; source: MemberSource }> = [];
  if (isBootstrap) out.push({ role: "admin", source: "bootstrap" });
  for (const r of groupRoles) out.push({ role: r, source: "group" });
  for (const b of bindings) {
    if (b.projectId === ALL_PROJECTS) out.push({ role: b.role, source: "global" });
  }
  if (out.length === 0 && defaultRole) out.push({ role: defaultRole, source: "default" });
  return out;
}

/**
 * Everyone who can reach `projectId`.
 *
 * Users whose only role would be the server-wide default are included only when
 * a default role is configured — because then everyone with an account really
 * can reach every project, and a list that hid that would misrepresent access.
 */
export async function listProjectMembers(projectId: string): Promise<ProjectMember[]> {
  const cfg = authConfig();
  const store = authStore();
  const [users, allBindings] = await Promise.all([store.listUsers(), store.listBindings()]);

  // Someone can hold a grant before they have ever signed in, so the member list
  // is the union of accounts and the people named in bindings.
  const byUser = new Map<string, AuthUser>(users.map((u) => [u.id, u]));
  for (const b of allBindings) {
    if (byUser.has(b.userId)) continue;
    if (b.projectId !== projectId && b.projectId !== ALL_PROJECTS) continue;
    byUser.set(b.userId, {
      id: b.userId,
      username: b.userId,
      displayName: b.userId,
      email: null,
      dn: null,
      groups: [],
      disabled: false,
      createdAt: b.grantedAt,
      lastLoginAt: null,
    });
  }

  const members: ProjectMember[] = [];
  for (const user of byUser.values()) {
    const bindings = allBindings.filter((b) => b.userId === user.id);
    const { roles, sources } = resolveRoles({
      cfg,
      username: user.username,
      groups: user.groups,
      bindings,
      projectId,
    });
    if (roles.length === 0) continue;

    const projectBindings = bindings.filter((b) => b.projectId === projectId);
    const projectRole = highestRole(projectBindings.map((b) => b.role));
    const groupRoles = sources.filter((s) => s.source === "group").map((s) => s.role);
    const isBootstrap = sources.some((s) => s.source === "bootstrap");
    const inherited = inheritedFor(bindings, groupRoles, isBootstrap, cfg.defaultRole);

    members.push({
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      disabled: user.disabled,
      lastLoginAt: user.lastLoginAt,
      invited: user.lastLoginAt === null,
      roles,
      effectiveRole: highestRole(roles),
      projectRole,
      inherited,
      removable: projectBindings.length > 0,
    });
  }

  members.sort((a, b) => {
    const rank = (m: ProjectMember) => (m.effectiveRole ? ROLE_RANK[m.effectiveRole] : -1);
    return rank(b) - rank(a) || a.username.localeCompare(b.username);
  });
  return members;
}

/**
 * Give someone a role on a project.
 *
 * The username is taken as typed and canonicalised the same way a sign-in would
 * be, so a member can be added *before* they have ever signed in — which is the
 * normal case when a team is being set up. A placeholder account is recorded so
 * they appear in the list as invited; their first sign-in fills in the real
 * name, mail and groups from the directory.
 */
export async function addProjectMember(args: {
  projectId: string;
  username: string;
  role: string;
  grantedBy: string;
}): Promise<ProjectMember> {
  const { projectId, grantedBy } = args;
  const username = args.username.trim();
  if (!username) throw new MemberError("A username is required.");
  if (!isRole(args.role)) {
    throw new MemberError(`Unknown role '${args.role}'. Known: viewer, contributor, maintainer, admin.`);
  }
  const role = args.role;
  const userId = username.toLowerCase();

  const store = authStore();
  const existing = await store.getUser(userId);
  if (!existing) {
    await store.upsertUser({
      id: userId,
      username,
      displayName: username,
      email: null,
      dn: null,
      groups: [],
      disabled: false,
    });
  }

  // One role per user per project: adding a second would leave the first in
  // place and silently keep the stronger of the two, which is not what "change
  // their role to viewer" means.
  const bindings = await store.listBindings(userId);
  for (const b of bindings) {
    if (b.projectId === projectId && b.role !== role) {
      await store.revokeRole(userId, projectId, b.role);
    }
  }
  await store.grantRole({ userId, projectId, role, grantedBy, grantedAt: now() });

  const members = await listProjectMembers(projectId);
  const member = members.find((m) => m.userId === userId);
  if (!member) throw new MemberError("The member was added but could not be read back.", 500);
  return member;
}

/**
 * Take away the role granted on this project.
 *
 * Access inherited from a directory group or a server-wide grant is untouched —
 * it is not this project's to remove — so the result says whether the person can
 * still reach the project afterwards.
 */
export async function removeProjectMember(args: {
  projectId: string;
  userId: string;
  actorId: string;
}): Promise<{ removed: boolean; stillHasAccess: boolean; remainingRoles: Role[] }> {
  const { projectId, userId } = args;
  const store = authStore();
  const bindings = (await store.listBindings(userId)).filter((b) => b.projectId === projectId);
  let removed = false;
  for (const b of bindings) {
    if (await store.revokeRole(userId, projectId, b.role)) removed = true;
  }

  const members = await listProjectMembers(projectId);
  const still = members.find((m) => m.userId === userId);
  return {
    removed,
    stillHasAccess: Boolean(still),
    remainingRoles: still?.roles ?? [],
  };
}
