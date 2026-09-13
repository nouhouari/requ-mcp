/**
 * Turning a request into a `Principal`.
 *
 * Three ways in, in the order they are tried:
 *   1. auth disabled → the development principal, full rights, no lookup;
 *   2. `Authorization: Bearer requ_pat_…` → a personal access token (MCP clients);
 *   3. the session cookie the dashboard sets at login.
 */

import type { IncomingMessage } from "node:http";
import { authConfig, type AuthConfig } from "./config.js";
import { authenticateLdap, LdapError } from "./ldap.js";
import {
  buildPrincipal,
  devPrincipal,
  UnauthorizedError,
  type Permission,
  type Principal,
  type Role,
} from "./model.js";
import { effectivePermissions, resolveRoles } from "./roles.js";
import { authStore } from "./store.js";
import { bearerFromHeaders, hashesEqual, hashTokenSecret, parseToken } from "./tokens.js";
import { newSessionId, parseCookies, verifySessionCookie } from "./cookies.js";
import type { AuthUser, SessionRecord } from "./types.js";

const now = (): string => new Date().toISOString();

/** Canonical, case-insensitive user id. */
export function userIdFor(username: string): string {
  return username.trim().toLowerCase();
}

export function clientIp(req: IncomingMessage): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress ?? null;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export type LoginResult = {
  user: AuthUser;
  session: SessionRecord;
  /** Value to put in the session cookie (already signed). */
  cookieValue: string;
  /**
   * What still stands between the caller and a usable session.
   *
   *  none    — the cookie is live, sign-in is complete;
   *  code    — they have an authenticator; a code must be verified;
   *  enrol   — policy requires a second factor they have not set up yet.
   *
   * For anything but `none` the caller gets the signed session id as a
   * *challenge* rather than as a cookie: the password has been proven and
   * nothing else, and the session authenticates no request until the factor is
   * satisfied.
   */
  secondFactor: "none" | "code" | "enrol";
};

/** Whether policy obliges this user to hold a second factor. */
export function twoFactorRequiredFor(cfg: AuthConfig, roles: readonly Role[]): boolean {
  if (cfg.twoFactor === "off") return false;
  if (cfg.twoFactor === "required") return true;
  return cfg.twoFactorRequiredRoles.some((r) => roles.includes(r));
}

export class LoginError extends Error {
  /** True when the directory rejected the credentials rather than failing. */
  readonly invalidCredentials: boolean;
  constructor(message: string, invalidCredentials = false) {
    super(message);
    this.name = "LoginError";
    this.invalidCredentials = invalidCredentials;
  }
}

/**
 * Authenticate against the directory and open a dashboard session.
 *
 * The directory's answer is mirrored into `auth_users` so the dashboard can list
 * people and grant them roles without querying LDAP on every page, and so an
 * audit entry can name someone who has since left.
 */
export async function login(
  username: string,
  password: string,
  meta: { ip: string | null; userAgent: string | null },
): Promise<LoginResult> {
  const cfg = authConfig();
  if (!cfg.enabled || !cfg.ldap) {
    throw new LoginError("Authentication is disabled on this server; there is nothing to log in to.");
  }

  let dirUser;
  try {
    dirUser = await authenticateLdap(cfg.ldap, username, password);
  } catch (err) {
    if (err instanceof LdapError) throw new LoginError(err.message, err.invalidCredentials);
    throw new LoginError(`Directory error: ${(err as Error).message}`);
  }

  const store = authStore();
  const id = userIdFor(dirUser.username);
  const existing = await store.getUser(id);
  if (existing?.disabled) {
    throw new LoginError("This account is disabled in requ. Contact an administrator.", true);
  }

  const user = await store.upsertUser({
    id,
    username: dirUser.username,
    displayName: dirUser.displayName,
    email: dirUser.email,
    dn: dirUser.dn,
    groups: dirUser.groups,
    disabled: false,
    lastLoginAt: now(),
  });

  // A login with no role anywhere and no default is a rejection, not an empty
  // session: better a clear message now than a dashboard where nothing works.
  //
  // "Anywhere" is the point: someone added to a single project holds no global
  // role at all, and resolving only the global scope here would refuse the
  // sign-in of every person who was invited to one project.
  const bindings = await store.listBindings(id);
  const globalRoles = resolveRoles({ cfg, username: user.username, groups: user.groups, bindings, projectId: null }).roles;
  const hasAnyAccess = globalRoles.length > 0 || bindings.length > 0;
  if (!hasAnyAccess) {
    throw new LoginError(
      "Your account authenticated, but no requ role is mapped to it. Ask an administrator for access.",
      true,
    );
  }

  // Which second factor, if any, this sign-in still owes. Roles are resolved
  // across every project the user can reach, so "administrators must use 2FA"
  // covers someone who is an administrator of one project.
  const everyRole = new Set<Role>(globalRoles);
  for (const b of bindings) everyRole.add(b.role);
  const enrolment = await store.getTotp(id);
  const hasFactor = Boolean(enrolment?.confirmedAt);
  const mustHaveFactor = twoFactorRequiredFor(cfg, [...everyRole]);

  let secondFactor: LoginResult["secondFactor"] = "none";
  if (cfg.twoFactor !== "off") {
    if (hasFactor) secondFactor = "code";
    else if (mustHaveFactor) secondFactor = "enrol";
  }

  const createdAt = now();
  const session: SessionRecord = {
    id: newSessionId(),
    userId: id,
    createdAt,
    expiresAt: new Date(Date.now() + cfg.sessionTtlHours * 3_600_000).toISOString(),
    revokedAt: null,
    ip: meta.ip,
    userAgent: meta.userAgent,
    pendingTotp: secondFactor !== "none",
  };
  await store.createSession(session);
  // Opportunistic housekeeping; a failure here must not fail the login.
  store.purgeExpired(new Date(Date.now() - 7 * 86_400_000).toISOString()).catch(() => {});

  const { signSessionId } = await import("./cookies.js");
  return { user, session, cookieValue: signSessionId(session.id, cfg.secret), secondFactor };
}

