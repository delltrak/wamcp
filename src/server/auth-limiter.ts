import { clientAddress, normalizeClientIp, type TrustedProxy } from "./ip-address.js";

const DEFAULT_FREE_FAILURES = 8;
const DEFAULT_GLOBAL_FREE_FAILURES = 128;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 15 * 60 * 1000;
const DEFAULT_RECENT_SUCCESS_MS = 60 * 60 * 1000;
const DEFAULT_EXEMPT_FAILURES = 3;
const MAX_BUCKETS = 10_000;

export interface AuthLimiterOptions {
  freeFailures?: number;
  /** Failures of one username across addresses before the distributed-attack lock. */
  globalFreeFailures?: number;
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
 * Failed-sign-in backoff.
 * The strict lock is the client address and the address-plus-username pair.
 * A username also has a much higher limit across addresses, only for a
 * distributed attack. The attempt is counted before password verification.
 * A success removes that one count and does not change a lock that is already
 * in effect. A lock keeps its failure count when it expires and doubles on the
 * next attempt, up to `maxDelayMs`. Quiet time starts at the later of the last
 * attempt and the end of the lock. The address is an IPv6 /64 or everyone
 * behind the same NAT, so a recent success exempts only that username at that
 * address, and only for a few failures.
 */
export class AuthAttemptLimiter {
  private readonly freeFailures: number;
  private readonly globalFreeFailures: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly recentSuccessMs: number;
  private readonly exemptFailures: number;
  private readonly now: () => number;
  private readonly byIp = new Map<string, AttemptBucket>();
  private readonly byPair = new Map<string, AttemptBucket>();
  private readonly byUser = new Map<string, AttemptBucket>();
  private readonly exemptions = new Map<string, Exemption>();
  /** Attempts that reached verification and can still be undone by a success. */
  private readonly pending = new Map<string, number>();

  constructor(options: AuthLimiterOptions = {}) {
    this.freeFailures = options.freeFailures ?? DEFAULT_FREE_FAILURES;
    this.globalFreeFailures = options.globalFreeFailures ?? DEFAULT_GLOBAL_FREE_FAILURES;
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
    const pairKey = this.pairKey(ipKey, userKey);
    this.decay(this.byIp, ipKey, now);
    this.decay(this.byPair, pairKey, now);
    this.decay(this.byUser, userKey, now);
    const ipWait = this.wait(this.byIp.get(ipKey), now);
    const pairWait = this.wait(this.byPair.get(pairKey), now);
    const userWait = this.wait(this.byUser.get(userKey), now);
    const exemption = this.exemptionFor(ipKey, userKey, now);
    const blocked = Math.max(ipWait, pairWait, userWait);
    const bypass = exemption !== undefined && blocked > 0;
    if (!bypass && blocked > 0) return blocked;
    if (bypass && exemption) {
      exemption.remaining -= 1;
      if (exemption.remaining <= 0) this.exemptions.delete(this.exemptionKey(ipKey, userKey));
      return 0;
    }
    const ipBefore = cloneBucket(this.byIp.get(ipKey));
    const pairBefore = cloneBucket(this.byPair.get(pairKey));
    const userBefore = cloneBucket(this.byUser.get(userKey));
    const stored =
      this.bump(this.byIp, ipKey, now, this.freeFailures) &&
      this.bump(this.byPair, pairKey, now, this.freeFailures) &&
      this.bump(this.byUser, userKey, now, this.globalFreeFailures);
    if (!stored) {
      restoreBucket(this.byIp, ipKey, ipBefore);
      restoreBucket(this.byPair, pairKey, pairBefore);
      restoreBucket(this.byUser, userKey, userBefore);
      return this.baseDelayMs;
    }
    const wait = Math.max(
      this.wait(this.byIp.get(ipKey), now),
      this.wait(this.byPair.get(pairKey), now),
      this.wait(this.byUser.get(userKey), now),
    );
    if (wait === 0) this.noteCredit(ipKey, userKey);
    return wait;
  }

