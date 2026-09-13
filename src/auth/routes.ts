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
import { clearSessionCookie, serializeSessionCookie } from "./cookies.js";
import { clientIp, login, logout, userIdFor } from "./authenticate.js";
import { checkLdapConnection } from "./ldap.js";
import {
  can,
  isRole,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  type Principal,
  type Role,
} from "./model.js";
import { ALL_PROJECTS, resolveRoles } from "./roles.js";
import { authStore } from "./store.js";
import { clearLoginFailures, loginRetryAfterMs, recordLoginFailure } from "./throttle.js";
import { mintToken, tokenDisplayPrefix } from "./tokens.js";
import type { AuditOutcome, AuditSource, TokenRecord } from "./types.js";
import { audit, auditSync } from "../audit.js";

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
      roles: ROLES,
      permissions: PERMISSIONS,
      rolePermissions: ROLE_PERMISSIONS,
      // A development server says so out loud, so nobody mistakes an open
      // instance for a secured one.
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
      await auditLogin(username, "ok", ip, { roles });
      send(
        res,
        200,
        {
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
        },
        {
          "Set-Cookie": serializeSessionCookie(result.cookieValue, {
            name: cfg.cookieName,
            secure: cfg.cookieSecure,
            maxAgeSeconds: cfg.sessionTtlHours * 3600,
          }),
        },
      );
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
    send(res, 200, {
      authenticated: true,
      mode: cfg.mode,
      ...principalPayload(ctx.principal),
    });
    return true;
  }

  // Everything below needs an identified caller.
  const principal = ctx.principal;
  if (!principal) {
    if (pathname.startsWith("/api/auth/") || pathname.startsWith("/api/admin/")) {
      fail(res, 401, "Authentication required.", "UNAUTHENTICATED");
      return true;
    }
    return false;
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

    let maxRole: Role | null = null;
    const rawRole = str(payload.maxRole);
    if (rawRole) {
      if (!isRole(rawRole)) {
        fail(res, 400, `Unknown role '${rawRole}'. Known: ${ROLES.join(", ")}.`);
        return true;
      }
      maxRole = rawRole;
    }

    let projects: string[] | null = null;
    if (Array.isArray(payload.projects)) {
      projects = payload.projects.filter((p): p is string => typeof p === "string" && p.trim() !== "");
      if (projects.length === 0) projects = null;
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
  // Administration — every route below needs `admin:users`
  // -------------------------------------------------------------------------

  if (pathname.startsWith("/api/admin/")) {
    if (!can(principal, "admin:users")) {
      audit({ action: `admin:${pathname}`, outcome: "denied", source: "web", permission: "admin:users" });
      fail(res, 403, "Administrator access is required.");
      return true;
    }

    // --- GET /api/admin/users
    if (pathname === "/api/admin/users" && m === "GET") {
      const store = authStore();
      const [users, bindings] = await Promise.all([store.listUsers(), store.listBindings()]);
      send(
        res,
        200,
        users.map((u) => ({
          ...u,
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
      if (!isRole(role)) {
        fail(res, 400, `Unknown role '${role}'. Known: ${ROLES.join(", ")}.`);
        return true;
      }
      const target = userIdFor(userId);
      if (!(await authStore().getUser(target))) {
        fail(res, 404, `No such user '${target}'. Users appear here after their first sign-in.`);
        return true;
      }
      await authStore().grantRole({
        userId: target,
        projectId,
        role,
        grantedBy: principal.userId,
        grantedAt: now(),
      });
      audit({ action: "admin:role.grant", outcome: "ok", source: "web", detail: { userId: target, projectId, role } });
      send(res, 200, { ok: true });
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
      if (!userId || !role || !isRole(role)) {
        fail(res, 400, "`userId` and a valid `role` are required.");
        return true;
      }
      const removed = await authStore().revokeRole(userIdFor(userId), projectId, role);
      audit({ action: "admin:role.revoke", outcome: "ok", source: "web", detail: { userId, projectId, role, removed } });
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
