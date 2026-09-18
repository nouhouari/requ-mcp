/**
 * LDAP directory access.
 *
 * One entry point — `authenticateLdap` — which proves a password and returns
 * the directory's view of the user (dn, display name, mail, groups). Nothing
 * here knows about roles or requ's data model; `roles.ts` maps groups to roles.
 *
 * `ldapts` is imported lazily so that a server running with authentication
 * disabled never opens the module, and a packaging problem with it cannot stop
 * a development instance from booting.
 */

import type { Client, Entry } from "ldapts";
import type { LdapConfig } from "./config.js";

export type DirectoryUser = {
  dn: string;
  username: string;
  displayName: string;
  email: string | null;
  /** Group names, and the full DNs when the directory reported them. */
  groups: string[];
};

export class LdapError extends Error {
  /** True when the directory answered and rejected the credentials. */
  readonly invalidCredentials: boolean;
  constructor(message: string, invalidCredentials = false) {
    super(message);
    this.name = "LdapError";
    this.invalidCredentials = invalidCredentials;
  }
}

/**
 * Escape a value for use inside an LDAP filter (RFC 4515).
 *
 * Without this, a username of `*` matches every entry and `)(uid=admin` ends the
 * filter early — filter injection is the LDAP equivalent of SQL injection.
 */
export function escapeFilterValue(value: string): string {
  let out = "";
  for (const ch of value) {
    switch (ch) {
      case "\\": out += "\\5c"; break;
      case "*":  out += "\\2a"; break;
      case "(":  out += "\\28"; break;
      case ")":  out += "\\29"; break;
      case "\0": out += "\\00"; break;
      case "/":  out += "\\2f"; break;
      default:
        // Control characters have no business in a filter either.
        out += ch.charCodeAt(0) < 0x20 ? `\\${ch.charCodeAt(0).toString(16).padStart(2, "0")}` : ch;
    }
  }
  return out;
}

/**
 * Escape a value placed inside a DN (RFC 4514), for `REQU_LDAP_USER_DN_TEMPLATE`.
 */