export async function logout(sessionId: string): Promise<boolean> {
  return authStore().revokeSession(sessionId);
}

// ---------------------------------------------------------------------------
// Resolving a principal
// ---------------------------------------------------------------------------

/**
 * Build the principal for an already-identified user, with roles resolved for
 * one project.
 *
 * `projectKey` of null is the *global* scope: only grants that apply everywhere
 * count. That distinction is what keeps a project's administrator from being a
 * server administrator.
 */
async function principalForUser(
  user: AuthUser,
  projectKey: string | null,
  extra: Partial<Principal> & { kind: Principal["kind"] },
  ceiling: Role | null = null,
): Promise<Principal> {
  const cfg = authConfig();
  const bindings = await authStore().listBindings(user.id);
  const { roles } = resolveRoles({
    cfg,
    username: user.username,
    groups: user.groups,
    bindings,
    projectId: projectKey,
  });
  // The roles stay as assigned; the *ceiling* narrows what they grant. Reporting
  // the real roles keeps "why can I do this?" answerable, while the permission
  // set is what any check actually reads.
  return buildPrincipal({
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    groups: user.groups,
    ...extra,
    roles,
    cappedTo: ceiling,
    permissions: await effectivePermissions({ roles, projectId: projectKey, ceiling }),
  });
}

/**
 * The same principal, with its roles recomputed for a named scope.
 *
 * Permission checks that decide *administrative* questions must say which scope
 * they mean rather than trusting the roles the request happened to be
 * authenticated with: a caller who is `admin` on one project arrives holding
 * every permission, and asking "may they?" without naming a scope would answer
 * yes for the whole server.
 *
 * `projectId` null means the global scope.
 */
export async function principalInScope(
  principal: Principal,
  projectId: string | null,
): Promise<Principal> {
  const cfg = authConfig();
  // With authentication off there is one principal and it may do everything;
  // there is no scope to narrow it to.
  if (!cfg.enabled || principal.kind === "anonymous") return principal;

  const user = await authStore().getUser(principal.userId);
  if (!user) throw new UnauthorizedError("Your account no longer exists.");
  if (user.disabled) throw new UnauthorizedError("Your account is disabled.");

  let ceiling: Role | null = null;
  if (principal.kind === "token" && principal.tokenId) {
    const row = await authStore().getTokenWithHash(principal.tokenId);
    if (!row) throw new UnauthorizedError("This access token no longer exists.");
    if (row.revokedAt) throw new UnauthorizedError("This access token has been revoked.");
    if (row.expiresAt && row.expiresAt < now()) throw new UnauthorizedError("This access token has expired.");
    if (row.projects !== null && projectId !== null && !row.projects.includes(projectId)) {
      throw new UnauthorizedError(`This access token is not scoped to project '${projectId}'.`);
    }
    ceiling = row.maxRole;
  }

  return principalForUser(
    user,
    projectId,
    {
      kind: principal.kind,
      tokenId: principal.tokenId,
      tokenName: principal.tokenName,
      sessionId: principal.sessionId,
    },
    ceiling,
  );
}

