/**
 * An in-process LDAP directory for the test suite.
 *
 * Public test directories are unreachable from CI, and a container is a heavy
 * dependency for one smoke suite — so the suite runs a real LDAP server in the
 * test process instead. That matters because the bind path is the part of
 * authentication that cannot be checked by reasoning about it: the filter that
 * goes on the wire, the DN that comes back, and how groups are discovered are
 * all protocol-level behaviour.
 *
 * The directory it serves:
 *
 *   dc=example,dc=test
 *     cn=requ-service                     service account used for the lookup
 *     ou=people
 *       uid=vera                          member of requ-readers
 *       uid=mika                          member of requ-maintainers
 *       uid=nora                          member of nothing
 *       uid=dup1, uid=dup2                both answer to sAMAccountName=dup
 *     ou=groups
 *       cn=requ-readers, cn=requ-maintainers
 */

import ldap from "ldapjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const BASE_DN = "dc=example,dc=test";
export const GROUP_BASE_DN = `ou=groups,${BASE_DN}`;
export const SERVICE_DN = `cn=requ-service,${BASE_DN}`;
export const SERVICE_PASSWORD = "service-secret";

export type FixtureUser = {
  uid: string;
  dn: string;
  password: string;
  displayName: string;
  mail: string;
  /** Group DNs this user belongs to. */
  groups: string[];
  /** Extra attributes, e.g. a second name the filter can match on. */
  extra?: Record<string, string>;
};

function user(
  uid: string,
  password: string,
  displayName: string,
  groups: string[],
  extra?: Record<string, string>,
): FixtureUser {
  return {
    uid,
    dn: `uid=${uid},ou=people,${BASE_DN}`,
    password,
    displayName,
    mail: `${uid}@example.test`,
    groups,
    extra,
  };
}

export const USERS: Record<string, FixtureUser> = {
  vera: user("vera", "vera-secret", "Vera Viewer", [`cn=requ-readers,${GROUP_BASE_DN}`]),
  mika: user("mika", "mika-secret", "Mika Maintainer", [`cn=requ-maintainers,${GROUP_BASE_DN}`]),
  nora: user("nora", "nora-secret", "Nora Nogroup", []),
  // Two entries answering to one sAMAccountName, so the "which one is it?"
  // branch can be checked rather than assumed.
  dup1: user("dup1", "dup-secret", "Dup One", [], { sAMAccountName: "dup" }),
  dup2: user("dup2", "dup-secret", "Dup Two", [], { sAMAccountName: "dup" }),
};

const GROUPS = [
  { dn: `cn=requ-readers,${GROUP_BASE_DN}`, cn: "requ-readers" },
  { dn: `cn=requ-maintainers,${GROUP_BASE_DN}`, cn: "requ-maintainers" },
];

export type LdapFixture = {
  /** URL to hand to REQU_LDAP_URL. */
  url: string;
  /** How many searches the server has answered, per search base. */
  searches: string[];
  stop: () => Promise<void>;
};

export type FixtureOptions = {
  /**
   * `memberOf` publishes each user's groups on their own entry, the way Active
   * Directory does. `search` leaves the entry bare so groups must be found by
   * searching the group tree, the way OpenLDAP does without the overlay.
   * requ supports both, so both are worth serving.
   */
  groupDiscovery?: "memberOf" | "search";
  /** Serve LDAPS with a generated self-signed certificate. */
  tls?: boolean;
  /**
   * Publish every attribute name in lower case, as some directories do —
   * attribute descriptions are case-insensitive (RFC 4512), so a client that
   * looks `memberOf` up by exact key finds nothing and sees a user with no
   * groups at all.
   */
  lowercaseAttributes?: boolean;
};

function lowercaseKeys(attrs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k.toLowerCase(), v]));
}

/** Attributes of a user entry, as the server would publish them. */
function userAttributes(
  u: FixtureUser,
  groupDiscovery: "memberOf" | "search",
  lowercase = false,
): Record<string, unknown> {
  const attrs = {
    objectClass: ["inetOrgPerson", "top"],
    uid: u.uid,
    cn: u.displayName,
    displayName: u.displayName,
    mail: u.mail,
    ...(u.extra ?? {}),
    ...(groupDiscovery === "memberOf" && u.groups.length ? { memberOf: u.groups } : {}),
  };
  return lowercase ? lowercaseKeys(attrs) : attrs;
}

