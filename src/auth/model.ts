/**
 * Permissions, and the principal that carries them.
 *
 * A permission names one kind of change to one kind of thing. They are split by
 * entity rather than by tool, so one grant covers the MCP tool and the REST
 * endpoint that do the same work — and, more importantly, so a role can mean
 * something in the language of the team: a QA engineer owns scenarios and test
 * results without being able to rewrite the requirements they are testing, and
 * an analyst owns the requirements without being able to mark them as passing.
 *
 * Roles themselves are *not* defined here. They are records in the role
 * catalogue (see `role-catalogue.ts`), each a named set of these permissions, so
 * a team can describe the jobs it actually has — product owner, requirements
 * analyst, QA — instead of the four this file used to hard-code.
 */

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * The grouping is presentational — it drives the role editor's layout and the
 * documentation table — but it is kept beside the permissions so a new one
 * cannot be added without deciding where a person would look for it.
 */
export const PERMISSION_GROUPS = [
  { id: "read", label: "Reading" },
  { id: "specification", label: "Specification" },
  { id: "delivery", label: "Delivery progress" },
  { id: "lifecycle", label: "Project lifecycle" },
  { id: "administration", label: "Administration" },
] as const;

export type PermissionGroup = (typeof PERMISSION_GROUPS)[number]["id"];

export type PermissionInfo = {
  id: string;
  group: PermissionGroup;
  /** Short label for the role editor. */
  label: string;
  /** What holding it actually lets someone do. */
  description: string;
};

export const PERMISSION_CATALOGUE = [
  // --- reading ---
  {
    id: "spec:read",
    group: "read",
    label: "Read the project",
    description: "See requirements, stories, screens, scenarios, coverage and decisions.",
  },
  {
    id: "history:read",
    group: "read",
    label: "Read change history",
    description: "See what changed on a requirement, story or scenario, and who changed it.",
  },
  {
    id: "audit:read",
    group: "read",
    label: "Read the audit log",
    description: "See every action taken on the server, including the ones that were refused.",
  },

  // --- specification ---
  {
    id: "requirement:write",
    group: "specification",
    label: "Edit requirements",
    description: "Create, change and remove requirements, and assign them to phases.",
  },
  {
    id: "story:write",
    group: "specification",
    label: "Edit user stories",
    description: "Create and change user stories and their acceptance criteria.",
  },
  {
    id: "scenario:write",
    group: "specification",
    label: "Edit test scenarios",
    description: "Write and import the cucumber scenarios that verify a story.",
  },
  {
    id: "screen:write",
    group: "specification",
    label: "Edit screens",
    description: "Create and change UI specifications, and link them to stories.",
  },
  {
    id: "adr:write",
    group: "specification",
    label: "Edit architecture decisions",
    description: "Record and supersede architecture decision records.",
  },
  {
    id: "component:write",
    group: "specification",
    label: "Edit components",
    description: "Maintain the component breakdown requirements are grouped by.",
  },
  {
    id: "phase:write",
    group: "specification",
    label: "Edit phases",
    description: "Create phases and choose which one is active.",
  },

  // --- delivery progress ---
  {
    id: "execution:write",
    group: "delivery",
    label: "Record test results",
    description: "Record scenario runs by hand or by importing a cucumber report.",
  },
  {
    id: "vcs:write",
    group: "delivery",
    label: "Link branches and merge requests",
    description: "Attach VCS references to stories and requirements.",
  },

  // --- project lifecycle ---
  {
    id: "version:manage",
    group: "lifecycle",
    label: "Manage specification versions",
    description: "Create, lock, unlock and activate specification baselines.",
  },
  {
    id: "project:manage",
    group: "lifecycle",
    label: "Manage the project",
    description: "Create a project and edit its configuration and brief.",
  },
  {
    id: "project:export",
    group: "lifecycle",
    label: "Export data",
    description: "Take a full export of the project's data.",
  },
  {
    id: "project:import",
    group: "lifecycle",
    label: "Import data",
    description: "Import data over the project — this overwrites what is there.",
  },

  // --- administration ---
  {
    id: "project:members",
    group: "administration",
    label: "Manage members and roles",
    description:
      "Decide who can reach this project and with which role, and define the project's own roles. " +
      "Always checked against the project being administered, never server-wide.",
  },
  {
    id: "admin:users",
    group: "administration",
    label: "Administer the server",
    description:
      "Grants that apply to every project, shared roles, disabling accounts, and everyone's tokens. " +
      "Always checked in the global scope, so being an admin of one project never adds up to this.",
  },
] as const satisfies readonly PermissionInfo[];

