/**
 * Generate the OpenAPI 3.1 contract for the scenario REST API to
 * `openapi/scenarios.yaml`. This file is committed and shared with the tool that
 * runs the scenarios (Conductor). Regenerated as part of `npm run build`.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { stringify } from "yaml";
import { buildOpenApiDocument } from "../src/openapi.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const version = (JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version: string }).version;
const doc = buildOpenApiDocument(version);

const outDir = path.join(repoRoot, "openapi");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "scenarios.yaml");
writeFileSync(outFile, stringify(doc), "utf8");
console.error(`Wrote ${path.relative(repoRoot, outFile)} (openapi ${doc.openapi}, v${version}).`);
