/**
 * Authentication configuration, read once from the environment.
 *
 * Two modes, so the same build runs unattended on a laptop and locked down in
 * production:
 *
 *   REQU_AUTH_MODE=disabled  (default) — no login, every caller is an admin.
 *   REQU_AUTH_MODE=ldap                — users authenticate against a directory.
 *
 * Nothing here talks to the network; `ldap.ts` does that with the settings this
 * module validates.
 */

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { isRole, type Role } from "./model.js";

export type AuthMode = "disabled" | "ldap";

/**
 * How hard the second factor is pushed.
 *
 *  off       — not offered at all;
 *  optional  — anyone may enrol, nobody must;
 *  required  — everyone must, and a sign-in without one leads to enrolment.
 */
export type TwoFactorMode = "off" | "optional" | "required";

export type LdapConfig = {
  url: string;
  /** Service account used to search for users. Empty means anonymous search. */
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  /** Search filter for the login name; `{{username}}` is substituted. */
  userFilter: string;
  /**
   * Optional DN template for a direct bind, e.g. `uid={{username}},ou=people,dc=acme,dc=com`.
   * When set, requ binds as the user straight away and only searches afterwards
   * to read their attributes — useful for directories that forbid anonymous or
   * service-account search.
   */
  userDnTemplate: string | null;
  /** Attributes tried in order for the display name. */
  displayNameAttrs: string[];
  emailAttrs: string[];
  /** Where to look for groups. Defaults to `baseDn`. */
  groupBaseDn: string;
  /** `{{dn}}` and `{{username}}` are substituted. */
  groupFilter: string;
  /** Attribute holding the group's name, e.g. `cn`. */
  groupNameAttr: string;
  /**
   * Attribute on the *user* entry that already lists their groups
   * (`memberOf` on Active Directory). When present it is used first and the
   * group search is skipped.
   */
  memberOfAttr: string | null;
  timeoutMs: number;
  /** Set false only for a directory with a self-signed certificate you trust. */
  tlsRejectUnauthorized: boolean;
};

export type AuthConfig = {
  mode: AuthMode;
  enabled: boolean;
  /** HMAC key for session cookies and the token pepper. */
  secret: string;
  /** True when `secret` was generated at boot, so sessions die with the process. */
  ephemeralSecret: boolean;
  sessionTtlHours: number;
  /** 0 means tokens never expire on their own. */
  tokenTtlDays: number;
  /** Role granted to a user no group mapping matched. `null` denies the login. */
  defaultRole: Role | null;
  /** Usernames that are always admin, so a fresh install has a way in. */
  bootstrapAdmins: string[];
  /** Directory group name (lower-cased) → role. */
  roleMap: Map<string, Role>;
  /** Whether the audit log and change history are recorded. */
  auditEnabled: boolean;
  /** Only set when `mode === "ldap"`. */
  ldap: LdapConfig | null;
  /** SQLite fallback location for auth data when REQU_PG_URL is not set. */
  sqlitePath: string;
  /** Cookie name for the dashboard session. */
  cookieName: string;
  /** Send the session cookie with `Secure`. Defaults to on for ldap mode. */
  cookieSecure: boolean;
  /** Second factor (TOTP: Microsoft Authenticator, Google Authenticator, …). */
  twoFactor: TwoFactorMode;
  /**
   * Roles for which the second factor is mandatory even when the mode is
   * `optional` — "everyone may, administrators must" is the common policy.
   */
  twoFactorRequiredRoles: Role[];
  /** Name shown beside the account in the authenticator app. */
  twoFactorIssuer: string;
};

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function envBool(name: string, fallback: boolean): boolean {
  const v = env(name);
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function envInt(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new AuthConfigError(`${name} must be a non-negative integer, got '${v}'.`);
  }
  return n;
}

