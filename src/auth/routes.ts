/**
 * REST endpoints for signing in, managing access tokens, granting roles, and
 * reading the audit trail.
 *
 * `handleAuthRoutes` is called from `handleWebRequest` before the blanket
 * permission guard, because some of these routes are how a caller *becomes*
 * authenticated in the first place.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { authConfig } from "./config.js";
import { clearSessionCookie, serializeSessionCookie, signSessionId, verifySessionCookie } from "./cookies.js";
import { canInScope, clientIp, login, logout, principalInScope, userIdFor } from "./authenticate.js";
import { checkLdapConnection } from "./ldap.js";
import {
  can,
  PERMISSION_CATALOGUE,
  PERMISSION_GROUPS,
  type Principal,
  type Role,
} from "./model.js";
import { roleExists, rolesFor } from "./role-catalogue.js";
import { addProjectMember, listProjectMembers, MemberError, removeProjectMember } from "./members.js";
import { ALL_PROJECTS, resolveRoles } from "./roles.js";
import { authStore } from "./store.js";
import { clearLoginFailures, loginRetryAfterMs, recordLoginFailure } from "./throttle.js";
import { mintToken, tokenDisplayPrefix } from "./tokens.js";
import type { AuditOutcome, AuditSource, TokenRecord } from "./types.js";
import { audit, auditSync } from "../audit.js";
import * as twoFactor from "./two-factor.js";

const now = (): string => new Date().toISOString();

// ---------------------------------------------------------------------------
// Small HTTP helpers (kept local so this module does not depend on web-api.ts)
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function send(res: ServerResponse, status: number, data: unknown, extra: Record<string, string> = {}): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { ...JSON_HEADERS, ...extra, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function fail(res: ServerResponse, status: number, message: string, code?: string): void {
  send(res, status, { error: message, ...(code ? { code } : {}) });
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/** The principal as the dashboard needs it: who, what they may do, and why. */
export function principalPayload(p: Principal): Record<string, unknown> {
  return {
    userId: p.userId,
    username: p.username,
    displayName: p.displayName,
    email: p.email,
    kind: p.kind,
    roles: p.roles,
    permissions: [...p.permissions].sort(),
    groups: p.groups,
    ...(p.tokenName ? { tokenName: p.tokenName } : {}),
    // Only meaningful for a capped token; absent otherwise so the dashboard can
    // treat its presence as "this token is limited".
    ...(p.cappedTo ? { cappedTo: p.cappedTo } : {}),
  };
}

function tokenPayload(t: TokenRecord): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    prefix: tokenDisplayPrefix(t.id),
    userId: t.userId,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
    revokedBy: t.revokedBy,
    maxRole: t.maxRole,
    projects: t.projects,
    active: !t.revokedAt && (!t.expiresAt || t.expiresAt > now()),
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export type AuthRouteContext = {
  /** Already-resolved principal, or null when the request is unauthenticated. */
  principal: Principal | null;
  /** Project slug from `?project=`, for project-scoped role resolution. */
  projectSlug: string | null;
  source: AuditSource;
};

/**
 * Handle `/api/auth/*` and `/api/admin/*`. Returns true when the request was
 * served.
 */
