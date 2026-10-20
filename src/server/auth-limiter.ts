import { createHmac, randomBytes } from "node:crypto";
import { clientAddress, normalizeClientIp, type TrustedProxy } from "./ip-address.js";

const DEFAULT_FREE_FAILURES = 8;
const DEFAULT_GLOBAL_FREE_FAILURES = 128;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 15 * 60 * 1000;
const DEFAULT_RECENT_SUCCESS_MS = 60 * 60 * 1000;
const DEFAULT_EXEMPT_FAILURES = 3;
const MAX_BUCKETS = 10_000;
/** Fixed username table. A hash collision shares a bucket and only makes the limit stricter. */
const USER_SLOTS = 4096;

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
  countedIp: boolean;
  countedPair: boolean;
  countedUser: boolean;
  countedOverflow: boolean;
  overflowLockBefore: number;
  overflowLockAfter: number;
}

/**
 * Failed-sign-in backoff.
 * The strict lock is the client address and the address-plus-username pair.
 * A username is also limited across addresses after 128 failures, which takes
 * about 16 distinct /64s or NATs. About one failure per window keeps that
 * global lock. While it continues, only a username that signed in from that
 * address in the last hour is exempt, and only for a few failures. The wait
 * returned to the caller is a lock that was already in effect. Counting this
 * attempt may lock only the next one. A success removes this attempt's count
 * and the lock it created, and still records the exemption when the attempt
 * token was dropped. A lock keeps its failure count when it expires and
 * doubles on the next failure, up to `maxDelayMs`. Quiet time starts at the
 * later of the last attempt and the end of the lock. The address is an IPv6
 * /64 or everyone behind the same NAT, so a recent success exempts only that
 * username at that address, and only for a few failures. Usernames live in a
 * fixed table of 4096 buckets, indexed by an HMAC with a per-process key.
 * Nothing is evicted from that table. A collision shares a bucket. Each bucket
 * still forgets its count after a quiet period once its lock has ended. The
 * address maps, when full, drop the unlocked entry with the fewest failures.
 * When every address slot is an active lock, a new address shares one overflow
 * bucket, and a recent success does not create an address bucket.
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
  private readonly userHashKey = randomBytes(32);
  private readonly userSlots: AttemptBucket[] = Array.from({ length: USER_SLOTS }, () =>
    emptyBucket(),
  );
  private readonly exemptions = new Map<string, Exemption>();
  /** Counted attempts that can still be undone, keyed by the token given to the caller. */
  private readonly pending = new Map<string, PendingUndo>();
  /** Counts a new address when its map is full of active locks. */
  private overflow: AttemptBucket = emptyBucket();
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
   * The count can lock later attempts. When an address map is full of active
   * locks, the new address is counted in one shared overflow bucket. A recent
   * success in that case does not create an address bucket.
   */
  beginAttempt(ip: string, username: string): AuthAttemptResult {
    const now = this.now();
    const ipKey = normalizeClientIp(ip);
    const userKey = normalizeUser(username);
    const pairKey = this.pairKey(ipKey, userKey);
    const userBucket = this.userBucket(userKey);
    this.decay(this.byIp, ipKey, now);
    this.decay(this.byPair, pairKey, now);
    this.decayBucket(userBucket, now);
    this.decayOverflow(now);
    const placement = this.placement(ipKey, pairKey, now);
    const ipWait = placement.ipOverflow
      ? this.wait(this.overflow, now)
      : this.wait(this.byIp.get(ipKey), now);
    const pairWait = placement.pairOverflow
      ? this.wait(this.overflow, now)
      : this.wait(this.byPair.get(pairKey), now);
    const userWait = this.wait(userBucket, now);
    const exemption = this.exemptionFor(ipKey, userKey, now);
    const blocked = Math.max(ipWait, pairWait, userWait);
    const bypass = exemption !== undefined && blocked > 0;
    if (!bypass && blocked > 0) return { retryAfterMs: blocked };
    if (bypass && exemption) {
      exemption.remaining -= 1;
      if (exemption.remaining <= 0) this.exemptions.delete(this.exemptionKey(ipKey, userKey));
      return { retryAfterMs: 0 };
    }
    if (exemption && placement.sharedOverflow) return { retryAfterMs: 0 };
    const ipBefore = cloneBucket(this.byIp.get(ipKey));
    const pairBefore = cloneBucket(this.byPair.get(pairKey));
    const ipLockBefore = ipBefore?.lockedUntil ?? 0;
    const pairLockBefore = pairBefore?.lockedUntil ?? 0;
    const userLockBefore = userBucket.lockedUntil;
    const overflowLockBefore = this.overflow.lockedUntil;
    const skipped = { evicted: undefined };
    const ipBump = placement.ipOverflow
      ? skipped
      : this.bump(this.byIp, ipKey, now, this.freeFailures);
    const pairBump = !ipBump
      ? undefined
      : placement.pairOverflow
        ? skipped
        : this.bump(this.byPair, pairKey, now, this.freeFailures);
    if (!ipBump || !pairBump) {
      restoreBucket(this.byIp, ipKey, ipBefore);
      restoreBucket(this.byPair, pairKey, pairBefore);
      this.restoreEvicted(this.byIp, ipBump?.evicted);
      this.restoreEvicted(this.byPair, pairBump?.evicted);
      return { retryAfterMs: this.baseDelayMs };
    }
    this.applyFailure(userBucket, now, this.globalFreeFailures);
    if (placement.sharedOverflow) this.applyFailure(this.overflow, now, this.freeFailures);
    const token = this.notePending({
      ipKey,
      pairKey,
      userKey,
      ipLockBefore,
      pairLockBefore,
      userLockBefore,
      ipLockAfter: placement.ipOverflow ? ipLockBefore : (this.byIp.get(ipKey)?.lockedUntil ?? 0),
      pairLockAfter: placement.pairOverflow
        ? pairLockBefore
        : (this.byPair.get(pairKey)?.lockedUntil ?? 0),
      userLockAfter: userBucket.lockedUntil,
      countedIp: !placement.ipOverflow,
      countedPair: !placement.pairOverflow,
      countedUser: true,
      countedOverflow: placement.sharedOverflow,
      overflowLockBefore,
      overflowLockAfter: this.overflow.lockedUntil,
    });
    return { retryAfterMs: 0, token };
  }

  retryAfterMs(ip: string, username?: string): number {
    const now = this.now();
    const ipKey = normalizeClientIp(ip);
    this.decay(this.byIp, ipKey, now);
    this.decayOverflow(now);
    const ipOverflow = this.needsOverflow(this.byIp, ipKey, now);
    const ipWait = ipOverflow
      ? this.wait(this.overflow, now)
      : this.wait(this.byIp.get(ipKey), now);
    if (!username) return ipWait;
    const userKey = normalizeUser(username);
    const pairKey = this.pairKey(ipKey, userKey);
    this.decay(this.byPair, pairKey, now);
    const userBucket = this.userBucket(userKey);
    this.decayBucket(userBucket, now);
    if (this.exemptionFor(ipKey, userKey, now)) return 0;
    const pairOverflow = this.needsOverflow(this.byPair, pairKey, now);
    const pairWait = pairOverflow
      ? this.wait(this.overflow, now)
      : this.wait(this.byPair.get(pairKey), now);
    return Math.max(ipWait, pairWait, this.wait(userBucket, now));
  }

  /**
   * Password matched. Undoes this attempt's count and the lock it created when
   * the attempt token is still stored. A dropped token skips that undo and still
   * records the exemption. A lock that was already in effect stays. Other
   * failures on the address stay.
   */
  recordSuccess(ip: string, username: string, token?: string): void {
    const now = this.now();
    const ipKey = normalizeClientIp(ip);
    const userKey = normalizeUser(username);
    const undo = token ? this.takePending(ipKey, userKey, token) : undefined;
    if (undo) {
      if (undo.countedIp) {
        this.undo(this.byIp, undo.ipKey, now, undo.ipLockBefore, undo.ipLockAfter);
      }
      if (undo.countedPair) {
        this.undo(this.byPair, undo.pairKey, now, undo.pairLockBefore, undo.pairLockAfter);
      }
      if (undo.countedUser) {
        this.undoBucket(
          this.userBucket(undo.userKey),
          now,
          undo.userLockBefore,
          undo.userLockAfter,
        );
      }
      if (undo.countedOverflow) {
        this.undoOverflow(now, undo.overflowLockBefore, undo.overflowLockAfter);
      }
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
    if (this.undoBucket(bucket, now, lockBefore, lockAfter)) buckets.delete(key);
  }

  private userBucket(userKey: string): AttemptBucket {
    const mac = createHmac("sha256", this.userHashKey).update(userKey).digest();
    const index = mac.readUInt32BE(0) % USER_SLOTS;
    const existing = this.userSlots[index];
    if (existing) return existing;
    const created = emptyBucket();
    this.userSlots[index] = created;
    return created;
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

  private placement(
    ipKey: string,
    pairKey: string,
    now: number,
  ): { ipOverflow: boolean; pairOverflow: boolean; sharedOverflow: boolean } {
    const ipOverflow = this.needsOverflow(this.byIp, ipKey, now);
    const pairOverflow = this.needsOverflow(this.byPair, pairKey, now);
    return { ipOverflow, pairOverflow, sharedOverflow: ipOverflow || pairOverflow };
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
    this.applyFailure(current, now, freeFailures);
    buckets.delete(key);
    buckets.set(key, current);
    return { evicted };
  }

  private applyFailure(bucket: AttemptBucket, now: number, freeFailures: number): void {
    bucket.failures += 1;
    bucket.lastAttempt = now;
    if (bucket.failures > freeFailures) {
      const exponent = Math.min(bucket.failures - freeFailures - 1, 20);
      const delay = Math.min(this.baseDelayMs * 2 ** exponent, this.maxDelayMs);
      bucket.lockedUntil = now + delay;
    }
  }

  /** Drop the unlocked bucket with the fewest failures. The oldest wins a tie. */
  private evictUnlocked(
    buckets: Map<string, AttemptBucket>,
    now: number,
  ): EvictedBucket | undefined {
    const best = this.findUnlocked(buckets, now);
    if (!best) return undefined;
    buckets.delete(best.key);
    return best;
  }

  private findUnlocked(
    buckets: Map<string, AttemptBucket>,
    now: number,
  ): EvictedBucket | undefined {
    let best: EvictedBucket | undefined;
    for (const [key, bucket] of buckets) {
      if (bucket.lockedUntil > now) continue;
      if (!best || bucket.failures < best.bucket.failures) best = { key, bucket };
    }
    return best;
  }

  private needsOverflow(buckets: Map<string, AttemptBucket>, key: string, now: number): boolean {
    if (buckets.has(key) || buckets.size < MAX_BUCKETS) return false;
    return this.findUnlocked(buckets, now) === undefined;
  }

  private decayBucket(bucket: AttemptBucket, now: number): void {
    if (bucket.failures === 0 && bucket.lockedUntil <= now) return;
    if (this.idle(bucket, now)) clearBucket(bucket);
  }

  /** @returns true when the bucket is empty and should leave a map. */
  private undoBucket(
    bucket: AttemptBucket,
    now: number,
    lockBefore: number,
    lockAfter: number,
  ): boolean {
    bucket.failures = Math.max(0, bucket.failures - 1);
    if (bucket.lockedUntil === lockAfter) bucket.lockedUntil = lockBefore;
    const empty = bucket.failures === 0 && bucket.lockedUntil <= now;
    if (empty) clearBucket(bucket);
    return empty;
  }

  private decayOverflow(now: number): void {
    this.decayBucket(this.overflow, now);
  }

  private undoOverflow(now: number, lockBefore: number, lockAfter: number): void {
    this.undoBucket(this.overflow, now, lockBefore, lockAfter);
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

function emptyBucket(): AttemptBucket {
  return { failures: 0, lockedUntil: 0, lastAttempt: 0 };
}

function clearBucket(bucket: AttemptBucket): void {
  bucket.failures = 0;
  bucket.lockedUntil = 0;
  bucket.lastAttempt = 0;
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
