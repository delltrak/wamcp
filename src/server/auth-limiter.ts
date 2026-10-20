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

export interface AuthAttemptResult {
  /** Positive when a lock is already in effect and the password must not be checked. */
  retryAfterMs: number;
  /** Set when this attempt was counted and may still be undone. */
  token?: string;
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

interface EvictedBucket {
  key: string;
  bucket: AttemptBucket;
}

interface PendingUndo {
  ipKey: string;
  pairKey: string;
  userKey: string;
  ipLockBefore: number;
  pairLockBefore: number;
  userLockBefore: number;
  ipLockAfter: number;
  pairLockAfter: number;
  userLockAfter: number;
}

/**
 * Failed-sign-in backoff.
 * The strict lock is the client address and the address-plus-username pair.
 * A username is also limited across addresses after 128 failures, which takes
 * about 16 distinct /64s or NATs. The wait returned to the caller is a lock
 * that was already in effect. Counting this attempt may lock only the next
 * one. A success removes this attempt's count and the lock it created. A lock
 * keeps its failure count when it expires and doubles on the next failure, up
 * to `maxDelayMs`. Quiet time starts at the later of the last attempt and the
 * end of the lock. The address is an IPv6 /64 or everyone behind the same NAT,
 * so a recent success exempts only that username at that address, and only for
 * a few failures.
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
  /** Counted attempts that can still be undone, keyed by the token given to the caller. */
  private readonly pending = new Map<string, PendingUndo>();
  private nextToken = 1;

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
   * Reserve one attempt before verification.
   * A positive `retryAfterMs` is a lock that was already in effect; the password
   * must not be checked and nothing is counted. A zero result may be checked.
   * The count can lock later attempts. Returns the base delay when every stored
   * bucket is still locked.
   */
  beginAttempt(ip: string, username: string): AuthAttemptResult {
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
    if (!bypass && blocked > 0) return { retryAfterMs: blocked };
    if (bypass && exemption) {
      exemption.remaining -= 1;
      if (exemption.remaining <= 0) this.exemptions.delete(this.exemptionKey(ipKey, userKey));
      return { retryAfterMs: 0 };
    }
    const ipBefore = cloneBucket(this.byIp.get(ipKey));
    const pairBefore = cloneBucket(this.byPair.get(pairKey));
    const userBefore = cloneBucket(this.byUser.get(userKey));
    const ipLockBefore = ipBefore?.lockedUntil ?? 0;
    const pairLockBefore = pairBefore?.lockedUntil ?? 0;
    const userLockBefore = userBefore?.lockedUntil ?? 0;
    const ipBump = this.bump(this.byIp, ipKey, now, this.freeFailures);
    const pairBump = ipBump ? this.bump(this.byPair, pairKey, now, this.freeFailures) : undefined;
    const userBump = pairBump
      ? this.bump(this.byUser, userKey, now, this.globalFreeFailures)
      : undefined;
    if (!ipBump || !pairBump || !userBump) {
      restoreBucket(this.byIp, ipKey, ipBefore);
      restoreBucket(this.byPair, pairKey, pairBefore);
      restoreBucket(this.byUser, userKey, userBefore);
      this.restoreEvicted(this.byIp, ipBump?.evicted);
      this.restoreEvicted(this.byPair, pairBump?.evicted);
      this.restoreEvicted(this.byUser, userBump?.evicted);
      return { retryAfterMs: this.baseDelayMs };
    }
    const token = this.notePending({
      ipKey,
      pairKey,
      userKey,
      ipLockBefore,
      pairLockBefore,
      userLockBefore,
      ipLockAfter: this.byIp.get(ipKey)?.lockedUntil ?? 0,
      pairLockAfter: this.byPair.get(pairKey)?.lockedUntil ?? 0,
      userLockAfter: this.byUser.get(userKey)?.lockedUntil ?? 0,
    });
    return { retryAfterMs: 0, token };
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
   * Password matched. Undoes this attempt's count and the lock it created.
   * A lock that was already in effect stays. Other failures on the address stay.
   */
  recordSuccess(ip: string, username: string, token?: string): void {
    const now = this.now();
    const ipKey = normalizeClientIp(ip);
    const userKey = normalizeUser(username);
    const undo = token ? this.takePending(ipKey, userKey, token) : undefined;
    if (token && !undo) return;
    if (undo) {
      this.undo(this.byIp, undo.ipKey, now, undo.ipLockBefore, undo.ipLockAfter);
      this.undo(this.byPair, undo.pairKey, now, undo.pairLockBefore, undo.pairLockAfter);
      this.undo(this.byUser, undo.userKey, now, undo.userLockBefore, undo.userLockAfter);
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
  recordFailure(ip: string, username: string, token?: string): void {
    const ipKey = normalizeClientIp(ip);
    const userKey = normalizeUser(username);
    this.takePending(ipKey, userKey, token);
    this.exemptions.delete(this.exemptionKey(ipKey, userKey));
  }

  /** Verification did not finish. The counted attempt stays, and an exemption stays. */
  recordBusy(ip: string, username: string, token?: string): void {
    this.takePending(normalizeClientIp(ip), normalizeUser(username), token);
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

  private notePending(undo: PendingUndo): string {
    while (this.pending.size >= MAX_BUCKETS) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    const token = String(this.nextToken);
    this.nextToken += 1;
    this.pending.set(token, undo);
    return token;
  }

  private takePending(ipKey: string, userKey: string, token?: string): PendingUndo | undefined {
    if (!token) return undefined;
    const undo = this.pending.get(token);
    if (!undo || undo.ipKey !== ipKey || undo.userKey !== userKey) return undefined;
    this.pending.delete(token);
    return undo;
  }

  /** Drop this attempt's increment and the lock it set, unless a later attempt replaced that lock. */
  private undo(
    buckets: Map<string, AttemptBucket>,
    key: string,
    now: number,
    lockBefore: number,
    lockAfter: number,
  ): void {
    const bucket = buckets.get(key);
    if (!bucket) return;
    bucket.failures = Math.max(0, bucket.failures - 1);
    if (bucket.lockedUntil === lockAfter) bucket.lockedUntil = lockBefore;
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

  /** @returns undefined when a new bucket cannot be stored without dropping a live lock. */
  private bump(
    buckets: Map<string, AttemptBucket>,
    key: string,
    now: number,
    freeFailures: number,
  ): { evicted?: EvictedBucket } | undefined {
    let evicted: EvictedBucket | undefined;
    if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) {
      evicted = this.evictUnlocked(buckets, now);
      if (!evicted) return undefined;
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
    return { evicted };
  }

  /** Drop the oldest bucket that is not locked right now. */
  private evictUnlocked(
    buckets: Map<string, AttemptBucket>,
    now: number,
  ): EvictedBucket | undefined {
    for (const [key, bucket] of buckets) {
      if (bucket.lockedUntil <= now) {
        buckets.delete(key);
        return { key, bucket };
      }
    }
    return undefined;
  }

  private restoreEvicted(
    buckets: Map<string, AttemptBucket>,
    evicted: EvictedBucket | undefined,
  ): void {
    if (!evicted) return;
    buckets.set(evicted.key, evicted.bucket);
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
