/**
 * Enrolling and checking the second factor.
 *
 * The state machine, which the endpoints in routes.ts drive:
 *
 *   begin()    → a secret is generated and stored *unconfirmed*, with the QR
 *                code to scan. Nothing changes about how the user signs in yet.
 *   confirm()  → one correct code proves the app really holds the secret. Only
 *                now does the enrolment count, and the recovery codes are
 *                issued — once, like an access token.
 *   verify()   → at sign-in: a code, or a recovery code, against the confirmed
 *                enrolment.
 *   disable()  → removed, after proving possession again.
 *
 * An unconfirmed enrolment is deliberately harmless: if someone starts the
 * process and closes the tab, they can still sign in with their password alone
 * and start again. The alternative — locking an account to a secret nobody
 * scanned — is the classic way to lock a whole team out of a system.
 */

import { authConfig } from "./config.js";
import { openSecret, sealSecret } from "./secret-box.js";
import { authStore } from "./store.js";
import {
  formatSecretForDisplay,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  matchRecoveryCode,
  provisioningUri,
  qrSvg,
  verifyTotp,
} from "./totp.js";
import type { AuthUser, TotpRecord } from "./types.js";

const now = (): string => new Date().toISOString();

export class TwoFactorError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = "TWO_FACTOR_ERROR") {
    super(message);
    this.name = "TwoFactorError";
    this.status = status;
    this.code = code;
  }
}

export type EnrolmentOffer = {
  /** The `otpauth://` URI, for a "can't scan?" link. */
  uri: string;
  /** Inline SVG QR code to display. */
  qrSvg: string;
  /** The secret in groups of four, for manual entry. */
  secret: string;
};

export type TwoFactorStatus = {
  /** Whether the server offers a second factor at all. */
  available: boolean;
  mode: string;
  /** Whether this user has a confirmed authenticator. */
  enrolled: boolean;
  /** Whether policy obliges them to have one. */
  required: boolean;
  confirmedAt: string | null;
  recoveryCodesRemaining: number;
};

/**
 * Start (or restart) enrolment: a new secret, stored unconfirmed.
 *
 * Restarting deliberately replaces any unconfirmed secret — someone who scanned
 * a code, lost the tab, and came back must get a QR that matches what is stored,
 * not the previous one.
 */
export async function begin(user: AuthUser): Promise<EnrolmentOffer> {
  const cfg = authConfig();
  if (cfg.twoFactor === "off") {
    throw new TwoFactorError("Two-factor authentication is switched off on this server.", 400, "TWO_FACTOR_OFF");
  }
  const store = authStore();
  const existing = await store.getTotp(user.id);
  if (existing?.confirmedAt) {
    throw new TwoFactorError(
      "An authenticator is already enrolled. Remove it first if you want to enrol a new device.",
      409,
      "ALREADY_ENROLLED",
    );
  }

  const secret = generateSecret();
  await store.putTotp({
    userId: user.id,
    secretSealed: sealSecret(secret, cfg.secret),
    confirmedAt: null,
    createdAt: now(),
    lastStep: null,
    recoveryHashes: [],
  });

  const account = user.email || user.username;
  const uri = provisioningUri({ issuer: cfg.twoFactorIssuer, account, secret });
  return { uri, qrSvg: await qrSvg(uri), secret: formatSecretForDisplay(secret) };
}

/** Read back the stored secret, or fail in a way the caller can act on. */
function unseal(row: TotpRecord, serverSecret: string): string {
  const secret = openSecret(row.secretSealed, serverSecret);
  if (secret === null) {
    // Only reachable when REQU_AUTH_SECRET changed under a live database.
    throw new TwoFactorError(
      "This enrolment cannot be read — the server secret has changed since it was created. Enrol the authenticator again.",
      409,
      "UNREADABLE_ENROLMENT",
    );
  }
  return secret;
}

/**
 * Finish enrolment with one code from the app, and hand back the recovery
 * codes. They are shown exactly once; only their hashes are kept.
 */
export async function confirm(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
  const cfg = authConfig();
  const store = authStore();
  const row = await store.getTotp(userId);
  if (!row) throw new TwoFactorError("Start the enrolment first.", 400, "NOT_STARTED");
  if (row.confirmedAt) throw new TwoFactorError("This authenticator is already confirmed.", 409, "ALREADY_ENROLLED");

  const result = verifyTotp(unseal(row, cfg.secret), code);
  if (!result.ok) {
    throw new TwoFactorError(
      result.reason === "malformed"
        ? "Enter the 6-digit code shown in your authenticator app."
        : "That code is not right. Check your phone's clock is correct and try the current code.",
      400,
      "BAD_CODE",
    );
  }

  const recoveryCodes = generateRecoveryCodes();
  await store.putTotp({
    ...row,
    confirmedAt: now(),
    lastStep: result.step,
    recoveryHashes: recoveryCodes.map((c) => hashRecoveryCode(c, cfg.secret)),
  });
  return { recoveryCodes };
}