/**
 * Whether the caller holds a permission *in a named scope*.
 *
 * Never throws for an ordinary refusal — a caller whose account or token has
 * gone away simply cannot do the thing.
 */
export async function canInScope(
  principal: Principal,
  permission: Permission,
  projectId: string | null,
): Promise<boolean> {
  try {
    const scoped = await principalInScope(principal, projectId);
    return scoped.permissions.has(permission);
  } catch {
    return false;
  }
}

export type AuthAttempt =
  | { ok: true; principal: Principal }
  | { ok: false; reason: string; status: 401 | 403 };

/**
 * Identify the caller of an HTTP request.
 *
 * `projectKey` scopes role resolution: the same user may be a maintainer on one
 * project and a viewer on another, and the answer must be computed for the
 * project the request is actually about. Callers that do not know it yet pass
 * null and re-resolve later with `reauthorizeForProject`.
 */
export async function authenticateRequest(
  req: IncomingMessage,
  projectKey: string | null,
): Promise<AuthAttempt> {
  const cfg = authConfig();
  if (!cfg.enabled) return { ok: true, principal: devPrincipal() };

  const store = authStore();

  // --- personal access token ---
  const bearer = bearerFromHeaders(req.headers as Record<string, unknown>);
  if (bearer) {
    const parsed = parseToken(bearer);
    if (!parsed) return { ok: false, reason: "Malformed access token.", status: 401 };
    const row = await store.getTokenWithHash(parsed.id);
    if (!row) return { ok: false, reason: "Unknown access token.", status: 401 };
    if (!hashesEqual(row.tokenHash, hashTokenSecret(parsed.secret, cfg.secret))) {
      return { ok: false, reason: "Invalid access token.", status: 401 };
    }
    if (row.revokedAt) return { ok: false, reason: "This access token has been revoked.", status: 401 };
    if (row.expiresAt && row.expiresAt < now()) {
      return { ok: false, reason: "This access token has expired.", status: 401 };
    }
    if (row.projects !== null && projectKey !== null && !row.projects.includes(projectKey)) {
      return {
        ok: false,
        reason: `This access token is not scoped to project '${projectKey}'.`,
        status: 403,
      };
    }
    const user = await store.getUser(row.userId);
    if (!user) return { ok: false, reason: "The owner of this token no longer exists.", status: 401 };
    if (user.disabled) return { ok: false, reason: "The owner of this token is disabled.", status: 403 };

    // Best-effort: a busy server should not serialise on a bookkeeping update.
    store.touchToken(row.id, now()).catch(() => {});

    return {
      ok: true,
      principal: await principalForUser(
        user,
        projectKey,
        { kind: "token", tokenId: row.id, tokenName: row.name },
        row.maxRole,
      ),
    };
  }

  // --- dashboard session cookie ---
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = verifySessionCookie(cookies[cfg.cookieName], cfg.secret);
  if (sessionId) {
    const session = await store.getSession(sessionId);
    if (!session) return { ok: false, reason: "Session not found. Please sign in again.", status: 401 };
    if (session.revokedAt) return { ok: false, reason: "Session ended. Please sign in again.", status: 401 };
    if (session.expiresAt < now()) return { ok: false, reason: "Session expired. Please sign in again.", status: 401 };
    // The password was proven, the second factor was not. Such a session is a
    // challenge handle, never a credential.
    if (session.pendingTotp) {
      return { ok: false, reason: "Two-factor authentication is not complete.", status: 401 };
    }
    const user = await store.getUser(session.userId);
    if (!user) return { ok: false, reason: "Your account no longer exists.", status: 401 };
    if (user.disabled) return { ok: false, reason: "Your account is disabled.", status: 403 };
    return {
      ok: true,
      principal: await principalForUser(user, projectKey, { kind: "session", sessionId: session.id }),
    };
  }

  return { ok: false, reason: "Authentication required.", status: 401 };
}

/**
 * Re-resolve an already-authenticated principal's roles for a project.
 *
 * MCP calls carry the project key in the tool arguments, which is only known
 * after the request has been authenticated, so the first resolution uses global
 * grants and this narrows (or widens) it once the project is known. A null key
 * means nothing was named, so the principal stands as authenticated.
 */
export async function reauthorizeForProject(
  principal: Principal,
  projectKey: string | null,
): Promise<Principal> {
  if (projectKey === null) return principal;
  return principalInScope(principal, projectKey);
}