function envList(name: string): string[] {
  const v = env(name);
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse `group=role` pairs. The group may be a bare name (`requ-admins`) or a
 * full DN (`cn=requ-admins,ou=groups,dc=acme,dc=com`); both are matched against
 * what the directory returns, so operators can use whichever they have to hand.
 */
function parseRoleMap(raw: string | undefined): Map<string, Role> {
  const map = new Map<string, Role>();
  if (!raw) return map;
  // A DN contains commas, so split on the *last* separator style that cannot
  // appear inside a DN: entries are separated by ';' when any entry has a DN,
  // and by ',' otherwise.
  const entries = raw.includes(";") ? raw.split(";") : raw.split(",");
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.lastIndexOf("=");
    if (eq === -1) {
      throw new AuthConfigError(
        `REQU_LDAP_ROLE_MAP entry '${trimmed}' is not 'group=role'. ` +
          `Use ';' between entries when a group is written as a full DN.`,
      );
    }
    const group = trimmed.slice(0, eq).trim().toLowerCase();
    const role = trimmed.slice(eq + 1).trim().toLowerCase();
    if (!group) throw new AuthConfigError(`REQU_LDAP_ROLE_MAP entry '${trimmed}' has an empty group.`);
    if (!isRole(role)) {
      throw new AuthConfigError(
        `REQU_LDAP_ROLE_MAP entry '${trimmed}' names an unknown role '${role}'. ` +
          `Known roles: viewer, contributor, maintainer, admin.`,
      );
    }
    map.set(group, role);
  }
  return map;
}

function parseLdap(): LdapConfig {
  const url = env("REQU_LDAP_URL");
  if (!url) {
    throw new AuthConfigError(
      "REQU_AUTH_MODE=ldap requires REQU_LDAP_URL (e.g. ldaps://ldap.example.com:636).",
    );
  }
  const baseDn = env("REQU_LDAP_BASE_DN");
  if (!baseDn) {
    throw new AuthConfigError("REQU_AUTH_MODE=ldap requires REQU_LDAP_BASE_DN.");
  }
  if (url.startsWith("ldap://") && !envBool("REQU_LDAP_ALLOW_PLAINTEXT", false)) {
    throw new AuthConfigError(
      `REQU_LDAP_URL is plaintext ldap://, which sends passwords in the clear. ` +
        `Use ldaps:// — or set REQU_LDAP_ALLOW_PLAINTEXT=true if the link is already secured.`,
    );
  }

  return {
    url,
    bindDn: env("REQU_LDAP_BIND_DN") ?? "",
    bindPassword: env("REQU_LDAP_BIND_PASSWORD") ?? "",
    baseDn,
    userFilter: env("REQU_LDAP_USER_FILTER") ?? "(|(uid={{username}})(sAMAccountName={{username}}))",
    userDnTemplate: env("REQU_LDAP_USER_DN_TEMPLATE") ?? null,
    displayNameAttrs: envList("REQU_LDAP_ATTR_DISPLAY_NAME").length
      ? envList("REQU_LDAP_ATTR_DISPLAY_NAME")
      : ["displayName", "cn", "givenName"],
    emailAttrs: envList("REQU_LDAP_ATTR_EMAIL").length ? envList("REQU_LDAP_ATTR_EMAIL") : ["mail", "userPrincipalName"],
    groupBaseDn: env("REQU_LDAP_GROUP_BASE_DN") ?? baseDn,
    groupFilter: env("REQU_LDAP_GROUP_FILTER") ?? "(|(member={{dn}})(memberUid={{username}}))",
    groupNameAttr: env("REQU_LDAP_GROUP_ATTR") ?? "cn",
    memberOfAttr: env("REQU_LDAP_MEMBEROF_ATTR") ?? "memberOf",
    timeoutMs: envInt("REQU_LDAP_TIMEOUT_MS", 5_000),
    tlsRejectUnauthorized: envBool("REQU_LDAP_TLS_REJECT_UNAUTHORIZED", true),
  };
}

let _config: AuthConfig | null = null;

