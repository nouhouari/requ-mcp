/**
 * Shared harness for the smoke suites.
 *
 * requ-mcp is an HTTP server, so the suites drive it the way a real client does:
 * spawn the built server, speak MCP over Streamable HTTP, tear it down. SQLite
 * backs it (no REQU_PG_URL) so CI needs no database service.
 *
 * Projects are addressed by `key`. Key-based *creation* requires Postgres, so
 * the harness declares the project up front via REQU_PROJECTS — the server then
 * pre-registers one SQLite store whose slug is the key every call uses.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, "..", "..");

/** The same slug the server derives from a project root (see slugify in index.ts). */
export function slugFor(root: string): string {
  return path.basename(root).toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

export type ToolResult = { isError: boolean; data: any; raw: string };

export type Harness = {
  /** Call an MCP tool against the default project. */
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  /** Call an MCP tool against a specific project key (multi-project fixtures). */
  callOn: (key: string, name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  /** Base URL, for the REST assertions some suites make. */
  base: string;
  /** Project key of the primary root. */
  key: string;
  stop: () => Promise<void>;
};

/**
 * Start the built server over HTTP with SQLite and connect an MCP client.
 * `roots` are project roots; the first is the default the `call` helper targets.
 */
export async function startHarness(roots: string[], name = "smoke"): Promise<Harness> {
  // Spread ports so concurrently-run suites do not collide.
  const port = 8800 + Math.floor(Math.random() * 900);
  const child: ChildProcess = spawn(process.execPath, [path.join(repoRoot, "dist", "index.js")], {
    env: {
      ...process.env,
      REQU_PROJECTS: roots.join(","),
      REQU_PORT: String(port),
      REQU_HOST: "127.0.0.1",
      // Force SQLite even when the developer has Postgres configured in their shell.
      REQU_PG_URL: "",
      REQU_ROOT: "",
      REQU_DB: "",
    },
    stdio: "ignore",
  });

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/api/version`);
      if (res.ok) { up = true; break; }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) {
    child.kill("SIGKILL");
    throw new Error(`server did not come up on ${base}`);
  }

  const client = new Client({ name, version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));

  const key = slugFor(roots[0]);

  const callOn = async (k: string, tool: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const res: any = await client.callTool({ name: tool, arguments: { key: k, ...args } });
    const txt = res.content?.[0]?.text ?? "{}";
    let parsed: any = txt;
    try { parsed = JSON.parse(txt); } catch { /* markdown */ }
    return { isError: !!res.isError, data: parsed, raw: txt };
  };

  return {
    base,
    key,
    call: (tool, args) => callOn(key, tool, args),
    callOn,
    stop: async () => {
      try { await client.close(); } catch { /* already gone */ }
      child.kill("SIGKILL");
    },
  };
}
