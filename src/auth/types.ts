/**
 * Row shapes for the auth and audit tables, shared by both store backends and
 * by the REST layer that serialises them.
 */

import type { Role } from "./model.js";

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  dn: string | null;
  groups: string[];
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
};

export type RoleBinding = {
  userId: string;
  /** `*` grants the role on every project. */
  projectId: string;
  role: Role;
  grantedBy: string | null;
  grantedAt: string;
};

export type TokenRecord = {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  /** Caps the token below the user's own roles. `null` means no ceiling. */
  maxRole: Role | null;
  /** Restricts the token to these project keys. `null` means all projects. */
  projects: string[] | null;
};

export type SessionRecord = {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  ip: string | null;
  userAgent: string | null;
};

export type AuditOutcome = "ok" | "denied" | "error";
export type AuditSource = "mcp" | "web" | "system";

export type AuditEntry = {
  id?: number;
  at: string;
  actorId: string;
  actorName: string;
  actorKind: string;
  source: AuditSource;
  /** Tool name (`create_requirement`) or route (`POST /api/requirements`). */
  action: string;
  projectId: string | null;
  version: string | null;
  outcome: AuditOutcome;
  /** The permission that was required, when one was checked. */
  permission: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  tokenId: string | null;
};

export type AuditQuery = {
  projectId?: string;
  actorId?: string;
  action?: string;
  outcome?: AuditOutcome;
  source?: AuditSource;
  /** ISO timestamps, inclusive. */
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
};

/** One field that differed between the old and new state of an entity. */
export type FieldChange = {
  field: string;
  from: unknown;
  to: unknown;
};

export type ChangeAction = "created" | "updated" | "deleted" | "restored";

export type EntityChange = {
  id?: number;
  at: string;
  projectId: string;
  version: string | null;
  /** Singular entity name: `requirement`, `story`, `scenario`, `screen`, … */
  entity: string;
  entityId: string;
  action: ChangeAction;
  actorId: string;
  actorName: string;
  source: AuditSource;
  changes: FieldChange[];
};

export type ChangeQuery = {
  projectId: string;
  entity?: string;
  entityId?: string;
  version?: string;
  actorId?: string;
  since?: string;
  limit?: number;
  offset?: number;
};