/** Parse and validate the environment. Throws `AuthConfigError` on bad input. */
export function loadAuthConfig(): AuthConfig {
  const rawMode = (env("REQU_AUTH_MODE") ?? "disabled").toLowerCase();
  if (rawMode !== "disabled" && rawMode !== "ldap") {
    throw new AuthConfigError(
      `REQU_AUTH_MODE must be 'disabled' or 'ldap', got '${rawMode}'.`,
    );
  }
  const mode = rawMode as AuthMode;
  const enabled = mode !== "disabled";

  let secret = env("REQU_AUTH_SECRET") ?? "";
  let ephemeralSecret = false;
  if (!secret) {
    if (enabled) {
      throw new AuthConfigError(
        "REQU_AUTH_SECRET is required when authentication is enabled. " +
          "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
    secret = crypto.randomBytes(32).toString("hex");
    ephemeralSecret = true;
  } else if (enabled && secret.length < 32) {
    throw new AuthConfigError("REQU_AUTH_SECRET must be at least 32 characters.");
  }

  const rawDefaultRole = (env("REQU_AUTH_DEFAULT_ROLE") ?? "viewer").toLowerCase();
  let defaultRole: Role | null;
  if (rawDefaultRole === "none" || rawDefaultRole === "deny") {
    defaultRole = null;
  } else if (isRole(rawDefaultRole)) {
    defaultRole = rawDefaultRole;
  } else {
    throw new AuthConfigError(
      `REQU_AUTH_DEFAULT_ROLE must be one of viewer, contributor, maintainer, admin, none — got '${rawDefaultRole}'.`,
    );
  }

  const rawTwoFactor = (env("REQU_2FA") ?? "off").toLowerCase();
  if (!["off", "optional", "required"].includes(rawTwoFactor)) {
    throw new AuthConfigError(`REQU_2FA must be 'off', 'optional' or 'required', got '${rawTwoFactor}'.`);
  }
  if (rawTwoFactor !== "off" && !enabled) {
    throw new AuthConfigError(
      "REQU_2FA needs REQU_AUTH_MODE=ldap: a second factor is meaningless without a first one.",
    );
  }
  const twoFactorRequiredRoles: Role[] = [];
  for (const raw of envList("REQU_2FA_REQUIRED_ROLES")) {
    const role = raw.toLowerCase();
    if (!isRole(role)) {
      throw new AuthConfigError(
        `REQU_2FA_REQUIRED_ROLES names an unknown role '${raw}'. Known: viewer, contributor, maintainer, admin.`,
      );
    }
    twoFactorRequiredRoles.push(role);
  }
  if (twoFactorRequiredRoles.length > 0 && rawTwoFactor === "off") {
    throw new AuthConfigError(
      "REQU_2FA_REQUIRED_ROLES has no effect while REQU_2FA=off. Set REQU_2FA=optional to require it for those roles.",
    );
  }

  const rawAudit = (env("REQU_AUDIT") ?? "auto").toLowerCase();
  if (!["auto", "on", "off"].includes(rawAudit)) {
    throw new AuthConfigError(`REQU_AUDIT must be 'auto', 'on' or 'off', got '${rawAudit}'.`);
  }
  const auditEnabled = rawAudit === "on" || (rawAudit === "auto" && enabled);

  return {
    mode,
    enabled,
    secret,
    ephemeralSecret,
    sessionTtlHours: envInt("REQU_AUTH_SESSION_TTL_HOURS", 12) || 12,
    tokenTtlDays: envInt("REQU_AUTH_TOKEN_TTL_DAYS", 0),
    defaultRole,
    bootstrapAdmins: envList("REQU_AUTH_ADMINS").map((s) => s.toLowerCase()),
    roleMap: parseRoleMap(env("REQU_LDAP_ROLE_MAP")),
    auditEnabled,
    ldap: mode === "ldap" ? parseLdap() : null,
    sqlitePath:
      env("REQU_AUTH_DB") ?? path.join(os.homedir(), ".requ", "auth.db"),
    cookieName: env("REQU_AUTH_COOKIE") ?? "requ_session",
    cookieSecure: envBool("REQU_AUTH_COOKIE_SECURE", enabled),
    twoFactor: rawTwoFactor as TwoFactorMode,
    twoFactorRequiredRoles,
    twoFactorIssuer: env("REQU_2FA_ISSUER") ?? "requ",
  };
}

/** Process-wide config, parsed on first use. */
export function authConfig(): AuthConfig {
  if (!_config) _config = loadAuthConfig();
  return _config;
}

/** Replace the cached config — for tests and for an explicit boot-time load. */
export function setAuthConfig(cfg: AuthConfig): void {
  _config = cfg;
}

export function resetAuthConfig(): void {
  _config = null;
}
