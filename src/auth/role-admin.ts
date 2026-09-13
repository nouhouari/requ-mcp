/**
 * Creating, editing and deleting roles.
 *
 * The rule that makes a custom-role catalogue safe to hand to a project
 * administrator is one sentence: **you cannot give away what you do not have.**
 * Without it, "define your project's own roles" is a complete bypass of every
 * other check — a project admin invents a role holding `admin:users`, assigns it
 * to themselves, and is now a server administrator.
 *
 * So every write here is checked permission by permission against what the
 * caller actually holds *in the scope the permission is decided in*: a
 * project-scoped permission against the project being administered, and
 * `admin:users` against the global scope, because being an administrator of one
 * project has never added up to administering the server.
 */

import { principalInScope } from "./authenticate.js";
import {
  isPermission,
  isValidRoleId,
  normalisePermissions,
  PERMISSION_CATALOGUE,
  roleIdFromName,
  type Permission,
  type Principal,
  type Role,
} from "./model.js";
import { ensureSeeded, RoleError, roleFor, type RoleDefinition } from "./role-catalogue.js";
import { authStore } from "./store.js";

const now = (): string => new Date().toISOString();

/** Permissions that are only ever decided in the global scope. */
const GLOBAL_ONLY: ReadonlySet<Permission> = new Set<Permission>(["admin:users"]);

const MAX_NAME = 80;
const MAX_DESCRIPTION = 500;

/**
 * Refuse to hand out a permission the caller does not hold.
 *
 * `projectId` is the scope being administered — null when the role is shared
 * server-wide. The check is made in that scope, which is also the scope the
 * permission will be exercised in, so "can they give this away?" and "can they
 * do it themselves?" are the same question.
 *
 * Global-only permissions are dropped rather than refused when the scope is a
 * project: a project-scoped grant of `admin:users` confers nothing, because that
 * permission is only ever decided globally. Refusing over it would stop a
 * project's administrator from appointing a second one — which is not a
 * privilege escalation, it is the ordinary case.
 */
export async function assertMayGrant(
  principal: Principal,
  permissions: readonly Permission[],
  projectId: string | null,
  what: string,
): Promise<void> {
  const effective =
    projectId === null ? permissions : permissions.filter((p) => !GLOBAL_ONLY.has(p));
  if (effective.length === 0) return;

  let held: ReadonlySet<Permission>;
  try {
    held = (await principalInScope(principal, projectId)).permissions;
  } catch {
    // The account or token went away mid-request; they hold nothing.
    held = new Set<Permission>();
  }

  const missing = effective.filter((p) => !held.has(p));
  if (missing.length === 0) return;
  const where = projectId === null ? "server-wide" : `on project '${projectId}'`;
  throw new RoleError(
    `You cannot ${what}: it would grant ${missing.join(", ")}, which you do not hold ${where}. ` +
      `A role can only ever pass on permissions its author already has.`,
    403,
    "ROLE_ESCALATION",
  );
}

export type RoleInput = {
  id?: string;
  name?: string;
  description?: string;
  permissions?: unknown;
};

/**
 * Refuse to *write down* a permission that a project-scoped role could never
 * exercise.
 *
 * Assigning a shared role that happens to contain one is fine — the part that
 * does not apply is simply inert — but a project writing one into a role of its
 * own is saying something it cannot mean, and a role listing a permission it
 * does not confer is a lie the next reader has to discover for themselves.
 */
function assertScopeable(permissions: readonly Permission[], projectId: string | null): void {
  if (projectId === null) return;
  const global = permissions.filter((p) => GLOBAL_ONLY.has(p));
  if (global.length === 0) return;
  throw new RoleError(
    `${global.join(", ")} ${global.length === 1 ? "is" : "are"} decided server-wide, so ` +
      `a role belonging to project '${projectId}' cannot include ${global.length === 1 ? "it" : "them"}. ` +
      `Ask a server administrator for a shared role instead.`,
    400,
    "ROLE_SCOPE",
  );
}

