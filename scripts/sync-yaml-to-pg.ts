#!/usr/bin/env node
// One-shot sync: read the YAML-backed store (.requ/ source of truth written by
// requirements-analyst) and POST its export payload into the Postgres-backed
// HTTP store, so /api/* queries reflect the latest YAML content.
//
// Usage: tsx scripts/sync-yaml-to-pg.ts <root-dir> <project-slug> <http-base-url>
import { Store } from "../src/storage.js";
import { buildExport } from "../src/export-import.js";

async function main() {
  const [root, slug, base] = process.argv.slice(2);
  if (!root || !slug || !base) {
    console.error("Usage: tsx scripts/sync-yaml-to-pg.ts <root-dir> <project-slug> <http-base-url>");
    process.exit(1);
  }
  const store = new Store(root);
  const payload = await buildExport(store);
  console.error(`Export YAML (${root}): ${payload.data.requirements.length} requirements, ${payload.data.stories.length} stories, ${payload.data.phases.length} phases`);

  const res = await fetch(`${base}/api/import?project=${encodeURIComponent(slug)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  // Read as text first: a proxy/server error page may not be JSON, and a parse
  // failure must not mask the real HTTP status.
  const text = await res.text();
  console.error(`Import → HTTP ${res.status}`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
  if (!res.ok) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
