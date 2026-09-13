/**
 * Read endpoints for the audit log and the per-entity change history.
 *
 * Split from web-api.ts so the two records stay together with the code that
 * writes them, and so the permission boundary between them is visible in one
 * place: `history:read` is an ordinary part of reading a project (every role has
 * it, the way every Jira user sees an issue's history), while `audit:read` —
 * which exposes denied attempts, token ids and other people's activity — is
 * maintainer and above.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { can, type Principal } from "./auth/model.js";
import { authStore } from "./auth/store.js";
import { auditEnabled } from "./audit.js";
import type { AuditOutcome, AuditSource } from "./auth/types.js";

function send(res: ServerResponse, status: number, data: unknown, cors: Record<string, string>): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { ...cors, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function intParam(sp: URLSearchParams, name: string, fallback: number): number {
  const raw = sp.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const OUTCOMES = new Set(["ok", "denied", "error"]);
const SOURCES = new Set(["mcp", "web", "system"]);

/**
 * Handle `/api/audit` and `/api/history*`. Returns true when served.
 *
 * `projectId` is the project the request resolved to; history is always scoped
 * to it, while the audit log may be read across every project by leaving
 * `?project=` off — an admin investigating an incident should not have to ask
 * project by project.
 */
export async function handleAuditRoutes(
  _req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  searchParams: URLSearchParams,
  principal: Principal,
  projectId: string | null,
  cors: Record<string, string>,
): Promise<boolean> {
  const m = method.toUpperCase();
  if (m !== "GET") return false;

  // --- GET /api/audit
  if (pathname === "/api/audit") {
    if (!can(principal, "audit:read")) {
      send(res, 403, { error: "Reading the audit log requires the 'audit:read' permission." }, cors);
      return true;
    }
    if (!auditEnabled()) {
      send(res, 200, { enabled: false, total: 0, entries: [], message: "Auditing is switched off on this server (REQU_AUDIT)." }, cors);
      return true;
    }
    const outcome = searchParams.get("outcome");
    const source = searchParams.get("source");
    const { entries, total } = await authStore().queryAudit({
      // `all` reads across every project; otherwise the resolved project wins.
      projectId: searchParams.get("scope") === "all" ? undefined : (searchParams.get("project") ?? projectId ?? undefined),
      actorId: searchParams.get("actor") ?? undefined,
      action: searchParams.get("action") ?? undefined,
      outcome: outcome && OUTCOMES.has(outcome) ? (outcome as AuditOutcome) : undefined,
      source: source && SOURCES.has(source) ? (source as AuditSource) : undefined,
      since: searchParams.get("since") ?? undefined,
      until: searchParams.get("until") ?? undefined,
      limit: intParam(searchParams, "limit", 100),
      offset: intParam(searchParams, "offset", 0),
    });
    send(res, 200, { enabled: true, total, entries }, cors);
    return true;
  }

  // --- GET /api/history            — the project's whole activity stream
  // --- GET /api/history/:entity/:id — one entity's history
  const entityMatch = /^\/api\/history\/([^/]+)\/(.+)$/.exec(pathname);
  if (pathname === "/api/history" || entityMatch) {
    if (!can(principal, "history:read")) {
      send(res, 403, { error: "Reading change history requires the 'history:read' permission." }, cors);
      return true;
    }
    if (!projectId) {
      send(res, 400, { error: "Specify a project: /api/history?project=<slug>" }, cors);
      return true;
    }
    if (!auditEnabled()) {
      send(res, 200, { enabled: false, total: 0, changes: [], message: "Change history is switched off on this server (REQU_AUDIT)." }, cors);
      return true;
    }
    const { changes, total } = await authStore().queryChanges({
      projectId,
      entity: entityMatch ? decodeURIComponent(entityMatch[1]) : (searchParams.get("entity") ?? undefined),
      entityId: entityMatch ? decodeURIComponent(entityMatch[2]) : (searchParams.get("entityId") ?? undefined),
      version: searchParams.get("version") ?? undefined,
      actorId: searchParams.get("actor") ?? undefined,
      since: searchParams.get("since") ?? undefined,
      limit: intParam(searchParams, "limit", entityMatch ? 200 : 100),
      offset: intParam(searchParams, "offset", 0),
    });
    send(res, 200, { enabled: true, total, changes }, cors);
    return true;
  }

  return false;
}
