import { Pool, type PoolClient } from "pg";
import path from "node:path";
import {
  Component,
  Config,
  Execution,
  Phase,
  Requirement,
  Adr,
  Scenario,
  Screen,
  UserStory,
  VcsRef,
  ProjectVersion,
  INITIAL_VERSION,
  VERSIONED_ENTITIES,
  type Component as TComponent,
  type Config as TConfig,
  type Execution as TExecution,
  type Phase as TPhase,
  type Requirement as TRequirement,
  type Scenario as TScenario,
  type Adr as TAdr,
  type Screen as TScreen,
  type UserStory as TUserStory,
  type VcsRef as TVcsRef,
  type ProjectVersion as TProjectVersion,
  type VersionedEntity,
} from "./schema.js";
import { assertWritable, compareSemver } from "./versioning.js";
import { nextId } from "./ids.js";

// ---------------------------------------------------------------------------
// Module-level pool singleton
// ---------------------------------------------------------------------------

let _pool: Pool | null = null;
let _schemaReady: Promise<void> | null = null;

/** Version status cache, keyed `${projectId}:${version}`. */
const _versionStatus = new Map<string, "draft" | "locked">();

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS config (
    project_id TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    PRIMARY KEY (project_id, key)
  );
  CREATE TABLE IF NOT EXISTS components (
    project_id TEXT  NOT NULL,
    id         TEXT  NOT NULL,
    data       JSONB NOT NULL,
    PRIMARY KEY (project_id, id)
  );
  CREATE TABLE IF NOT EXISTS requirements (
    project_id TEXT  NOT NULL,
    id         TEXT  NOT NULL,
    data       JSONB NOT NULL,
    PRIMARY KEY (project_id, id)
  );
  CREATE TABLE IF NOT EXISTS stories (
    project_id TEXT  NOT NULL,
    id         TEXT  NOT NULL,
    data       JSONB NOT NULL,
    PRIMARY KEY (project_id, id)
  );
  CREATE TABLE IF NOT EXISTS phases (
    project_id TEXT    NOT NULL,
    id         TEXT    NOT NULL,
    sort_order INTEGER NOT NULL,
    data       JSONB   NOT NULL,
    PRIMARY KEY (project_id, id)
  );
  CREATE TABLE IF NOT EXISTS executions (
    id         SERIAL  PRIMARY KEY,
    project_id TEXT    NOT NULL,
    phase_id   TEXT    NOT NULL,
    feature    TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    status     TEXT    NOT NULL,
    ran_at     TEXT    NOT NULL,
    run_id     TEXT,
    source     TEXT    NOT NULL DEFAULT 'manual',
    note       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_exec_project_phase ON executions(project_id, phase_id, ran_at);
  CREATE TABLE IF NOT EXISTS vcs_refs (
    project_id TEXT  NOT NULL,
    id         TEXT  NOT NULL,
    data       JSONB NOT NULL,
    PRIMARY KEY (project_id, id)
  );
  CREATE TABLE IF NOT EXISTS scenarios (
    project_id TEXT  NOT NULL,
    id         TEXT  NOT NULL,
    data       JSONB NOT NULL,
    PRIMARY KEY (project_id, id)
  );
  CREATE TABLE IF NOT EXISTS screens (
    project_id TEXT  NOT NULL,
    id         TEXT  NOT NULL,
    data       JSONB NOT NULL,
    PRIMARY KEY (project_id, id)
  );
  CREATE TABLE IF NOT EXISTS adrs (
    project_id TEXT  NOT NULL,
    id         TEXT  NOT NULL,
    data       JSONB NOT NULL,
    PRIMARY KEY (project_id, id)
  );
  CREATE TABLE IF NOT EXISTS versions (
    project_id TEXT  NOT NULL,
    version    TEXT  NOT NULL,
    status     TEXT  NOT NULL DEFAULT 'draft',
    data       JSONB NOT NULL,
    PRIMARY KEY (project_id, version)
  );
`;

/**
 * Forward migration to the versioned schema.
 *
 * Idempotent: the primary-key rebuild is skipped once `version` is already part
 * of the key, so this is safe to run on every boot. Pre-versioning rows are
 * stamped `1.0.0` by the column default, and a matching *draft* version row is
 * backfilled for every project that has a config row — so behaviour is unchanged
 * until someone locks a version for the first time.
 */
const MIGRATION_SQL = `
DO $$
DECLARE
  t text;
BEGIN
  -- Versioned entities: version joins the primary key, plus a tombstone flag.
  FOREACH t IN ARRAY ARRAY['components','requirements','stories','phases','screens','adrs'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS version TEXT NOT NULL DEFAULT %L', t, '${INITIAL_VERSION}');
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS removed BOOLEAN NOT NULL DEFAULT false', t);
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.table_constraints c
      JOIN information_schema.key_column_usage k
        ON k.constraint_name   = c.constraint_name
       AND k.constraint_schema = c.constraint_schema
      WHERE c.table_name      = t
        AND c.constraint_type = 'PRIMARY KEY'
        AND k.column_name     = 'version'
    ) THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_pkey');
      EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (project_id, version, id)', t);
    END IF;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(project_id, version)', 'idx_' || t || '_pv', t);
  END LOOP;

  -- Tagged data: records which version produced it; never part of the key.
  FOREACH t IN ARRAY ARRAY['executions','scenarios','vcs_refs'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS version TEXT', t);
  END LOOP;
END $$;

INSERT INTO versions(project_id, version, status, data)
SELECT DISTINCT c.project_id,
       '${INITIAL_VERSION}',
       'draft',
       jsonb_build_object(
         'version',   '${INITIAL_VERSION}',
         'status',    'draft',
         'label',     'Initial version',
         'createdAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       )
FROM config c
WHERE NOT EXISTS (SELECT 1 FROM versions v WHERE v.project_id = c.project_id);
`;

/**
 * Initialize the shared PostgreSQL pool. Must be called once before any
 * PostgresStore is used. Safe to call multiple times (idempotent per process).
 */
export function initPgPool(connectionString: string): void {
  if (_pool) return;
  _pool = new Pool({ connectionString });
  _schemaReady = _pool
    .query(SCHEMA_SQL)
    .then(() => _pool!.query(MIGRATION_SQL))
    .then(() =>
      _pool!.query(`
        DROP INDEX IF EXISTS idx_exec_project_phase;
        CREATE INDEX IF NOT EXISTS idx_exec_project_phase ON executions(project_id, phase_id, ran_at);
      `)
    )
    .then(() => undefined);
}

/** Table backing each versioned entity type. */
const TABLE: Record<VersionedEntity, string> = {
  components:   "components",
  requirements: "requirements",
  stories:      "stories",
  phases:       "phases",
  screens:      "screens",
  adrs:         "adrs",
};

// ---------------------------------------------------------------------------
// PostgresStore
// ---------------------------------------------------------------------------

/**
 * PostgreSQL-backed store for HTTP mode.
 * Same async interface as SqliteStore. All projects share one PG database; rows
 * are namespaced by `project_id` (the URL-safe slug for the project root) and by
 * `version` (the specification baseline they belong to).
 */
export class PostgresStore {
  readonly root: string;
  readonly baseDir: string;
  readonly projectId: string;
  /** Bound version, or null to resolve the project's pointer lazily. */
  private _version: string | null;

  constructor(root: string, projectId: string, version: string | null = null) {
    this.root = path.resolve(root);
    this.baseDir = path.join(this.root, ".requ");
    this.projectId = projectId;
    this._version = version;
  }

  /** A view of this project bound to another version. Shares the pool. */
  at(version: string): PostgresStore {
    return new PostgresStore(this.root, this.projectId, version);
  }

  private async pool(): Promise<Pool> {
    if (!_pool) throw new Error("PostgreSQL not configured. Set REQU_PG_URL.");
    await _schemaReady;
    return _pool;
  }

  /** The version this store reads and writes. Falls back to the project pointer. */
  async version(): Promise<string> {
    if (this._version) return this._version;
    let resolved = INITIAL_VERSION;
    try {
      const cfg = await this.readConfig();
      resolved = cfg.draftVersion ?? cfg.currentVersion ?? INITIAL_VERSION;
    } catch {
      /* uninitialized project — the initial version is the right answer */
    }
    this._version = resolved;
    return resolved;
  }

  // --- version registry ---

  async listVersions(): Promise<TProjectVersion[]> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      "SELECT data FROM versions WHERE project_id = $1",
      [this.projectId],
    );
    return rows
      .map((r) => ProjectVersion.parse(r.data))
      .sort((a, b) => compareSemver(a.version, b.version));
  }

  async getVersion(version: string): Promise<TProjectVersion | null> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      "SELECT data FROM versions WHERE project_id = $1 AND version = $2",
      [this.projectId, version],
    );
    return rows.length ? ProjectVersion.parse(rows[0].data) : null;
  }

  async writeVersion(v: TProjectVersion): Promise<void> {
    const pool = await this.pool();
    const parsed = ProjectVersion.parse(v);
    await pool.query(
      `INSERT INTO versions(project_id, version, status, data) VALUES($1, $2, $3, $4)
       ON CONFLICT (project_id, version) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data`,
      [this.projectId, parsed.version, parsed.status, parsed],
    );
    _versionStatus.set(`${this.projectId}:${parsed.version}`, parsed.status);
  }

  /**
   * Copy every in-scope entity from `from` into `to`, in one transaction.
   * Tombstoned rows are not carried over: a soft delete means the entity is gone
   * from that point on, and the diff against the parent already recorded it.
   */
  async copyVersion(from: string, to: string): Promise<Record<string, number>> {
    const pool = await this.pool();
    const client: PoolClient = await pool.connect();
    const counts: Record<string, number> = {};
    try {
      await client.query("BEGIN");
      for (const entity of VERSIONED_ENTITIES) {
        const table = TABLE[entity];
        const cols =
          table === "phases"
            ? "project_id, version, id, sort_order, data, removed"
            : "project_id, version, id, data, removed";
        const select =
          table === "phases"
            ? "project_id, $3, id, sort_order, data, false"
            : "project_id, $3, id, data, false";
        const res = await client.query(
          `INSERT INTO ${table}(${cols})
           SELECT ${select} FROM ${table}
           WHERE project_id = $1 AND version = $2 AND removed = false`,
          [this.projectId, from, to],
        );
        counts[entity] = res.rowCount ?? 0;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return counts;
  }

  /** Delete a version and everything in it. Used to roll back a failed create. */
  async dropVersion(version: string): Promise<void> {
    const pool = await this.pool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const entity of VERSIONED_ENTITIES) {
        await client.query(
          `DELETE FROM ${TABLE[entity]} WHERE project_id = $1 AND version = $2`,
          [this.projectId, version],
        );
      }
      await client.query("DELETE FROM versions WHERE project_id = $1 AND version = $2", [
        this.projectId,
        version,
      ]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    _versionStatus.delete(`${this.projectId}:${version}`);
  }

  /** Ids used by an entity type in *any* version, so an id is never reused. */
  async idsAcrossVersions(entity: VersionedEntity): Promise<string[]> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `SELECT DISTINCT id FROM ${TABLE[entity]} WHERE project_id = $1`,
      [this.projectId],
    );
    return rows.map((r) => r.id as string);
  }

  async isLocked(): Promise<boolean> {
    const version = await this.version();
    const cacheKey = `${this.projectId}:${version}`;
    let status = _versionStatus.get(cacheKey);
    if (!status) {
      const row = await this.getVersion(version);
      // An unregistered version is an open draft: that is the state a brand-new
      // project is in before its first version row is written.
      status = row?.status ?? "draft";
      _versionStatus.set(cacheKey, status);
    }
    return status === "locked";
  }

  // ---- generic versioned row helpers -------------------------------------

  private async listRows<T>(
    entity: VersionedEntity,
    schema: { parse: (v: unknown) => T },
    opts: { includeRemoved?: boolean; orderBy?: string } = {},
  ): Promise<T[]> {
    const pool = await this.pool();
    const order = opts.orderBy ?? "id";
    const { rows } = await pool.query(
      `SELECT data FROM ${TABLE[entity]}
       WHERE project_id = $1 AND version = $2 ${opts.includeRemoved ? "" : "AND removed = false"}
       ORDER BY ${order}`,
      [this.projectId, await this.version()],
    );
    return rows.map((r) => schema.parse(r.data));
  }

  private async getRow<T>(
    entity: VersionedEntity,
    schema: { parse: (v: unknown) => T },
    id: string,
    includeRemoved = false,
  ): Promise<T | null> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `SELECT data FROM ${TABLE[entity]}
       WHERE project_id = $1 AND version = $2 AND id = $3 ${includeRemoved ? "" : "AND removed = false"}`,
      [this.projectId, await this.version(), id],
    );
    return rows.length ? schema.parse(rows[0].data) : null;
  }

  /** Raw read that ignores tombstones — the lock guard needs the true prior state. */
  private async rawRow(entity: VersionedEntity, id: string): Promise<Record<string, unknown> | null> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `SELECT data FROM ${TABLE[entity]} WHERE project_id = $1 AND version = $2 AND id = $3`,
      [this.projectId, await this.version(), id],
    );
    return rows.length ? (rows[0].data as Record<string, unknown>) : null;
  }

  private async writeRow(
    entity: VersionedEntity,
    id: string,
    value: Record<string, unknown>,
    extra?: { column: string; value: unknown },
  ): Promise<void> {
    const pool = await this.pool();
    const version = await this.version();
    if (await this.isLocked()) {
      assertWritable(entity, version, await this.rawRow(entity, id), value);
    }
    const table = TABLE[entity];
    const removed = value.removed === true;
    if (extra) {
      await pool.query(
        `INSERT INTO ${table}(project_id, version, id, ${extra.column}, data, removed)
         VALUES($1, $2, $3, $4, $5, $6)
         ON CONFLICT (project_id, version, id)
         DO UPDATE SET ${extra.column} = EXCLUDED.${extra.column}, data = EXCLUDED.data, removed = EXCLUDED.removed`,
        [this.projectId, version, id, extra.value, value, removed],
      );
      return;
    }
    await pool.query(
      `INSERT INTO ${table}(project_id, version, id, data, removed)
       VALUES($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, version, id)
       DO UPDATE SET data = EXCLUDED.data, removed = EXCLUDED.removed`,
      [this.projectId, version, id, value, removed],
    );
  }

  /** Soft delete: leaves a tombstone so `diff_versions` can report the removal. */
  private async removeRow(
    entity: VersionedEntity,
    schema: { parse: (v: unknown) => Record<string, unknown> },
    id: string,
  ): Promise<boolean> {
    const existing = await this.rawRow(entity, id);
    if (!existing || existing.removed === true) return false;
    const tombstoned = schema.parse({
      ...existing,
      removed: true,
      updatedAt: new Date().toISOString(),
    });
    const extra =
      entity === "phases" ? { column: "sort_order", value: (tombstoned as any).order } : undefined;
    await this.writeRow(entity, id, tombstoned, extra);
    return true;
  }

  // --- config ---

  async isInitialized(): Promise<boolean> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      "SELECT 1 FROM config WHERE project_id = $1 AND key = $2",
      [this.projectId, "config"],
    );
    return rows.length > 0;
  }

  async init(config: TConfig): Promise<void> {
    await this.writeConfig(config);
  }

  async readConfig(): Promise<TConfig> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      "SELECT value FROM config WHERE project_id = $1 AND key = $2",
      [this.projectId, "config"],
    );
    if (!rows.length) throw new Error("requ project not initialized. Run init_project first.");
    return Config.parse(JSON.parse(rows[0].value as string));
  }

  async writeConfig(config: TConfig): Promise<void> {
    const pool = await this.pool();
    const v = Config.parse(config);
    await pool.query(
      `INSERT INTO config(project_id, key, value) VALUES($1, $2, $3)
       ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [this.projectId, "config", JSON.stringify(v)],
    );
  }

  async conductorRoot(): Promise<string> {
    const cfg = await this.readConfig();
    return path.isAbsolute(cfg.conductorPath)
      ? cfg.conductorPath
      : path.resolve(this.root, cfg.conductorPath);
  }

  resolvePath(p: string): string {
    return path.isAbsolute(p) ? p : path.resolve(this.root, p);
  }

  // --- components ---

  async listComponents(opts?: { includeRemoved?: boolean }): Promise<TComponent[]> {
    return this.listRows("components", Component, opts);
  }

  async getComponent(id: string): Promise<TComponent | null> {
    return this.getRow("components", Component, id);
  }

  async writeComponent(comp: TComponent): Promise<void> {
    const v = Component.parse(comp);
    await this.writeRow("components", v.id, v);
  }

  async deleteComponent(id: string): Promise<boolean> {
    return this.removeRow("components", Component as any, id);
  }

  // --- requirements ---

  async listRequirements(opts?: { includeRemoved?: boolean }): Promise<TRequirement[]> {
    return this.listRows("requirements", Requirement, opts);
  }

  async getRequirement(id: string): Promise<TRequirement | null> {
    return this.getRow("requirements", Requirement, id);
  }

  async writeRequirement(req: TRequirement): Promise<void> {
    const v = Requirement.parse(req);
    await this.writeRow("requirements", v.id, v);
  }

  async deleteRequirement(id: string): Promise<boolean> {
    return this.removeRow("requirements", Requirement as any, id);
  }

  // --- stories ---

  async listStories(opts?: { includeRemoved?: boolean }): Promise<TUserStory[]> {
    return this.listRows("stories", UserStory, opts);
  }

  async getStory(id: string): Promise<TUserStory | null> {
    return this.getRow("stories", UserStory, id);
  }

  async writeStory(story: TUserStory): Promise<void> {
    const v = UserStory.parse(story);
    await this.writeRow("stories", v.id, v);
  }

  async deleteStory(id: string): Promise<boolean> {
    return this.removeRow("stories", UserStory as any, id);
  }

  // --- phases ---

  async listPhases(opts?: { includeRemoved?: boolean }): Promise<TPhase[]> {
    return this.listRows("phases", Phase, { ...opts, orderBy: "sort_order" });
  }

  async getPhase(id: string): Promise<TPhase | null> {
    return this.getRow("phases", Phase, id);
  }

  async writePhase(phase: TPhase): Promise<void> {
    const v = Phase.parse(phase);
    await this.writeRow("phases", v.id, v, { column: "sort_order", value: v.order });
  }

  async deletePhase(id: string): Promise<boolean> {
    return this.removeRow("phases", Phase as any, id);
  }

  async resolvePhaseId(explicit?: string): Promise<string | null> {
    if (explicit) return explicit;
    const cfg = await this.readConfig();
    if (cfg.activePhase) return cfg.activePhase;
    const phases = await this.listPhases();
    return phases.length ? phases[phases.length - 1].id : null;
  }

  // --- executions ---
  // Tagged, not versioned: an execution records what actually ran, stamped with
  // the version it was produced against, so coverage can decide whether the
  // result still applies to a later version.

  async readExecutionLog(phaseId: string, opts?: { versions?: string[] }): Promise<TExecution[]> {
    const pool = await this.pool();
    const params: unknown[] = [this.projectId, phaseId];
    let filter = "";
    if (opts?.versions) {
      params.push(opts.versions);
      filter = "AND (version IS NULL OR version = ANY($3))";
    }
    const { rows } = await pool.query(
      `SELECT feature, name, status, ran_at, run_id, source, note, version
       FROM executions
       WHERE project_id = $1 AND phase_id = $2 ${filter}
       ORDER BY ran_at`,
      params,
    );
    return rows.map((r) =>
      Execution.parse({
        feature: r.feature as string,
        name:    r.name as string,
        status:  r.status as string,
        ranAt:   r.ran_at as string,
        runId:   (r.run_id as string | null) ?? undefined,
        source:  r.source as string,
        note:    (r.note as string | null) ?? undefined,
        version: (r.version as string | null) ?? undefined,
      }),
    );
  }

  async appendExecutions(phaseId: string, runs: TExecution[]): Promise<void> {
    const pool = await this.pool();
    const version = await this.version();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const run of runs) {
        const v = Execution.parse(run);
        await client.query(
          `INSERT INTO executions(project_id, phase_id, feature, name, status, ran_at, run_id, source, note, version)
           VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            this.projectId, phaseId, v.feature, v.name, v.status, v.ranAt,
            v.runId ?? null, v.source, v.note ?? null, v.version ?? version,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async readAllExecutions(opts?: { versions?: string[] }): Promise<Map<string, TExecution[]>> {
    const phases = await this.listPhases();
    const out = new Map<string, TExecution[]>();
    for (const p of phases) out.set(p.id, await this.readExecutionLog(p.id, opts));
    return out;
  }

  // --- vcs refs (tagged) ---

  async listVcsRefs(): Promise<TVcsRef[]> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      "SELECT data FROM vcs_refs WHERE project_id = $1 ORDER BY id",
      [this.projectId],
    );
    return rows.map((r) => VcsRef.parse(r.data));
  }

  async getVcsRef(id: string): Promise<TVcsRef | null> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      "SELECT data FROM vcs_refs WHERE project_id = $1 AND id = $2",
      [this.projectId, id],
    );
    return rows.length ? VcsRef.parse(rows[0].data) : null;
  }

  async writeVcsRef(ref: TVcsRef): Promise<void> {
    const pool = await this.pool();
    const v = VcsRef.parse(ref);
    await pool.query(
      `INSERT INTO vcs_refs(project_id, id, data, version) VALUES($1, $2, $3, $4)
       ON CONFLICT (project_id, id) DO UPDATE SET data = EXCLUDED.data`,
      [this.projectId, v.id, v, await this.version()],
    );
  }

  async updateVcsRef(id: string, patch: Partial<TVcsRef>): Promise<TVcsRef | null> {
    const existing = await this.getVcsRef(id);
    if (!existing) return null;
    const merged = VcsRef.parse({ ...existing, ...patch, id: existing.id });
    await this.writeVcsRef(merged);
    return merged;
  }

  // --- scenarios (tagged) ---

  async listScenarios(): Promise<TScenario[]> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      "SELECT data FROM scenarios WHERE project_id = $1 ORDER BY id",
      [this.projectId],
    );
    return rows.map((r) => Scenario.parse(r.data));
  }

  async getScenario(testKey: string): Promise<TScenario | null> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      "SELECT data FROM scenarios WHERE project_id = $1 AND id = $2",
      [this.projectId, testKey],
    );
    return rows.length ? Scenario.parse(rows[0].data) : null;
  }

  async writeScenario(sc: TScenario): Promise<void> {
    const pool = await this.pool();
    const v = Scenario.parse(sc);
    await pool.query(
      `INSERT INTO scenarios(project_id, id, data, version) VALUES($1, $2, $3, $4)
       ON CONFLICT (project_id, id) DO UPDATE SET data = EXCLUDED.data, version = EXCLUDED.version`,
      [this.projectId, v.testKey, v, await this.version()],
    );
  }

  async deleteScenario(testKey: string): Promise<boolean> {
    const pool = await this.pool();
    const res = await pool.query(
      "DELETE FROM scenarios WHERE project_id = $1 AND id = $2",
      [this.projectId, testKey],
    );
    return (res.rowCount ?? 0) > 0;
  }

  // --- screens ---

  async listScreens(opts?: { includeRemoved?: boolean }): Promise<TScreen[]> {
    return this.listRows("screens", Screen, opts);
  }

  async getScreen(id: string): Promise<TScreen | null> {
    return this.getRow("screens", Screen, id);
  }

  async writeScreen(screen: TScreen): Promise<void> {
    const v = Screen.parse(screen);
    await this.writeRow("screens", v.id, v);
  }

  async deleteScreen(id: string): Promise<boolean> {
    return this.removeRow("screens", Screen as any, id);
  }

  // --- architecture decisions ---

  async listAdrs(opts?: { includeRemoved?: boolean }): Promise<TAdr[]> {
    return this.listRows("adrs", Adr, opts);
  }

  async getAdr(id: string): Promise<TAdr | null> {
    return this.getRow("adrs", Adr, id);
  }

  async writeAdr(adr: TAdr): Promise<void> {
    const v = Adr.parse(adr);
    await this.writeRow("adrs", v.id, v);
  }

  async deleteAdr(id: string): Promise<boolean> {
    return this.removeRow("adrs", Adr as any, id);
  }

  /** Discover all project_ids that have a config row (DB-native project list). */
  static async listProjectIds(): Promise<string[]> {
    if (!_pool) throw new Error("PostgreSQL not configured. Set REQU_PG_URL.");
    await _schemaReady;
    const { rows } = await _pool.query("SELECT DISTINCT project_id FROM config ORDER BY project_id");
    return rows.map((r) => r.project_id as string);
  }

  static nextId = nextId;
}
