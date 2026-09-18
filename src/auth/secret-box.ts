/**
 * Authenticated encryption for the few values that must be stored recoverably.
 *
 * Passwords and tokens are hashed, because nothing ever needs to read them back.
 * A TOTP seed is different: verifying a code requires the seed itself, so it can
 * only be encrypted. Doing that means a database dump on its own does not yield
 * working second factors — an attacker needs `REQU_AUTH_SECRET` as well, which
 * lives in the process environment rather than the database.
 *
 * AES-256-GCM, with the key derived from the server secret by HKDF under a
 * distinct label so it cannot collide with the session-cookie or token-pepper
 * uses of the same secret.
 */

import crypto from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12; // GCM's standard nonce size
const KEY_INFO = "requ-mcp/totp-secret";

function keyFrom(serverSecret: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(serverSecret, "utf-8"), Buffer.alloc(0), Buffer.from(KEY_INFO, "utf-8"), 32),
  );
}

/** `v1.<iv>.<ciphertext>.<tag>`, all base64url. */
export function sealSecret(plaintext: string, serverSecret: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFrom(serverSecret), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), enc.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

/**
 * Reverse of `sealSecret`. Returns null rather than throwing when the value
 * cannot be opened — which is what a rotated `REQU_AUTH_SECRET` looks like, and
 * is better handled as "this enrolment is unusable, enrol again" than as a
 * crash on every sign-in.
 */
export function openSecret(sealed: string, serverSecret: string): string | null {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      keyFrom(serverSecret),
      Buffer.from(parts[1], "base64url"),
    );
    decipher.setAuthTag(Buffer.from(parts[3], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], "base64url")), decipher.final()]).toString("utf-8");
  } catch {
    return null;
  }
}
