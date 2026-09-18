/**
 * Persistence for identities, tokens, sessions, role grants, the audit log and
 * the per-entity change history.
 *
 * These tables are server-wide, not per-project: one user has one set of tokens
 * whichever project they touch. So the store is a singleton, chosen to match how
 * requ itself is deployed — PostgreSQL when `REQU_PG_URL` is set (which is how
 * the Docker Compose stack and every production install runs), and a SQLite file
 * otherwise, so a laptop still keeps its audit trail across restarts.
 */

import type { Pool } from "pg";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { sharedPool, hasPgPool } from "../postgres-store.js";
import { authConfig } from "./config.js";
import type { Role } from "./model.js";
import type { RoleDefinition } from "./role-catalogue.js";
import type {
  AuditEntry,
  AuditQuery,
  AuthUser,
  ChangeQuery,
  EntityChange,
  RoleBinding,
  SessionRecord,
  TokenRecord,
  TotpRecord,
} from "./types.js";

const now = (): string => new Date().toISOString();

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface AuthStore {
  /** Create the tables. Idempotent, called once at boot. */
  init(): Promise<void>;

  // users
  upsertUser(user: Omit<AuthUser, "createdAt" | "lastLoginAt"> & { lastLoginAt?: string }): Promise<AuthUser>;
  getUser(id: string): Promise<AuthUser | null>;
  listUsers(): Promise<AuthUser[]>;
  setUserDisabled(id: string, disabled: boolean): Promise<boolean>;

  // role catalogue
  listRoles(): Promise<RoleDefinition[]>;
  putRole(role: RoleDefinition): Promise<void>;
  deleteRole(id: string, projectId: string | null): Promise<boolean>;

  // role bindings
  listBindings(userId?: string): Promise<RoleBinding[]>;
  grantRole(binding: RoleBinding): Promise<void>;
  revokeRole(userId: string, projectId: string, role: Role): Promise<boolean>;

  // tokens
  createToken(row: TokenRecord & { tokenHash: string }): Promise<void>;
  getTokenWithHash(id: string): Promise<(TokenRecord & { tokenHash: string }) | null>;
  listTokens(userId: string): Promise<TokenRecord[]>;
  listAllTokens(): Promise<TokenRecord[]>;
  revokeToken(id: string, revokedBy: string): Promise<boolean>;
  touchToken(id: string, at: string): Promise<void>;

  // sessions
  createSession(row: SessionRecord): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  /** Promote a session that has passed its second factor. */
  clearSessionPending(id: string): Promise<boolean>;
  revokeSession(id: string): Promise<boolean>;
  revokeSessionsForUser(userId: string): Promise<number>;
  purgeExpired(before: string): Promise<void>;

  // second factor
  getTotp(userId: string): Promise<TotpRecord | null>;
  putTotp(row: TotpRecord): Promise<void>;
  deleteTotp(userId: string): Promise<boolean>;
  /** Record the step a code was spent at, so it cannot be replayed. */
  setTotpLastStep(userId: string, step: number): Promise<void>;
  setRecoveryHashes(userId: string, hashes: string[]): Promise<void>;
  /** Users with a confirmed authenticator, for the administration listing. */
  listTotpUserIds(): Promise<string[]>;

  // audit
  appendAudit(entry: AuditEntry): Promise<number | null>;
  queryAudit(q: AuditQuery): Promise<{ entries: AuditEntry[]; total: number }>;

  // change history
  appendChanges(changes: EntityChange[]): Promise<void>;
  queryChanges(q: ChangeQuery): Promise<{ changes: EntityChange[]; total: number }>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function asJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

function clampLimit(n: number | undefined, fallback = 100, max = 1000): number {
  if (!Number.isFinite(n as number)) return fallback;
  return Math.min(Math.max(Math.trunc(n as number), 1), max);
}

function clampOffset(n: number | undefined): number {
  if (!Number.isFinite(n as number) || (n as number) < 0) return 0;
  return Math.trunc(n as number);
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS auth_users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    email         TEXT,
    dn            TEXT,
    groups        JSONB NOT NULL DEFAULT '[]'::jsonb,
    disabled      BOOLEAN NOT NULL DEFAULT false,
    created_at    TEXT NOT NULL,
    last_login_at TEXT
  );
  CREATE TABLE IF NOT EXISTS auth_role_bindings (
    user_id    TEXT NOT NULL,
    project_id TEXT NOT NULL,
    role       TEXT NOT NULL,
    granted_by TEXT,
    granted_at TEXT NOT NULL,
    PRIMARY KEY (user_id, project_id, role)
  );
  CREATE TABLE IF NOT EXISTS auth_roles (
    id          TEXT NOT NULL,
    -- '*' rather than NULL so it can sit in the primary key: a shared role and a
    -- project's own role of the same id are different rows.
    project_id  TEXT NOT NULL DEFAULT '*',
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
    built_in    BOOLEAN NOT NULL DEFAULT false,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    created_by  TEXT,
    PRIMARY KEY (project_id, id)
  );
  CREATE TABLE IF NOT EXISTS auth_tokens (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT,
    last_used_at TEXT,
    revoked_at   TEXT,
    revoked_by   TEXT,
    max_role     TEXT,
    projects     JSONB
  );
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    revoked_at   TEXT,
    ip           TEXT,
    user_agent   TEXT,
    pending_totp BOOLEAN NOT NULL DEFAULT false
  );
  -- Added after the sessions table shipped, so existing databases get it here.
  ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS pending_totp BOOLEAN NOT NULL DEFAULT false;
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
  CREATE TABLE IF NOT EXISTS auth_totp (
    user_id         TEXT PRIMARY KEY,
    secret_sealed   TEXT NOT NULL,
    confirmed_at    TEXT,
    created_at      TEXT NOT NULL,
    last_step       BIGINT,
    recovery_hashes JSONB NOT NULL DEFAULT '[]'::jsonb
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id         BIGSERIAL PRIMARY KEY,
    at         TEXT NOT NULL,
    actor_id   TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    source     TEXT NOT NULL,
    action     TEXT NOT NULL,
    project_id TEXT,
    version    TEXT,
    outcome    TEXT NOT NULL,
    permission TEXT,
    detail     JSONB,
    ip         TEXT,
    token_id   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_at      ON audit_log(at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_id, at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_log(actor_id, at DESC);
  CREATE TABLE IF NOT EXISTS entity_changes (
    id         BIGSERIAL PRIMARY KEY,
    at         TEXT NOT NULL,
    project_id TEXT NOT NULL,
    version    TEXT,
    entity     TEXT NOT NULL,
    entity_id  TEXT NOT NULL,
    action     TEXT NOT NULL,
    actor_id   TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    source     TEXT NOT NULL,
    changes    JSONB NOT NULL DEFAULT '[]'::jsonb
  );
  CREATE INDEX IF NOT EXISTS idx_changes_entity  ON entity_changes(project_id, entity, entity_id, at DESC);
  CREATE INDEX IF NOT EXISTS idx_changes_project ON entity_changes(project_id, at DESC);
`;

class PgAuthStore implements AuthStore {
  private ready: Promise<void> | null = null;

  private async db(): Promise<Pool> {
    const pool = await sharedPool();
    if (!pool) throw new Error("PostgreSQL not configured.");
    return pool;
  }

  async init(): Promise<void> {
    this.ready ??= (async () => {
      const pool = await this.db();
      await pool.query(PG_SCHEMA);
    })().catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  private async q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    await this.init();
    const pool = await this.db();
    const { rows } = await pool.query(sql, params as any[]);
    return rows as T[];
  }

  // --- users ---

  async upsertUser(
    user: Omit<AuthUser, "createdAt" | "lastLoginAt"> & { lastLoginAt?: string },
  ): Promise<AuthUser> {
    const ts = now();
    const rows = await this.q(
      `INSERT INTO auth_users (id, username, display_name, email, dn, groups, disabled, created_at, last_login_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         username      = EXCLUDED.username,
         display_name  = EXCLUDED.display_name,
         email         = EXCLUDED.email,
         dn            = EXCLUDED.dn,
         groups        = EXCLUDED.groups,
         last_login_at = COALESCE(EXCLUDED.last_login_at, auth_users.last_login_at)
       RETURNING *`,
      [
        user.id,
        user.username,
        user.displayName,
        user.email,
        user.dn,
        JSON.stringify(user.groups ?? []),
        user.disabled,
        ts,
        user.lastLoginAt ?? null,
      ],
    );
    return pgUser(rows[0]);
  }

  async getUser(id: string): Promise<AuthUser | null> {
    const rows = await this.q(`SELECT * FROM auth_users WHERE id = $1`, [id]);
    return rows[0] ? pgUser(rows[0]) : null;
  }

  async listUsers(): Promise<AuthUser[]> {
    const rows = await this.q(`SELECT * FROM auth_users ORDER BY username`);
    return rows.map(pgUser);
  }

  async setUserDisabled(id: string, disabled: boolean): Promise<boolean> {
    const rows = await this.q(`UPDATE auth_users SET disabled = $2 WHERE id = $1 RETURNING id`, [id, disabled]);
    return rows.length > 0;
  }

  // --- role catalogue ---

  async listRoles(): Promise<RoleDefinition[]> {
    const rows = await this.q(`SELECT * FROM auth_roles ORDER BY project_id, name`);
    return rows.map(pgRole);
  }

  async putRole(role: RoleDefinition): Promise<void> {
    await this.q(
      `INSERT INTO auth_roles (id, project_id, name, description, permissions, built_in, created_at, updated_at, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
       ON CONFLICT (project_id, id) DO UPDATE SET
         name        = EXCLUDED.name,
         description = EXCLUDED.description,
         permissions = EXCLUDED.permissions,
         updated_at  = EXCLUDED.updated_at`,
      [
        role.id, role.projectId ?? "*", role.name, role.description,
        JSON.stringify(role.permissions ?? []), role.builtIn,
        role.createdAt, role.updatedAt, role.createdBy,
      ],
    );
  }

  async deleteRole(id: string, projectId: string | null): Promise<boolean> {
    const rows = await this.q(
      `DELETE FROM auth_roles WHERE id = $1 AND project_id = $2 RETURNING id`,
      [id, projectId ?? "*"],
    );
    return rows.length > 0;
  }

  // --- role bindings ---

  async listBindings(userId?: string): Promise<RoleBinding[]> {
    const rows = userId
      ? await this.q(`SELECT * FROM auth_role_bindings WHERE user_id = $1`, [userId])
      : await this.q(`SELECT * FROM auth_role_bindings ORDER BY user_id, project_id`);
    return rows.map(pgBinding);
  }

  async grantRole(b: RoleBinding): Promise<void> {
    await this.q(
      `INSERT INTO auth_role_bindings (user_id, project_id, role, granted_by, granted_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, project_id, role) DO UPDATE SET granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at`,
      [b.userId, b.projectId, b.role, b.grantedBy, b.grantedAt],
    );
  }

  async revokeRole(userId: string, projectId: string, role: Role): Promise<boolean> {
    const rows = await this.q(
      `DELETE FROM auth_role_bindings WHERE user_id = $1 AND project_id = $2 AND role = $3 RETURNING user_id`,
      [userId, projectId, role],
    );
    return rows.length > 0;
  }

  // --- tokens ---

  async createToken(row: TokenRecord & { tokenHash: string }): Promise<void> {
    await this.q(
      `INSERT INTO auth_tokens (id, user_id, name, token_hash, created_at, expires_at, last_used_at, revoked_at, revoked_by, max_role, projects)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [
        row.id, row.userId, row.name, row.tokenHash, row.createdAt, row.expiresAt,
        row.lastUsedAt, row.revokedAt, row.revokedBy, row.maxRole,
        row.projects === null ? null : JSON.stringify(row.projects),
      ],
    );
  }

  async getTokenWithHash(id: string): Promise<(TokenRecord & { tokenHash: string }) | null> {
    const rows = await this.q(`SELECT * FROM auth_tokens WHERE id = $1`, [id]);
    return rows[0] ? { ...pgToken(rows[0]), tokenHash: rows[0].token_hash } : null;
  }

  async listTokens(userId: string): Promise<TokenRecord[]> {
    const rows = await this.q(`SELECT * FROM auth_tokens WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
    return rows.map(pgToken);
  }

  async listAllTokens(): Promise<TokenRecord[]> {
    const rows = await this.q(`SELECT * FROM auth_tokens ORDER BY created_at DESC`);
    return rows.map(pgToken);
  }

  async revokeToken(id: string, revokedBy: string): Promise<boolean> {
    const rows = await this.q(
      `UPDATE auth_tokens SET revoked_at = $2, revoked_by = $3 WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
      [id, now(), revokedBy],
    );
    return rows.length > 0;
  }

  async touchToken(id: string, at: string): Promise<void> {
    await this.q(`UPDATE auth_tokens SET last_used_at = $2 WHERE id = $1`, [id, at]);
  }

  // --- sessions ---

  async createSession(s: SessionRecord): Promise<void> {
    await this.q(
      `INSERT INTO auth_sessions (id, user_id, created_at, expires_at, revoked_at, ip, user_agent, pending_totp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [s.id, s.userId, s.createdAt, s.expiresAt, s.revokedAt, s.ip, s.userAgent, Boolean(s.pendingTotp)],
    );
  }

  async clearSessionPending(id: string): Promise<boolean> {
    const rows = await this.q(
      `UPDATE auth_sessions SET pending_totp = false
       WHERE id = $1 AND pending_totp = true AND revoked_at IS NULL RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const rows = await this.q(`SELECT * FROM auth_sessions WHERE id = $1`, [id]);
    return rows[0] ? pgSession(rows[0]) : null;
  }

  async revokeSession(id: string): Promise<boolean> {
    const rows = await this.q(
      `UPDATE auth_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
      [id, now()],
    );
    return rows.length > 0;
  }

  async revokeSessionsForUser(userId: string): Promise<number> {
    const rows = await this.q(
      `UPDATE auth_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
      [userId, now()],
    );
    return rows.length;
  }

  async purgeExpired(before: string): Promise<void> {
    await this.q(`DELETE FROM auth_sessions WHERE expires_at < $1`, [before]);
  }

  // --- second factor ---

  async getTotp(userId: string): Promise<TotpRecord | null> {
    const rows = await this.q(`SELECT * FROM auth_totp WHERE user_id = $1`, [userId]);
    return rows[0] ? pgTotp(rows[0]) : null;
  }

  async putTotp(row: TotpRecord): Promise<void> {
    await this.q(
      `INSERT INTO auth_totp (user_id, secret_sealed, confirmed_at, created_at, last_step, recovery_hashes)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET
         secret_sealed   = EXCLUDED.secret_sealed,
         confirmed_at    = EXCLUDED.confirmed_at,
         created_at      = EXCLUDED.created_at,
         last_step       = EXCLUDED.last_step,
         recovery_hashes = EXCLUDED.recovery_hashes`,
      [row.userId, row.secretSealed, row.confirmedAt, row.createdAt, row.lastStep, JSON.stringify(row.recoveryHashes ?? [])],
    );
  }

  async deleteTotp(userId: string): Promise<boolean> {
    const rows = await this.q(`DELETE FROM auth_totp WHERE user_id = $1 RETURNING user_id`, [userId]);
    return rows.length > 0;
  }

  async setTotpLastStep(userId: string, step: number): Promise<void> {
    // GREATEST so a code accepted one step behind cannot lower the watermark
    // and re-open a step that was already spent.
    await this.q(
      `UPDATE auth_totp SET last_step = GREATEST(COALESCE(last_step, -1), $2) WHERE user_id = $1`,
      [userId, step],
    );
  }

  async setRecoveryHashes(userId: string, hashes: string[]): Promise<void> {
    await this.q(`UPDATE auth_totp SET recovery_hashes = $2::jsonb WHERE user_id = $1`, [userId, JSON.stringify(hashes)]);
  }

  async listTotpUserIds(): Promise<string[]> {
    const rows = await this.q(`SELECT user_id FROM auth_totp WHERE confirmed_at IS NOT NULL`);
    return rows.map((r: any) => r.user_id as string);
  }

  // --- audit ---

  async appendAudit(e: AuditEntry): Promise<number | null> {
    const rows = await this.q(
      `INSERT INTO audit_log (at, actor_id, actor_name, actor_kind, source, action, project_id, version, outcome, permission, detail, ip, token_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13) RETURNING id`,
      [
        e.at, e.actorId, e.actorName, e.actorKind, e.source, e.action, e.projectId,
        e.version, e.outcome, e.permission,
        e.detail === null ? null : JSON.stringify(e.detail), e.ip, e.tokenId,
      ],
    );
    return rows[0] ? Number(rows[0].id) : null;
  }

  async queryAudit(q: AuditQuery): Promise<{ entries: AuditEntry[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (q.projectId) add("project_id = ?", q.projectId);
    if (q.actorId) add("actor_id = ?", q.actorId);
    if (q.action) add("action = ?", q.action);
    if (q.outcome) add("outcome = ?", q.outcome);
    if (q.source) add("source = ?", q.source);
    if (q.since) add("at >= ?", q.since);
    if (q.until) add("at <= ?", q.until);
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = clampLimit(q.limit);
    const offset = clampOffset(q.offset);
    const countRows = await this.q(`SELECT COUNT(*)::int AS n FROM audit_log ${clause}`, params);
    const rows = await this.q(
      `SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { entries: rows.map(pgAudit), total: Number(countRows[0]?.n ?? 0) };
  }

  // --- change history ---

  async appendChanges(changes: EntityChange[]): Promise<void> {
    if (changes.length === 0) return;
    const values: string[] = [];
    const params: unknown[] = [];
    for (const c of changes) {
      const base = params.length;
      values.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10}::jsonb)`,
      );
      params.push(c.at, c.projectId, c.version, c.entity, c.entityId, c.action, c.actorId, c.actorName, c.source, JSON.stringify(c.changes));
    }
    await this.q(
      `INSERT INTO entity_changes (at, project_id, version, entity, entity_id, action, actor_id, actor_name, source, changes)
       VALUES ${values.join(",")}`,
      params,
    );
  }

  async queryChanges(q: ChangeQuery): Promise<{ changes: EntityChange[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    add("project_id = ?", q.projectId);
    if (q.entity) add("entity = ?", q.entity);
    if (q.entityId) add("entity_id = ?", q.entityId);
    if (q.version) add("version = ?", q.version);
    if (q.actorId) add("actor_id = ?", q.actorId);
    if (q.since) add("at >= ?", q.since);
    const clause = `WHERE ${where.join(" AND ")}`;
    const limit = clampLimit(q.limit);
    const offset = clampOffset(q.offset);
    const countRows = await this.q(`SELECT COUNT(*)::int AS n FROM entity_changes ${clause}`, params);
    const rows = await this.q(
      `SELECT * FROM entity_changes ${clause} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { changes: rows.map(pgChange), total: Number(countRows[0]?.n ?? 0) };
  }
}

function pgUser(r: any): AuthUser {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    email: r.email ?? null,
    dn: r.dn ?? null,
    groups: asJson<string[]>(r.groups, []),
    disabled: Boolean(r.disabled),
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at ?? null,
  };
}

function pgRole(r: any): RoleDefinition {
  return {
    id: r.id,
    // '*' is how "shared across every project" is stored, so it can be part of
    // the primary key; null is how the rest of the code says it.
    projectId: r.project_id === "*" ? null : r.project_id,
    name: r.name,
    description: r.description ?? "",
    permissions: asJson<string[]>(r.permissions, []) as RoleDefinition["permissions"],
    builtIn: Boolean(r.built_in),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by ?? null,
  };
}

function pgBinding(r: any): RoleBinding {
  return {
    userId: r.user_id,
    projectId: r.project_id,
    role: r.role,
    grantedBy: r.granted_by ?? null,
    grantedAt: r.granted_at,
  };
}

function pgToken(r: any): TokenRecord {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    createdAt: r.created_at,
    expiresAt: r.expires_at ?? null,
    lastUsedAt: r.last_used_at ?? null,
    revokedAt: r.revoked_at ?? null,
    revokedBy: r.revoked_by ?? null,
    maxRole: (r.max_role ?? null) as Role | null,
    projects: r.projects === null || r.projects === undefined ? null : asJson<string[]>(r.projects, []),
  };
}

function pgSession(r: any): SessionRecord {
  return {
    id: r.id,
    userId: r.user_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at ?? null,
    ip: r.ip ?? null,
    userAgent: r.user_agent ?? null,
    pendingTotp: Boolean(r.pending_totp),
  };
}

function pgTotp(r: any): TotpRecord {
  return {
    userId: r.user_id,
    secretSealed: r.secret_sealed,
    confirmedAt: r.confirmed_at ?? null,
    createdAt: r.created_at,
    lastStep: r.last_step === null || r.last_step === undefined ? null : Number(r.last_step),
    recoveryHashes: asJson<string[]>(r.recovery_hashes, []),
  };
}

function pgAudit(r: any): AuditEntry {
  return {
    id: Number(r.id),
    at: r.at,
    actorId: r.actor_id,
    actorName: r.actor_name,
    actorKind: r.actor_kind,
    source: r.source,
    action: r.action,
    projectId: r.project_id ?? null,
    version: r.version ?? null,
    outcome: r.outcome,
    permission: r.permission ?? null,
    detail: r.detail === null || r.detail === undefined ? null : asJson<Record<string, unknown>>(r.detail, {}),
    ip: r.ip ?? null,
    tokenId: r.token_id ?? null,
  };
}

function pgChange(r: any): EntityChange {
  return {
    id: Number(r.id),
    at: r.at,
    projectId: r.project_id,
    version: r.version ?? null,
    entity: r.entity,
    entityId: r.entity_id,
    action: r.action,
    actorId: r.actor_id,
    actorName: r.actor_name,
    source: r.source,
    changes: asJson(r.changes, []),
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS auth_users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    email         TEXT,
    dn            TEXT,
    groups        TEXT NOT NULL DEFAULT '[]',
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    last_login_at TEXT
  );
  CREATE TABLE IF NOT EXISTS auth_role_bindings (
    user_id    TEXT NOT NULL,
    project_id TEXT NOT NULL,
    role       TEXT NOT NULL,
    granted_by TEXT,
    granted_at TEXT NOT NULL,
    PRIMARY KEY (user_id, project_id, role)
  );
  CREATE TABLE IF NOT EXISTS auth_roles (
    id          TEXT NOT NULL,
    -- '*' rather than NULL so it can sit in the primary key: a shared role and a
    -- project's own role of the same id are different rows.
    project_id  TEXT NOT NULL DEFAULT '*',
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    permissions TEXT NOT NULL DEFAULT '[]',
    built_in    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    created_by  TEXT,
    PRIMARY KEY (project_id, id)
  );
  CREATE TABLE IF NOT EXISTS auth_tokens (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT,
    last_used_at TEXT,
    revoked_at   TEXT,
    revoked_by   TEXT,
    max_role     TEXT,
    projects     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    revoked_at   TEXT,
    ip           TEXT,
    user_agent   TEXT,
    pending_totp INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
  CREATE TABLE IF NOT EXISTS auth_totp (
    user_id         TEXT PRIMARY KEY,
    secret_sealed   TEXT NOT NULL,
    confirmed_at    TEXT,
    created_at      TEXT NOT NULL,
    last_step       INTEGER,
    recovery_hashes TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL,
    actor_id   TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    source     TEXT NOT NULL,
    action     TEXT NOT NULL,
    project_id TEXT,
    version    TEXT,
    outcome    TEXT NOT NULL,
    permission TEXT,
    detail     TEXT,
    ip         TEXT,
    token_id   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_at      ON audit_log(at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_id, at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_log(actor_id, at DESC);
  CREATE TABLE IF NOT EXISTS entity_changes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL,
    project_id TEXT NOT NULL,
    version    TEXT,
    entity     TEXT NOT NULL,
    entity_id  TEXT NOT NULL,
    action     TEXT NOT NULL,
    actor_id   TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    source     TEXT NOT NULL,
    changes    TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_changes_entity  ON entity_changes(project_id, entity, entity_id, at DESC);
  CREATE INDEX IF NOT EXISTS idx_changes_project ON entity_changes(project_id, at DESC);
`;

class SqliteAuthStore implements AuthStore {
  private db: any = null;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async init(): Promise<void> {
    if (this.db) return;
    const { default: Database } = await import("better-sqlite3");
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new Database(this.file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SQLITE_SCHEMA);
  }

  private async handle(): Promise<any> {
    await this.init();
    return this.db;
  }

  // --- users ---

  async upsertUser(
    user: Omit<AuthUser, "createdAt" | "lastLoginAt"> & { lastLoginAt?: string },
  ): Promise<AuthUser> {
    const db = await this.handle();
    db.prepare(
      `INSERT INTO auth_users (id, username, display_name, email, dn, groups, disabled, created_at, last_login_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         username      = excluded.username,
         display_name  = excluded.display_name,
         email         = excluded.email,
         dn            = excluded.dn,
         groups        = excluded.groups,
         last_login_at = COALESCE(excluded.last_login_at, auth_users.last_login_at)`,
    ).run(
      user.id, user.username, user.displayName, user.email, user.dn,
      JSON.stringify(user.groups ?? []), user.disabled ? 1 : 0, now(), user.lastLoginAt ?? null,
    );
    return (await this.getUser(user.id))!;
  }

  async getUser(id: string): Promise<AuthUser | null> {
    const db = await this.handle();
    const r = db.prepare(`SELECT * FROM auth_users WHERE id = ?`).get(id);
    return r ? pgUser(r) : null;
  }

  async listUsers(): Promise<AuthUser[]> {
    const db = await this.handle();
    return db.prepare(`SELECT * FROM auth_users ORDER BY username`).all().map(pgUser);
  }

  async setUserDisabled(id: string, disabled: boolean): Promise<boolean> {
    const db = await this.handle();
    return db.prepare(`UPDATE auth_users SET disabled = ? WHERE id = ?`).run(disabled ? 1 : 0, id).changes > 0;
  }

  // --- role catalogue ---

  async listRoles(): Promise<RoleDefinition[]> {
    const db = await this.handle();
    return db.prepare(`SELECT * FROM auth_roles ORDER BY project_id, name`).all().map(pgRole);
  }

  async putRole(role: RoleDefinition): Promise<void> {
    const db = await this.handle();
    db.prepare(
      `INSERT INTO auth_roles (id, project_id, name, description, permissions, built_in, created_at, updated_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(project_id, id) DO UPDATE SET
         name        = excluded.name,
         description = excluded.description,
         permissions = excluded.permissions,
         updated_at  = excluded.updated_at`,
    ).run(
      role.id, role.projectId ?? "*", role.name, role.description,
      JSON.stringify(role.permissions ?? []), role.builtIn ? 1 : 0,
      role.createdAt, role.updatedAt, role.createdBy,
    );
  }

  async deleteRole(id: string, projectId: string | null): Promise<boolean> {
    const db = await this.handle();
    return db.prepare(`DELETE FROM auth_roles WHERE id = ? AND project_id = ?`).run(id, projectId ?? "*").changes > 0;
  }

  // --- role bindings ---

  async listBindings(userId?: string): Promise<RoleBinding[]> {
    const db = await this.handle();
    const rows = userId
      ? db.prepare(`SELECT * FROM auth_role_bindings WHERE user_id = ?`).all(userId)
      : db.prepare(`SELECT * FROM auth_role_bindings ORDER BY user_id, project_id`).all();
    return rows.map(pgBinding);
  }

  async grantRole(b: RoleBinding): Promise<void> {
    const db = await this.handle();
    db.prepare(
      `INSERT INTO auth_role_bindings (user_id, project_id, role, granted_by, granted_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(user_id, project_id, role) DO UPDATE SET granted_by = excluded.granted_by, granted_at = excluded.granted_at`,
    ).run(b.userId, b.projectId, b.role, b.grantedBy, b.grantedAt);
  }

  async revokeRole(userId: string, projectId: string, role: Role): Promise<boolean> {
    const db = await this.handle();
    return (
      db.prepare(`DELETE FROM auth_role_bindings WHERE user_id = ? AND project_id = ? AND role = ?`)
        .run(userId, projectId, role).changes > 0
    );
  }

  // --- tokens ---

  async createToken(row: TokenRecord & { tokenHash: string }): Promise<void> {
    const db = await this.handle();
    db.prepare(
      `INSERT INTO auth_tokens (id, user_id, name, token_hash, created_at, expires_at, last_used_at, revoked_at, revoked_by, max_role, projects)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.id, row.userId, row.name, row.tokenHash, row.createdAt, row.expiresAt,
      row.lastUsedAt, row.revokedAt, row.revokedBy, row.maxRole,
      row.projects === null ? null : JSON.stringify(row.projects),
    );
  }

  async getTokenWithHash(id: string): Promise<(TokenRecord & { tokenHash: string }) | null> {
    const db = await this.handle();
    const r = db.prepare(`SELECT * FROM auth_tokens WHERE id = ?`).get(id);
    return r ? { ...pgToken(r), tokenHash: r.token_hash } : null;
  }

  async listTokens(userId: string): Promise<TokenRecord[]> {
    const db = await this.handle();
    return db.prepare(`SELECT * FROM auth_tokens WHERE user_id = ? ORDER BY created_at DESC`).all(userId).map(pgToken);
  }

  async listAllTokens(): Promise<TokenRecord[]> {
    const db = await this.handle();
    return db.prepare(`SELECT * FROM auth_tokens ORDER BY created_at DESC`).all().map(pgToken);
  }

  async revokeToken(id: string, revokedBy: string): Promise<boolean> {
    const db = await this.handle();
    return (
      db.prepare(`UPDATE auth_tokens SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL`)
        .run(now(), revokedBy, id).changes > 0
    );
  }

  async touchToken(id: string, at: string): Promise<void> {
    const db = await this.handle();
    db.prepare(`UPDATE auth_tokens SET last_used_at = ? WHERE id = ?`).run(at, id);
  }

  // --- sessions ---

  async createSession(s: SessionRecord): Promise<void> {
    const db = await this.handle();
    db.prepare(
      `INSERT INTO auth_sessions (id, user_id, created_at, expires_at, revoked_at, ip, user_agent, pending_totp)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(s.id, s.userId, s.createdAt, s.expiresAt, s.revokedAt, s.ip, s.userAgent, s.pendingTotp ? 1 : 0);
  }

  async clearSessionPending(id: string): Promise<boolean> {
    const db = await this.handle();
    return (
      db.prepare(`UPDATE auth_sessions SET pending_totp = 0 WHERE id = ? AND pending_totp = 1 AND revoked_at IS NULL`)
        .run(id).changes > 0
    );
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const db = await this.handle();
    const r = db.prepare(`SELECT * FROM auth_sessions WHERE id = ?`).get(id);
    return r ? pgSession(r) : null;
  }

  async revokeSession(id: string): Promise<boolean> {
    const db = await this.handle();
    return db.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now(), id).changes > 0;
  }

  async revokeSessionsForUser(userId: string): Promise<number> {
    const db = await this.handle();
    return db.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).run(now(), userId).changes;
  }

  async purgeExpired(before: string): Promise<void> {
    const db = await this.handle();
    db.prepare(`DELETE FROM auth_sessions WHERE expires_at < ?`).run(before);
  }

  // --- second factor ---

  async getTotp(userId: string): Promise<TotpRecord | null> {
    const db = await this.handle();
    const r = db.prepare(`SELECT * FROM auth_totp WHERE user_id = ?`).get(userId);
    return r ? pgTotp(r) : null;
  }

  async putTotp(row: TotpRecord): Promise<void> {
    const db = await this.handle();
    db.prepare(
      `INSERT INTO auth_totp (user_id, secret_sealed, confirmed_at, created_at, last_step, recovery_hashes)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET
         secret_sealed   = excluded.secret_sealed,
         confirmed_at    = excluded.confirmed_at,
         created_at      = excluded.created_at,
         last_step       = excluded.last_step,
         recovery_hashes = excluded.recovery_hashes`,
    ).run(row.userId, row.secretSealed, row.confirmedAt, row.createdAt, row.lastStep, JSON.stringify(row.recoveryHashes ?? []));
  }

  async deleteTotp(userId: string): Promise<boolean> {
    const db = await this.handle();
    return db.prepare(`DELETE FROM auth_totp WHERE user_id = ?`).run(userId).changes > 0;
  }

  async setTotpLastStep(userId: string, step: number): Promise<void> {
    const db = await this.handle();
    // MAX so a code accepted one step behind cannot lower the watermark and
    // re-open a step that was already spent.
    db.prepare(`UPDATE auth_totp SET last_step = MAX(COALESCE(last_step, -1), ?) WHERE user_id = ?`).run(step, userId);
  }

  async setRecoveryHashes(userId: string, hashes: string[]): Promise<void> {
    const db = await this.handle();
    db.prepare(`UPDATE auth_totp SET recovery_hashes = ? WHERE user_id = ?`).run(JSON.stringify(hashes), userId);
  }

  async listTotpUserIds(): Promise<string[]> {
    const db = await this.handle();
    return db.prepare(`SELECT user_id FROM auth_totp WHERE confirmed_at IS NOT NULL`).all().map((r: any) => r.user_id as string);
  }

  // --- audit ---

  async appendAudit(e: AuditEntry): Promise<number | null> {
    const db = await this.handle();
    const info = db.prepare(
      `INSERT INTO audit_log (at, actor_id, actor_name, actor_kind, source, action, project_id, version, outcome, permission, detail, ip, token_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      e.at, e.actorId, e.actorName, e.actorKind, e.source, e.action, e.projectId, e.version,
      e.outcome, e.permission, e.detail === null ? null : JSON.stringify(e.detail), e.ip, e.tokenId,
    );
    return Number(info.lastInsertRowid);
  }

  async queryAudit(q: AuditQuery): Promise<{ entries: AuditEntry[]; total: number }> {
    const db = await this.handle();
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => { where.push(sql); params.push(value); };
    if (q.projectId) add("project_id = ?", q.projectId);
    if (q.actorId) add("actor_id = ?", q.actorId);
    if (q.action) add("action = ?", q.action);
    if (q.outcome) add("outcome = ?", q.outcome);
    if (q.source) add("source = ?", q.source);
    if (q.since) add("at >= ?", q.since);
    if (q.until) add("at <= ?", q.until);
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).get(...params).n as number;
    const rows = db
      .prepare(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, clampLimit(q.limit), clampOffset(q.offset));
    return { entries: rows.map(pgAudit), total: Number(total) };
  }

  // --- change history ---

  async appendChanges(changes: EntityChange[]): Promise<void> {
    if (changes.length === 0) return;
    const db = await this.handle();
    const stmt = db.prepare(
      `INSERT INTO entity_changes (at, project_id, version, entity, entity_id, action, actor_id, actor_name, source, changes)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    const many = db.transaction((rows: EntityChange[]) => {
      for (const c of rows) {
        stmt.run(c.at, c.projectId, c.version, c.entity, c.entityId, c.action, c.actorId, c.actorName, c.source, JSON.stringify(c.changes));
      }
    });
    many(changes);
  }

  async queryChanges(q: ChangeQuery): Promise<{ changes: EntityChange[]; total: number }> {
    const db = await this.handle();
    const where: string[] = ["project_id = ?"];
    const params: unknown[] = [q.projectId];
    const add = (sql: string, value: unknown) => { where.push(sql); params.push(value); };
    if (q.entity) add("entity = ?", q.entity);
    if (q.entityId) add("entity_id = ?", q.entityId);
    if (q.version) add("version = ?", q.version);
    if (q.actorId) add("actor_id = ?", q.actorId);
    if (q.since) add("at >= ?", q.since);
    const clause = `WHERE ${where.join(" AND ")}`;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM entity_changes ${clause}`).get(...params).n as number;
    const rows = db
      .prepare(`SELECT * FROM entity_changes ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, clampLimit(q.limit), clampOffset(q.offset));
    return { changes: rows.map(pgChange), total: Number(total) };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _store: AuthStore | null = null;

/**
 * The process-wide auth store, created on first use. Follows requ's own
 * backend: PostgreSQL when configured, otherwise a SQLite file.
 */
export function authStore(): AuthStore {
  if (!_store) {
    _store = hasPgPool() ? new PgAuthStore() : new SqliteAuthStore(authConfig().sqlitePath);
  }
  return _store;
}

/** Replace the store — used by tests. */
export function setAuthStore(store: AuthStore | null): void {
  _store = store;
}
