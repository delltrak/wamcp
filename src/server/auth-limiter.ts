import { clientAddress, normalizeClientIp, type TrustedProxy } from "./ip-address.js";

const DEFAULT_FREE_FAILURES = 8;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 15 * 60 * 1000;
const DEFAULT_RECENT_SUCCESS_MS = 60 * 60 * 1000;
const DEFAULT_EXEMPT_FAILURES = 3;
const MAX_BUCKETS = 10_000;

export interface AuthLimiterOptions {
  freeFailures?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  recentSuccessMs?: number;
  exemptFailures?: number;
  now?: () => number;
}

interface AttemptBucket {
  failures: number;
  lockedUntil: number;
  lastAttempt: number;
}

interface Exemption {
  expiresAt: number;
  remaining: number;
}

/**
 * Failed-sign-in backoff keyed by client address and username.
 * The attempt is counted before password verification. A lock keeps its failure
 * count when it expires and doubles on the next attempt, up to `maxDelayMs`.
 * The bucket is forgotten only after `maxDelayMs` without an attempt.
 * A success clears that username, not the shared address count. The address is
 * an IPv6 /64 or everyone behind the same NAT, so a recent success exempts only
 * that username at that address, and only for a few failures.
 */
export class AuthAttemptLimiter {
  private readonly freeFailures: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly recentSuccessMs: number;
  private readonly exemptFailures: number;
  private readonly now: () => number;
  private readonly byIp = new Map<string, AttemptBucket>();
  private readonly byUser = new Map<string, AttemptBucket>();
  private readonly exemptions = new Map<string, Exemption>();

  constructor(options: AuthLimiterOptions = {}) {
    this.freeFailures = options.freeFailures ?? DEFAULT_FREE_FAILURES;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.recentSuccessMs = options.recentSuccessMs ?? DEFAULT_RECENT_SUCCESS_MS;
    this.exemptFailures = options.exemptFailures ?? DEFAULT_EXEMPT_FAILURES;
    this.now = options.now ?? Date.now;
  }

  /**
   * Reserve one attempt before verification. A positive result must be refused
   * without checking the password; the attempt is already counted.
   * Returns a positive delay when every stored bucket is still locked and none
   * can be forgotten.
   */
  beginAttempt(ip: string, username: string): number {
    const now = this.now();
    const ipKey = normalizeClientIp(ip);
    const userKey = normalizeUser(username);
    this.decay(this.byIp, ipKey, now);
    this.decay(this.byUser, userKey, now);
    const ipWait = this.wait(this.byIp.get(ipKey), now);
    const userWait = this.wait(this.byUser.get(userKey), now);
    const exemption = this.exemptionFor(ipKey, userKey, now);
    const bypass = exemption !== undefined && (ipWait > 0 || userWait > 0);
    if (!bypass && Math.max(ipWait, userWait) > 0) return Math.max(ipWait, userWait);
    if (bypass && exemption) {
      exemption.remaining -= 1;
      if (exemption.remaining <= 0) this.exemptions.delete(this.exemptionKey(ipKey, userKey));
      return 0;
    }
    const ipBefore = cloneBucket(this.byIp.get(ipKey));
    const userBefore = cloneBucket(this.byUser.get(userKey));
    if (!this.bump(this.byIp, ipKey, now) || !this.bump(this.byUser, userKey, now)) {
      restoreBucket(this.byIp, ipKey, ipBefore);
      restoreBucket(this.byUser, userKey, userBefore);
      return this.baseDelayMs;
    }
    return Math.max(this.wait(this.byIp.get(ipKey), now), this.wait(this.byUser.get(userKey), now));
  }

  retryAfterMs(ip: string, username?: string): number {
    const now = this.now();
    const ipKey = normalizeClientIp(ip);
    this.decay(this.byIp, ipKey, now);
    const ipWait = this.wait(this.byIp.get(ipKey), now);
    if (!username) return ipWait;
    const userKey = normalizeUser(username);
    this.decay(this.byUser, userKey, now);
    if (this.exemptionFor(ipKey, userKey, now)) return 0;
    return Math.max(ipWait, this.wait(this.byUser.get(userKey), now));
  }

