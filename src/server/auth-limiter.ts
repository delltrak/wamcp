import { clientAddress, normalizeClientIp, type TrustedProxy } from "./ip-address.js";

const DEFAULT_FREE_FAILURES = 8;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 15 * 60 * 1000;
const DEFAULT_RECENT_SUCCESS_MS = 60 * 60 * 1000;
const MAX_BUCKETS = 10_000;

export interface AuthLimiterOptions {
  freeFailures?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  recentSuccessMs?: number;
  now?: () => number;
}

interface AttemptBucket {
  failures: number;
  lockedUntil: number;
}

/**
 * Failed-sign-in backoff keyed by client address and username.
 * The attempt is counted before password verification so concurrent requests
 * cannot all pass the check. A success clears that address and username.
 * A per-user lock does not apply to an address that recently succeeded for the user.
 */
export class AuthAttemptLimiter {
  private readonly freeFailures: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly recentSuccessMs: number;
  private readonly now: () => number;
  private readonly byIp = new Map<string, AttemptBucket>();
  private readonly byUser = new Map<string, AttemptBucket>();
  private readonly recentSuccess = new Map<string, number>();

  constructor(options: AuthLimiterOptions = {}) {
    this.freeFailures = options.freeFailures ?? DEFAULT_FREE_FAILURES;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.recentSuccessMs = options.recentSuccessMs ?? DEFAULT_RECENT_SUCCESS_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Reserve one attempt before verification. A positive result must be refused
   * without checking the password; the attempt is already counted.
   */
  beginAttempt(ip: string, username: string): number {
    const now = this.now();
    const ipKey = normalizeClientIp(ip);
    const userKey = normalizeUser(username);
    this.decay(this.byIp, ipKey, now);
    this.decay(this.byUser, userKey, now);
    const pending = this.lockWait(ipKey, userKey, now);
    if (pending > 0) return pending;
    this.bump(this.byIp, ipKey, now);
    this.bump(this.byUser, userKey, now);
    return this.lockWait(ipKey, userKey, now);
  }

  retryAfterMs(ip: string, username?: string): number {
    const now = this.now();
    const ipKey = normalizeClientIp(ip);
    this.decay(this.byIp, ipKey, now);
    if (!username) return this.wait(this.byIp.get(ipKey), now);
    const userKey = normalizeUser(username);
    this.decay(this.byUser, userKey, now);
    return this.lockWait(ipKey, userKey, now);
  }

  /** Password matched. Clears this address and the username, and remembers the success. */
  recordSuccess(ip: string, username: string): void {
    const now = this.now();
    const ipKey = normalizeClientIp(ip);
    const userKey = normalizeUser(username);
    this.byIp.delete(ipKey);
    this.byUser.delete(userKey);
    this.recentSuccess.delete(`${ipKey}\0${userKey}`);
    this.recentSuccess.set(`${ipKey}\0${userKey}`, now + this.recentSuccessMs);
    while (this.recentSuccess.size > MAX_BUCKETS) {
      const oldest = this.recentSuccess.keys().next().value;
      if (oldest === undefined) break;
      this.recentSuccess.delete(oldest);
    }
  }

  /** Drop a reservation that never checked the password. */
  cancelAttempt(ip: string, username: string): void {
    this.unbump(this.byIp, normalizeClientIp(ip));
    this.unbump(this.byUser, normalizeUser(username));
  }

  private lockWait(ipKey: string, userKey: string, now: number): number {
    const ipWait = this.wait(this.byIp.get(ipKey), now);
    const userWait = this.userLockApplies(ipKey, userKey, now)
      ? this.wait(this.byUser.get(userKey), now)
      : 0;
    return Math.max(ipWait, userWait);
  }

  private userLockApplies(ipKey: string, userKey: string, now: number): boolean {
    const expiresAt = this.recentSuccess.get(`${ipKey}\0${userKey}`);
    return expiresAt === undefined || expiresAt <= now;
  }

  private decay(buckets: Map<string, AttemptBucket>, key: string, now: number): void {
    const bucket = buckets.get(key);
    if (!bucket) return;
    if (bucket.lockedUntil > 0 && bucket.lockedUntil <= now) buckets.delete(key);
  }

  private wait(bucket: AttemptBucket | undefined, now: number): number {
    if (!bucket || bucket.lockedUntil <= now) return 0;
    return bucket.lockedUntil - now;
  }

  private bump(buckets: Map<string, AttemptBucket>, key: string, now: number): void {
    const current = buckets.get(key) ?? { failures: 0, lockedUntil: 0 };
    current.failures += 1;
    if (current.failures > this.freeFailures) {
      const exponent = Math.min(current.failures - this.freeFailures - 1, 20);
      const delay = Math.min(this.baseDelayMs * 2 ** exponent, this.maxDelayMs);
      current.lockedUntil = now + delay;
    }
    buckets.delete(key);
    buckets.set(key, current);
    while (buckets.size > MAX_BUCKETS) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  }

  private unbump(buckets: Map<string, AttemptBucket>, key: string): void {
    const current = buckets.get(key);
    if (!current) return;
    current.failures -= 1;
    if (current.failures <= 0) {
      buckets.delete(key);
      return;
    }
    if (current.failures <= this.freeFailures) current.lockedUntil = 0;
  }
}

function normalizeUser(username: string): string {
  if (!username || username.length > 128) return "\0invalid";
  return username;
}

export { clientAddress, type TrustedProxy };
