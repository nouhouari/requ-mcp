/**
 * Login throttling.
 *
 * The sign-in endpoint forwards a password to the directory on every call, so
 * without a limit requ becomes a convenient password-guessing oracle against the
 * whole organisation — and, on directories that lock accounts after N failures,
 * a way to lock a colleague out on purpose.
 *
 * Deliberately simple: an in-memory counter per username and per source address,
 * with exponential back-off and a hard ceiling. A multi-instance deployment
 * therefore limits per instance, which is fine — the point is to make bulk
 * guessing impractical, not to be an exact quota. Successful sign-ins clear the
 * counter, so a person who mistypes once and then succeeds is never delayed.
 */

const MAX_ATTEMPTS = 5;
/** Back-off after MAX_ATTEMPTS failures, doubling each time up to the cap. */
const BASE_LOCKOUT_MS = 30_000;
const MAX_LOCKOUT_MS = 15 * 60_000;
/** Forget a key that has been quiet for this long. */
const IDLE_MS = 60 * 60_000;

type Bucket = { failures: number; blockedUntil: number; lastSeen: number };

const buckets = new Map<string, Bucket>();

function sweep(now: number): void {
  if (buckets.size < 512) return;
  for (const [key, b] of buckets) {
    if (now - b.lastSeen > IDLE_MS) buckets.delete(key);
  }
}

function keysFor(username: string, ip: string | null): string[] {
  const keys = [`u:${username.trim().toLowerCase()}`];
  if (ip) keys.push(`i:${ip}`);
  return keys;
}

/**
 * Milliseconds the caller must wait before another attempt is accepted, or 0
 * when they may try now.
 */
export function loginRetryAfterMs(username: string, ip: string | null, now = Date.now()): number {
  let wait = 0;
  for (const key of keysFor(username, ip)) {
    const b = buckets.get(key);
    if (b && b.blockedUntil > now) wait = Math.max(wait, b.blockedUntil - now);
  }
  return wait;
}

/** Record a failed attempt and return how long the caller is now blocked for. */
export function recordLoginFailure(username: string, ip: string | null, now = Date.now()): number {
  sweep(now);
  let wait = 0;
  for (const key of keysFor(username, ip)) {
    const b = buckets.get(key) ?? { failures: 0, blockedUntil: 0, lastSeen: now };
    b.failures += 1;
    b.lastSeen = now;
    if (b.failures >= MAX_ATTEMPTS) {
      const over = b.failures - MAX_ATTEMPTS;
      const lockout = Math.min(BASE_LOCKOUT_MS * 2 ** over, MAX_LOCKOUT_MS);
      b.blockedUntil = now + lockout;
      wait = Math.max(wait, lockout);
    }
    buckets.set(key, b);
  }
  return wait;
}

/** A successful sign-in clears the counters that were tracking this attempt. */
export function clearLoginFailures(username: string, ip: string | null): void {
  for (const key of keysFor(username, ip)) buckets.delete(key);
}

/** Reset every counter — for tests. */
export function resetLoginThrottle(): void {
  buckets.clear();
}