/** A throwaway self-signed certificate, so the LDAPS path is a real TLS handshake. */
function selfSignedCert(): { cert: string; key: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "requ-ldap-tls-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", path.join(dir, "key.pem"),
    "-out", path.join(dir, "cert.pem"),
    "-days", "1",
    "-subj", "/CN=localhost",
  ], { stdio: "ignore" });
  return {
    cert: readFileSync(path.join(dir, "cert.pem"), "utf-8"),
    key: readFileSync(path.join(dir, "key.pem"), "utf-8"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** ldapjs reports the scope as a number on the wire and a word in some builds. */
function isBaseScope(scope: unknown): boolean {
  return scope === 0 || scope === "base";
}

export async function startLdapFixture(options: FixtureOptions = {}): Promise<LdapFixture> {
  const groupDiscovery = options.groupDiscovery ?? "memberOf";
  const tls = options.tls ?? false;
  const lowercase = options.lowercaseAttributes ?? false;
  const searches: string[] = [];

  const tlsMaterial = tls ? selfSignedCert() : null;
  const server = tlsMaterial
    ? ldap.createServer({ certificate: tlsMaterial.cert, key: tlsMaterial.key })
    : ldap.createServer();

  // A client that drops a connection mid-message — which ldapts does after a
  // rejected bind — otherwise raises an unhandled 'error' and takes the test
  // process down with it. A directory does not fall over when a client
  // misbehaves, and neither should the fixture.
  server.on("error", () => {});

  server.unbind((_req: any, res: any, next: any) => {
    res.end();
    return next();
  });

  server.bind(BASE_DN, (req: any, res: any, next: any) => {
    const dn = req.dn.toString().toLowerCase();
    const password = req.credentials;

    // A bind with no password is an *unauthenticated* bind, which a real
    // directory accepts and which would turn any known username into a free
    // login. The fixture reproduces that, so requ's own guard is what is
    // actually being tested.
    if (!password) {
      res.end();
      return next();
    }
    if (dn === SERVICE_DN.toLowerCase()) {
      if (password === SERVICE_PASSWORD) { res.end(); return next(); }
      return next(new ldap.InvalidCredentialsError());
    }
    const match = Object.values(USERS).find((u) => u.dn.toLowerCase() === dn);
    if (match && password === match.password) { res.end(); return next(); }
    return next(new ldap.InvalidCredentialsError());
  });

  server.search(BASE_DN, (req: any, res: any, next: any) => {
    const base = req.dn.toString().toLowerCase();
    searches.push(base);

    // A base-scoped search on a user entry: reading their own attributes.
    if (isBaseScope(req.scope)) {
      const u = Object.values(USERS).find((x) => x.dn.toLowerCase() === base);
      if (u) res.send({ dn: u.dn, attributes: userAttributes(u, groupDiscovery, lowercase) });
      else if (base === BASE_DN.toLowerCase()) res.send({ dn: BASE_DN, attributes: { objectClass: "domain", dc: "example" } });
      res.end();
      return next();
    }

    // Group tree.
    if (base === GROUP_BASE_DN.toLowerCase()) {
      for (const g of GROUPS) {
        const members = Object.values(USERS).filter((u) => u.groups.includes(g.dn));
        const attrs = {
          objectClass: ["groupOfNames", "top"],
          cn: g.cn,
          member: members.map((m) => m.dn),
          memberUid: members.map((m) => m.uid),
        };
        if (req.filter.matches(attrs)) res.send({ dn: g.dn, attributes: attrs });
      }
      res.end();
      return next();
    }

    // Everything else: a subtree search for a user.
    for (const u of Object.values(USERS)) {
      const attrs = userAttributes(u, groupDiscovery, lowercase);
      if (req.filter.matches(attrs)) res.send({ dn: u.dn, attributes: attrs });
    }
    res.end();
    return next();
  });

  const port: number = await new Promise((resolve, reject) => {
    // Port 0 lets the OS pick, so parallel suites cannot collide.
    server.listen(0, "127.0.0.1", (err?: Error) => {
      if (err) return reject(err);
      resolve((server.address() as { port: number }).port);
    });
  });

  return {
    url: `${tls ? "ldaps" : "ldap"}://127.0.0.1:${port}`,
    searches,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          tlsMaterial?.cleanup();
          resolve();
        });
      }),
  };
}