export function escapeDnValue(value: string): string {
  return value
    .replace(/([\\,+"<>;=])/g, "\\$1")
    .replace(/^ /, "\\ ")
    .replace(/ $/, "\\ ")
    .replace(/^#/, "\\#");
}

function substituteFilter(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
    escapeFilterValue(vars[name] ?? ""),
  );
}

function substituteDn(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => escapeDnValue(vars[name] ?? ""));
}

/**
 * Read an attribute regardless of how the directory cased its name.
 *
 * Attribute descriptions are case-insensitive (RFC 4512), and directories do
 * disagree: one returns `memberOf`, another `memberof`. An exact-key lookup
 * silently finds nothing — which for the group attribute means every user looks
 * like they belong to no group and quietly falls back to the default role.
 */
function rawAttr(entry: Entry, name: string): unknown {
  if (name in entry) return entry[name];
  const wanted = name.toLowerCase();
  for (const key of Object.keys(entry)) {
    if (key.toLowerCase() === wanted) return entry[key];
  }
  return undefined;
}

/** Every value of an entry attribute, as non-empty strings. */
function attrAll(entry: Entry, name: string): string[] {
  const raw = rawAttr(entry, name);
  if (raw === undefined || raw === null) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .map((v) => (Buffer.isBuffer(v) ? v.toString("utf-8") : String(v)))
    .filter((s) => s.trim() !== "");
}

/** First non-empty value of an entry attribute. */
function attr(entry: Entry, name: string): string | null {
  return attrAll(entry, name)[0] ?? null;
}

function firstAttr(entry: Entry, names: string[]): string | null {
  for (const n of names) {
    const v = attr(entry, n);
    if (v) return v;
  }
  return null;
}

/**
 * The RDN value of a DN — `cn=requ-admins,ou=groups,dc=acme` → `requ-admins`.
 * Group role mapping accepts either form, so both are recorded.
 */
export function rdnValue(dn: string): string | null {
  const first = dn.split(",")[0];
  const eq = first.indexOf("=");
  return eq === -1 ? null : first.slice(eq + 1).trim();
}

async function newClient(cfg: LdapConfig): Promise<Client> {
  const { Client: LdapClient } = await import("ldapts");
  // ldapts turns TLS on when *either* the scheme is ldaps: or tlsOptions is
  // present, so passing tlsOptions unconditionally would make a plaintext
  // ldap:// deployment fail the TLS handshake against a server that never
  // offered one — reported as "socket disconnected before secure TLS connection
  // was established", which points nowhere near the cause.
  const secure = cfg.url.trim().toLowerCase().startsWith("ldaps:");
  return new LdapClient({
    url: cfg.url,
    timeout: cfg.timeoutMs,
    connectTimeout: cfg.timeoutMs,
    ...(secure ? { tlsOptions: { rejectUnauthorized: cfg.tlsRejectUnauthorized } } : {}),
  });
}

/** True when the error is the directory rejecting the password, not a fault. */
function isInvalidCredentials(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  const code = (err as { code?: number })?.code;
  return name === "InvalidCredentialsError" || code === 49;
}

/**
 * Look the user up, bind as them to prove the password, then collect groups.
 *
 * Two search strategies, both supported because directories differ:
 *  - `userDnTemplate` set → bind straight away at the templated DN, then read
 *    the entry as the user themselves (works when search is closed off).
 *  - otherwise → bind with the service account, search `userFilter`, then
 *    re-bind as the found DN with the supplied password.
 */
export async function authenticateLdap(
  cfg: LdapConfig,
  username: string,
  password: string,
): Promise<DirectoryUser> {
  // An empty password makes most directories perform an *unauthenticated* bind
  // that succeeds, which would turn any known username into a free login.
  if (!password) throw new LdapError("Password is required.", true);
  if (!username.trim()) throw new LdapError("Username is required.", true);

  const client = await newClient(cfg);
  try {
    let userDn: string | null = null;

    if (cfg.userDnTemplate) {
      userDn = substituteDn(cfg.userDnTemplate, { username });
      try {
        await client.bind(userDn, password);
      } catch (err) {
        if (isInvalidCredentials(err)) throw new LdapError("Invalid username or password.", true);
        throw new LdapError(`LDAP bind failed: ${(err as Error).message}`);
      }
    } else {
      if (cfg.bindDn) {
        try {
          await client.bind(cfg.bindDn, cfg.bindPassword);
        } catch (err) {
          throw new LdapError(
            `LDAP service account bind failed — check REQU_LDAP_BIND_DN / REQU_LDAP_BIND_PASSWORD: ${(err as Error).message}`,
          );
        }
      }
      const filter = substituteFilter(cfg.userFilter, { username });
      const { searchEntries } = await client.search(cfg.baseDn, {
        scope: "sub",
        filter,
        sizeLimit: 2,
      });
      if (searchEntries.length === 0) throw new LdapError("Invalid username or password.", true);
      if (searchEntries.length > 1) {
        throw new LdapError(
          `Username '${username}' matched ${searchEntries.length} directory entries — tighten REQU_LDAP_USER_FILTER.`,
        );
      }
      userDn = searchEntries[0].dn;
      try {
        await client.bind(userDn, password);
      } catch (err) {
        if (isInvalidCredentials(err)) throw new LdapError("Invalid username or password.", true);
        throw new LdapError(`LDAP bind failed: ${(err as Error).message}`);
      }
    }

    // Read the user entry. We are bound as the user now, which is the identity
    // most likely to be allowed to read its own attributes.
    //
    // `*` asks for every user attribute rather than naming each one: servers
    // match a requested attribute list case-sensitively often enough that
    // spelling `displayName` can return nothing on a directory that calls it
    // `displayname`. The group attribute is named as well, because on Active
    // Directory it is constructed and `*` alone does not always include it.
    const wanted = ["*", ...(cfg.memberOfAttr ? [cfg.memberOfAttr] : [])];
    let entry: Entry | null = null;
    try {
      const res = await client.search(userDn, {
        scope: "base",
        filter: "(objectClass=*)",
        attributes: wanted,
      });
      entry = res.searchEntries[0] ?? null;
    } catch {
      // Directory refuses a base search on the user entry — fall back to the
      // login name, which is all we strictly need.
      entry = null;
    }

    const groups = new Set<string>();
    if (entry && cfg.memberOfAttr) {
      for (const dn of attrAll(entry, cfg.memberOfAttr)) {
        groups.add(dn);
        const rdn = rdnValue(dn);
        if (rdn) groups.add(rdn);
      }
    }

    // No memberOf (OpenLDAP without the overlay): search the group tree.
    if (groups.size === 0) {
      try {
        const groupFilter = cfg.groupFilter
          .replace(/\{\{dn\}\}/g, escapeFilterValue(userDn))
          .replace(/\{\{username\}\}/g, escapeFilterValue(username));
        const res = await client.search(cfg.groupBaseDn, {
          scope: "sub",
          filter: groupFilter,
          attributes: [cfg.groupNameAttr],
        });
        for (const g of res.searchEntries) {
          const name = attr(g, cfg.groupNameAttr);
          if (name) groups.add(name);
          groups.add(g.dn);
        }
      } catch (err) {
        // Group discovery failing must not deny the login: the user still gets
        // the default role. Roles are re-resolved on the next login anyway.
        console.error(`[requ-mcp] LDAP group search failed for '${username}':`, (err as Error).message);
      }
    }

    return {
      dn: userDn,
      username: (entry && (attr(entry, "uid") ?? attr(entry, "sAMAccountName"))) || username,
      displayName: (entry && firstAttr(entry, cfg.displayNameAttrs)) || username,
      email: entry ? firstAttr(entry, cfg.emailAttrs) : null,
      groups: [...groups],
    };
  } finally {
    try {
      await client.unbind();
    } catch {
      // The socket is going away regardless.
    }
  }
}

/**
 * Prove the configuration reaches the directory, without any user's password.
 * Used by the health endpoint so a misconfiguration surfaces before someone
 * tries to log in.
 */
export async function checkLdapConnection(cfg: LdapConfig): Promise<void> {
  const client = await newClient(cfg);
  try {
    if (cfg.bindDn) await client.bind(cfg.bindDn, cfg.bindPassword);
    await client.search(cfg.baseDn, { scope: "base", filter: "(objectClass=*)", sizeLimit: 1 });
  } finally {
    try {
      await client.unbind();
    } catch {
      /* closing */
    }
  }
}
