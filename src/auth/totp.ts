/**
 * Time-based one-time passwords (RFC 6238), the second factor.
 *
 * Microsoft Authenticator enrols third-party accounts as standard TOTP — its
 * push-approval flow is proprietary to Entra ID and not open to other
 * applications — so this is what "2FA with Microsoft Authenticator" means in
 * practice. The same QR code works with Google Authenticator, 1Password, Authy
 * and every other authenticator app, which is a feature rather than a
 * compromise: nobody is forced onto one vendor.
 *
 * Written against `node:crypto` rather than pulled from npm. TOTP is HMAC plus
 * a truncation rule — small enough to read in one sitting, and checked here
 * against the test vectors in RFC 4226 and RFC 6238, which is more assurance
 * than a dependency's version range gives.
 */

import crypto from "node:crypto";

/** Authenticator apps universally implement SHA-1, 6 digits, 30 seconds. */
export const DIGITS = 6;
export const PERIOD_SECONDS = 30;
const ALGORITHM = "sha1";

/**
 * How many steps either side of now are accepted.
 *
 * One step (±30s) absorbs ordinary phone clock drift and the seconds a person
 * spends typing. Wider would meaningfully enlarge the window an intercepted
 * code stays usable in.
 */
export const DRIFT_STEPS = 1;

// ---------------------------------------------------------------------------
// Base32 (RFC 4648), the encoding authenticator apps expect for the secret
// ---------------------------------------------------------------------------

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  // Deliberately unpadded: authenticator apps accept it, and it keeps the
  // manual-entry string shorter for someone typing it by hand.
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[=\s-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character '${ch}'.`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret — the size RFC 4226 recommends for HMAC-SHA1. */
export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

// ---------------------------------------------------------------------------
// The algorithm
// ---------------------------------------------------------------------------

/** HOTP (RFC 4226): an HMAC of the counter, truncated to `digits` decimals. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  // Counters are well inside 2^53, so the high word is derived by division
  // rather than by a 32-bit shift, which would overflow.
  msg.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);

  const digest = crypto.createHmac(ALGORITHM, secret).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The step number a timestamp falls in. */
export function stepFor(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / PERIOD_SECONDS);
}

/** The code for one step, for a base32 secret. */
export function totpAt(secretBase32: string, step: number): string {
  return hotp(base32Decode(secretBase32), step);
}

export type TotpVerification =
  | { ok: true; step: number }
  | { ok: false; reason: "malformed" | "mismatch" | "replayed" };

/**
 * Check a code against the accepted window.
 *
 * `minStep` rejects a code from a step already spent. Without it a code stays
 * valid for its whole period, so anyone who reads it over a shoulder — or off a
 * phishing page — can replay it until the clock ticks over.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { atMs?: number; minStep?: number; driftSteps?: number } = {},
): TotpVerification {
  const digits = code.replace(/\s/g, "");
  if (!new RegExp(`^\\d{${DIGITS}}$`).test(digits)) return { ok: false, reason: "malformed" };

  const drift = opts.driftSteps ?? DRIFT_STEPS;
  const current = stepFor(opts.atMs ?? Date.now());
  const expected = Buffer.from(digits, "utf-8");

  for (let offset = -drift; offset <= drift; offset++) {
    const step = current + offset;
    if (step < 0) continue;
    const candidate = Buffer.from(totpAt(secretBase32, step), "utf-8");
    // Constant-time, so the comparison cannot be used to learn the code
    // digit by digit from response timing.
    if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) {
      if (opts.minStep !== undefined && step <= opts.minStep) return { ok: false, reason: "replayed" };
      return { ok: true, step };
    }
  }
  return { ok: false, reason: "mismatch" };
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/**
 * The `otpauth://` URI an authenticator app reads from the QR code.
 *
 * `issuer` appears twice — in the label prefix and as a parameter — because
 * older readers use one and newer ones the other; Microsoft Authenticator shows
 * the account as "issuer (account)" from these.
 */
export function provisioningUri(args: { issuer: string; account: string; secret: string }): string {
  const label = `${encodeURIComponent(args.issuer)}:${encodeURIComponent(args.account)}`;
  const params = new URLSearchParams({
    secret: args.secret,
    issuer: args.issuer,
    algorithm: ALGORITHM.toUpperCase(),
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** The secret grouped in fours, for someone typing it in by hand. */
export function formatSecretForDisplay(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(" ");
}

/** The provisioning URI as an inline SVG QR code. */
export async function qrSvg(uri: string): Promise<string> {
  const { default: qrcode } = await import("qrcode-generator");
  // Type 0 picks the smallest symbol that fits; M tolerates ~15% damage, which
  // is the usual choice for a code shown on screen.
  const qr = qrcode(0, "M");
  qr.addData(uri);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

export const RECOVERY_CODE_COUNT = 10;

/**
 * Single-use codes for the day someone loses their phone.
 *
 * Without them, a lost device means an administrator has to reset the second
 * factor — which is both an interruption and a social-engineering target. They
 * are stored only as hashes, like the access tokens.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    // 10 base32 characters ≈ 50 bits: far beyond guessing, still transcribable.
    const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10);
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

export function hashRecoveryCode(code: string, pepper: string): string {
  return crypto.createHmac("sha256", pepper).update(normaliseRecoveryCode(code)).digest("hex");
}

/**
 * Find which stored hash a presented recovery code matches.
 *
 * Every candidate is compared even after a match so the work does not depend on
 * the position of the code in the list.
 */
export function matchRecoveryCode(code: string, hashes: readonly string[], pepper: string): number {
  const presented = Buffer.from(hashRecoveryCode(code, pepper), "utf-8");
  let found = -1;
  for (let i = 0; i < hashes.length; i++) {
    const stored = Buffer.from(hashes[i], "utf-8");
    if (stored.length === presented.length && crypto.timingSafeEqual(stored, presented) && found === -1) {
      found = i;
    }
  }
  return found;
}
