import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  Config,
  Execution,
  ExecutionLog,
  Phase,
  Requirement,
  UserStory,
  type Config as TConfig,
  type Execution as TExecution,
  type Phase as TPhase,
  type Requirement as TRequirement,
  type UserStory as TUserStory,
} from "./schema.js";

/**
 * File-backed store for the `.requ/` directory.
 *
 *   <root>/.requ/config.yaml
 *   <root>/.requ/requirements/REQ-001.yaml
 *   <root>/.requ/stories/US-001.yaml
 *   <root>/.requ/phases/PHASE-001.yaml
 *   <root>/.requ/executions/PHASE-001.yaml   (append-style run log)
 */
export class Store {
  readonly root: string;
  readonly baseDir: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.baseDir = path.join(this.root, ".requ");
  }

  private get reqDir() {
    return path.join(this.baseDir, "requirements");
  }
  private get storyDir() {
    return path.join(this.baseDir, "stories");
  }
  private get phaseDir() {
    return path.join(this.baseDir, "phases");
  }
  private get execDir() {
    return path.join(this.baseDir, "executions");
  }
  private get configPath() {
    return path.join(this.baseDir, "config.yaml");
  }

  async isInitialized(): Promise<boolean> {
    try {
      await fs.access(this.configPath);
      return true;
    } catch {
      return false;
    }
  }

  async init(config: TConfig): Promise<void> {
    await fs.mkdir(this.reqDir, { recursive: true });
    await fs.mkdir(this.storyDir, { recursive: true });
    await fs.mkdir(this.phaseDir, { recursive: true });
    await fs.mkdir(this.execDir, { recursive: true });
    await this.writeConfig(config);
  }

  // --- config ---

  async readConfig(): Promise<TConfig> {
    const raw = await fs.readFile(this.configPath, "utf8");
    return Config.parse(YAML.parse(raw));
  }

  async writeConfig(config: TConfig): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(this.configPath, YAML.stringify(Config.parse(config)), "utf8");
  }

  async conductorRoot(): Promise<string> {
    const cfg = await this.readConfig();
    return path.isAbsolute(cfg.conductorPath)
      ? cfg.conductorPath
      : path.resolve(this.root, cfg.conductorPath);
  }

  /** Resolve a possibly-relative path against the repo root. */
  resolvePath(p: string): string {
    return path.isAbsolute(p) ? p : path.resolve(this.root, p);
  }

  // --- requirements ---

  async listRequirements(): Promise<TRequirement[]> {
    return this.readAll(this.reqDir, Requirement);
  }
  async getRequirement(id: string): Promise<TRequirement | null> {
    return this.readOne(path.join(this.reqDir, `${id}.yaml`), Requirement);
  }
  async writeRequirement(req: TRequirement): Promise<void> {
    await fs.mkdir(this.reqDir, { recursive: true });
    const v = Requirement.parse(req);
    await fs.writeFile(path.join(this.reqDir, `${v.id}.yaml`), YAML.stringify(v), "utf8");
  }

  // --- stories ---

  async listStories(): Promise<TUserStory[]> {
    return this.readAll(this.storyDir, UserStory);
  }
  async getStory(id: string): Promise<TUserStory | null> {
    return this.readOne(path.join(this.storyDir, `${id}.yaml`), UserStory);
  }
  async writeStory(story: TUserStory): Promise<void> {
    await fs.mkdir(this.storyDir, { recursive: true });
    const v = UserStory.parse(story);
    await fs.writeFile(path.join(this.storyDir, `${v.id}.yaml`), YAML.stringify(v), "utf8");
  }

  // --- phases ---

  async listPhases(): Promise<TPhase[]> {
    const phases = await this.readAll(this.phaseDir, Phase);
    return phases.sort((a, b) => a.order - b.order);
  }
  async getPhase(id: string): Promise<TPhase | null> {
    return this.readOne(path.join(this.phaseDir, `${id}.yaml`), Phase);
  }
  async writePhase(phase: TPhase): Promise<void> {
    await fs.mkdir(this.phaseDir, { recursive: true });
    const v = Phase.parse(phase);
    await fs.writeFile(path.join(this.phaseDir, `${v.id}.yaml`), YAML.stringify(v), "utf8");
  }

  /** The phase to operate on by default: explicit active phase, else latest by order. */
  async resolvePhaseId(explicit?: string): Promise<string | null> {
    if (explicit) return explicit;
    const cfg = await this.readConfig();
    if (cfg.activePhase) return cfg.activePhase;
    const phases = await this.listPhases();
    return phases.length ? phases[phases.length - 1].id : null;
  }

  // --- executions ---

  private execPath(phaseId: string): string {
    return path.join(this.execDir, `${phaseId}.yaml`);
  }

  async readExecutionLog(phaseId: string): Promise<TExecution[]> {
    const log = await this.readOne(this.execPath(phaseId), ExecutionLog);
    return log?.runs ?? [];
  }

  /** Append execution records to a phase's log (creating it if needed). */
  async appendExecutions(phaseId: string, runs: TExecution[]): Promise<void> {
    await fs.mkdir(this.execDir, { recursive: true });
    const existing = await this.readExecutionLog(phaseId);
    const parsed = runs.map((r) => Execution.parse(r));
    const log = ExecutionLog.parse({ phase: phaseId, runs: [...existing, ...parsed] });
    await fs.writeFile(this.execPath(phaseId), YAML.stringify(log), "utf8");
  }

  /** All execution logs keyed by phase id. */
  async readAllExecutions(): Promise<Map<string, TExecution[]>> {
    const phases = await this.listPhases();
    const out = new Map<string, TExecution[]>();
    for (const p of phases) out.set(p.id, await this.readExecutionLog(p.id));
    return out;
  }

  // --- helpers ---

  private async readOne<T>(file: string, schema: { parse: (v: unknown) => T }): Promise<T | null> {
    try {
      const raw = await fs.readFile(file, "utf8");
      return schema.parse(YAML.parse(raw));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
  }

  private async readAll<T>(dir: string, schema: { parse: (v: unknown) => T }): Promise<T[]> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw err;
    }
    const files = names.filter((n) => n.endsWith(".yaml") || n.endsWith(".yml"));
    const out: T[] = [];
    for (const f of files.sort()) {
      const raw = await fs.readFile(path.join(dir, f), "utf8");
      out.push(schema.parse(YAML.parse(raw)));
    }
    return out;
  }

  /** Next numeric id for a prefix, e.g. nextId("REQ", existing) -> "REQ-003". */
  static nextId(prefix: string, existing: string[]): string {
    let max = 0;
    const re = new RegExp(`^${prefix}-(\\d+)$`);
    for (const id of existing) {
      const m = id.match(re);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `${prefix}-${String(max + 1).padStart(3, "0")}`;
  }
}