/** Validate a submitted role body. Throws `RoleError` with a usable message. */
function readDraft(input: RoleInput, fallbackId?: string): {
  id: Role;
  name: string;
  description: string;
  permissions: Permission[];
} {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new RoleError("A role needs a `name`.");
  if (name.length > MAX_NAME) throw new RoleError(`\`name\` must be ${MAX_NAME} characters or fewer.`);

  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (description.length > MAX_DESCRIPTION) {
    throw new RoleError(`\`description\` must be ${MAX_DESCRIPTION} characters or fewer.`);
  }

  const rawId = typeof input.id === "string" && input.id.trim() ? input.id.trim().toLowerCase() : null;
  const id = rawId ?? fallbackId ?? roleIdFromName(name);
  if (!isValidRoleId(id)) {
    throw new RoleError(
      `'${id}' is not a usable role id. Use lower-case letters, digits and hyphens, ` +
        `e.g. 'requirements-analyst'.`,
    );
  }

  if (!Array.isArray(input.permissions)) {
    throw new RoleError("`permissions` must be an array of permission ids.");
  }
  // Unknown ids are refused rather than quietly dropped: a role that silently
  // grants less than it was asked to is worse than one that would not save.
  const unknown = input.permissions
    .filter((p) => typeof p !== "string" || !isPermission(p))
    .map((p) => String(p));
  if (unknown.length > 0) {
    throw new RoleError(
      `Unknown permission${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
        `Known: ${PERMISSION_CATALOGUE.map((p) => p.id).join(", ")}.`,
    );
  }
  const permissions = normalisePermissions(input.permissions as string[]);

  return { id, name, description, permissions };
}

/**
 * Create a role, shared (`projectId: null`) or owned by one project.
 */
export async function createRole(args: {
  principal: Principal;
  projectId: string | null;
  input: RoleInput;
}): Promise<RoleDefinition> {
  await ensureSeeded();
  const { principal, projectId } = args;
  const draft = readDraft(args.input);

  // Only a role defined at the same scope collides: a project *may* define a
  // role that shadows a shared one, which is how "QA means something else here"
  // is expressed.
  const existing = (await authStore().listRoles()).find(
    (r) => r.id === draft.id && r.projectId === projectId,
  );
  if (existing) {
    throw new RoleError(
      `A role with id '${draft.id}' already exists ${projectId === null ? "server-wide" : `on '${projectId}'`}.`,
      409,
      "ROLE_EXISTS",
    );
  }

  assertScopeable(draft.permissions, projectId);
  await assertMayGrant(principal, draft.permissions, projectId, `create the role '${draft.name}'`);

  const role: RoleDefinition = {
    ...draft,
    projectId,
    builtIn: false,
    createdAt: now(),
    updatedAt: now(),
    createdBy: principal.userId,
  };
  await authStore().putRole(role);
  return role;
}

/**
 * Edit a role.
 *
 * A built-in role can be edited — a team's idea of what QA may do is theirs —
 * but keeps its id, its scope and its built-in flag, because grants, tokens and
 * `REQU_LDAP_ROLE_MAP` entries point at it by id.
 */
export async function updateRole(args: {
  principal: Principal;
  projectId: string | null;
  id: Role;
  input: RoleInput;
}): Promise<RoleDefinition> {
  await ensureSeeded();
  const { principal, projectId, id } = args;
  const existing = (await authStore().listRoles()).find(
    (r) => r.id === id && r.projectId === projectId,
  );
  if (!existing) {
    throw new RoleError(
      `No role '${id}' is defined ${projectId === null ? "server-wide" : `on project '${projectId}'`}.`,
      404,
      "ROLE_NOT_FOUND",
    );
  }

  const draft = readDraft(args.input, existing.id);
  if (draft.id !== existing.id) {
    throw new RoleError(
      "A role's id cannot change — grants and tokens point at it. Create a new role instead.",
      400,
      "ROLE_ID_IMMUTABLE",
    );
  }

  // Only the permissions being *added* need to be held: an administrator whose
  // own rights have since been narrowed must still be able to take permissions
  // away from a role, and to rename it.
  assertScopeable(draft.permissions, projectId);
  const added = draft.permissions.filter((p) => !existing.permissions.includes(p));
  await assertMayGrant(principal, added, projectId, `add those permissions to '${existing.name}'`);

  const role: RoleDefinition = {
    ...existing,
    name: draft.name,
    description: draft.description,
    permissions: draft.permissions,
    updatedAt: now(),
  };
  await authStore().putRole(role);
  return role;
}

/** Everyone currently holding a role, at the scope it is defined for. */
export async function grantsOf(id: Role, projectId: string | null): Promise<string[]> {
  const bindings = await authStore().listBindings();
  return bindings
    .filter((b) => b.role === id && (projectId === null || b.projectId === projectId))
    .map((b) => b.userId);
}

/**
 * Delete a role.
 *
 * Built-in roles stay: removing `viewer` would make every grant and every group
 * mapping that names it mean nothing, with no way to tell that from a typo. A
 * role that people still hold is refused unless the caller says to go ahead, in
 * which case their grants are revoked rather than left pointing at nothing.
 */
export async function deleteRole(args: {
  principal: Principal;
  projectId: string | null;
  id: Role;
  force: boolean;
}): Promise<{ deleted: boolean; revoked: string[] }> {
  await ensureSeeded();
  const { projectId, id, force } = args;
  const existing = (await authStore().listRoles()).find(
    (r) => r.id === id && r.projectId === projectId,
  );
  if (!existing) {
    throw new RoleError(
      `No role '${id}' is defined ${projectId === null ? "server-wide" : `on project '${projectId}'`}.`,
      404,
      "ROLE_NOT_FOUND",
    );
  }
  if (existing.builtIn) {
    throw new RoleError(
      `'${existing.name}' is a built-in role and cannot be deleted. You can change what it grants instead.`,
      400,
      "ROLE_BUILT_IN",
    );
  }

  // Deleting a role you could not have created would be a way to check what it
  // granted against what you hold, so the same rule applies.
  await assertMayGrant(
    args.principal,
    existing.permissions,
    projectId,
    `delete the role '${existing.name}'`,
  );

  const holders = await grantsOf(id, projectId);
  if (holders.length > 0 && !force) {
    throw new RoleError(
      `'${existing.name}' is still granted to ${holders.length} ` +
        `${holders.length === 1 ? "person" : "people"} (${holders.slice(0, 5).join(", ")}` +
        `${holders.length > 5 ? ", …" : ""}). Delete it with \`force\` to revoke those grants too.`,
      409,
      "ROLE_IN_USE",
    );
  }

  const revoked: string[] = [];
  for (const userId of holders) {
    const bindings = (await authStore().listBindings(userId)).filter((b) => b.role === id);
    for (const b of bindings) {
      if (projectId !== null && b.projectId !== projectId) continue;
      if (await authStore().revokeRole(userId, b.projectId, id)) revoked.push(userId);
    }
  }
  const deleted = await authStore().deleteRole(id, projectId);
  return { deleted, revoked };
}

/** A role with the grants that reference it, for the role editor's list. */
export async function roleWithUsage(
  id: Role,
  projectId: string | null,
): Promise<(RoleDefinition & { grants: number }) | null> {
  const role = await roleFor(id, projectId);
  if (!role) return null;
  return { ...role, grants: (await grantsOf(id, role.projectId)).length };
}
