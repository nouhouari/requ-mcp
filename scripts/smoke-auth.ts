/**
 * End-to-end smoke test for authentication, RBAC, the audit log and the
 * per-entity change history.
 *
 * Two servers are driven:
 *
 *  1. **auth off, audit on** — the development posture. Everything still works
 *     without credentials, and every write is still recorded, so a laptop keeps
 *     a usable "what changed" history.
 *  2. **auth on (ldap mode)** — the production posture. Unauthenticated calls
 *     are refused on both the MCP endpoint and the REST API; personal access
 *     tokens carry a role; a viewer may read but not write; a maintainer may
 *     write; revoking a token takes effect immediately.
 *
 * No directory is needed: the suite seeds users and tokens straight into the
 * auth store the server reads, which is exactly what a successful LDAP bind
 * would have produced. The LDAP bind itself is exercised only for its failure
 * path, where an unreachable directory must produce a clean error rather than a
 * stack trace.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness, slugFor } from "./lib/http-harness.js";
import type { AuthConfig } from "../src/auth/config.js";
import {
  BASE_DN,
  GROUP_BASE_DN,
  SERVICE_DN,
  SERVICE_PASSWORD,
  startLdapFixture,
  USERS,
  type FixtureOptions,
} from "./lib/ldap-fixture.js";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

const SECRET = "smoke-secret-smoke-secret-smoke-secret-0123456789";

/** Seed a user and mint a token directly in the auth store the server reads. */
async function seed(
  authDb: string,
  user: { id: string; groups: string[] },
  token: { name: string; maxRole?: "viewer" | "contributor" | "maintainer" | "admin" | null; projects?: string[] | null },
): Promise<string> {
  // Point the modules at the same database and secret the server uses.
  process.env.REQU_AUTH_DB = authDb;
  process.env.REQU_AUTH_SECRET = SECRET;
  process.env.REQU_AUTH_MODE = "disabled"; // the seeder itself does not authenticate
  const { resetAuthConfig } = await import("../src/auth/config.js");
  const { authStore, setAuthStore } = await import("../src/auth/store.js");
  resetAuthConfig();
  setAuthStore(null);

  const store = authStore();
  await store.init();
  await store.upsertUser({
    id: user.id,
    username: user.id,
    displayName: user.id,
    email: `${user.id}@example.test`,
    dn: `uid=${user.id},ou=people,dc=example,dc=test`,
    groups: user.groups,
    disabled: false,
    lastLoginAt: new Date().toISOString(),
  });

  const { mintToken } = await import("../src/auth/tokens.js");
  const minted = mintToken(SECRET);
  await store.createToken({
    id: minted.id,
    userId: user.id,
    name: token.name,
    tokenHash: minted.hash,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    revokedBy: null,
    maxRole: token.maxRole ?? null,
    projects: token.projects ?? null,
    // `tokenHash` is carried alongside the record; the type demands both.
  } as any);
  return minted.plaintext;
}

