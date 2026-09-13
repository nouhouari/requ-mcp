/**
 * Turning a request into a `Principal`.
 *
 * Three ways in, in the order they are tried:
 *   1. auth disabled → the development principal, full rights, no lookup;
 *   2. `Authorization: Bearer requ_pat_…` → a personal access token (MCP clients);
 *   3. the session cookie the dashboard sets at login.
 */

import type { IncomingMessage } from "node:http";
import { authConfig } from "./config.js";
import { authenticateLdap, LdapError } from "./ldap.js";
import {
  buildPrincipal,
  devPrincipal,
  UnauthorizedError,
  type Principal,
  type Role,
} from "./model.js";
import { capRoles, resolveRoles } from "./roles.js";
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
};

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

  // A login with no mapped role and no default is a rejection, not an empty
  // session: better a clear message now than a dashboard where nothing works.
  const bindings = await store.listBindings(id);
  const { roles } = resolveRoles({ cfg, username: user.username, groups: user.groups, bindings, projectId: null });
  if (roles.length === 0) {
    throw new LoginError(
      "Your account authenticated, but no requ role is mapped to it. Ask an administrator for access.",
      true,
    );
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
  };
  await store.createSession(session);
  // Opportunistic housekeeping; a failure here must not fail the login.
  store.purgeExpired(new Date(Date.now() - 7 * 86_400_000).toISOString()).catch(() => {});

  const { signSessionId } = await import("./cookies.js");
  return { user, session, cookieValue: signSessionId(session.id, cfg.secret) };
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
  return buildPrincipal({
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    groups: user.groups,
    ...extra,
    roles: capRoles(roles, ceiling),
  });
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
 * grants and this narrows (or widens) it once the project is known.
 */
export async function reauthorizeForProject(
  principal: Principal,
  projectKey: string | null,
): Promise<Principal> {
  const cfg = authConfig();
  if (!cfg.enabled || principal.kind === "anonymous") return principal;
  if (projectKey === null) return principal;
  const user = await authStore().getUser(principal.userId);
  if (!user) throw new UnauthorizedError("Your account no longer exists.");

  let ceiling: Role | null = null;
  if (principal.kind === "token" && principal.tokenId) {
    const row = await authStore().getTokenWithHash(principal.tokenId);
    if (!row) throw new UnauthorizedError("This access token no longer exists.");
    if (row.revokedAt) throw new UnauthorizedError("This access token has been revoked.");
    if (row.projects !== null && !row.projects.includes(projectKey)) {
      throw new UnauthorizedError(`This access token is not scoped to project '${projectKey}'.`);
    }
    ceiling = row.maxRole;
  }

  return principalForUser(
    user,
    projectKey,
    {
      kind: principal.kind,
      tokenId: principal.tokenId,
      tokenName: principal.tokenName,
      sessionId: principal.sessionId,
    },
    ceiling,
  );
}
