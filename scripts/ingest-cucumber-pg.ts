#!/usr/bin/env node
// CLI counterpart of the `import_execution_report` MCP tool (see src/index.ts), for
// ingesting a cucumber-json report into the Postgres store when the MCP channel is
// unavailable. If the MCP tool's logic changes, mirror the change here (same steps).
// Same parser, same execution shape (source: "cucumber-json"), same counters.
//
// Usage: REQU_PG_URL=postgresql://... tsx scripts/ingest-cucumber-pg.ts <root> <projectId> <filePath> <phase> <runId>
import { promises as fs } from "node:fs";
import { parseCucumberJson } from "../src/ingest.js";
import { PostgresStore, initPgPool } from "../src/postgres-store.js";

async function main() {
  const [root, projectId, filePath, phase, runId] = process.argv.slice(2);
  if (!root || !projectId || !filePath || !phase || !runId) {
    console.error("Usage: tsx scripts/ingest-cucumber-pg.ts <root> <projectId> <filePath> <phase> <runId>");
    process.exit(1);
  }
  const url = process.env.REQU_PG_URL;
  if (!url) { console.error("REQU_PG_URL manquant"); process.exit(1); }
  initPgPool(url);

  const store = new PostgresStore(root, projectId);
  const content = await fs.readFile(filePath, "utf8");
  const scenarios = parseCucumberJson(content);
  if (!(await store.getPhase(phase))) { console.error(`Phase ${phase} introuvable`); process.exit(1); }

  const ranAt = new Date().toISOString();
  const execs = scenarios.map((s) => ({
    feature: s.feature,
    name: s.name,
    status: s.status,
    ranAt,
    runId,
    source: "cucumber-json" as const,
  }));
  await store.appendExecutions(phase, execs);
  const counts = {
    pass: execs.filter((e) => e.status === "pass").length,
    fail: execs.filter((e) => e.status === "fail").length,
    pending: execs.filter((e) => e.status === "pending").length,
  };
  console.log(JSON.stringify({ phase, runId, total: execs.length, counts }, null, 2));
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