export const PERMISSIONS = PERMISSION_CATALOGUE.map((p) => p.id) as unknown as readonly Permission[];

export type Permission = (typeof PERMISSION_CATALOGUE)[number]["id"];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSION_CATALOGUE.map((p) => p.id));

export function isPermission(x: string): x is Permission {
  return PERMISSION_SET.has(x);
}

/** Keep only the recognised permissions, de-duplicated and in catalogue order. */
export function normalisePermissions(input: readonly string[]): Permission[] {
  const wanted = new Set(input);
  return PERMISSION_CATALOGUE.filter((p) => wanted.has(p.id)).map((p) => p.id);
}

export function permissionInfo(id: Permission): PermissionInfo {
  return PERMISSION_CATALOGUE.find((p) => p.id === id)!;
}

/**
 * Every specification-editing permission.
 *
 * Used where a check means "may they change the specification at all" rather
 * than one entity in particular — the members panel's summary, for instance.
 */
export const SPEC_WRITE_PERMISSIONS: readonly Permission[] = PERMISSION_CATALOGUE.filter(
  (p) => p.group === "specification",
).map((p) => p.id);

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * A role is referred to by id. What it grants lives in the catalogue, so this is
 * deliberately just a string: a deployment's roles are its own business.
 */
export type Role = string;

/** Ids are used in URLs, config and the group map, so keep them plain. */
export const ROLE_ID_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

export function isValidRoleId(id: string): boolean {
  return ROLE_ID_RE.test(id);
}

/** Turn a human name into a usable id: "Requirements Analyst" → "requirements-analyst". */
export function roleIdFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

/** How the caller proved who they are. */
export type PrincipalKind =
  /** Auth is disabled — a development stand-in with full rights. */
  | "anonymous"
  /** A dashboard session cookie. */
  | "session"
  /** A personal access token, used by an MCP client. */
  | "token";

/**
 * The authenticated caller of one request.
 *
 * `permissions` are already resolved for the project in question, so a check
 * never has to reach back into the directory, the catalogue or the database.
 */
export type Principal = {
  kind: PrincipalKind;
  /** Stable user id; `dev` when auth is disabled. */
  userId: string;
  /** Login name as the directory knows it. */
  username: string;
  displayName: string;
  email: string | null;
  roles: Role[];
  permissions: Set<Permission>;
  /** Directory groups, kept for the audit trail and for re-resolving roles. */
  groups: string[];
  /** Set when `kind === "token"` — which token was presented. */
  tokenId?: string;
  tokenName?: string;
  /**
   * The token's ceiling role, when it has one.
   *
   * `roles` stays as assigned so "why can I do this?" is still answerable; this
   * says why the permission set is smaller than those roles would suggest.
   */
  cappedTo?: Role | null;
  /** Set when `kind === "session"`. */
  sessionId?: string;
};

/** The stand-in principal used when authentication is switched off. */
export function devPrincipal(): Principal {
  return {
    kind: "anonymous",
    userId: "dev",
    username: "dev",
    displayName: "Development (auth disabled)",
    email: null,
    roles: ["admin"],
    permissions: new Set(PERMISSION_CATALOGUE.map((p) => p.id)),
    groups: [],
  };
}

export function buildPrincipal(
  base: Omit<Principal, "permissions"> & { permissions: Iterable<Permission> },
): Principal {
  return { ...base, permissions: new Set(base.permissions) };
}

export function can(principal: Principal, permission: Permission): boolean {
  return principal.permissions.has(permission);
}

/** True when the caller holds at least one of the permissions. */
export function canAny(principal: Principal, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => principal.permissions.has(p));
}

/** Error thrown when a caller is authenticated but lacks a permission. */
export class ForbiddenError extends Error {
  readonly permission: Permission;
  constructor(permission: Permission, what?: string) {
    super(
      `Permission denied: '${permission}' is required${what ? ` to ${what}` : ""}. ` +
        `Ask an administrator to grant you a role that includes it.`,
    );
    this.name = "ForbiddenError";
    this.permission = permission;
  }
}

/** Error thrown when a caller presented no, or invalid, credentials. */
export class UnauthorizedError extends Error {
  constructor(message = "Authentication required.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export function requirePermission(
  principal: Principal,
  permission: Permission,
  what?: string,
): void {
  if (!can(principal, permission)) throw new ForbiddenError(permission, what);
}