export type VerifyOutcome = {
  /** True when a recovery code was spent rather than an app code. */
  usedRecoveryCode: boolean;
  /** How many recovery codes are left afterwards. */
  recoveryCodesRemaining: number;
};

/**
 * Check a code at sign-in.
 *
 * Accepts either a 6-digit app code or one of the recovery codes. A spent app
 * code is refused by its time step, and a spent recovery code is deleted, so
 * neither survives being observed.
 */
export async function verify(userId: string, code: string): Promise<VerifyOutcome> {
  const cfg = authConfig();
  const store = authStore();
  const row = await store.getTotp(userId);
  if (!row?.confirmedAt) throw new TwoFactorError("No authenticator is enrolled for this account.", 400, "NOT_ENROLLED");

  const trimmed = code.trim();

  // A recovery code first: it is not six digits, so the two can never be
  // confused for one another.
  if (!/^\d{6}$/.test(trimmed.replace(/\s/g, ""))) {
    const index = matchRecoveryCode(trimmed, row.recoveryHashes, cfg.secret);
    if (index === -1) throw new TwoFactorError("That code is not right.", 401, "BAD_CODE");
    const remaining = row.recoveryHashes.filter((_, i) => i !== index);
    await store.setRecoveryHashes(userId, remaining);
    return { usedRecoveryCode: true, recoveryCodesRemaining: remaining.length };
  }

  const result = verifyTotp(unseal(row, cfg.secret), trimmed, { minStep: row.lastStep ?? undefined });
  if (!result.ok) {
    throw new TwoFactorError(
      result.reason === "replayed"
        ? "That code has already been used. Wait for your app to show the next one."
        : "That code is not right.",
      401,
      "BAD_CODE",
    );
  }
  await store.setTotpLastStep(userId, result.step);
  return { usedRecoveryCode: false, recoveryCodesRemaining: row.recoveryHashes.length };
}

/**
 * Remove the enrolment. Requires a current code, so someone who walks up to an
 * unlocked laptop cannot quietly strip the second factor off the account.
 */
export async function disable(userId: string, code: string): Promise<void> {
  const cfg = authConfig();
  const store = authStore();
  const row = await store.getTotp(userId);
  if (!row?.confirmedAt) throw new TwoFactorError("No authenticator is enrolled.", 400, "NOT_ENROLLED");

  const roles = await rolesOf(userId);
  const { twoFactorRequiredFor } = await import("./authenticate.js");
  if (twoFactorRequiredFor(cfg, roles)) {
    throw new TwoFactorError(
      "This server requires a second factor for your account, so it cannot be removed. Enrol a new device instead.",
      403,
      "TWO_FACTOR_REQUIRED",
    );
  }

  await verify(userId, code);
  await store.deleteTotp(userId);
}

/** Issue a fresh set of recovery codes, invalidating the previous ones. */
export async function regenerateRecoveryCodes(userId: string, code: string): Promise<string[]> {
  const cfg = authConfig();
  const store = authStore();
  const row = await store.getTotp(userId);
  if (!row?.confirmedAt) throw new TwoFactorError("No authenticator is enrolled.", 400, "NOT_ENROLLED");
  await verify(userId, code);

  const codes = generateRecoveryCodes();
  await store.setRecoveryHashes(userId, codes.map((c) => hashRecoveryCode(c, cfg.secret)));
  return codes;
}

/**
 * Administrative reset: drop the enrolment without a code.
 *
 * For the person who lost their phone and their recovery codes. It is audited,
 * and the account is then treated as un-enrolled — which, under a `required`
 * policy, means their next sign-in leads straight back into enrolment rather
 * than into an unprotected session.
 */
export async function adminReset(userId: string): Promise<boolean> {
  return authStore().deleteTotp(userId);
}

export async function status(user: AuthUser): Promise<TwoFactorStatus> {
  const cfg = authConfig();
  const row = await authStore().getTotp(user.id);
  const roles = await rolesOf(user.id);
  const { twoFactorRequiredFor } = await import("./authenticate.js");
  return {
    available: cfg.twoFactor !== "off",
    mode: cfg.twoFactor,
    enrolled: Boolean(row?.confirmedAt),
    required: twoFactorRequiredFor(cfg, roles),
    confirmedAt: row?.confirmedAt ?? null,
    recoveryCodesRemaining: row?.recoveryHashes.length ?? 0,
  };
}

/**
 * Every role a user holds anywhere, so "administrators must use 2FA" catches
 * someone who administers a single project.
 */
async function rolesOf(userId: string) {
  const cfg = authConfig();
  const store = authStore();
  const user = await store.getUser(userId);
  const bindings = await store.listBindings(userId);
  const { resolveRoles } = await import("./roles.js");
  const global = resolveRoles({
    cfg,
    username: user?.username ?? userId,
    groups: user?.groups ?? [],
    bindings,
    projectId: null,
  }).roles;
  return [...new Set([...global, ...bindings.map((b) => b.role)])];
}
