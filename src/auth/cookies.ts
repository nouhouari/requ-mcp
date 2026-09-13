/**
 * Session cookie handling.
 *
 * The cookie carries a session id signed with the server secret. The id is also
 * a row in `auth_sessions`, so a logout revokes it for real rather than relying
 * on the browser to forget — a signed-but-unrevocable cookie would keep working
 * until it expired.
 */

import crypto from "node:crypto";

export type CookieOptions = {
  name: string;
  secure: boolean;
  maxAgeSeconds: number;
};

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function sign(value: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

/** `<sessionId>.<signature>` */
export function signSessionId(sessionId: string, secret: string): string {
  return `${sessionId}.${sign(sessionId, secret)}`;
}

/** Verify and unwrap a cookie value, or null when it was tampered with. */
export function verifySessionCookie(raw: string | undefined, secret: string): string | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = sign(id, secret);
  const a = Buffer.from(sig, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? id : null;
}

export function serializeSessionCookie(value: string, opts: CookieOptions): string {
  const parts = [
    `${opts.name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${opts.maxAgeSeconds}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(opts: Pick<CookieOptions, "name" | "secure">): string {
  const parts = [`${opts.name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function newSessionId(): string {
  return crypto.randomBytes(24).toString("base64url");
}