export async function handleAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  ctx: AuthRouteContext,
): Promise<boolean> {
  const cfg = authConfig();
  const m = method.toUpperCase();

  // --- GET /api/auth/config — public; tells the SPA whether to show a login form
  if (pathname === "/api/auth/config" && m === "GET") {
    send(res, 200, {
      mode: cfg.mode,
      enabled: cfg.enabled,
      auditEnabled: cfg.auditEnabled,
      // The permission catalogue is a property of the software, so it is safe
      // to serve before sign-in — it is the same everywhere requ runs, and the
      // login form needs nothing from it. Which *roles* exist is deployment
      // data and names real teams, so that is behind `/api/roles` instead.
      permissions: PERMISSION_CATALOGUE,
      permissionGroups: PERMISSION_GROUPS,
      // A development server says so out loud, so nobody mistakes an open
      // instance for a secured one.
      twoFactor: cfg.twoFactor,
      warning: cfg.enabled ? null : "Authentication is disabled: every caller has full access.",
    });
    return true;
  }

  // --- POST /api/auth/login
  if (pathname === "/api/auth/login" && m === "POST") {
    if (!cfg.enabled) {
      fail(res, 400, "Authentication is disabled on this server.", "AUTH_DISABLED");
      return true;
    }
    let payload: Record<string, unknown>;
    try {
      payload = await body(req);
    } catch (e) {
      fail(res, 400, (e as Error).message);
      return true;
    }
    const username = str(payload.username);
    const password = typeof payload.password === "string" ? payload.password : "";
    if (!username || !password) {
      fail(res, 400, "Both `username` and `password` are required.");
      return true;
    }

    // Refuse before touching the directory: this endpoint forwards a password on
    // every call, so an unthrottled one is a guessing oracle against the whole
    // organisation — and a way to trip a colleague's account lockout.
    const ip = clientIp(req);
    const waitMs = loginRetryAfterMs(username, ip);
    if (waitMs > 0) {
      const seconds = Math.ceil(waitMs / 1000);
      await auditLogin(username, "denied", ip, { reason: "throttled", retryAfterSeconds: seconds });
      res.setHeader("Retry-After", String(seconds));
      fail(res, 429, `Too many sign-in attempts. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`, "THROTTLED");
      return true;
    }

    try {
      const result = await login(username, password, {
        ip,
        userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
      });
      clearLoginFailures(username, ip);
      const bindings = await authStore().listBindings(result.user.id);
      const { roles, sources } = resolveRoles({
        cfg,
        username: result.user.username,
        groups: result.user.groups,
        bindings,
        projectId: ctx.projectSlug,
      });
      await auditLogin(username, "ok", ip, { roles, secondFactor: result.secondFactor });

      const identity = {
        user: {
          userId: result.user.id,
          username: result.user.username,
          displayName: result.user.displayName,
          email: result.user.email,
          groups: result.user.groups,
        },
        roles,
        roleSources: sources,
        expiresAt: result.session.expiresAt,
      };

      // A second factor is still owed: the signed session id goes back as a
      // *challenge*, not as a cookie. It authenticates nothing until the code
      // is verified, so a stolen challenge is worth no more than the password.
      if (result.secondFactor !== "none") {
        send(res, 200, {
          ...identity,
          twoFactor: {
            required: true,
            // "code" — they have an app; "enrol" — policy says they need one.
            step: result.secondFactor,
            challenge: result.cookieValue,
          },
        });
        return true;
      }

      send(res, 200, { ...identity, twoFactor: { required: false } }, {
        "Set-Cookie": serializeSessionCookie(result.cookieValue, {
          name: cfg.cookieName,
          secure: cfg.cookieSecure,
          maxAgeSeconds: cfg.sessionTtlHours * 3600,
        }),
      });
    } catch (err) {
      const message = (err as Error).message;
      const invalid = (err as { invalidCredentials?: boolean }).invalidCredentials === true;
      // Only a rejected credential counts towards the throttle: an unreachable
      // directory is requ's problem, and locking people out for it would turn a
      // brief outage into a long one.
      if (invalid) recordLoginFailure(username, ip);
      await auditLogin(username, "denied", ip, { reason: message });
      // A failed login is always reported the same way to the caller; the audit
      // row keeps the real reason, so probing cannot tell a wrong password from
      // an unknown account.
      fail(res, invalid ? 401 : 502, invalid ? "Invalid username or password." : message);
    }
    return true;
  }

  // --- POST /api/auth/logout
  if (pathname === "/api/auth/logout" && m === "POST") {
    if (ctx.principal?.sessionId) {
      await logout(ctx.principal.sessionId);
      audit({ action: "auth:logout", outcome: "ok", source: "web" });
    }
    send(res, 200, { ok: true }, {
      "Set-Cookie": clearSessionCookie({ name: cfg.cookieName, secure: cfg.cookieSecure }),
    });
    return true;
  }

  // --- GET /api/auth/me
  if (pathname === "/api/auth/me" && m === "GET") {
    if (!ctx.principal) {
      send(res, 200, { authenticated: false, mode: cfg.mode });
      return true;
    }
    // `permissions` answers "what may I do here?" for the project in scope;
    // `globalPermissions` answers "am I a server administrator?". The dashboard
    // needs both, because a project's admin sees a members panel but not the
    // server administration one.
    let globalPermissions: string[] = [];
    try {
      const global = await principalInScope(ctx.principal, null);
      globalPermissions = [...global.permissions].sort();
    } catch {
      // The account or token went away between authenticating and here; the
      // caller simply has no global rights.
    }
    send(res, 200, {
      authenticated: true,
      mode: cfg.mode,
      ...principalPayload(ctx.principal),
      globalPermissions,
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Second factor — the half of sign-in that happens after the password
  // -------------------------------------------------------------------------
  //
  // These two are reached with a *challenge* rather than a session, because the
  // caller has no usable session yet. The challenge is the signed id of a
  // session marked pending; verifying the code is what promotes it.

  if (pathname === "/api/auth/2fa/verify" && m === "POST") {
    await handlePendingStep(req, res, cfg, "verify");
    return true;
  }
  if (pathname === "/api/auth/2fa/enrol" && m === "POST") {
    await handlePendingStep(req, res, cfg, "enrol");
    return true;
  }

  // Everything below needs an identified caller.
  const principal = ctx.principal;
  if (!principal) {
    if (
      pathname.startsWith("/api/auth/") ||
      pathname.startsWith("/api/admin/") ||
      /^\/api\/projects\/[^/]+\/members(\/|$)/.test(pathname)
    ) {
      fail(res, 401, "Authentication required.", "UNAUTHENTICATED");
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Second factor — self-service, for a caller who is already signed in
  // -------------------------------------------------------------------------

  if (pathname.startsWith("/api/auth/2fa")) {
    const me = await authStore().getUser(principal.userId);
    if (!me) {
      fail(res, 401, "Your account no longer exists.");
      return true;
    }

    // A token is a credential of its own; it is not a browser and has no
    // authenticator to prompt. Enrolment is a deliberate act by a person.
    if (principal.kind === "token" && m !== "GET") {
      fail(res, 403, "Manage two-factor authentication from the dashboard, not with an access token.", "SESSION_REQUIRED");
      return true;
    }

    const withCode = async (): Promise<string | null> => {
      const payload = await body(req);
      return str(payload.code);
    };

    try {
      // --- GET /api/auth/2fa — is it available, am I enrolled, must I be?
      if (pathname === "/api/auth/2fa" && m === "GET") {
        send(res, 200, await twoFactor.status(me));
        return true;
      }

      // --- POST /api/auth/2fa/setup — a new secret plus the QR to scan
      if (pathname === "/api/auth/2fa/setup" && m === "POST") {
        const offer = await twoFactor.begin(me);
        audit({ action: "2fa.setup", outcome: "ok", source: "web" });
        send(res, 200, offer);
        return true;
      }

      // --- POST /api/auth/2fa/confirm { code } — finish, and take the recovery codes
      if (pathname === "/api/auth/2fa/confirm" && m === "POST") {
        const code = await withCode();
        if (!code) {
          fail(res, 400, "Enter the 6-digit code from your authenticator app.");
          return true;
        }
        const { recoveryCodes } = await twoFactor.confirm(me.id, code);
        audit({ action: "2fa.enrolled", outcome: "ok", source: "web" });
        send(res, 200, { ok: true, recoveryCodes });
        return true;
      }

      // --- POST /api/auth/2fa/disable { code }
      if (pathname === "/api/auth/2fa/disable" && m === "POST") {
        const code = await withCode();
        if (!code) {
          fail(res, 400, "Enter a current code to confirm it is you.");
          return true;
        }
        await twoFactor.disable(me.id, code);
        audit({ action: "2fa.disabled", outcome: "ok", source: "web" });
        send(res, 200, { ok: true });
        return true;
      }

      // --- POST /api/auth/2fa/recovery-codes { code } — reissue
      if (pathname === "/api/auth/2fa/recovery-codes" && m === "POST") {
        const code = await withCode();
        if (!code) {
          fail(res, 400, "Enter a current code to confirm it is you.");
          return true;
        }
        const recoveryCodes = await twoFactor.regenerateRecoveryCodes(me.id, code);
        audit({ action: "2fa.recovery-codes.reissued", outcome: "ok", source: "web" });
        send(res, 200, { recoveryCodes });
        return true;
      }

      fail(res, 404, "Unknown two-factor route.");
      return true;
    } catch (e) {
      const err = e as twoFactor.TwoFactorError;
      audit({
        action: `2fa:${pathname}`,
        outcome: "denied",
        source: "web",
        detail: { reason: err.message, code: err.code },
      });
      fail(res, typeof err.status === "number" ? err.status : 400, err.message, err.code);
      return true;
    }
  }

  // --- GET /api/auth/tokens — the caller's own tokens
  if (pathname === "/api/auth/tokens" && m === "GET") {
    const tokens = await authStore().listTokens(principal.userId);
    send(res, 200, tokens.map(tokenPayload));
    return true;
  }

  // --- POST /api/auth/tokens — mint one; the plaintext is returned exactly once
  if (pathname === "/api/auth/tokens" && m === "POST") {
    let payload: Record<string, unknown>;
    try {
      payload = await body(req);
    } catch (e) {
      fail(res, 400, (e as Error).message);
      return true;
    }
    const name = str(payload.name) ?? "MCP client";
    if (name.length > 120) {
      fail(res, 400, "`name` must be 120 characters or fewer.");
      return true;
    }

    let projects: string[] | null = null;
    if (Array.isArray(payload.projects)) {
      projects = payload.projects.filter((p): p is string => typeof p === "string" && p.trim() !== "");
      if (projects.length === 0) projects = null;
    }

    // The ceiling role is checked where the token will actually be used: a
    // token limited to one project may be capped to a role that project
    // defines, while an unrestricted token can only be capped to a shared one.
    let maxRole: Role | null = null;
    const rawRole = str(payload.maxRole);
    if (rawRole) {
      const scopes: Array<string | null> = projects && projects.length === 1 ? [projects[0]] : [null];
      for (const scope of scopes) {
        if (await roleExists(rawRole, scope)) continue;
        const known = (await rolesFor(scope)).map((r) => r.id).join(", ");
        fail(res, 400, `Unknown role '${rawRole}'. Known: ${known}.`);
        return true;
      }
      maxRole = rawRole;
    }

    const requestedDays = Number(payload.expiresInDays ?? cfg.tokenTtlDays);
    const days = Number.isFinite(requestedDays) && requestedDays > 0 ? Math.trunc(requestedDays) : 0;
    const expiresAt = days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;

    const minted = mintToken(cfg.secret);
    const record: TokenRecord = {
      id: minted.id,
      userId: principal.userId,
      name,
      createdAt: now(),
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
      maxRole,
      projects,
    };
    await authStore().createToken({ ...record, tokenHash: minted.hash });
    audit({
      action: "auth:token.create",
      outcome: "ok",
      source: "web",
      detail: { tokenId: minted.id, name, maxRole, projects },
    });
    send(res, 201, {
      // Shown once, never retrievable again — the store only holds its hash.
      token: minted.plaintext,
      ...tokenPayload(record),
    });
    return true;
  }

  // --- DELETE /api/auth/tokens/:id — revoke
  const revokeMatch = /^\/api\/auth\/tokens\/([^/]+)$/.exec(pathname);
  if (revokeMatch && m === "DELETE") {
    const id = decodeURIComponent(revokeMatch[1]);
    const row = await authStore().getTokenWithHash(id);
    if (!row) {
      fail(res, 404, "No such token.");
      return true;
    }
    const ownIt = row.userId === principal.userId;
    if (!ownIt && !can(principal, "admin:users")) {
      audit({ action: "auth:token.revoke", outcome: "denied", source: "web", permission: "admin:users", detail: { tokenId: id } });
      fail(res, 403, "You can only revoke your own tokens.");
      return true;
    }
    const revoked = await authStore().revokeToken(id, principal.userId);
    audit({
      action: "auth:token.revoke",
      outcome: "ok",
      source: "web",
      detail: { tokenId: id, owner: row.userId, alreadyRevoked: !revoked },
    });
    send(res, 200, { ok: true, alreadyRevoked: !revoked });
    return true;
  }

  // -------------------------------------------------------------------------
  // Project membership — who can reach one project, and with what role
  // -------------------------------------------------------------------------
  //
  // Authorised against the project in the URL, not against whatever project the
  // request happened to be authenticated for. A project's admin administers that
  // project; nothing else follows from it.

  const membersMatch = /^\/api\/projects\/([^/]+)\/members$/.exec(pathname);
  const memberMatch = /^\/api\/projects\/([^/]+)\/members\/([^/]+)$/.exec(pathname);

  if (membersMatch || memberMatch) {
    const targetProject = decodeURIComponent((membersMatch ?? memberMatch)![1]);
    if (!(await canInScope(principal, "project:members", targetProject))) {
      audit({
        action: `members:${m} ${targetProject}`,
        outcome: "denied",
        source: "web",
        permission: "project:members",
        projectId: targetProject,
      });
      fail(res, 403, `You need the admin role on project '${targetProject}' to manage its members.`);
      return true;
    }

    // --- GET /api/projects/:slug/members
    if (membersMatch && m === "GET") {
      send(res, 200, {
        project: targetProject,
        members: await listProjectMembers(targetProject),
        // Assignable here means shared plus this project's own roles.
        roles: await rolesFor(targetProject),
        // A server-wide default role means everyone with an account reaches
        // every project; the UI needs to say so rather than imply the list is
        // the whole story.
        defaultRole: cfg.defaultRole,
      });
      return true;
    }

    // --- POST /api/projects/:slug/members  { username, role }
    if (membersMatch && m === "POST") {
      let payload: Record<string, unknown>;
      try {
        payload = await body(req);
      } catch (e) {
        fail(res, 400, (e as Error).message);
        return true;
      }
      const username = str(payload.username) ?? str(payload.userId);
      const role = str(payload.role) ?? "viewer";
      if (!username) {
        fail(res, 400, "`username` is required.");
        return true;
      }
      try {
        const member = await addProjectMember({
          projectId: targetProject,
          username,
          role,
          grantedBy: principal.userId,
        });
        audit({
          action: "members.add",
          outcome: "ok",
          source: "web",
          permission: "project:members",
          projectId: targetProject,
          detail: { userId: member.userId, role, invited: member.invited },
        });
        send(res, 200, member);
      } catch (e) {
        const status = e instanceof MemberError ? e.status : 500;
        audit({
          action: "members.add",
          outcome: "error",
          source: "web",
          projectId: targetProject,
          detail: { username, role, error: (e as Error).message },
        });
        fail(res, status, (e as Error).message);
      }
      return true;
    }

    // --- DELETE /api/projects/:slug/members/:userId
    if (memberMatch && m === "DELETE") {
      const targetUser = userIdFor(decodeURIComponent(memberMatch[2]));
      // Removing your own last way in leaves a project nobody can administer.
      if (targetUser === principal.userId) {
        const others = (await listProjectMembers(targetProject)).filter(
          (x) => x.userId !== principal.userId && x.roles.includes("admin"),
        );
        if (others.length === 0) {
          fail(res, 400, "You are the only administrator of this project; add another before removing yourself.");
          return true;
        }
      }
      const result = await removeProjectMember({
        projectId: targetProject,
        userId: targetUser,
        actorId: principal.userId,
      });
      audit({
        action: "members.remove",
        outcome: "ok",
        source: "web",
        permission: "project:members",
        projectId: targetProject,
        detail: { userId: targetUser, ...result },
      });
      send(res, 200, result);
      return true;
    }

    fail(res, 405, `Method ${m} is not supported here.`);
    return true;
  }

  // -------------------------------------------------------------------------
  // Administration — server-wide, and checked in the global scope
  // -------------------------------------------------------------------------

  if (pathname.startsWith("/api/admin/")) {
    // Resolved globally on purpose: `can(principal, …)` would answer from the
    // roles this request was authenticated with, and a caller who is admin on
    // one project arrives holding every permission. Asking in the global scope
    // is what keeps that a delegation rather than an escalation.
    if (!(await canInScope(principal, "admin:users", null))) {
      audit({ action: `admin:${pathname}`, outcome: "denied", source: "web", permission: "admin:users" });
      fail(res, 403, "Server administrator access is required.");
      return true;
    }

    // --- GET /api/admin/users
    if (pathname === "/api/admin/users" && m === "GET") {
      const store = authStore();
      const [users, bindings, enrolled] = await Promise.all([
        store.listUsers(),
        store.listBindings(),
        store.listTotpUserIds(),
      ]);
      const withFactor = new Set(enrolled);
      send(
        res,
        200,
        users.map((u) => ({
          ...u,
          twoFactorEnrolled: withFactor.has(u.id),
          bindings: bindings.filter((b) => b.userId === u.id),
          effectiveRoles: resolveRoles({
            cfg,
            username: u.username,
            groups: u.groups,
            bindings: bindings.filter((b) => b.userId === u.id),
            projectId: ctx.projectSlug,
          }).roles,
        })),
      );
      return true;
    }

    // --- PATCH /api/admin/users/:id  { disabled: boolean }
    const userMatch = /^\/api\/admin\/users\/([^/]+)$/.exec(pathname);
    if (userMatch && m === "PATCH") {
      const id = userIdFor(decodeURIComponent(userMatch[1]));
      let payload: Record<string, unknown>;
      try {
        payload = await body(req);
      } catch (e) {
        fail(res, 400, (e as Error).message);
        return true;
      }
      if (typeof payload.disabled !== "boolean") {
        fail(res, 400, "`disabled` must be true or false.");
        return true;
      }
      if (id === principal.userId && payload.disabled) {
        fail(res, 400, "You cannot disable your own account.");
        return true;
      }
      const ok = await authStore().setUserDisabled(id, payload.disabled);
      if (!ok) {
        fail(res, 404, "No such user.");
        return true;
      }
      // Disabling must take effect now, not when the browser tab is closed.
      if (payload.disabled) await authStore().revokeSessionsForUser(id);
      audit({ action: "admin:user.disable", outcome: "ok", source: "web", detail: { userId: id, disabled: payload.disabled } });
      send(res, 200, { ok: true });
      return true;
    }

    // --- POST /api/admin/roles  { userId, projectId?, role }
    if (pathname === "/api/admin/roles" && m === "POST") {
      let payload: Record<string, unknown>;
      try {
        payload = await body(req);
      } catch (e) {
        fail(res, 400, (e as Error).message);
        return true;
      }
      const userId = str(payload.userId);
      const role = str(payload.role);
      const projectId = str(payload.projectId) ?? ALL_PROJECTS;
      if (!userId || !role) {
        fail(res, 400, "`userId` and `role` are required.");
        return true;
      }
      // A grant with `projectId: "*"` applies everywhere, so it may only name a
      // shared role; a grant on one project may also name that project's own.
      const roleScope = projectId === ALL_PROJECTS ? null : projectId;
      if (!(await roleExists(role, roleScope))) {
        const known = (await rolesFor(roleScope)).map((r) => r.id).join(", ");
        fail(res, 400, `Unknown role '${role}'. Known: ${known}.`);
        return true;
      }
      // A grant may be made before the person has ever signed in — that is the
      // normal case when a team is being set up — so a placeholder account is
      // recorded and their first sign-in fills in the real details.
      const target = userIdFor(userId);
      const invited = !(await authStore().getUser(target));
      if (invited) {
        await authStore().upsertUser({
          id: target,
          username: userId,
          displayName: userId,
          email: null,
          dn: null,
          groups: [],
          disabled: false,
        });
      }
      await authStore().grantRole({
        userId: target,
        projectId,
        role,
        grantedBy: principal.userId,
        grantedAt: now(),
      });
      audit({ action: "admin:role.grant", outcome: "ok", source: "web", detail: { userId: target, projectId, role, invited } });
      send(res, 200, { ok: true, invited });
      return true;
    }

    // --- POST /api/admin/roles/revoke  { userId, projectId?, role }
    if (pathname === "/api/admin/roles/revoke" && m === "POST") {
      let payload: Record<string, unknown>;
      try {
        payload = await body(req);
      } catch (e) {
        fail(res, 400, (e as Error).message);
        return true;
      }
      const userId = str(payload.userId);
      const role = str(payload.role);
      const projectId = str(payload.projectId) ?? ALL_PROJECTS;
      // Deliberately not checked against the catalogue: a role deleted while
      // people still held it must stay revocable, or the stale grants could
      // never be cleaned up.
      if (!userId || !role) {
        fail(res, 400, "`userId` and `role` are required.");
        return true;
      }
      const removed = await authStore().revokeRole(userIdFor(userId), projectId, role);
      audit({ action: "admin:role.revoke", outcome: "ok", source: "web", detail: { userId, projectId, role, removed } });
      send(res, 200, { ok: true, removed });
      return true;
    }

    // --- DELETE /api/admin/users/:id/2fa — reset a lost authenticator
    //
    // For the person who lost their phone *and* their recovery codes. Under a
    // `required` policy this does not leave them unprotected: their next sign-in
    // walks straight back into enrolment.
    const resetMatch = /^\/api\/admin\/users\/([^/]+)\/2fa$/.exec(pathname);
    if (resetMatch && m === "DELETE") {
      const target = userIdFor(decodeURIComponent(resetMatch[1]));
      const removed = await twoFactor.adminReset(target);
      // End their sessions too: a reset is what you do when an account may be
      // compromised, and leaving live sessions open would defeat it.
      await authStore().revokeSessionsForUser(target);
      audit({
        action: "admin:2fa.reset",
        outcome: "ok",
        source: "web",
        detail: { userId: target, removed },
      });
      send(res, 200, { ok: true, removed });
      return true;
    }

    // --- GET /api/admin/tokens — every token on the server
    if (pathname === "/api/admin/tokens" && m === "GET") {
      const tokens = await authStore().listAllTokens();
      send(res, 200, tokens.map(tokenPayload));
      return true;
    }

    // --- GET /api/admin/ldap-check — prove the directory settings work
    if (pathname === "/api/admin/ldap-check" && m === "GET") {
      if (!cfg.ldap) {
        send(res, 200, { configured: false, ok: false, message: "LDAP is not configured." });
        return true;
      }
      try {
        await checkLdapConnection(cfg.ldap);
        send(res, 200, { configured: true, ok: true, url: cfg.ldap.url });
      } catch (err) {
        send(res, 200, { configured: true, ok: false, url: cfg.ldap.url, message: (err as Error).message });
      }
      return true;
    }

    fail(res, 404, "Unknown administration route.");
    return true;
  }

  if (pathname.startsWith("/api/auth/")) {
    fail(res, 404, "Unknown auth route.");
    return true;
  }

  return false;
}

/**
 * The second half of sign-in, reached with a challenge rather than a session.
 *
 * `verify` takes a code from the authenticator (or a recovery code) and
 * promotes the pending session. `enrol` is the forced-enrolment path: a user
 * the policy obliges to hold a factor sets one up here, and confirming it
 * promotes the session in the same step.
 *
 * Both are throttled on the same counters as the password, because a six-digit
 * code is a million guesses — trivially brute-forced if a caller may keep
 * trying.
 */
async function handlePendingStep(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ReturnType<typeof authConfig>,
  step: "verify" | "enrol",
): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = await body(req);
  } catch (e) {
    fail(res, 400, (e as Error).message);
    return;
  }

  const challenge = str(payload.challenge);
  if (!challenge) {
    fail(res, 400, "`challenge` is required — sign in with your password first.", "NO_CHALLENGE");
    return;
  }
  const sessionId = verifySessionCookie(challenge, cfg.secret);
  if (!sessionId) {
    fail(res, 401, "That sign-in has expired. Start again.", "BAD_CHALLENGE");
    return;
  }

  const store = authStore();
  const session = await store.getSession(sessionId);
  if (!session || session.revokedAt || session.expiresAt < now()) {
    fail(res, 401, "That sign-in has expired. Start again.", "BAD_CHALLENGE");
    return;
  }
  if (!session.pendingTotp) {
    fail(res, 400, "This sign-in is already complete.", "NOT_PENDING");
    return;
  }

  const user = await store.getUser(session.userId);
  if (!user || user.disabled) {
    fail(res, 403, "This account is not available.", "ACCOUNT_UNAVAILABLE");
    return;
  }

  const ip = clientIp(req);
  const waitMs = loginRetryAfterMs(user.username, ip);
  if (waitMs > 0) {
    const seconds = Math.ceil(waitMs / 1000);
    await auditLogin(user.username, "denied", ip, { reason: "throttled", stage: `2fa:${step}` });
    res.setHeader("Retry-After", String(seconds));
    fail(res, 429, `Too many attempts. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`, "THROTTLED");
    return;
  }

  const completeSignIn = async (detail: Record<string, unknown>) => {
    await store.clearSessionPending(sessionId);
    clearLoginFailures(user.username, ip);
    await auditLogin(user.username, "ok", ip, { stage: `2fa:${step}`, ...detail });
    return serializeSessionCookie(signSessionId(sessionId, cfg.secret), {
      name: cfg.cookieName,
      secure: cfg.cookieSecure,
      maxAgeSeconds: cfg.sessionTtlHours * 3600,
    });
  };

  try {
    if (step === "verify") {
      const code = str(payload.code);
      if (!code) {
        fail(res, 400, "Enter the code from your authenticator app.");
        return;
      }
      const outcome = await twoFactor.verify(user.id, code);
      const cookie = await completeSignIn({ usedRecoveryCode: outcome.usedRecoveryCode });
      send(res, 200, { ok: true, ...outcome }, { "Set-Cookie": cookie });
      return;
    }

    // enrol: either hand out a fresh secret, or confirm the one just scanned.
    const code = str(payload.code);
    if (!code) {
      const offer = await twoFactor.begin(user);
      send(res, 200, { enrolment: offer });
      return;
    }
    const { recoveryCodes } = await twoFactor.confirm(user.id, code);
    const cookie = await completeSignIn({ enrolled: true });
    send(res, 200, { ok: true, recoveryCodes }, { "Set-Cookie": cookie });
  } catch (e) {
    const err = e as twoFactor.TwoFactorError;
    const status = typeof err.status === "number" ? err.status : 400;
    // Only a wrong code counts towards the throttle; a misconfiguration is the
    // server's problem and must not lock the user out on top of it.
    if (err.code === "BAD_CODE") recordLoginFailure(user.username, ip);
    await auditLogin(user.username, "denied", ip, { stage: `2fa:${step}`, reason: err.message });
    fail(res, status, err.message, err.code);
  }
}

/**
 * Login attempts are audited without a request context, because the principal
 * only exists once the attempt has succeeded.
 */
async function auditLogin(
  username: string,
  outcome: AuditOutcome,
  ip: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  const { runWithContext, newContext } = await import("./context.js");
  await runWithContext(
    newContext({
      principal: {
        kind: "session",
        userId: userIdFor(username),
        username,
        displayName: username,
        email: null,
        roles: [],
        permissions: new Set(),
        groups: [],
      },
      source: "web",
      ip,
    }),
    () => auditSync({ action: "auth:login", outcome, detail }),
  );
}