  retryAfterMs(ip: string, username?: string): number {
    const now = this.now();
    const ipKey = normalizeClientIp(ip);
    this.decay(this.byIp, ipKey, now);
    const ipWait = this.wait(this.byIp.get(ipKey), now);
    if (!username) return ipWait;
    const userKey = normalizeUser(username);
    const pairKey = this.pairKey(ipKey, userKey);
    this.decay(this.byPair, pairKey, now);
    this.decay(this.byUser, userKey, now);
    if (this.exemptionFor(ipKey, userKey, now)) return 0;
    return Math.max(
      ipWait,
      this.wait(this.byPair.get(pairKey), now),
      this.wait(this.byUser.get(userKey), now),
    );
  }

  /**
   * Password matched. Undoes this request's count on the address, the pair, and
   * the global username bucket. An existing lock is left unchanged, and other
   * failures on the address stay in place.
   */
  recordSuccess(ip: string, username: string): void {
    const now = this.now();
    const ipKey = normalizeClientIp(ip);
    const userKey = normalizeUser(username);
    if (this.takeCredit(ipKey, userKey)) {
      this.release(this.byIp, ipKey, now);
      this.release(this.byPair, this.pairKey(ipKey, userKey), now);
      this.release(this.byUser, userKey, now);
    }
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
    const ipKey = normalizeClientIp(ip);
    const userKey = normalizeUser(username);
    this.takeCredit(ipKey, userKey);
    this.exemptions.delete(this.exemptionKey(ipKey, userKey));
  }

  /** Verification did not finish. The counted attempt stays, and an exemption stays. */
  recordBusy(ip: string, username: string): void {
    this.takeCredit(normalizeClientIp(ip), normalizeUser(username));
  }

  hasRecentSuccess(ip: string, username: string): boolean {
    return (
      this.exemptionFor(normalizeClientIp(ip), normalizeUser(username), this.now()) !== undefined
    );
  }

  private pairKey(ipKey: string, userKey: string): string {
    return `${ipKey}\0${userKey}`;
  }

  private exemptionKey(ipKey: string, userKey: string): string {
    return this.pairKey(ipKey, userKey);
  }

  private noteCredit(ipKey: string, userKey: string): void {
    const key = this.pairKey(ipKey, userKey);
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
  }

  private takeCredit(ipKey: string, userKey: string): boolean {
    const key = this.pairKey(ipKey, userKey);
    const count = this.pending.get(key) ?? 0;
    if (count <= 0) return false;
    if (count === 1) this.pending.delete(key);
    else this.pending.set(key, count - 1);
    return true;
  }

  /** Drop this request's increment. A lock that is already set stays set. */
  private release(buckets: Map<string, AttemptBucket>, key: string, now: number): void {
    const bucket = buckets.get(key);
    if (!bucket) return;
    bucket.failures = Math.max(0, bucket.failures - 1);
    if (bucket.failures === 0 && bucket.lockedUntil <= now) buckets.delete(key);
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
    if (this.idle(bucket, now)) buckets.delete(key);
  }

  private idle(bucket: AttemptBucket, now: number): boolean {
    if (bucket.lockedUntil > now) return false;
    return now - Math.max(bucket.lastAttempt, bucket.lockedUntil) >= this.maxDelayMs;
  }

  private wait(bucket: AttemptBucket | undefined, now: number): number {
    if (!bucket || bucket.lockedUntil <= now) return 0;
    return bucket.lockedUntil - now;
  }

  /** @returns false when a new bucket cannot be stored without dropping a live lock. */
  private bump(
    buckets: Map<string, AttemptBucket>,
    key: string,
    now: number,
    freeFailures: number,
  ): boolean {
    if (!buckets.has(key) && buckets.size >= MAX_BUCKETS && !this.evictIdle(buckets, now)) {
      return false;
    }
    const current = buckets.get(key) ?? { failures: 0, lockedUntil: 0, lastAttempt: now };
    current.failures += 1;
    current.lastAttempt = now;
    if (current.failures > freeFailures) {
      const exponent = Math.min(current.failures - freeFailures - 1, 20);
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
      if (this.idle(bucket, now)) {
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
