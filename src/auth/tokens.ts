/**
 * Personal access tokens — the credential an MCP client puts in its config.
 *
 * Shape: `requ_pat_<id>.<secret>`
 *   id     — 12 url-safe chars, stored in clear so a token can be looked up in
 *            one indexed query and shown in the UI ("which token is this?").
 *   secret — 32 url-safe chars of CSPRNG output.
 *
 * The two halves are separated by `.` because base64url itself uses `-` and `_`:
 * splitting on an underscore would cut roughly one token in six at the wrong
 * place and reject it as unknown.
 *
 * Only a peppered SHA-256 of the secret is stored. A database dump therefore
 * does not yield working tokens, and the plaintext is shown exactly once, at
 * creation, the way GitHub and GitLab do it.
 */

import crypto from "node:crypto";

export const TOKEN_PREFIX = "requ_pat_";

/** Separator between the id and the secret. Not part of the base64url alphabet. */
const SEPARATOR = ".";

const ID_BYTES = 9; // → 12 base64url chars
const SECRET_BYTES = 24; // → 32 base64url chars

export type ParsedToken = { id: string; secret: string };

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function newTokenId(): string {
  return b64url(crypto.randomBytes(ID_BYTES));
}

/** Mint a token. Returns the plaintext to show once, and what to store. */
export function mintToken(pepper: string): { plaintext: string; id: string; hash: string } {
  const id = newTokenId();
  const secret = b64url(crypto.randomBytes(SECRET_BYTES));
  return {
    plaintext: `${TOKEN_PREFIX}${id}${SEPARATOR}${secret}`,
    id,
    hash: hashTokenSecret(secret, pepper),
  };
}

export function hashTokenSecret(secret: string, pepper: string): string {
  return crypto.createHmac("sha256", pepper).update(secret).digest("hex");
}

/** Split a presented token, or null when it is not one of ours. */
export function parseToken(raw: string): ParsedToken | null {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const body = raw.slice(TOKEN_PREFIX.length);
  const sep = body.indexOf(SEPARATOR);
  if (sep <= 0) return null;
  const id = body.slice(0, sep);
  const secret = body.slice(sep + 1);
  if (!id || !secret) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id) || !/^[A-Za-z0-9_-]+$/.test(secret)) return null;
  return { id, secret };
}

/** Constant-time comparison of two hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** A short, safe fragment for display: `requ_pat_AbCdEfGhIjKl…`. */
export function tokenDisplayPrefix(id: string): string {
  return `${TOKEN_PREFIX}${id}…`;
}

/**
 * Pull a bearer token out of a request's headers.
 * Accepts `Authorization: Bearer <token>` and the `X-Requ-Token` header, which
 * is easier to set in some MCP client configurations.
 */
export function bearerFromHeaders(headers: Record<string, unknown>): string | null {
  const auth = headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const custom = headers["x-requ-token"];
  if (typeof custom === "string" && custom.trim()) return custom.trim();
  return null;
}