  /**
   * Password matched. Clears that username and remembers the address, which may
   * be a whole /64 or NAT. The shared address failure count stays, so other
   * usernames do not receive a fresh budget.
   */
  recordSuccess(ip: string, username: string): void {
    const now = this.now();
    const ipKey = normalizeClientIp(ip);
    const userKey = normalizeUser(username);
    this.byUser.delete(userKey);
    this.exemptions.delete(this.exemptionKey(ipKey, userKey));
    this.exemptions.set(this.exemptionKey(ipKey, userKey), {
      expiresAt: now + this.recentSuccessMs,
      remaining: this.exemptFailures,
    });
    while (this.exemptions.size > MAX_BUCKETS) {
      const oldest = this.exemptions.keys().next().value;
      if (oldest === undefined) break;
      this.exemptions.delete(oldest);
    }
  }

  /** A wrong password removes the recent-success exemption for this address and username. */
  recordFailure(ip: string, username: string): void {
    this.exemptions.delete(this.exemptionKey(normalizeClientIp(ip), normalizeUser(username)));
  }

  hasRecentSuccess(ip: string, username: string): boolean {
    return (
      this.exemptionFor(normalizeClientIp(ip), normalizeUser(username), this.now()) !== undefined
    );
  }

  private exemptionKey(ipKey: string, userKey: string): string {
    return `${ipKey}\0${userKey}`;
  }

  private exemptionFor(ipKey: string, userKey: string, now: number): Exemption | undefined {
    const key = this.exemptionKey(ipKey, userKey);
    const entry = this.exemptions.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now || entry.remaining <= 0) {
      this.exemptions.delete(key);
      return undefined;
    }
    return entry;
  }

  private decay(buckets: Map<string, AttemptBucket>, key: string, now: number): void {
    const bucket = buckets.get(key);
    if (!bucket) return;
    if (bucket.lockedUntil > 0 && bucket.lockedUntil <= now) bucket.lockedUntil = 0;
    if (bucket.lockedUntil === 0 && now - bucket.lastAttempt >= this.maxDelayMs) {
      buckets.delete(key);
    }
  }

  private wait(bucket: AttemptBucket | undefined, now: number): number {
    if (!bucket || bucket.lockedUntil <= now) return 0;
    return bucket.lockedUntil - now;
  }

  /** @returns false when a new bucket cannot be stored without dropping a live lock. */
  private bump(buckets: Map<string, AttemptBucket>, key: string, now: number): boolean {
    if (!buckets.has(key) && buckets.size >= MAX_BUCKETS && !this.evictIdle(buckets, now)) {
      return false;
    }
    const current = buckets.get(key) ?? { failures: 0, lockedUntil: 0, lastAttempt: now };
    current.failures += 1;
    current.lastAttempt = now;
    if (current.failures > this.freeFailures) {
      const exponent = Math.min(current.failures - this.freeFailures - 1, 20);
      const delay = Math.min(this.baseDelayMs * 2 ** exponent, this.maxDelayMs);
      current.lockedUntil = now + delay;
    }
    buckets.delete(key);
    buckets.set(key, current);
    return true;
  }

  /** Drop one unlocked bucket whose idle window has elapsed. */
  private evictIdle(buckets: Map<string, AttemptBucket>, now: number): boolean {
    for (const [key, bucket] of buckets) {
      if (bucket.lockedUntil <= now && now - bucket.lastAttempt >= this.maxDelayMs) {
        buckets.delete(key);
        return true;
      }
    }
    return false;
  }
}

function normalizeUser(username: string): string {
  if (username === "\0unknown") return username;
  if (!username || username.length > 128) return "\0unknown";
  return username;
}

function cloneBucket(bucket: AttemptBucket | undefined): AttemptBucket | undefined {
  return bucket ? { ...bucket } : undefined;
}

function restoreBucket(
  buckets: Map<string, AttemptBucket>,
  key: string,
  previous: AttemptBucket | undefined,
): void {
  if (!previous) {
    buckets.delete(key);
    return;
  }
  buckets.set(key, previous);
}

export { clientAddress, normalizeClientIp, type TrustedProxy };
