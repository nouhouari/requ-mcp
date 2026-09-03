import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
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

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS components (
    id   TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS requirements (
    id   TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stories (
    id   TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS phases (
    id         TEXT    PRIMARY KEY,
    sort_order INTEGER NOT NULL,
    data       TEXT    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS executions (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    phase_id TEXT    NOT NULL,
    feature  TEXT    NOT NULL,
    name     TEXT    NOT NULL,
    status   TEXT    NOT NULL,
    ran_at   TEXT    NOT NULL,
    run_id   TEXT,
    source   TEXT    NOT NULL DEFAULT 'manual',
    note     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_exec_phase ON executions(phase_id);
  CREATE TABLE IF NOT EXISTS vcs_refs (
    id   TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scenarios (
    id   TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS screens (
    id   TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS adrs (
    id   TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS versions (
    version TEXT PRIMARY KEY,
    status  TEXT NOT NULL DEFAULT 'draft',
    data    TEXT NOT NULL
  );
`;

/** Extra columns a versioned table carries beyond `id` / `version` / `data`. */
const EXTRA_COLUMNS: Partial<Record<VersionedEntity, string>> = {
  phases: "sort_order INTEGER NOT NULL",
};

/** Table backing each versioned entity type. */
const TABLE: Record<VersionedEntity, string> = {
  components:   "components",
  requirements: "requirements",
  stories:      "stories",
  phases:       "phases",
  screens:      "screens",
  adrs:         "adrs",
};

/**
 * SQLite-backed store for HTTP mode.
 * Same async interface as PostgresStore; synchronous better-sqlite3 calls wrapped
 * in Promises. One database file holds one project, whose rows are namespaced by
 * the `version` (specification baseline) they belong to.
 */
export class SqliteStore {
  readonly root: string;
  readonly baseDir: string;
  private db: Database.Database;
  /** Bound version, or null to resolve the project's pointer lazily. */
  private _version: string | null;
  /** Version status cache, shared by every view of this database. */
  private _status: Map<string, "draft" | "locked">;

  constructor(root: string, dbPathOverride?: string, version: string | null = null) {
    this.root = path.resolve(root);
    this.baseDir = path.join(this.root, ".requ");
    const dbPath = dbPathOverride ?? path.join(this.baseDir, "requ.db");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);
    this._version = version;
    this._status = new Map();
    this.migrate();
  }

  /**
   * A view of this project bound to another version. Shares the open database
   * handle and the status cache, so locking through one view is seen by all.
   */
  at(version: string): SqliteStore {
    const view: SqliteStore = Object.create(SqliteStore.prototype);
    Object.assign(view, this);
    (view as any)._version = version;
    return view;
  }

  // ---- migration ---------------------------------------------------------

  /**
   * Forward migration to the versioned schema.
   *
   * SQLite cannot `ALTER` a primary key, so each versioned table is rebuilt:
   * create the new shape, copy the rows in stamping them as `1.0.0`, drop the
   * original, rename. Wrapped in one transaction and skipped once the `version`
   * column exists, so it is safe to run on every boot.
   */
  private migrate(): void {
    const hasColumn = (table: string, column: string): boolean =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .some((c) => c.name === column);

    const rebuild = this.db.transaction(() => {
      for (const entity of VERSIONED_ENTITIES) {
        const table = TABLE[entity];
        if (hasColumn(table, "version")) continue;

        const extra = EXTRA_COLUMNS[entity];
        const extraName = extra ? extra.split(" ")[0] : null;
        const cols = [
          "id TEXT NOT NULL",
          "version TEXT NOT NULL",
          extra,
          "data TEXT NOT NULL",
          "removed INTEGER NOT NULL DEFAULT 0",
        ].filter(Boolean).join(", ");
        const names  = ["id", "version", extraName, "data", "removed"].filter(Boolean).join(", ");
        const source = ["id", `'${INITIAL_VERSION}'`, extraName, "data", "0"].filter(Boolean).join(", ");

        this.db.exec(`
          CREATE TABLE ${table}__v (${cols}, PRIMARY KEY (id, version));
          INSERT INTO ${table}__v(${names}) SELECT ${source} FROM ${table};
          DROP TABLE ${table};
          ALTER TABLE ${table}__v RENAME TO ${table};
          CREATE INDEX IF NOT EXISTS idx_${table}_v ON ${table}(version);
        `);
      }

      // Tagged data: provenance only, never part of the key.
      for (const table of ["executions", "scenarios", "vcs_refs"]) {
        if (!hasColumn(table, "version")) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN version TEXT`);
        }
      }
    });
    rebuild();

    // A project that already has data gets an open 1.0.0 draft, so behaviour is
    // unchanged until someone locks it for the first time.
    const initialized = this.db.prepare("SELECT 1 FROM config WHERE key = 'config'").get();
    const anyVersion = this.db.prepare("SELECT 1 FROM versions LIMIT 1").get();
    if (initialized && !anyVersion) {
      const v = ProjectVersion.parse({
        version: INITIAL_VERSION,
        status: "draft",
        label: "Initial version",
        createdAt: new Date().toISOString(),
      });
      this.db.prepare("INSERT INTO versions(version, status, data) VALUES (?, ?, ?)")
        .run(v.version, v.status, JSON.stringify(v));
    }
  }

  // ---- version registry --------------------------------------------------

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

  async listVersions(): Promise<TProjectVersion[]> {
    const rows = this.db.prepare("SELECT data FROM versions").all() as { data: string }[];
    return rows
      .map((r) => ProjectVersion.parse(JSON.parse(r.data)))
      .sort((a, b) => compareSemver(a.version, b.version));
  }

  async getVersion(version: string): Promise<TProjectVersion | null> {
    const row = this.db.prepare("SELECT data FROM versions WHERE version = ?").get(version) as
      | { data: string } | undefined;
    return row ? ProjectVersion.parse(JSON.parse(row.data)) : null;
  }

  async writeVersion(v: TProjectVersion): Promise<void> {
    const parsed = ProjectVersion.parse(v);
    this.db.prepare("INSERT OR REPLACE INTO versions(version, status, data) VALUES (?, ?, ?)")
      .run(parsed.version, parsed.status, JSON.stringify(parsed));
    this._status.set(parsed.version, parsed.status);
  }

  /**
   * Copy every in-scope entity from `from` into `to`, in one transaction.
   * Tombstoned rows are not carried over: a soft delete means the entity is gone
   * from that point on, and the diff against the parent already recorded it.
   */
  async copyVersion(from: string, to: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const tx = this.db.transaction(() => {
      for (const entity of VERSIONED_ENTITIES) {
        const table = TABLE[entity];
        const extra = EXTRA_COLUMNS[entity];
        const extraName = extra ? extra.split(" ")[0] : null;
        const names  = ["id", "version", extraName, "data", "removed"].filter(Boolean).join(", ");
        const source = ["id", "?", extraName, "data", "0"].filter(Boolean).join(", ");
        const info = this.db
          .prepare(
            `INSERT INTO ${table}(${names})
             SELECT ${source} FROM ${table} WHERE version = ? AND removed = 0`,
          )
          .run(to, from);
        counts[entity] = info.changes;
      }
    });
    tx();
    return counts;
  }

  /** Delete a version and everything in it. Used to roll back a failed create. */
  async dropVersion(version: string): Promise<void> {
    const tx = this.db.transaction(() => {
      for (const entity of VERSIONED_ENTITIES) {
        this.db.prepare(`DELETE FROM ${TABLE[entity]} WHERE version = ?`).run(version);
      }
      this.db.prepare("DELETE FROM versions WHERE version = ?").run(version);
    });
    tx();
    this._status.delete(version);
  }

  /** Ids used by an entity type in *any* version, so an id is never reused. */
  async idsAcrossVersions(entity: VersionedEntity): Promise<string[]> {
    const rows = this.db.prepare(`SELECT DISTINCT id FROM ${TABLE[entity]}`).all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  async isLocked(): Promise<boolean> {
    const version = await this.version();
    let status = this._status.get(version);
    if (!status) {
      const row = await this.getVersion(version);
      // An unregistered version is an open draft: that is the state a brand-new
      // project is in before its first version row is written.
      status = row?.status ?? "draft";
      this._status.set(version, status);
    }
    return status === "locked";
  }

  // ---- generic versioned row helpers -------------------------------------

  private async listRows<T>(
    entity: VersionedEntity,
    schema: { parse: (v: unknown) => T },
    opts: { includeRemoved?: boolean; orderBy?: string } = {},
  ): Promise<T[]> {
    const rows = this.db
      .prepare(
        `SELECT data FROM ${TABLE[entity]}
         WHERE version = ? ${opts.includeRemoved ? "" : "AND removed = 0"}
         ORDER BY ${opts.orderBy ?? "id"}`,
      )
      .all(await this.version()) as { data: string }[];
    return rows.map((r) => schema.parse(JSON.parse(r.data)));
  }

  private async getRow<T>(
    entity: VersionedEntity,
    schema: { parse: (v: unknown) => T },
    id: string,
    includeRemoved = false,
  ): Promise<T | null> {
    const row = this.db
      .prepare(
        `SELECT data FROM ${TABLE[entity]}
         WHERE version = ? AND id = ? ${includeRemoved ? "" : "AND removed = 0"}`,
      )
      .get(await this.version(), id) as { data: string } | undefined;
    return row ? schema.parse(JSON.parse(row.data)) : null;
  }

  /** Raw read that ignores tombstones — the lock guard needs the true prior state. */
  private async rawRow(entity: VersionedEntity, id: string): Promise<Record<string, unknown> | null> {
    const row = this.db
      .prepare(`SELECT data FROM ${TABLE[entity]} WHERE version = ? AND id = ?`)
      .get(await this.version(), id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Record<string, unknown>) : null;
  }

  private async writeRow(
    entity: VersionedEntity,
    id: string,
    value: Record<string, unknown>,
    extra?: { column: string; value: unknown },
  ): Promise<void> {
    const version = await this.version();
    if (await this.isLocked()) {
      assertWritable(entity, version, await this.rawRow(entity, id), value);
    }
    const table = TABLE[entity];
    const removed = value.removed === true ? 1 : 0;
    const json = JSON.stringify(value);
    if (extra) {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO ${table}(id, version, ${extra.column}, data, removed) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, version, extra.value, json, removed);
      return;
    }
    this.db
      .prepare(`INSERT OR REPLACE INTO ${table}(id, version, data, removed) VALUES (?, ?, ?, ?)`)
      .run(id, version, json, removed);
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

  // --- init / config ---

  async isInitialized(): Promise<boolean> {
    const row = this.db.prepare("SELECT value FROM config WHERE key = ?").get("config") as { value: string } | undefined;
    return !!row;
  }

  async init(config: TConfig): Promise<void> {
    await this.writeConfig(config);
  }

  async readConfig(): Promise<TConfig> {
    const row = this.db.prepare("SELECT value FROM config WHERE key = ?").get("config") as { value: string } | undefined;
    if (!row) throw new Error("requ project not initialized. Run init_project first.");
    return Config.parse(JSON.parse(row.value));
  }

  async writeConfig(config: TConfig): Promise<void> {
    const v = Config.parse(config);
    this.db.prepare("INSERT OR REPLACE INTO config(key, value) VALUES (?, ?)").run("config", JSON.stringify(v));
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

  // --- executions (tagged) ---

  async readExecutionLog(phaseId: string, opts?: { versions?: string[] }): Promise<TExecution[]> {
    type Row = {
      feature: string; name: string; status: string; ran_at: string;
      run_id: string | null; source: string; note: string | null; version: string | null;
    };
    let sql =
      "SELECT feature, name, status, ran_at, run_id, source, note, version FROM executions WHERE phase_id = ?";
    const params: unknown[] = [phaseId];
    if (opts?.versions) {
      sql += ` AND (version IS NULL OR version IN (${opts.versions.map(() => "?").join(", ")}))`;
      params.push(...opts.versions);
    }
    sql += " ORDER BY ran_at";
    const rows = this.db.prepare(sql).all(...(params as [])) as Row[];
    return rows.map((r) =>
      Execution.parse({
        feature: r.feature,
        name:    r.name,
        status:  r.status,
        ranAt:   r.ran_at,
        runId:   r.run_id ?? undefined,
        source:  r.source,
        note:    r.note ?? undefined,
        version: r.version ?? undefined,
      }),
    );
  }

  async appendExecutions(phaseId: string, runs: TExecution[]): Promise<void> {
    const version = await this.version();
    const stmt = this.db.prepare(
      "INSERT INTO executions(phase_id, feature, name, status, ran_at, run_id, source, note, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const tx = this.db.transaction(() => {
      for (const run of runs) {
        const v = Execution.parse(run);
        stmt.run(
          phaseId, v.feature, v.name, v.status, v.ranAt,
          v.runId ?? null, v.source, v.note ?? null, v.version ?? version,
        );
      }
    });
    tx();
  }

  async readAllExecutions(opts?: { versions?: string[] }): Promise<Map<string, TExecution[]>> {
    const phases = await this.listPhases();
    const out = new Map<string, TExecution[]>();
    for (const p of phases) out.set(p.id, await this.readExecutionLog(p.id, opts));
    return out;
  }

  // --- vcs refs (tagged) ---

  async listVcsRefs(): Promise<TVcsRef[]> {
    const rows = this.db.prepare("SELECT data FROM vcs_refs ORDER BY id").all() as { data: string }[];
    return rows.map((r) => VcsRef.parse(JSON.parse(r.data)));
  }

  async getVcsRef(id: string): Promise<TVcsRef | null> {
    const row = this.db.prepare("SELECT data FROM vcs_refs WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? VcsRef.parse(JSON.parse(row.data)) : null;
  }

  async writeVcsRef(ref: TVcsRef): Promise<void> {
    const v = VcsRef.parse(ref);
    this.db.prepare("INSERT OR REPLACE INTO vcs_refs(id, data, version) VALUES (?, ?, ?)")
      .run(v.id, JSON.stringify(v), await this.version());
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
    const rows = this.db.prepare("SELECT data FROM scenarios ORDER BY id").all() as { data: string }[];
    return rows.map((r) => Scenario.parse(JSON.parse(r.data)));
  }

  async getScenario(testKey: string): Promise<TScenario | null> {
    const row = this.db.prepare("SELECT data FROM scenarios WHERE id = ?").get(testKey) as { data: string } | undefined;
    return row ? Scenario.parse(JSON.parse(row.data)) : null;
  }

  async writeScenario(sc: TScenario): Promise<void> {
    const v = Scenario.parse(sc);
    this.db.prepare("INSERT OR REPLACE INTO scenarios(id, data, version) VALUES (?, ?, ?)")
      .run(v.testKey, JSON.stringify(v), await this.version());
  }

  async deleteScenario(testKey: string): Promise<boolean> {
    const info = this.db.prepare("DELETE FROM scenarios WHERE id = ?").run(testKey);
    return info.changes > 0;
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

  static nextId = nextId;
}
