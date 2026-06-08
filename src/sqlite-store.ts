import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  Component,
  Config,
  Execution,
  Phase,
  Requirement,
  UserStory,
  type Component as TComponent,
  type Config as TConfig,
  type Execution as TExecution,
  type Phase as TPhase,
  type Requirement as TRequirement,
  type UserStory as TUserStory,
} from "./schema.js";
import { Store } from "./storage.js";

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
`;

/**
 * SQLite-backed store for HTTP mode.
 * Same async interface as Store; synchronous better-sqlite3 calls wrapped in Promises.
 * A single instance is reused for the lifetime of the HTTP server (WAL mode).
 */
export class SqliteStore {
  readonly root: string;
  readonly baseDir: string;
  private db: Database.Database;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.baseDir = path.join(this.root, ".requ");
    const dbPath = process.env.REQU_DB ?? path.join(this.baseDir, "requ.db");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);
  }

  // --- helpers ---

  private get<T>(stmt: string, params: unknown[], schema: { parse: (v: unknown) => T }): T | null {
    const row = (this.db.prepare(stmt).get(...(params as []))) as { data: string } | undefined;
    return row ? schema.parse(JSON.parse(row.data)) : null;
  }

  private all<T>(stmt: string, schema: { parse: (v: unknown) => T }): T[] {
    const rows = (this.db.prepare(stmt).all()) as { data: string }[];
    return rows.map(r => schema.parse(JSON.parse(r.data)));
  }

  private put(table: string, id: string, data: unknown): void {
    this.db.prepare(`INSERT OR REPLACE INTO ${table}(id, data) VALUES (?, ?)`)
      .run(id, JSON.stringify(data));
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

  async listComponents(): Promise<TComponent[]> {
    return this.all("SELECT data FROM components ORDER BY id", Component);
  }

  async getComponent(id: string): Promise<TComponent | null> {
    return this.get("SELECT data FROM components WHERE id = ?", [id], Component);
  }

  async writeComponent(comp: TComponent): Promise<void> {
    const v = Component.parse(comp);
    this.put("components", v.id, v);
  }

  // --- requirements ---

  async listRequirements(): Promise<TRequirement[]> {
    return this.all("SELECT data FROM requirements ORDER BY id", Requirement);
  }

  async getRequirement(id: string): Promise<TRequirement | null> {
    return this.get("SELECT data FROM requirements WHERE id = ?", [id], Requirement);
  }

  async writeRequirement(req: TRequirement): Promise<void> {
    const v = Requirement.parse(req);
    this.put("requirements", v.id, v);
  }

  // --- stories ---

  async listStories(): Promise<TUserStory[]> {
    return this.all("SELECT data FROM stories ORDER BY id", UserStory);
  }

  async getStory(id: string): Promise<TUserStory | null> {
    return this.get("SELECT data FROM stories WHERE id = ?", [id], UserStory);
  }

  async writeStory(story: TUserStory): Promise<void> {
    const v = UserStory.parse(story);
    this.put("stories", v.id, v);
  }

  // --- phases ---

  async listPhases(): Promise<TPhase[]> {
    const rows = (this.db.prepare("SELECT data FROM phases ORDER BY sort_order").all()) as { data: string }[];
    return rows.map(r => Phase.parse(JSON.parse(r.data)));
  }

  async getPhase(id: string): Promise<TPhase | null> {
    const row = this.db.prepare("SELECT data FROM phases WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? Phase.parse(JSON.parse(row.data)) : null;
  }

  async writePhase(phase: TPhase): Promise<void> {
    const v = Phase.parse(phase);
    this.db.prepare("INSERT OR REPLACE INTO phases(id, sort_order, data) VALUES (?, ?, ?)").run(v.id, v.order, JSON.stringify(v));
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
    type Row = { feature: string; name: string; status: string; ran_at: string; run_id: string | null; source: string; note: string | null };
    const rows = (this.db.prepare(
      "SELECT feature, name, status, ran_at, run_id, source, note FROM executions WHERE phase_id = ? ORDER BY ran_at"
    ).all(phaseId)) as Row[];
    return rows.map(r => Execution.parse({
      feature: r.feature,
      name:    r.name,
      status:  r.status,
      ranAt:   r.ran_at,
      runId:   r.run_id ?? undefined,
      source:  r.source,
      note:    r.note ?? undefined,
    }));
  }

  async appendExecutions(phaseId: string, runs: TExecution[]): Promise<void> {
    const stmt = this.db.prepare(
      "INSERT INTO executions(phase_id, feature, name, status, ran_at, run_id, source, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const tx = this.db.transaction(() => {
      for (const run of runs) {
        const v = Execution.parse(run);
        stmt.run(phaseId, v.feature, v.name, v.status, v.ranAt, v.runId ?? null, v.source, v.note ?? null);
      }
    });
    tx();
  }

  async readAllExecutions(): Promise<Map<string, TExecution[]>> {
    const phases = await this.listPhases();
    const out = new Map<string, TExecution[]>();
    for (const p of phases) out.set(p.id, await this.readExecutionLog(p.id));
    return out;
  }

  // Reuse static helper from Store
  static nextId = Store.nextId;
}
