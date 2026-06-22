import { Pool } from "pg";
import path from "node:path";
import {
  Component,
  Config,
  Execution,
  Phase,
  Requirement,
  Scenario,
  UserStory,
  VcsRef,
  type Component as TComponent,
  type Config as TConfig,
  type Execution as TExecution,
  type Phase as TPhase,
  type Requirement as TRequirement,
  type Scenario as TScenario,
  type UserStory as TUserStory,
  type VcsRef as TVcsRef,
} from "./schema.js";
import { Store } from "./storage.js";

// ---------------------------------------------------------------------------
// Module-level pool singleton
// ---------------------------------------------------------------------------

let _pool: Pool | null = null;
let _schemaReady: Promise<void> | null = null;

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
    .then(() =>
      _pool!.query(`
        DROP INDEX IF EXISTS idx_exec_project_phase;
        CREATE INDEX IF NOT EXISTS idx_exec_project_phase ON executions(project_id, phase_id, ran_at);
      `)
    )
    .then(() => undefined);
}

// ---------------------------------------------------------------------------
// PostgresStore
// ---------------------------------------------------------------------------

/**
 * PostgreSQL-backed store for HTTP mode.
 * Same async interface as SqliteStore. All projects share one PG database;
 * rows are namespaced by `project_id` (the URL-safe slug for the project root).
 */
export class PostgresStore {
  readonly root: string;
  readonly baseDir: string;
  readonly projectId: string;

  constructor(root: string, projectId: string) {
    this.root = path.resolve(root);
    this.baseDir = path.join(this.root, ".requ");
    this.projectId = projectId;
  }

