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
      check("audit entry carries the permission checked", createEntry?.permission === "spec:write", createEntry?.permission);
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
      check("a viewer may not write", me.body.permissions?.includes("spec:write") !== true, me.body.permissions);
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
      check("a capped token drops its owner's higher role", me.body.roles?.includes("maintainer") !== true, me.body.roles);
      check("a capped token keeps the role it was capped to", me.body.roles?.includes("viewer") === true, me.body.roles);

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
      { REQU_AUTH_MODE: "ldap", REQU_AUTH_SECRET: SECRET, REQU_LDAP_URL: "ldaps://dir", REQU_LDAP_BASE_DN: "dc=x", REQU_LDAP_ROLE_MAP: "grp=wizard" },
      () => {
        check("an unknown role in the group map is refused", throws(loadAuthConfig)?.includes("wizard") === true);
      },
    );
    await withEnv({ REQU_AUTH_MODE: "sometimes" }, () => {
      check("an unknown auth mode is refused", throws(loadAuthConfig)?.includes("REQU_AUTH_MODE") === true);
    });

    // Filter injection: a username may not end the filter or match everything.
    const { escapeFilterValue } = await import("../src/auth/ldap.js");
    check("filter escaping neutralises a wildcard", escapeFilterValue("*") === "\\2a");
    check("filter escaping neutralises parentheses", escapeFilterValue(")(uid=admin") === "\\29\\28uid=admin");

    const { capRoles } = await import("../src/auth/roles.js");
    check("capping keeps roles at or below the ceiling", JSON.stringify(capRoles(["viewer"], "maintainer")) === JSON.stringify(["viewer"]));
    check("capping drops roles above the ceiling", JSON.stringify(capRoles(["admin"], "viewer")) === JSON.stringify(["viewer"]));

    const { permissionsFor } = await import("../src/auth/model.js");
    check("a viewer cannot write", !permissionsFor(["viewer"]).has("spec:write"));
    check("a contributor records progress but not scope", permissionsFor(["contributor"]).has("progress:write") && !permissionsFor(["contributor"]).has("spec:write"));
    check("a maintainer is not a user administrator", !permissionsFor(["maintainer"]).has("admin:users"));
    check("an admin has every permission", permissionsFor(["admin"]).has("admin:users") && permissionsFor(["admin"]).has("audit:read"));

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
