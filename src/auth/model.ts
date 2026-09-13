/**
 * Roles, permissions and the principal that carries them.
 *
 * The permission set is deliberately small and phrased in terms of *what the
 * data is* (specification vs. delivery progress) rather than which tool or
 * route touches it, so one grant covers the MCP tool and the REST endpoint that
 * do the same thing.
 */

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export const PERMISSIONS = [
  /** Read specifications, coverage, screens, ADRs — everything the dashboard shows. */
  "spec:read",
  /** Create or edit specification entities: requirements, stories, screens, ADRs, components. */
  "spec:write",
  /** Record delivery progress: executions, scenario results, VCS refs. */
  "progress:write",
  /** Create, lock, unlock and activate specification versions. */
  "version:manage",
  /** Create a project, or edit its configuration and brief. */
  "project:manage",
  /** Export a project's data. */
  "project:export",
  /** Import data into a project — overwrites whatever is there. */
  "project:import",
  /** Read the change history of a single entity (the Jira-style "what changed" panel). */
  "history:read",
  /** Read the server-wide audit log, including denied attempts. */
  "audit:read",
  /** Grant and revoke roles, and revoke other users' tokens. */
  "admin:users",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(x: string): x is Permission {
  return (PERMISSIONS as readonly string[]).includes(x);
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const ROLES = ["viewer", "contributor", "maintainer", "admin"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(x: string): x is Role {
  return (ROLES as readonly string[]).includes(x);
}

/**
 * What each role may do. Roles are cumulative in practice but written out in
 * full: an explicit matrix is easier to audit than a chain of inheritances, and
 * it makes an accidental grant visible in review.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: ["spec:read", "history:read", "project:export"],
  contributor: ["spec:read", "history:read", "project:export", "progress:write"],
  maintainer: [
    "spec:read",
    "history:read",
    "project:export",
    "progress:write",
    "spec:write",
    "version:manage",
    "project:import",
    "project:manage",
    "audit:read",
  ],
  admin: [...PERMISSIONS],
};

/** Rank, so "the highest role wins" comparisons and token ceilings are total. */
export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  contributor: 1,
  maintainer: 2,
  admin: 3,
};

/** The strongest of the given roles, or null when there are none. */
export function highestRole(roles: readonly Role[]): Role | null {
  let best: Role | null = null;
  for (const r of roles) if (best === null || ROLE_RANK[r] > ROLE_RANK[best]) best = r;
  return best;
}

/** Union of the permissions carried by a set of roles. */
export function permissionsFor(roles: readonly Role[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r] ?? []) out.add(p);
  return out;
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
 * `roles` are already resolved for the project in question, so a permission
 * check never has to reach back into the directory or the database.
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
    permissions: permissionsFor(["admin"]),
    groups: [],
  };
}

export function buildPrincipal(
  base: Omit<Principal, "permissions" | "roles"> & { roles: Role[] },
): Principal {
  return { ...base, permissions: permissionsFor(base.roles) };
}

export function can(principal: Principal, permission: Permission): boolean {
  return principal.permissions.has(permission);
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