  private async pool(): Promise<Pool> {
    if (!_pool) throw new Error("PostgreSQL not configured. Set REQU_PG_URL.");
    await _schemaReady;
    return _pool;
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

  async listComponents(): Promise<TComponent[]> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      "SELECT data FROM components WHERE project_id = $1 ORDER BY id",
      [this.projectId],
    );
    return rows.map((r) => Component.parse(r.data));
  }

  async getComponent(id: string): Promise<TComponent | null> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      "SELECT data FROM components WHERE project_id = $1 AND id = $2",
      [this.projectId, id],
    );
    return rows.length ? Component.parse(rows[0].data) : null;
  }

  async writeComponent(comp: TComponent): Promise<void> {
    const pool = await this.pool();
    const v = Component.parse(comp);
    await pool.query(
      `INSERT INTO components(project_id, id, data) VALUES($1, $2, $3)
       ON CONFLICT (project_id, id) DO UPDATE SET data = EXCLUDED.data`,
      [this.projectId, v.id, v],
    );
  }

  // --- requirements ---

  async listRequirements(): Promise<TRequirement[]> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      "SELECT data FROM requirements WHERE project_id = $1 ORDER BY id",
      [this.projectId],
    );
    return rows.map((r) => Requirement.parse(r.data));
  }

  async getRequirement(id: string): Promise<TRequirement | null> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      "SELECT data FROM requirements WHERE project_id = $1 AND id = $2",
      [this.projectId, id],
    );
    return rows.length ? Requirement.parse(rows[0].data) : null;
  }

  async writeRequirement(req: TRequirement): Promise<void> {
    const pool = await this.pool();
    const v = Requirement.parse(req);
    await pool.query(
      `INSERT INTO requirements(project_id, id, data) VALUES($1, $2, $3)
       ON CONFLICT (project_id, id) DO UPDATE SET data = EXCLUDED.data`,
      [this.projectId, v.id, v],
    );
  }

  // --- stories ---

  async listStories(): Promise<TUserStory[]> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      "SELECT data FROM stories WHERE project_id = $1 ORDER BY id",
      [this.projectId],
    );
    return rows.map((r) => UserStory.parse(r.data));
  }

  async getStory(id: string): Promise<TUserStory | null> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      "SELECT data FROM stories WHERE project_id = $1 AND id = $2",
      [this.projectId, id],
    );
    return rows.length ? UserStory.parse(rows[0].data) : null;
  }

  async writeStory(story: TUserStory): Promise<void> {
    const pool = await this.pool();
    const v = UserStory.parse(story);
    await pool.query(
      `INSERT INTO stories(project_id, id, data) VALUES($1, $2, $3)
       ON CONFLICT (project_id, id) DO UPDATE SET data = EXCLUDED.data`,
      [this.projectId, v.id, v],
    );
  }

  // --- phases ---

  async listPhases(): Promise<TPhase[]> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      "SELECT data FROM phases WHERE project_id = $1 ORDER BY sort_order",
      [this.projectId],
    );
    return rows.map((r) => Phase.parse(r.data));
  }

  async getPhase(id: string): Promise<TPhase | null> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      "SELECT data FROM phases WHERE project_id = $1 AND id = $2",
      [this.projectId, id],
    );
    return rows.length ? Phase.parse(rows[0].data) : null;
  }

  async writePhase(phase: TPhase): Promise<void> {
    const pool = await this.pool();
    const v = Phase.parse(phase);
    await pool.query(
      `INSERT INTO phases(project_id, id, sort_order, data) VALUES($1, $2, $3, $4)
       ON CONFLICT (project_id, id) DO UPDATE SET sort_order = EXCLUDED.sort_order, data = EXCLUDED.data`,
      [this.projectId, v.id, v.order, v],
    );
  }

  async resolvePhaseId(explicit?: string): Promise<string | null> {
    if (explicit) return explicit;
    const cfg = await this.readConfig();
    if (cfg.activePhase) return cfg.activePhase;
    const phases = await this.listPhases();
    return phases.length ? phases[phases.length - 1].id : null;
  }

  // --- executions ---

  async readExecutionLog(phaseId: string): Promise<TExecution[]> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `SELECT feature, name, status, ran_at, run_id, source, note
       FROM executions
       WHERE project_id = $1 AND phase_id = $2
       ORDER BY ran_at`,
      [this.projectId, phaseId],
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
      }),
    );
  }

  async appendExecutions(phaseId: string, runs: TExecution[]): Promise<void> {
    const pool = await this.pool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const run of runs) {
        const v = Execution.parse(run);
        await client.query(
          `INSERT INTO executions(project_id, phase_id, feature, name, status, ran_at, run_id, source, note)
           VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [this.projectId, phaseId, v.feature, v.name, v.status, v.ranAt, v.runId ?? null, v.source, v.note ?? null],
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

  async readAllExecutions(): Promise<Map<string, TExecution[]>> {
    const phases = await this.listPhases();
    const out = new Map<string, TExecution[]>();
    for (const p of phases) out.set(p.id, await this.readExecutionLog(p.id));
    return out;
  }

  // --- vcs refs ---

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
      `INSERT INTO vcs_refs(project_id, id, data) VALUES($1, $2, $3)
       ON CONFLICT (project_id, id) DO UPDATE SET data = EXCLUDED.data`,
      [this.projectId, v.id, v],
    );
  }

  async updateVcsRef(id: string, patch: Partial<TVcsRef>): Promise<TVcsRef | null> {
    const existing = await this.getVcsRef(id);
    if (!existing) return null;
    const merged = VcsRef.parse({ ...existing, ...patch, id: existing.id });
    await this.writeVcsRef(merged);
    return merged;
  }

  // --- scenarios ---

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
      `INSERT INTO scenarios(project_id, id, data) VALUES($1, $2, $3)
       ON CONFLICT (project_id, id) DO UPDATE SET data = EXCLUDED.data`,
      [this.projectId, v.testKey, v],
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

  /** Discover all project_ids that have a config row (DB-native project list). */
  static async listProjectIds(): Promise<string[]> {
    if (!_pool) throw new Error("PostgreSQL not configured. Set REQU_PG_URL.");
    await _schemaReady;
    const { rows } = await _pool.query("SELECT DISTINCT project_id FROM config ORDER BY project_id");
    return rows.map((r) => r.project_id as string);
  }

  static nextId = Store.nextId;
}