async function revokeSeededToken(authDb: string, plaintext: string): Promise<void> {
  process.env.REQU_AUTH_DB = authDb;
  const { authStore, setAuthStore } = await import("../src/auth/store.js");
  const { parseToken } = await import("../src/auth/tokens.js");
  setAuthStore(null);
  const parsed = parseToken(plaintext)!;
  await authStore().revokeToken(parsed.id, "smoke");
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "requ-auth-"));

  // =========================================================================
  console.log("\n— development mode: auth off, audit on —");
  // =========================================================================
  {
    const root = path.join(tmp, "devproj");
    await fs.mkdir(root, { recursive: true });
    const authDb = path.join(tmp, "dev-auth.db");
    const h = await startHarness([root], "smoke-auth-dev", {
      env: { REQU_AUTH_MODE: "disabled", REQU_AUDIT: "on", REQU_AUTH_DB: authDb },
    });
    const slug = slugFor(root);
    try {
      const cfg = await getJson(`${h.base}/api/auth/config`);
      check("auth config reports disabled", cfg.body.enabled === false && cfg.body.mode === "disabled", cfg.body);
      check("auth config warns that the server is open", typeof cfg.body.warning === "string", cfg.body.warning);

      const me = await getJson(`${h.base}/api/auth/me`);
      check("/api/auth/me reports the development principal", me.body.authenticated === true && me.body.kind === "anonymous", me.body);
      check("development principal is an admin", Array.isArray(me.body.roles) && me.body.roles.includes("admin"), me.body.roles);

      check("no credentials needed to read", (await getJson(`${h.base}/api/version`)).status === 200);

      const init = await h.call("init_project", { name: "Dev Project", initialPhase: "v1.0", force: true });
      check("init_project works without credentials", !init.isError, init.data);

      const created = await h.call("create_requirement", { title: "Audited requirement", priority: "high" });
      check("create_requirement works without credentials", !created.isError, created.data);
      const reqId = created.data?.id;

      const updated = await h.call("update_requirement", { id: reqId, title: "Renamed requirement", priority: "critical" });
      check("update_requirement succeeds", !updated.isError, updated.data);

      // Change history — the Jira-style record.
      const hist = await getJson(`${h.base}/api/history/requirement/${encodeURIComponent(reqId)}?project=${slug}`);
      check("entity history is readable", hist.status === 200 && hist.body.enabled === true, hist.body);
      const changes = hist.body.changes ?? [];
      check("history has a creation and an update", changes.length >= 2, changes.map((c: any) => c.action));
      check("newest history entry is the update", changes[0]?.action === "updated", changes[0]);
      const titleChange = (changes[0]?.changes ?? []).find((c: any) => c.field === "title");
      check(
        "the title change records both sides",
        titleChange?.from === "Audited requirement" && titleChange?.to === "Renamed requirement",
        titleChange,
      );
      check(
        "updatedAt is not reported as a change",
        !(changes[0]?.changes ?? []).some((c: any) => c.field === "updatedAt"),
        changes[0]?.changes,
      );
      check("the change names an actor", typeof changes[0]?.actorId === "string" && changes[0].actorId.length > 0, changes[0]?.actorId);
      check("the change records its source", changes[0]?.source === "mcp", changes[0]?.source);

      // Project-wide history stream.
      const stream = await getJson(`${h.base}/api/history?project=${slug}`);
      check("project history stream is readable", stream.status === 200 && (stream.body.changes ?? []).length >= 2, stream.body.total);

      // Audit log.
      const auditRes = await getJson(`${h.base}/api/audit?project=${slug}&limit=200`);
      check("audit log is readable", auditRes.status === 200 && auditRes.body.enabled === true, auditRes.body);
      const actions = (auditRes.body.entries ?? []).map((e: any) => e.action);
      check("audit recorded the tool calls", actions.includes("create_requirement") && actions.includes("update_requirement"), actions.slice(0, 10));
      const createEntry = (auditRes.body.entries ?? []).find((e: any) => e.action === "create_requirement");
      check("audit entry carries the outcome", createEntry?.outcome === "ok", createEntry);
      check("audit entry carries the permission checked", createEntry?.permission === "requirement:write", createEntry?.permission);
      check("audit entry carries the project", createEntry?.projectId === slug, createEntry?.projectId);
      check("audit entry summarises the arguments", createEntry?.detail?.title === "Audited requirement", createEntry?.detail);

      // A REST write is recorded the same way as an MCP call.
      const restRes = await fetch(`${h.base}/api/config?project=${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: "Updated over REST" }),
      });
      check("REST config update succeeds", restRes.ok, restRes.status);
      const afterRest = await getJson(`${h.base}/api/history?project=${slug}&entity=project`);
      check("REST writes land in the change history", (afterRest.body.changes ?? []).length >= 1, afterRest.body.total);
      check("REST change is attributed to the web source", afterRest.body.changes?.[0]?.source === "web", afterRest.body.changes?.[0]);
    } finally {
      await h.stop();
    }
  }

  // =========================================================================
  console.log("\n— production mode: authentication required —");
  // =========================================================================
  {
    const root = path.join(tmp, "prodproj");
    await fs.mkdir(root, { recursive: true });
    const slug = slugFor(root);
    const authDb = path.join(tmp, "prod-auth.db");

    // Seed the identities a successful LDAP bind would have produced.
    const viewerToken = await seed(authDb, { id: "vera", groups: ["cn=requ-readers,ou=groups,dc=example,dc=test"] }, { name: "vera laptop" });
    const maintainerToken = await seed(authDb, { id: "mika", groups: ["cn=requ-maintainers,ou=groups,dc=example,dc=test"] }, { name: "mika ci" });
    const cappedToken = await seed(authDb, { id: "mika", groups: ["cn=requ-maintainers,ou=groups,dc=example,dc=test"] }, { name: "mika read-only", maxRole: "viewer" });
    const scopedToken = await seed(authDb, { id: "mika", groups: ["cn=requ-maintainers,ou=groups,dc=example,dc=test"] }, { name: "other project only", projects: ["some-other-project"] });

    const env = {
      REQU_AUTH_MODE: "ldap",
      REQU_AUTH_SECRET: SECRET,
      REQU_AUTH_DB: authDb,
      REQU_AUDIT: "on",
      // Never contacted except by the login test below, which asserts it fails cleanly.
      REQU_LDAP_URL: "ldaps://127.0.0.1:1",
      REQU_LDAP_BASE_DN: "dc=example,dc=test",
      REQU_LDAP_ROLE_MAP: "requ-readers=viewer;requ-maintainers=maintainer",
      REQU_AUTH_DEFAULT_ROLE: "none",
    };

    // --- unauthenticated ---
    const anon = await startHarness([root], "smoke-auth-anon", { env, connectMcp: false });
    try {
      const summary = await getJson(`${anon.base}/api/summary?project=${slug}`);
      check("unauthenticated REST read is refused", summary.status === 401, summary);
      check("the refusal names the reason", typeof summary.body.error === "string", summary.body);

      const mcp = await fetch(`${anon.base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      check("unauthenticated MCP call is refused", mcp.status === 401, mcp.status);
      check("the MCP refusal asks for a bearer token", (mcp.headers.get("www-authenticate") ?? "").includes("Bearer"), mcp.headers.get("www-authenticate"));

      const bad = await getJson(`${anon.base}/api/summary?project=${slug}`, { Authorization: "Bearer requ_pat_nope_nope" });
      check("an unknown token is refused", bad.status === 401, bad);

      const cfg = await getJson(`${anon.base}/api/auth/config`);
      check("auth config stays public", cfg.status === 200 && cfg.body.enabled === true, cfg.body);
      check("auth config does not leak the secret", !JSON.stringify(cfg.body).includes(SECRET));

      const meAnon = await getJson(`${anon.base}/api/auth/me`);
      check("/api/auth/me reports an anonymous caller", meAnon.status === 200 && meAnon.body.authenticated === false, meAnon.body);

      // An unreachable directory must fail cleanly, not crash the server.
      const loginRes = await fetch(`${anon.base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "vera", password: "hunter2" }),
      });
      check("login against an unreachable directory fails cleanly", loginRes.status === 502 || loginRes.status === 401, loginRes.status);
      check("the server is still alive after a failed login", (await getJson(`${anon.base}/api/version`)).status === 200);

      const emptyPassword = await fetch(`${anon.base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "vera", password: "" }),
      });
      check("login with an empty password is rejected before the directory", emptyPassword.status === 400, emptyPassword.status);

      const allure = await getJson(`${anon.base}/allure/${slug}/`);
      check("the Allure report is not served to an unauthenticated caller", allure.status === 401 || allure.status === 403, allure.status);
    } finally {
      await anon.stop();
    }

    // --- viewer ---
    const viewer = await startHarness([root], "smoke-auth-viewer", {
      env,
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    try {
      const me = await getJson(`${viewer.base}/api/auth/me`, { Authorization: `Bearer ${viewerToken}` });
      check("a token identifies its owner", me.body.username === "vera" && me.body.kind === "token", me.body);
      check("the group mapping granted the viewer role", me.body.roles?.includes("viewer") === true, me.body.roles);
      check("a viewer may read", me.body.permissions?.includes("spec:read") === true, me.body.permissions);
      check("a viewer may not write", me.body.permissions?.includes("requirement:write") !== true, me.body.permissions);
      check("/api/auth/me names the token", me.body.tokenName === "vera laptop", me.body.tokenName);

      const init = await viewer.call("init_project", { key: slug, name: "Prod Project", initialPhase: "v1.0", force: true });
      check("a viewer may not create a project", init.isError === true, init.data);

      const read = await getJson(`${viewer.base}/api/summary?project=${slug}`, { Authorization: `Bearer ${viewerToken}` });
      // The project is not initialized yet, so 503 is the expected read answer —
      // what matters is that it is not 401/403.
      check("a viewer's read is authorised", read.status !== 401 && read.status !== 403, read.status);

      const auditDenied = await getJson(`${viewer.base}/api/audit?project=${slug}`, { Authorization: `Bearer ${viewerToken}` });
      check("a viewer may not read the audit log", auditDenied.status === 403, auditDenied);
    } finally {
      await viewer.stop();
    }

    // --- maintainer ---
    let reqId: string | undefined;
    const maint = await startHarness([root], "smoke-auth-maint", {
      env,
      headers: { Authorization: `Bearer ${maintainerToken}` },
    });
    try {
      const me = await getJson(`${maint.base}/api/auth/me`, { Authorization: `Bearer ${maintainerToken}` });
      check("the group mapping granted the maintainer role", me.body.roles?.includes("maintainer") === true, me.body.roles);

      const init = await maint.call("init_project", { key: slug, name: "Prod Project", initialPhase: "v1.0", force: true });
      check("a maintainer may create a project", !init.isError, init.data);

      const created = await maint.call("create_requirement", { title: "Locked down", priority: "high" });
      check("a maintainer may write", !created.isError, created.data);
      reqId = created.data?.id;

      const hist = await getJson(`${maint.base}/api/history/requirement/${encodeURIComponent(reqId!)}?project=${slug}`, {
        Authorization: `Bearer ${maintainerToken}`,
      });
      check("the change is attributed to the maintainer", hist.body.changes?.[0]?.actorId === "mika", hist.body.changes?.[0]);

      const auditRes = await getJson(`${maint.base}/api/audit?project=${slug}&limit=200`, {
        Authorization: `Bearer ${maintainerToken}`,
      });
      check("a maintainer may read the audit log", auditRes.status === 200, auditRes.status);
      const denials = (auditRes.body.entries ?? []).filter((e: any) => e.outcome === "denied");
      check("the viewer's refused write was audited", denials.some((e: any) => e.actorId === "vera"), denials.slice(0, 5));
      check("the denial records the missing permission", denials.some((e: any) => e.permission === "project:manage"), denials.slice(0, 5));
      const tokenEntry = (auditRes.body.entries ?? []).find((e: any) => e.actorId === "mika" && e.action === "create_requirement");
      check("the audit entry names the token used", typeof tokenEntry?.tokenId === "string" && tokenEntry.tokenId.length > 0, tokenEntry?.tokenId);

      const adminDenied = await getJson(`${maint.base}/api/admin/users`, { Authorization: `Bearer ${maintainerToken}` });
      check("a maintainer is not an administrator", adminDenied.status === 403, adminDenied.status);
    } finally {
      await maint.stop();
    }

    // --- a token capped below its owner's role ---
    const capped = await startHarness([root], "smoke-auth-capped", {
      env,
      headers: { Authorization: `Bearer ${cappedToken}` },
    });
    try {
      const me = await getJson(`${capped.base}/api/auth/me`, { Authorization: `Bearer ${cappedToken}` });
      // The owner's roles are reported as assigned — that is what makes "why
      // can I do this?" answerable — and the ceiling is reported beside them.
      // What the token may actually do is the intersection of the two.
      check("a capped token reports its owner's roles", me.body.roles?.includes("maintainer") === true, me.body.roles);
      check("a capped token says what it was capped to", me.body.cappedTo === "viewer", me.body.cappedTo);
      check("a capped token loses the permissions the ceiling lacks", me.body.permissions?.includes("requirement:write") !== true, me.body.permissions);
      check("a capped token keeps the permissions both hold", me.body.permissions?.includes("spec:read") === true, me.body.permissions);

      const write = await capped.call("create_requirement", { key: slug, title: "Should not exist", priority: "medium" });
      check("a capped token cannot write even though its owner can", write.isError === true, write.data);
    } finally {
      await capped.stop();
    }

    // --- a token scoped to a different project ---
    const scoped = await startHarness([root], "smoke-auth-scoped", {
      env,
      headers: { Authorization: `Bearer ${scopedToken}` },
      connectMcp: false,
    });
    try {
      const res = await getJson(`${scoped.base}/api/summary?project=${slug}`, { Authorization: `Bearer ${scopedToken}` });
      check("a project-scoped token is refused on another project", res.status === 403, res);
    } finally {
      await scoped.stop();
    }

    // --- revocation ---
    await revokeSeededToken(authDb, maintainerToken);
    const revoked = await startHarness([root], "smoke-auth-revoked", { env, connectMcp: false });
    try {
      const res = await getJson(`${revoked.base}/api/summary?project=${slug}`, { Authorization: `Bearer ${maintainerToken}` });
      check("a revoked token no longer works", res.status === 401, res);
      check("the refusal says the token was revoked", String(res.body.error ?? "").toLowerCase().includes("revoked"), res.body);
    } finally {
      await revoked.stop();
    }
  }

  // =========================================================================
  console.log("\n— against a live LDAP directory —");
  // =========================================================================
  //
  // Everything above proves the authorisation layer; this proves the bind path,
  // which is the part that cannot be checked by reasoning about it. The
  // directory is a real LDAP server running in this process (see
  // lib/ldap-fixture.ts) — no container, no network, works in CI.
  {
    const { authenticateLdap } = await import("../src/auth/ldap.js");

    const ldapCfg = (url: string, over: Record<string, unknown> = {}) =>
      ({
        url,
        bindDn: SERVICE_DN,
        bindPassword: SERVICE_PASSWORD,
        baseDn: BASE_DN,
        userFilter: "(|(uid={{username}})(sAMAccountName={{username}}))",
        userDnTemplate: null,
        displayNameAttrs: ["displayName", "cn"],
        emailAttrs: ["mail"],
        groupBaseDn: GROUP_BASE_DN,
        groupFilter: "(|(member={{dn}})(memberUid={{username}}))",
        groupNameAttr: "cn",
        memberOfAttr: "memberOf",
        timeoutMs: 5_000,
        tlsRejectUnauthorized: false,
        ...over,
      }) as any;

    const withFixture = async (opts: FixtureOptions, fn: (url: string) => Promise<void>) => {
      const fixture = await startLdapFixture(opts);
      try {
        await fn(fixture.url);
      } finally {
        await fixture.stop();
      }
    };

    const rejects = async (fn: () => Promise<unknown>): Promise<{ message: string; invalid: boolean }> => {
      try {
        await fn();
        return { message: "<no error>", invalid: false };
      } catch (e) {
        return { message: (e as Error).message, invalid: (e as { invalidCredentials?: boolean }).invalidCredentials === true };
      }
    };

    // --- groups published on the user entry (Active Directory style) ---
    await withFixture({ groupDiscovery: "memberOf" }, async (url) => {
      const u = await authenticateLdap(ldapCfg(url), "vera", "vera-secret");
      check("ldap: a correct password binds", u.username === "vera", u);
      check("ldap: the DN comes back from the directory", u.dn === USERS.vera.dn, u.dn);
      check("ldap: the display name is read", u.displayName === "Vera Viewer", u.displayName);
      check("ldap: the mail attribute is read", u.email === "vera@example.test", u.email);
      check("ldap: memberOf groups are discovered", u.groups.includes(`cn=requ-readers,${GROUP_BASE_DN}`), u.groups);
      check("ldap: the bare group name is recorded too", u.groups.includes("requ-readers"), u.groups);

      const wrong = await rejects(() => authenticateLdap(ldapCfg(url), "vera", "not-the-password"));
      check("ldap: a wrong password is rejected", wrong.invalid, wrong);
      check("ldap: and is reported as a credential problem", wrong.message.includes("Invalid username or password"), wrong.message);

      const unknown = await rejects(() => authenticateLdap(ldapCfg(url), "ghost", "whatever"));
      check("ldap: an unknown user is rejected", unknown.invalid, unknown);
      check("ldap: an unknown user is indistinguishable from a wrong password",
        unknown.message === wrong.message, { unknown: unknown.message, wrong: wrong.message });

      // An empty password makes a real directory perform an *unauthenticated*
      // bind, which succeeds — so the guard has to be on requ's side.
      const blank = await rejects(() => authenticateLdap(ldapCfg(url), "vera", ""));
      check("ldap: an empty password never authenticates", blank.invalid, blank);

      // Filter injection: unescaped, `*` matches every entry in the tree.
      const wildcard = await rejects(() => authenticateLdap(ldapCfg(url), "*", "vera-secret"));
      check("ldap: a wildcard username matches nothing", wildcard.invalid, wildcard);
      const injected = await rejects(() => authenticateLdap(ldapCfg(url), ")(uid=*", "vera-secret"));
      check("ldap: a username cannot close the filter early", injected.invalid, injected);

      const ambiguous = await rejects(() => authenticateLdap(ldapCfg(url), "dup", "dup-secret"));
      check("ldap: a username matching two entries is refused, not guessed",
        ambiguous.message.includes("matched 2 directory entries"), ambiguous.message);

      // Direct bind, with a deliberately wrong service password: succeeding
      // proves the service account was never used.
      const direct = await authenticateLdap(
        ldapCfg(url, { userDnTemplate: `uid={{username}},ou=people,${BASE_DN}`, bindPassword: "WRONG" }),
        "mika", "mika-secret",
      );
      check("ldap: a DN template binds without the service account", direct.username === "mika", direct);
      check("ldap: groups are still discovered on that path", direct.groups.includes("requ-maintainers"), direct.groups);

      const badService = await rejects(() => authenticateLdap(ldapCfg(url, { bindPassword: "WRONG" }), "vera", "vera-secret"));
      check("ldap: a bad service password is reported as a configuration fault, not a bad login",
        !badService.invalid && badService.message.includes("REQU_LDAP_BIND_DN"), badService);
    });

    // --- groups found by searching the group tree (OpenLDAP without memberOf) ---
    await withFixture({ groupDiscovery: "search" }, async (url) => {
      const u = await authenticateLdap(ldapCfg(url), "mika", "mika-secret");
      check("ldap: groups are found by searching the group tree when there is no memberOf",
        u.groups.includes("requ-maintainers"), u.groups);
      const nora = await authenticateLdap(ldapCfg(url), "nora", "nora-secret");
      check("ldap: a user in no group authenticates with no groups", nora.groups.length === 0, nora.groups);
    });

    // --- a directory that normalises attribute names to lower case ---
    // Attribute descriptions are case-insensitive (RFC 4512). Reading them by
    // exact key finds nothing, and a user with no groups silently drops to the
    // default role — so this is checked, not assumed.
    await withFixture({ groupDiscovery: "memberOf", lowercaseAttributes: true }, async (url) => {
      const u = await authenticateLdap(ldapCfg(url), "vera", "vera-secret");
      check("ldap: attributes are read whatever case the directory used", u.displayName === "Vera Viewer", u.displayName);
      check("ldap: mail too", u.email === "vera@example.test", u.email);
      check("ldap: and the groups, which decide the role", u.groups.includes("requ-readers"), u.groups);
    });

    // --- LDAPS, against a real TLS handshake ---
    await withFixture({ tls: true }, async (url) => {
      check("ldap: the fixture is serving ldaps", url.startsWith("ldaps://"), url);
      const u = await authenticateLdap(ldapCfg(url), "mika", "mika-secret");
      check("ldaps: a bind over TLS works", u.username === "mika" && u.groups.includes("requ-maintainers"), u);

      // ldapts enables TLS when tlsOptions is present *or* the scheme is ldaps,
      // so a self-signed certificate must still be refused when verification is on.
      const strict = await rejects(() => authenticateLdap(ldapCfg(url, { tlsRejectUnauthorized: true }), "mika", "mika-secret"));
      check("ldaps: an untrusted certificate is refused when verification is on",
        !strict.invalid && /certificate|self[- ]signed/i.test(strict.message), strict.message);
    });

    const { checkLdapConnection } = await import("../src/auth/ldap.js");
    await withFixture({}, async (url) => {
      let healthy = true;
      try { await checkLdapConnection(ldapCfg(url)); } catch { healthy = false; }
      check("ldap: the health check reaches a working directory", healthy);
    });
    let unhealthy = false;
    try { await checkLdapConnection(ldapCfg("ldap://127.0.0.1:1")); } catch { unhealthy = true; }
    check("ldap: the health check reports an unreachable directory", unhealthy);
  }

  // =========================================================================
  console.log("\n— signing in to the server against that directory —");
  // =========================================================================
  //
  // The whole round trip a person makes: sign in, get a session, mint a token
  // from that session, and drive MCP with the token — with the role the
  // directory's groups earned them, and nothing more.
  {
    const root = path.join(tmp, "ldapproj");
    await fs.mkdir(root, { recursive: true });
    const slug = slugFor(root);
    const fixture = await startLdapFixture({ groupDiscovery: "memberOf" });

    const env = {
      REQU_AUTH_MODE: "ldap",
      REQU_AUTH_SECRET: SECRET,
      REQU_AUTH_DB: path.join(tmp, "ldap-auth.db"),
      REQU_AUDIT: "on",
      REQU_LDAP_URL: fixture.url,
      REQU_LDAP_ALLOW_PLAINTEXT: "true",
      REQU_LDAP_BASE_DN: BASE_DN,
      REQU_LDAP_BIND_DN: SERVICE_DN,
      REQU_LDAP_BIND_PASSWORD: SERVICE_PASSWORD,
      REQU_LDAP_GROUP_BASE_DN: GROUP_BASE_DN,
      REQU_LDAP_ROLE_MAP: "requ-readers=viewer;requ-maintainers=maintainer",
      REQU_AUTH_DEFAULT_ROLE: "none",
    };

    const h = await startHarness([root], "smoke-auth-ldap", { env, connectMcp: false });
    try {
      const signIn = async (username: string, password: string) => {
        const res = await fetch(`${h.base}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const body = await res.json().catch(() => ({}));
        return { status: res.status, body, cookie: res.headers.get("set-cookie") };
      };

      const bad = await signIn("mika", "wrong-password");
      check("sign-in: a wrong password is refused", bad.status === 401, bad.status);
      check("sign-in: no cookie is issued", !bad.cookie, bad.cookie);

      const noRole = await signIn("nora", "nora-secret");
      check("sign-in: a user no group maps to is refused when there is no default role",
        noRole.status === 401, { status: noRole.status, body: noRole.body });

      const ok = await signIn("mika", "mika-secret");
      check("sign-in: correct credentials are accepted", ok.status === 200, ok.body);
      check("sign-in: the directory's group became a role", ok.body.roles?.includes("maintainer") === true, ok.body.roles);
      check("sign-in: the display name comes from the directory", ok.body.user?.displayName === "Mika Maintainer", ok.body.user);
      check("sign-in: a session cookie is set", (ok.cookie ?? "").includes("requ_session="), ok.cookie);
      check("sign-in: the cookie is HttpOnly", (ok.cookie ?? "").includes("HttpOnly"), ok.cookie);
      check("sign-in: the cookie is SameSite=Lax", (ok.cookie ?? "").includes("SameSite=Lax"), ok.cookie);
      check("sign-in: the roles say where they came from", (ok.body.roleSources ?? []).some((r: any) => r.source === "group"), ok.body.roleSources);

      const cookie = (ok.cookie ?? "").split(";")[0];

      const me = await getJson(`${h.base}/api/auth/me`, { Cookie: cookie });
      check("session: the cookie identifies the user", me.body.username === "mika" && me.body.kind === "session", me.body);
      check("session: it carries the maintainer permissions", me.body.permissions?.includes("requirement:write") === true, me.body.permissions);

      // A session can mint a token, and that token drives MCP.
      const mint = await fetch(`${h.base}/api/auth/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "from the dashboard" }),
      });
      const minted = await mint.json().catch(() => ({}));
      check("token: a session can mint one", mint.status === 201 && typeof minted.token === "string", minted);
      check("token: the plaintext is returned only in the creation response",
        !JSON.stringify((await getJson(`${h.base}/api/auth/tokens`, { Cookie: cookie })).body).includes(minted.token), "listed tokens contain the secret");

      const viaToken = await startHarness([root], "smoke-auth-ldap-token", {
        env,
        headers: { Authorization: `Bearer ${minted.token}` },
      });
      try {
        const init = await viaToken.call("init_project", { key: slug, name: "LDAP Project", initialPhase: "v1.0", force: true });
        check("token: a token minted in the dashboard drives MCP", !init.isError, init.data);
        const created = await viaToken.call("create_requirement", { title: "Signed in for real", priority: "high" });
        check("token: the maintainer role carries over to MCP", !created.isError, created.data);

        const hist = await getJson(
          `${viaToken.base}/api/history/requirement/${encodeURIComponent(created.data?.id)}?project=${slug}`,
          { Authorization: `Bearer ${minted.token}` },
        );
        check("token: the change is attributed to the directory user", hist.body.changes?.[0]?.actorId === "mika", hist.body.changes?.[0]);
      } finally {
        await viaToken.stop();
      }

      // Signing out has to end the session for real, not just drop the cookie.
      const out = await fetch(`${h.base}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie } });
      check("sign-out: succeeds", out.ok, out.status);
      const after = await getJson(`${h.base}/api/auth/me`, { Cookie: cookie });
      check("sign-out: the old cookie no longer authenticates", after.body.authenticated === false, after.body);

      // A viewer signs in and is held to viewer rights.
      const vera = await signIn("vera", "vera-secret");
      check("sign-in: a reader's group maps to viewer", vera.body.roles?.includes("viewer") === true, vera.body.roles);
      const veraCookie = (vera.cookie ?? "").split(";")[0];
      const denied = await fetch(`${h.base}/api/config?project=${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: veraCookie },
        body: JSON.stringify({ brief: "should not land" }),
      });
      check("session: a viewer's write over REST is refused", denied.status === 403, denied.status);

      // Disabling an account ends its sessions immediately.
      const mikaAgain = await signIn("mika", "mika-secret");
      const mikaCookie = (mikaAgain.cookie ?? "").split(";")[0];
      // Point the modules at *this* section's database. The config caches
      // sqlitePath, so resetting the store alone would write to whichever
      // database an earlier section left configured.
      const { authStore, setAuthStore } = await import("../src/auth/store.js");
      const { resetAuthConfig } = await import("../src/auth/config.js");
      process.env.REQU_AUTH_DB = env.REQU_AUTH_DB;
      process.env.REQU_AUTH_SECRET = SECRET;
      process.env.REQU_AUTH_MODE = "disabled";
      resetAuthConfig();
      setAuthStore(null);
      await authStore().setUserDisabled("mika", true);
      await authStore().revokeSessionsForUser("mika");
      const disabled = await getJson(`${h.base}/api/auth/me`, { Cookie: mikaCookie });
      check("admin: disabling an account ends its session at once", disabled.body.authenticated === false, disabled.body);
      const blocked = await signIn("mika", "mika-secret");
      check("admin: a disabled account cannot sign back in", blocked.status === 401, blocked.status);
    } finally {
      await h.stop();
      await fixture.stop();
    }
  }

  // =========================================================================
  console.log("\n— project membership —");
  // =========================================================================
  //
  // Adding someone to one project must delegate exactly that: the right to work
  // on it, and — for an admin — the right to decide who else can. Nothing about
  // any other project, and nothing server-wide.
  {
    const root = path.join(tmp, "memberproj");
    const other = path.join(tmp, "otherproj");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(other, { recursive: true });
    const slug = slugFor(root);
    const otherSlug = slugFor(other);
    const authDb = path.join(tmp, "members-auth.db");
    const fixture = await startLdapFixture({ groupDiscovery: "memberOf" });

    // vera is a reader in the directory. Make her admin of this project only.
    process.env.REQU_AUTH_DB = authDb;
    process.env.REQU_AUTH_SECRET = SECRET;
    process.env.REQU_AUTH_MODE = "disabled";
    const { resetAuthConfig } = await import("../src/auth/config.js");
    const { authStore, setAuthStore } = await import("../src/auth/store.js");
    resetAuthConfig();
    setAuthStore(null);
    await authStore().init();
    await authStore().grantRole({
      userId: "vera", projectId: slug, role: "admin", grantedBy: "smoke", grantedAt: new Date().toISOString(),
    });

    const env = {
      REQU_AUTH_MODE: "ldap",
      REQU_AUTH_SECRET: SECRET,
      REQU_AUTH_DB: authDb,
      REQU_AUDIT: "on",
      REQU_LDAP_URL: fixture.url,
      REQU_LDAP_ALLOW_PLAINTEXT: "true",
      REQU_LDAP_BASE_DN: BASE_DN,
      REQU_LDAP_BIND_DN: SERVICE_DN,
      REQU_LDAP_BIND_PASSWORD: SERVICE_PASSWORD,
      REQU_LDAP_GROUP_BASE_DN: GROUP_BASE_DN,
      REQU_LDAP_ROLE_MAP: "requ-readers=viewer;requ-maintainers=maintainer",
      REQU_AUTH_DEFAULT_ROLE: "none",
    };

    const h = await startHarness([root, other], "smoke-auth-members", { env, connectMcp: false });
    try {
      const signIn = async (username: string, password: string) => {
        const res = await fetch(`${h.base}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        return {
          status: res.status,
          body: await res.json().catch(() => ({})),
          cookie: (res.headers.get("set-cookie") ?? "").split(";")[0],
        };
      };
      const post = async (url: string, cookie: string, payload: unknown) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie },
          body: JSON.stringify(payload),
        });
        return { status: res.status, body: await res.json().catch(() => ({})) };
      };

      const vera = await signIn("vera", "vera-secret");
      check("membership: a project-scoped admin can sign in", vera.status === 200, vera.body);

      // --- the escalation this design exists to prevent ---
      const escalate = await post(`${h.base}/api/admin/roles?project=${slug}`, vera.cookie, {
        userId: "vera", projectId: "*", role: "admin",
      });
      check("membership: a project admin cannot grant themselves a server-wide role",
        escalate.status === 403, escalate);
      const stillNotGlobal = await getJson(`${h.base}/api/auth/me`, { Cookie: vera.cookie });
      check("membership: and does not hold server-wide administration",
        (stillNotGlobal.body.globalPermissions ?? []).includes("admin:users") === false,
        stillNotGlobal.body.globalPermissions);
      check("membership: while still administering their own project",
        (await getJson(`${h.base}/api/auth/me?project=${slug}`, { Cookie: vera.cookie })).body.permissions?.includes("project:members") === true);

      const serverAdminRoutes = await getJson(`${h.base}/api/admin/users?project=${slug}`, { Cookie: vera.cookie });
      check("membership: server administration stays closed to them", serverAdminRoutes.status === 403, serverAdminRoutes.status);

      // --- adding someone who has never signed in ---
      const added = await post(`${h.base}/api/projects/${slug}/members`, vera.cookie, {
        username: "nora", role: "maintainer",
      });
      check("membership: a member can be added before they have ever signed in", added.status === 200, added.body);
      check("membership: they are listed as invited", added.body.invited === true, added.body);
      check("membership: with the role they were given", added.body.projectRole === "maintainer", added.body);

      const listed = await getJson(`${h.base}/api/projects/${slug}/members`, { Cookie: vera.cookie });
      const names = (listed.body.members ?? []).map((x: any) => x.userId);
      check("membership: the members list includes both of them", names.includes("vera") && names.includes("nora"), names);
      const veraRow = (listed.body.members ?? []).find((x: any) => x.userId === "vera");
      check("membership: a directory group shows as inherited, not as a grant made here",
        (veraRow?.inherited ?? []).some((i: any) => i.source === "group"), veraRow);

      // --- the invited user can now actually sign in ---
      const nora = await signIn("nora", "nora-secret");
      check("membership: someone whose only role is on one project can sign in", nora.status === 200, nora.body);
      const noraHere = await getJson(`${h.base}/api/auth/me?project=${slug}`, { Cookie: nora.cookie });
      check("membership: and holds their role on that project", noraHere.body.roles?.includes("maintainer") === true, noraHere.body.roles);
      check("membership: with nothing server-wide", (noraHere.body.globalPermissions ?? []).length === 0, noraHere.body.globalPermissions);
      const noraElsewhere = await getJson(`${h.base}/api/auth/me?project=${otherSlug}`, { Cookie: nora.cookie });
      check("membership: and nothing on another project", (noraElsewhere.body.roles ?? []).length === 0, noraElsewhere.body.roles);

      const noraWrite = await fetch(`${h.base}/api/config?project=${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: nora.cookie },
        body: JSON.stringify({ brief: "a maintainer may write here" }),
      });
      check("membership: the granted role really works on that project", noraWrite.status !== 403, noraWrite.status);
      const noraWriteElsewhere = await fetch(`${h.base}/api/config?project=${otherSlug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: nora.cookie },
        body: JSON.stringify({ brief: "but not here" }),
      });
      check("membership: and nowhere else", noraWriteElsewhere.status === 403, noraWriteElsewhere.status);

      // --- a member is not an administrator of the project ---
      const noraAdds = await post(`${h.base}/api/projects/${slug}/members`, nora.cookie, {
        username: "mika", role: "admin",
      });
      check("membership: a maintainer cannot change who else is a member", noraAdds.status === 403, noraAdds);

      // --- an admin of one project is not an admin of another ---
      const veraElsewhere = await getJson(`${h.base}/api/projects/${otherSlug}/members`, { Cookie: vera.cookie });
      check("membership: a project admin cannot read another project's members", veraElsewhere.status === 403, veraElsewhere.status);

      // --- changing a role replaces it rather than stacking ---
      const demoted = await post(`${h.base}/api/projects/${slug}/members`, vera.cookie, {
        username: "nora", role: "viewer",
      });
      check("membership: changing a role replaces the old one", demoted.body.projectRole === "viewer", demoted.body);
      check("membership: the old role is really gone",
        JSON.stringify(demoted.body.roles) === JSON.stringify(["viewer"]), demoted.body.roles);

      // --- removal ---
      const removed = await fetch(`${h.base}/api/projects/${slug}/members/nora`, {
        method: "DELETE", headers: { Cookie: vera.cookie },
      });
      const removedBody = await removed.json().catch(() => ({}));
      check("membership: a member can be removed", removed.status === 200 && removedBody.removed === true, removedBody);
      check("membership: and then has no access at all", removedBody.stillHasAccess === false, removedBody);
      const afterRemoval = await getJson(`${h.base}/api/auth/me?project=${slug}`, { Cookie: nora.cookie });
      check("membership: their existing session loses the role immediately",
        (afterRemoval.body.roles ?? []).length === 0, afterRemoval.body.roles);

      // --- the last administrator cannot lock everyone out ---
      const selfRemove = await fetch(`${h.base}/api/projects/${slug}/members/vera`, {
        method: "DELETE", headers: { Cookie: vera.cookie },
      });
      check("membership: the only administrator cannot remove themselves", selfRemove.status === 400, selfRemove.status);

      // --- inherited access cannot be removed from the project ---
      await post(`${h.base}/api/projects/${slug}/members`, vera.cookie, { username: "mika", role: "admin" });
      const mika = await signIn("mika", "mika-secret");
      check("membership: a second administrator can be added", mika.status === 200, mika.body);
      const withMika = await getJson(`${h.base}/api/projects/${slug}/members`, { Cookie: vera.cookie });
      const mikaRow = (withMika.body.members ?? []).find((x: any) => x.userId === "mika");
      check("membership: their directory role is shown alongside the one granted here",
        (mikaRow?.inherited ?? []).some((i: any) => i.role === "maintainer" && i.source === "group"), mikaRow);
      const dropMika = await fetch(`${h.base}/api/projects/${slug}/members/mika`, {
        method: "DELETE", headers: { Cookie: vera.cookie },
      });
      const dropBody = await dropMika.json().catch(() => ({}));
      check("membership: removing them drops only the grant made here",
        dropBody.removed === true && dropBody.stillHasAccess === true, dropBody);
      check("membership: their directory-granted role survives",
        (dropBody.remainingRoles ?? []).includes("maintainer"), dropBody.remainingRoles);

      // --- the audit trail records membership decisions ---
      const auditRes = await getJson(`${h.base}/api/audit?project=${slug}&limit=200`, { Cookie: vera.cookie });
      const actions = (auditRes.body.entries ?? []).map((e: any) => e.action);
      check("membership: adding a member is audited", actions.includes("members.add"), actions.slice(0, 10));
      check("membership: removing one is audited", actions.includes("members.remove"), actions.slice(0, 10));
      const refused = (auditRes.body.entries ?? []).find((e: any) => e.outcome === "denied" && e.actorId === "nora");
      check("membership: a refused membership change is audited", Boolean(refused), refused);
    } finally {
      await h.stop();
      await fixture.stop();
    }
  }

  // =========================================================================
  console.log("\n— two-factor authentication —");
  // =========================================================================
  //
  // TOTP, which is what Microsoft Authenticator speaks for third-party accounts.
  // The algorithm itself is checked against the RFC vectors below; this section
  // is about the flow around it: that a password alone stops being enough, that
  // a code cannot be replayed or brute-forced, and that losing a phone is
  // recoverable without an administrator.
  {
    const { totpAt, stepFor, verifyTotp, hotp, base32Encode, generateRecoveryCodes, hashRecoveryCode, matchRecoveryCode, PERIOD_SECONDS } =
      await import("../src/auth/totp.js");
    const { sealSecret, openSecret } = await import("../src/auth/secret-box.js");

    // --- the algorithm, against the published vectors ---
    const rfcKey = Buffer.from("12345678901234567890", "utf-8");
    const rfc4226 = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    check(
      "totp: matches every RFC 4226 HOTP vector",
      rfc4226.every((expected, counter) => hotp(rfcKey, counter) === expected),
      rfc4226.map((_, c) => hotp(rfcKey, c)),
    );
    const rfcSecret = base32Encode(rfcKey);
    const rfc6238: Array<[number, string]> = [
      [59, "287082"], [1111111109, "081804"], [1111111111, "050471"],
      [1234567890, "005924"], [2000000000, "279037"],
      // Past 2^32 seconds: catches a counter written with a 32-bit shift.
      [20000000000, "353130"],
    ];
    check(
      "totp: matches every RFC 6238 TOTP vector, including beyond 2^32 seconds",
      rfc6238.every(([t, expected]) => totpAt(rfcSecret, Math.floor(t / PERIOD_SECONDS)) === expected),
      rfc6238.map(([t]) => totpAt(rfcSecret, Math.floor(t / PERIOD_SECONDS))),
    );

    const at = 1_700_000_000_000;
    const nowStep = Math.floor(at / 1000 / PERIOD_SECONDS);
    check("totp: a code one step early is accepted (clock drift)", verifyTotp(rfcSecret, totpAt(rfcSecret, nowStep - 1), { atMs: at }).ok);
    check("totp: a code one step late is accepted", verifyTotp(rfcSecret, totpAt(rfcSecret, nowStep + 1), { atMs: at }).ok);
    check("totp: two steps out is refused", !verifyTotp(rfcSecret, totpAt(rfcSecret, nowStep - 2), { atMs: at }).ok);
    const spent = verifyTotp(rfcSecret, totpAt(rfcSecret, nowStep), { atMs: at, minStep: nowStep });
    check("totp: a spent step is refused as a replay", !spent.ok && spent.reason === "replayed", spent);

    // --- the seed is encrypted at rest ---
    const sealed = sealSecret(rfcSecret, SECRET);
    check("totp: the stored seed is not the seed", !sealed.includes(rfcSecret), sealed.slice(0, 24));
    check("totp: it opens with the right server secret", openSecret(sealed, SECRET) === rfcSecret);
    check("totp: and not with a different one", openSecret(sealed, "some-other-secret-entirely-0123456789") === null);
    check("totp: tampering with the ciphertext is detected", openSecret(sealed.slice(0, -4) + "AAAA", SECRET) === null);

    const rcs = generateRecoveryCodes();
    const rcHashes = rcs.map((c) => hashRecoveryCode(c, SECRET));
    check("totp: recovery codes are stored only as hashes", !rcHashes.some((h) => rcs.some((c) => h.includes(c.replace("-", "")))));
    check("totp: a recovery code matches regardless of case or dashes", matchRecoveryCode(rcs[2].toLowerCase(), rcHashes, SECRET) === 2);

    // --- the flow ---
    const root = path.join(tmp, "tfaproj");
    await fs.mkdir(root, { recursive: true });
    const authDb = path.join(tmp, "tfa-auth.db");
    const fixture = await startLdapFixture({ groupDiscovery: "memberOf" });
    const env = {
      REQU_AUTH_MODE: "ldap", REQU_AUTH_SECRET: SECRET, REQU_AUTH_DB: authDb, REQU_AUDIT: "on",
      REQU_LDAP_URL: fixture.url, REQU_LDAP_ALLOW_PLAINTEXT: "true", REQU_LDAP_BASE_DN: BASE_DN,
      REQU_LDAP_BIND_DN: SERVICE_DN, REQU_LDAP_BIND_PASSWORD: SERVICE_PASSWORD,
      REQU_LDAP_GROUP_BASE_DN: GROUP_BASE_DN,
      REQU_LDAP_ROLE_MAP: "requ-readers=viewer;requ-maintainers=maintainer",
      REQU_2FA: "optional",
    };

    const h = await startHarness([root], "smoke-auth-2fa", { env, connectMcp: false });
    try {
      const post = async (p: string, payload: unknown, cookie = "") => {
        const res = await fetch(`${h.base}${p}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
          body: JSON.stringify(payload),
        });
        return { status: res.status, body: await res.json().catch(() => ({})), cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
      };
      const signIn = (u: string, p: string) => post("/api/auth/login", { username: u, password: p });

      // Nothing changes for someone who has not enrolled.
      const plain = await signIn("mika", "mika-secret");
      check("2fa: an un-enrolled user signs in on the password alone", plain.status === 200 && Boolean(plain.cookie), plain.body);
      check("2fa: and is told no second factor is owed", plain.body.twoFactor?.required === false, plain.body.twoFactor);
      const cookie = plain.cookie;

      const status0 = await getJson(`${h.base}/api/auth/2fa`, { Cookie: cookie });
      check("2fa: the server offers it", status0.body.available === true && status0.body.mode === "optional", status0.body);
      check("2fa: and reports nobody enrolled yet", status0.body.enrolled === false, status0.body);

      // Enrolment.
      const setup = await post("/api/auth/2fa/setup", {}, cookie);
      check("2fa: setup returns a provisioning URI", String(setup.body.uri ?? "").startsWith("otpauth://totp/"), setup.body.uri);
      check("2fa: the URI names the issuer and the account", String(setup.body.uri).includes("issuer=requ") && String(setup.body.uri).includes("mika%40example.test"), setup.body.uri);
      check("2fa: a QR code is rendered server-side", String(setup.body.qrSvg ?? "").startsWith("<svg"), String(setup.body.qrSvg).slice(0, 20));
      check("2fa: the secret is also offered for manual entry", /^[A-Z2-7 ]+$/.test(setup.body.secret ?? ""), setup.body.secret);
      const secret = new URL(String(setup.body.uri).replace("otpauth://", "http://")).searchParams.get("secret")!;

      const wrongConfirm = await post("/api/auth/2fa/confirm", { code: "000000" }, cookie);
      check("2fa: a wrong code does not complete enrolment", wrongConfirm.status === 400, wrongConfirm.body);
      const stillOff = await getJson(`${h.base}/api/auth/2fa`, { Cookie: cookie });
      check("2fa: so the account is still un-enrolled", stillOff.body.enrolled === false, stillOff.body);

      const confirmed = await post("/api/auth/2fa/confirm", { code: totpAt(secret, stepFor()) }, cookie);
      check("2fa: the right code completes enrolment", confirmed.status === 200, confirmed.body);
      const recoveryCodes: string[] = confirmed.body.recoveryCodes ?? [];
      check("2fa: ten recovery codes are issued once", recoveryCodes.length === 10, recoveryCodes.length);

      const listed = await getJson(`${h.base}/api/auth/2fa`, { Cookie: cookie });
      check("2fa: the account now reports enrolled", listed.body.enrolled === true, listed.body);
      check("2fa: the recovery codes are never listed back", !JSON.stringify(listed.body).includes(recoveryCodes[0]), listed.body);

      // Signing in now takes two steps.
      const second = await signIn("mika", "mika-secret");
      check("2fa: the password alone no longer yields a session", !second.cookie, second.cookie);
      check("2fa: a code is demanded", second.body.twoFactor?.step === "code", second.body.twoFactor);
      const challenge = second.body.twoFactor?.challenge;
      check("2fa: a challenge is handed back", typeof challenge === "string" && challenge.length > 0);

      // The pending session is not a credential.
      const pendingUse = await getJson(`${h.base}/api/auth/me`, { Cookie: `requ_session=${encodeURIComponent(challenge)}` });
      check("2fa: the pending session authenticates nothing", pendingUse.body.authenticated === false, pendingUse.body);
      const pendingApi = await getJson(`${h.base}/api/summary?project=${slugFor(root)}`, { Cookie: `requ_session=${encodeURIComponent(challenge)}` });
      check("2fa: nor does it reach the API", pendingApi.status === 401, pendingApi.status);

      const badCode = await post("/api/auth/2fa/verify", { challenge, code: "123456" });
      check("2fa: a wrong code is refused", badCode.status === 401, badCode.body);
      check("2fa: and yields no cookie", !badCode.cookie);

      const reusedEnrolCode = await post("/api/auth/2fa/verify", { challenge, code: totpAt(secret, stepFor()) });
      check(
        "2fa: the code spent on enrolment cannot be reused to sign in",
        reusedEnrolCode.status === 401 && String(reusedEnrolCode.body.error).includes("already been used"),
        reusedEnrolCode.body,
      );

      const freshCode = totpAt(secret, stepFor() + 1);
      const verified = await post("/api/auth/2fa/verify", { challenge, code: freshCode });
      check("2fa: a fresh code completes the sign-in", verified.status === 200 && Boolean(verified.cookie), verified.body);
      const me = await getJson(`${h.base}/api/auth/me`, { Cookie: verified.cookie });
      check("2fa: and the session works", me.body.authenticated === true && me.body.username === "mika", me.body);

      // Replay across sign-ins.
      const third = await signIn("mika", "mika-secret");
      const replayed = await post("/api/auth/2fa/verify", { challenge: third.body.twoFactor.challenge, code: freshCode });
      check("2fa: the same code cannot be replayed on a new sign-in", replayed.status === 401, replayed.body);

      // Recovery codes.
      const fourth = await signIn("mika", "mika-secret");
      const viaRecovery = await post("/api/auth/2fa/verify", { challenge: fourth.body.twoFactor.challenge, code: recoveryCodes[0] });
      check("2fa: a recovery code signs you in", viaRecovery.status === 200 && Boolean(viaRecovery.cookie), viaRecovery.body);
      check("2fa: and says how many are left", viaRecovery.body.recoveryCodesRemaining === 9, viaRecovery.body);
      const fifth = await signIn("mika", "mika-secret");
      const reusedRecovery = await post("/api/auth/2fa/verify", { challenge: fifth.body.twoFactor.challenge, code: recoveryCodes[0] });
      check("2fa: a recovery code works exactly once", reusedRecovery.status === 401, reusedRecovery.body);

      // An expired or forged challenge is useless.
      const forged = await post("/api/auth/2fa/verify", { challenge: `${challenge}x`, code: totpAt(secret, stepFor() + 2) });
      check("2fa: a tampered challenge is refused", forged.status === 401, forged.body);

      // Removing it requires proving possession.
      const mikaSession = viaRecovery.cookie;
      const badDisable = await post("/api/auth/2fa/disable", { code: "000000" }, mikaSession);
      check("2fa: removing it needs a current code", badDisable.status === 401, badDisable.body);

      // The successful removal runs on a second account, because each accepted
      // code advances the replay watermark and only one step either side of now
      // is ever accepted — so mika has no unspent step left in this window.
      const vera = await signIn("vera", "vera-secret");
      const veraSetup = await post("/api/auth/2fa/setup", {}, vera.cookie);
      const veraSecret = new URL(String(veraSetup.body.uri).replace("otpauth://", "http://")).searchParams.get("secret")!;
      await post("/api/auth/2fa/confirm", { code: totpAt(veraSecret, stepFor()) }, vera.cookie);
      const veraEnrolled = await signIn("vera", "vera-secret");
      check("2fa: a second account enrols independently", veraEnrolled.body.twoFactor?.step === "code", veraEnrolled.body.twoFactor);

      const disabled = await post("/api/auth/2fa/disable", { code: totpAt(veraSecret, stepFor() + 1) }, vera.cookie);
      check("2fa: with a current code, it is removed", disabled.status === 200, disabled.body);
      const afterDisable = await signIn("vera", "vera-secret");
      check("2fa: and the password alone signs in again", Boolean(afterDisable.cookie), afterDisable.body.twoFactor);

      // A token is its own credential; it does not carry a second factor.
      const tokenRes = await post("/api/auth/tokens", { name: "ci" }, mikaSession);
      check("2fa: a token can still be minted", tokenRes.status === 201, tokenRes.body);
      const viaToken = await getJson(`${h.base}/api/auth/me`, { Authorization: `Bearer ${tokenRes.body.token}` });
      check("2fa: and keeps working as a credential of its own, with no code", viaToken.body.authenticated === true, viaToken.body);

      // The audit trail records the second factor.
      const auditRes = await getJson(`${h.base}/api/audit?scope=all&limit=200`, { Cookie: mikaSession });
      const actions = (auditRes.body.entries ?? []).map((e: any) => e.action);
      check("2fa: enrolment is audited", actions.includes("2fa.enrolled"), actions.slice(0, 12));
      check("2fa: removal is audited", actions.includes("2fa.disabled"), actions.slice(0, 12));
      const denials = (auditRes.body.entries ?? []).filter((e: any) => e.outcome === "denied");
      check("2fa: refused codes are audited", denials.length > 0, denials.slice(0, 3));
    } finally {
      await h.stop();
      await fixture.stop();
    }

    // --- a policy that requires it ---
    const strictRoot = path.join(tmp, "tfastrict");
    await fs.mkdir(strictRoot, { recursive: true });
    const strictFixture = await startLdapFixture({ groupDiscovery: "memberOf" });
    const strict = await startHarness([strictRoot], "smoke-auth-2fa-required", {
      connectMcp: false,
      env: {
        REQU_AUTH_MODE: "ldap", REQU_AUTH_SECRET: SECRET, REQU_AUTH_DB: path.join(tmp, "tfa-strict.db"), REQU_AUDIT: "on",
        REQU_LDAP_URL: strictFixture.url, REQU_LDAP_ALLOW_PLAINTEXT: "true", REQU_LDAP_BASE_DN: BASE_DN,
        REQU_LDAP_BIND_DN: SERVICE_DN, REQU_LDAP_BIND_PASSWORD: SERVICE_PASSWORD,
        REQU_LDAP_GROUP_BASE_DN: GROUP_BASE_DN,
        REQU_LDAP_ROLE_MAP: "requ-maintainers=maintainer",
        REQU_2FA: "required",
      },
    });
    try {
      const post = async (p: string, payload: unknown) => {
        const res = await fetch(`${strict.base}${p}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
        return { status: res.status, body: await res.json().catch(() => ({})), cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
      };
      const first = await post("/api/auth/login", { username: "mika", password: "mika-secret" });
      check("2fa required: a user without one gets no session", !first.cookie, first.cookie);
      check("2fa required: and is sent to enrolment", first.body.twoFactor?.step === "enrol", first.body.twoFactor);

      const challenge = first.body.twoFactor.challenge;
      const offer = await post("/api/auth/2fa/enrol", { challenge });
      check("2fa required: enrolment is offered against the challenge", String(offer.body.enrolment?.uri ?? "").startsWith("otpauth://"), offer.body);
      const secret = new URL(String(offer.body.enrolment.uri).replace("otpauth://", "http://")).searchParams.get("secret")!;

      const wrong = await post("/api/auth/2fa/enrol", { challenge, code: "000000" });
      check("2fa required: a wrong code does not let them past", wrong.status === 400 && !wrong.cookie, wrong.body);

      const done = await post("/api/auth/2fa/enrol", { challenge, code: totpAt(secret, stepFor()) });
      check("2fa required: enrolling completes the sign-in", done.status === 200 && Boolean(done.cookie), done.body);
      check("2fa required: recovery codes are issued at the same time", (done.body.recoveryCodes ?? []).length === 10, done.body.recoveryCodes?.length);

      const statusRes = await getJson(`${strict.base}/api/auth/2fa`, { Cookie: done.cookie });
      check("2fa required: the account reports it as required", statusRes.body.required === true && statusRes.body.enrolled === true, statusRes.body);
      const cannotRemove = await fetch(`${strict.base}/api/auth/2fa/disable`, {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: done.cookie },
        body: JSON.stringify({ code: totpAt(secret, stepFor() + 1) }),
      });
      check("2fa required: it cannot be removed while policy demands it", cannotRemove.status === 403, cannotRemove.status);
    } finally {
      await strict.stop();
      await strictFixture.stop();
    }

    // --- configuration guards ---
    const { loadAuthConfig, resetAuthConfig } = await import("../src/auth/config.js");
    const snap = { ...process.env };
    const tryCfg = (env: Record<string, string | undefined>): string | null => {
      for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      resetAuthConfig();
      try { loadAuthConfig(); return null; } catch (e) { return (e as Error).message; }
      finally {
        for (const k of Object.keys(env)) { if (snap[k] === undefined) delete process.env[k]; else process.env[k] = snap[k]!; }
        resetAuthConfig();
      }
    };
    check("2fa: an unknown mode is refused", (tryCfg({ REQU_2FA: "maybe" }) ?? "").includes("REQU_2FA"));
    check(
      "2fa: it cannot be switched on without authentication",
      (tryCfg({ REQU_2FA: "required", REQU_AUTH_MODE: "disabled" }) ?? "").includes("REQU_AUTH_MODE=ldap"),
    );
    // Roles live in the database, which is not reachable at boot, so config
    // checks the id's shape and the catalogue decides the rest.
    check(
      "2fa: a malformed role id in the required-roles list is refused",
      (tryCfg({
        REQU_2FA: "optional", REQU_AUTH_MODE: "ldap", REQU_AUTH_SECRET: SECRET,
        REQU_LDAP_URL: "ldaps://d", REQU_LDAP_BASE_DN: "dc=x", REQU_2FA_REQUIRED_ROLES: "Wizard!",
      }) ?? "").includes("Wizard!"),
    );
    check(
      "2fa: a custom role in the required-roles list is accepted",
      tryCfg({
        REQU_2FA: "optional", REQU_AUTH_MODE: "ldap", REQU_AUTH_SECRET: SECRET,
        REQU_LDAP_URL: "ldaps://d", REQU_LDAP_BASE_DN: "dc=x", REQU_2FA_REQUIRED_ROLES: "release-manager",
      }) === null,
    );
    check(
      "2fa: requiring it for roles while switched off is refused",
      (tryCfg({ REQU_2FA: "off", REQU_2FA_REQUIRED_ROLES: "admin" }) ?? "").includes("REQU_2FA=off"),
    );
  }

  // =========================================================================
  console.log("\n— login throttling —");
  // =========================================================================
  {
    const { resetLoginThrottle, loginRetryAfterMs, recordLoginFailure, clearLoginFailures } =
      await import("../src/auth/throttle.js");
    resetLoginThrottle();

    check("a first attempt is not throttled", loginRetryAfterMs("mallory", "10.0.0.1") === 0);
    for (let i = 0; i < 4; i++) recordLoginFailure("mallory", "10.0.0.1");
    check("four failures are still allowed through", loginRetryAfterMs("mallory", "10.0.0.1") === 0);
    recordLoginFailure("mallory", "10.0.0.1");
    check("the fifth failure starts a back-off", loginRetryAfterMs("mallory", "10.0.0.1") > 0);

    // Guessing a second account from the same address is blocked by the IP counter.
    check("the address is throttled too, not just the username", loginRetryAfterMs("someone-else", "10.0.0.1") > 0);
    check("an unrelated address is unaffected", loginRetryAfterMs("mallory2", "10.0.0.2") === 0);

    const first = loginRetryAfterMs("mallory", "10.0.0.1");
    recordLoginFailure("mallory", "10.0.0.1");
    check("the back-off grows with each further failure", loginRetryAfterMs("mallory", "10.0.0.1") > first);

    clearLoginFailures("mallory", "10.0.0.1");
    check("a successful sign-in clears the counter", loginRetryAfterMs("mallory", "10.0.0.1") === 0);
    resetLoginThrottle();
  }

  // =========================================================================
  console.log("\n— configuration guards —");
  // =========================================================================
  {
    const { loadAuthConfig, resetAuthConfig } = await import("../src/auth/config.js");
    const snapshot = { ...process.env };
    const withEnv = async (env: Record<string, string | undefined>, fn: () => void) => {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetAuthConfig();
      try { fn(); } finally {
        for (const k of Object.keys(env)) {
          if (snapshot[k] === undefined) delete process.env[k];
          else process.env[k] = snapshot[k]!;
        }
        resetAuthConfig();
      }
    };

    const throws = (fn: () => void): string | null => {
      try { fn(); return null; } catch (e) { return (e as Error).message; }
    };

    await withEnv({ REQU_AUTH_MODE: "ldap", REQU_AUTH_SECRET: undefined }, () => {
      check("ldap mode without a secret is refused", throws(loadAuthConfig)?.includes("REQU_AUTH_SECRET") === true);
    });
    await withEnv({ REQU_AUTH_MODE: "ldap", REQU_AUTH_SECRET: SECRET, REQU_LDAP_URL: undefined }, () => {
      check("ldap mode without a URL is refused", throws(loadAuthConfig)?.includes("REQU_LDAP_URL") === true);
    });
    await withEnv(
      { REQU_AUTH_MODE: "ldap", REQU_AUTH_SECRET: SECRET, REQU_LDAP_URL: "ldap://dir:389", REQU_LDAP_BASE_DN: "dc=x" },
      () => {
        check("plaintext ldap:// is refused unless explicitly allowed", throws(loadAuthConfig)?.includes("plaintext") === true);
      },
    );
    await withEnv(
      {
        REQU_AUTH_MODE: "ldap", REQU_AUTH_SECRET: SECRET, REQU_LDAP_URL: "ldap://dir:389",
        REQU_LDAP_BASE_DN: "dc=x", REQU_LDAP_ALLOW_PLAINTEXT: "true",
      },
      () => {
        check("plaintext ldap:// is allowed once acknowledged", throws(loadAuthConfig) === null);
      },
    );
    await withEnv(
      { REQU_AUTH_MODE: "ldap", REQU_AUTH_SECRET: SECRET, REQU_LDAP_URL: "ldaps://dir", REQU_LDAP_BASE_DN: "dc=x", REQU_LDAP_ROLE_MAP: "grp=Wizard!" },
      () => {
        check("a malformed role id in the group map is refused", throws(loadAuthConfig)?.includes("Wizard!") === true);
      },
    );
    // A well-formed id the catalogue does not know is accepted at boot — a
    // deployment may define its roles after wiring up the directory — and
    // reported once the database is reachable.
    await withEnv(
      { REQU_AUTH_MODE: "ldap", REQU_AUTH_SECRET: SECRET, REQU_LDAP_URL: "ldaps://dir", REQU_LDAP_BASE_DN: "dc=x", REQU_LDAP_ROLE_MAP: "grp=release-manager" },
      () => {
        check("a custom role in the group map is accepted", throws(loadAuthConfig) === null);
      },
    );
    await withEnv({ REQU_AUTH_MODE: "sometimes" }, () => {
      check("an unknown auth mode is refused", throws(loadAuthConfig)?.includes("REQU_AUTH_MODE") === true);
    });

    // Filter injection: a username may not end the filter or match everything.
    const { escapeFilterValue } = await import("../src/auth/ldap.js");
    check("filter escaping neutralises a wildcard", escapeFilterValue("*") === "\\2a");
    check("filter escaping neutralises parentheses", escapeFilterValue(")(uid=admin") === "\\29\\28uid=admin");

    await roleCatalogueChecks(path.join(tmp, "roles-unit.db"));

    const { parseToken, mintToken, hashTokenSecret } = await import("../src/auth/tokens.js");
    const t = mintToken("pepper");
    const parsedToken = parseToken(t.plaintext)!;
    check("a minted token round-trips through the parser", parsedToken.id === t.id);
    check("the stored hash matches the presented secret", hashTokenSecret(parsedToken.secret, "pepper") === t.hash);
    check("the stored hash does not match a different pepper", hashTokenSecret(parsedToken.secret, "other") !== t.hash);
    check("the plaintext is not recoverable from the hash", !t.hash.includes(parsedToken.secret));
    check("a foreign token is rejected by the parser", parseToken("ghp_something") === null);

    // The id half is base64url, whose alphabet includes `_` and `-`. Splitting
    // on an underscore cut about one token in six at the wrong place and made it
    // unusable, so the round-trip is checked over a population, not one sample.
    let misparsed = 0;
    for (let i = 0; i < 2000; i++) {
      const minted = mintToken("pepper");
      const back = parseToken(minted.plaintext);
      if (!back || back.id !== minted.id || hashTokenSecret(back.secret, "pepper") !== minted.hash) misparsed++;
    }
    check("every minted token parses back to itself", misparsed === 0, `${misparsed}/2000 failed`);
  }

  await fs.rm(tmp, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

/**
 * The role catalogue, checked directly rather than through a server.
 *
 * These are the guarantees a deployment relies on when it starts inventing its
 * own roles: the presets mean what their names say, a project can redefine a
 * role for itself without touching anyone else, and capping a token can only
 * ever remove permissions.
 */
async function roleCatalogueChecks(dbPath: string): Promise<void> {
  const { setAuthStore, authStore } = await import("../src/auth/store.js");
  const { resetAuthConfig } = await import("../src/auth/config.js");
  const { resetSeed, rolesFor, permissionsForRoles, roleExists, PRESET_ROLES } =
    await import("../src/auth/role-catalogue.js");
  const { effectivePermissions } = await import("../src/auth/roles.js");

  // A database of its own, so the catalogue starts empty and the seed is really
  // being observed rather than something an earlier suite left behind.
  const previousDb = process.env.REQU_AUTH_DB;
  process.env.REQU_AUTH_DB = dbPath;
  resetAuthConfig();
  setAuthStore(null);
  resetSeed();
  try {
    const shared = await rolesFor(null);
    check(
      "every preset role is seeded",
      PRESET_ROLES.every((preset) => shared.some((r) => r.id === preset.id)),
      shared.map((r) => r.id),
    );
    check("seeded roles are marked built-in", shared.every((r) => r.builtIn));

    // Seeding twice must not duplicate or overwrite.
    resetSeed();
    const again = await rolesFor(null);
    check("seeding is idempotent", again.length === shared.length, [shared.length, again.length]);

    const qa = await permissionsForRoles(["qa"], null);
    check(
      "a QA engineer writes scenarios and records runs",
      qa.has("scenario:write") && qa.has("execution:write"),
    );
    check(
      "a QA engineer cannot rewrite the requirements being tested",
      !qa.has("requirement:write") && !qa.has("story:write"),
    );

    const analyst = await permissionsForRoles(["requirements-analyst"], null);
    check(
      "a requirements analyst writes the specification",
      analyst.has("requirement:write") && analyst.has("story:write") && analyst.has("screen:write"),
    );
    check(
      "a requirements analyst does not report on delivery",
      !analyst.has("execution:write") && !analyst.has("version:manage"),
    );

    const po = await permissionsForRoles(["product-owner"], null);
    check(
      "a product owner owns scope and baselines",
      po.has("requirement:write") && po.has("phase:write") && po.has("version:manage"),
    );
    check("a product owner does not write tests", !po.has("scenario:write"));

    const viewer = await permissionsForRoles(["viewer"], null);
    check(
      "a viewer changes nothing",
      ![...viewer].some((perm) => perm.endsWith(":write") || perm.endsWith(":manage")),
      [...viewer],
    );
    check("a maintainer is not a server administrator", !(await permissionsForRoles(["maintainer"], null)).has("admin:users"));
    check("an administrator can administer", (await permissionsForRoles(["admin"], null)).has("admin:users"));

    // Holding two roles adds their permissions up.
    const both = await permissionsForRoles(["qa", "requirements-analyst"], null);
    check("roles union", both.has("scenario:write") && both.has("requirement:write"));

    // A role that no longer exists costs the access it granted; it does not
    // break every request its holder makes.
    const ghost = await permissionsForRoles(["no-such-role"], null);
    check("an unknown role grants nothing", ghost.size === 0);
    check("an unknown role does not exist", !(await roleExists("no-such-role", null)));

    // --- project-scoped roles ---
    await authStore().putRole({
      id: "qa",
      name: "QA (checkout)",
      description: "This project lets QA edit the requirements it tests.",
      permissions: ["spec:read", "scenario:write", "execution:write", "requirement:write"],
      projectId: "checkout",
      builtIn: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: "mika",
    });
    await authStore().putRole({
      id: "release-manager",
      name: "Release Manager",
      description: "Only meaningful on this project.",
      permissions: ["spec:read", "version:manage"],
      projectId: "checkout",
      builtIn: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: "mika",
    });

    const onCheckout = await permissionsForRoles(["qa"], "checkout");
    check("a project-scoped role shadows the shared one of the same id", onCheckout.has("requirement:write"));
    check("the shared role is unchanged elsewhere", !(await permissionsForRoles(["qa"], "storefront")).has("requirement:write"));
    check("a project's own role is assignable there", await roleExists("release-manager", "checkout"));
    check("a project's own role is not assignable elsewhere", !(await roleExists("release-manager", "storefront")));
    check("a project's own role is not shared", !(await roleExists("release-manager", null)));

    // --- capping a token ---
    //
    // A catalogue has no ladder, so a ceiling is an intersection: the token gets
    // what its owner and the ceiling role both hold, and nothing else.
    const capped = await effectivePermissions({ roles: ["maintainer"], projectId: null, ceiling: "qa" });
    check("capping keeps what both hold", capped.has("scenario:write") && capped.has("execution:write"));
    check("capping drops what the ceiling lacks", !capped.has("requirement:write") && !capped.has("version:manage"));

    const raised = await effectivePermissions({ roles: ["viewer"], projectId: null, ceiling: "admin" });
    check("a ceiling can never add a permission", !raised.has("admin:users") && !raised.has("requirement:write"));

    const uncapped = await effectivePermissions({ roles: ["qa"], projectId: null, ceiling: null });
    check("no ceiling leaves the role's own permissions", uncapped.has("scenario:write"));

    // --- configuration that names a role the catalogue does not have ---
    const { warnUnknownConfiguredRoles } = await import("../src/auth/role-catalogue.js");
    const warnings: string[] = [];
    const unknown = await warnUnknownConfiguredRoles(
      {
        roleMap: new Map([["cn=wizards", "wizard"], ["cn=qa", "qa"]]),
        defaultRole: "viewer",
        twoFactorRequiredRoles: [],
      } as unknown as AuthConfig,
      (m) => warnings.push(m),
    );
    check("a group mapped to no role is reported at startup", unknown.join() === "wizard", unknown);
    check("the warning says where the id came from", warnings[0]?.includes("REQU_LDAP_ROLE_MAP") === true, warnings);
    check("a project-scoped role does not count as shared", !(await roleExists("release-manager", null)));
  } finally {
    if (previousDb === undefined) delete process.env.REQU_AUTH_DB;
    else process.env.REQU_AUTH_DB = previousDb;
    resetAuthConfig();
    setAuthStore(null);
    resetSeed();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
