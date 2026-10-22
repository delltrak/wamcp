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
const USER_SLOTS = 65_536;

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
  /**
   * Delay safe to send as Retry-After.
   * A username lock always uses the ceiling, so the number does not identify the bucket.
   */
  headerRetryAfterMs?: number;
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
 * username at that address, and only for a few failures. An access token that
 * was already issued is not checked again here. Usernames live in a fixed
 * table of 65536 buckets, indexed by an HMAC with a per-process key. Nothing
 * is evicted from that table. A collision shares a bucket. A quiet period
 * halves the username count instead of clearing it. Locking every bucket takes
 * on the order of 11 million spread-out failures, and keeping them locked
 * takes about one failure per bucket per quiet window. Retry-After for that
 * lock is always the ceiling. The address maps, when full, drop the unlocked
 * entry with the fewest failures. When every address slot is an active lock, a
 * new address shares one overflow bucket, and a recent success does not create
 * an address bucket.
 */
export class AuthAttemptLimiter {
  private readonly freeFailures: number;
  private readonly globalFreeFailures: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly recentSuccessMs: number;
  private readonly exemptFailures: number;
  private readonly now: () => number;
  private readonly byIp = new CountedBuckets();
  private readonly byPair = new CountedBuckets();
  private readonly userHashKey = randomBytes(32);
  private readonly userFailures = new Uint32Array(USER_SLOTS);
  private readonly userLockedUntil = new Float64Array(USER_SLOTS);
  private readonly userLastAttempt = new Float64Array(USER_SLOTS);
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
    this.decayUser(userBucket, now);
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
    if (!bypass && blocked > 0) {
      return { retryAfterMs: blocked, headerRetryAfterMs: this.headerWait(blocked, userWait) };
    }
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
      this.restore(this.byIp, ipKey, ipBefore);
      this.restore(this.byPair, pairKey, pairBefore);
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
    return this.charges(ip, username).blocked;
  }

  /** Retry-After that does not identify which username bucket is locked. */
  headerRetryAfterMs(ip: string, username?: string): number {
    const charges = this.charges(ip, username);
    return this.headerWait(charges.blocked, charges.userWait);
  }

  private charges(ip: string, username?: string): { blocked: number; userWait: number } {
    const now = this.now();
    const ipKey = normalizeClientIp(ip);
    this.decay(this.byIp, ipKey, now);
    this.decayOverflow(now);
    const ipOverflow = this.needsOverflow(this.byIp, ipKey, now);
    const ipWait = ipOverflow
      ? this.wait(this.overflow, now)
      : this.wait(this.byIp.get(ipKey), now);
    if (!username) return { blocked: ipWait, userWait: 0 };
    const userKey = normalizeUser(username);
    const pairKey = this.pairKey(ipKey, userKey);
    this.decay(this.byPair, pairKey, now);
    const userBucket = this.userBucket(userKey);
    this.decayUser(userBucket, now);
    if (this.exemptionFor(ipKey, userKey, now)) return { blocked: 0, userWait: 0 };
    const pairOverflow = this.needsOverflow(this.byPair, pairKey, now);
    const pairWait = pairOverflow
      ? this.wait(this.overflow, now)
      : this.wait(this.byPair.get(pairKey), now);
    const userWait = this.wait(userBucket, now);
    return { blocked: Math.max(ipWait, pairWait, userWait), userWait };
  }

  private headerWait(blocked: number, userWait: number): number {
    if (userWait <= 0) return blocked;
    return Math.max(blocked, this.maxDelayMs);
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
    buckets: CountedBuckets,
    key: string,
    now: number,
    lockBefore: number,
    lockAfter: number,
  ): void {
    const bucket = buckets.get(key);
    if (!bucket) return;
    const previousFailures = bucket.failures;
    if (this.undoBucket(bucket, now, lockBefore, lockAfter)) {
      buckets.deleteCounted(key, previousFailures);
      return;
    }
    if (bucket.failures !== previousFailures) buckets.replace(key, bucket, previousFailures, true);
  }

  private userBucket(userKey: string): AttemptBucket {
    const mac = createHmac("sha256", this.userHashKey).update(userKey).digest();
    const index = mac.readUInt16BE(0);
    const failures = this.userFailures;
    const lockedUntil = this.userLockedUntil;
    const lastAttempt = this.userLastAttempt;
    return {
      get failures() {
        return failures[index] ?? 0;
      },
      set failures(value: number) {
        failures[index] = value;
      },
      get lockedUntil() {
        return lockedUntil[index] ?? 0;
      },
      set lockedUntil(value: number) {
        lockedUntil[index] = value;
      },
      get lastAttempt() {
        return lastAttempt[index] ?? 0;
      },
      set lastAttempt(value: number) {
        lastAttempt[index] = value;
      },
    };
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

  private decay(buckets: CountedBuckets, key: string, now: number): void {
    const bucket = buckets.get(key);
    if (!bucket) return;
    if (this.idle(bucket, now)) buckets.delete(key);
  }

  /** A quiet username keeps half its count, so the same burst every window still reaches the lock. */
  private decayUser(bucket: AttemptBucket, now: number): void {
    if (bucket.failures === 0 && bucket.lockedUntil <= now) return;
    if (!this.idle(bucket, now)) return;
    const halved = Math.floor(bucket.failures / 2);
    if (halved === 0) {
      clearBucket(bucket);
      return;
    }
    bucket.failures = halved;
    bucket.lockedUntil = 0;
    bucket.lastAttempt = now;
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
    buckets: CountedBuckets,
    key: string,
    now: number,
    freeFailures: number,
  ): { evicted?: EvictedBucket } | undefined {
    let evicted: EvictedBucket | undefined;
    const existing = buckets.get(key);
    if (!existing && buckets.size >= MAX_BUCKETS) {
      evicted = buckets.evictUnlocked(now);
      if (!evicted) return undefined;
    }
    const current = existing ?? emptyBucket();
    const previousFailures = existing ? existing.failures : undefined;
    this.applyFailure(current, now, freeFailures);
    buckets.replace(key, current, previousFailures);
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

  private needsOverflow(buckets: CountedBuckets, key: string, now: number): boolean {
    if (buckets.has(key) || buckets.size < MAX_BUCKETS) return false;
    return buckets.findUnlocked(now) === undefined;
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

  private restore(buckets: CountedBuckets, key: string, previous: AttemptBucket | undefined): void {
    if (!previous) {
      buckets.delete(key);
      return;
    }
    buckets.replace(key, previous);
  }

  private restoreEvicted(buckets: CountedBuckets, evicted: EvictedBucket | undefined): void {
    if (!evicted) return;
    buckets.replace(evicted.key, evicted.bucket);
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

interface AgeNode {
  key: string;
  age: number;
  prev?: AgeNode;
  next?: AgeNode;
}

/** Keys of one failure count, oldest at the head. */
class AgeList {
  head?: AgeNode;
  tail?: AgeNode;
  readonly nodes = new Map<string, AgeNode>();

  get size(): number {
    return this.nodes.size;
  }

  insert(key: string, age: number): void {
    const node: AgeNode = { key, age };
    this.nodes.set(key, node);
    const tail = this.tail;
    if (!tail || tail.age <= age) {
      if (!tail) {
        this.head = node;
        this.tail = node;
        return;
      }
      tail.next = node;
      node.prev = tail;
      this.tail = node;
      return;
    }
    let cursor = this.head;
    while (cursor && cursor.age <= age) cursor = cursor.next;
    if (!cursor) {
      const end = this.tail;
      if (!end) {
        this.head = node;
        this.tail = node;
        return;
      }
      end.next = node;
      node.prev = end;
      this.tail = node;
      return;
    }
    node.next = cursor;
    node.prev = cursor.prev;
    if (cursor.prev) cursor.prev.next = node;
    else this.head = node;
    cursor.prev = node;
  }

  remove(key: string): void {
    const node = this.nodes.get(key);
    if (!node) return;
    this.nodes.delete(key);
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
  }
}

/**
 * Address buckets indexed by failure count.
 * Eviction takes the oldest unlocked key of the smallest count, without scanning every key.
 */
class CountedBuckets {
  private readonly buckets = new Map<string, AttemptBucket>();
  private readonly lists = new Map<number, AgeList>();
  private readonly ages = new Map<string, number>();
  private nextAge = 1;
  private cached: EvictedBucket | undefined;
  private cachedAt = Number.NaN;
  /** No unlocked bucket exists before this time. */
  private noneUntil = 0;

  get size(): number {
    return this.buckets.size;
  }

  has(key: string): boolean {
    return this.buckets.has(key);
  }

  get(key: string): AttemptBucket | undefined {
    return this.buckets.get(key);
  }

  /**
   * Insert or replace a key.
   * A kept age stays where it was among the other keys. A refreshed age becomes the newest.
   */
  replace(key: string, bucket: AttemptBucket, previousFailures?: number, keepAge = false): void {
    const kept = keepAge ? this.ages.get(key) : undefined;
    if (previousFailures !== undefined) this.detach(key, previousFailures);
    else {
      const current = this.buckets.get(key);
      if (current) this.detach(key, current.failures);
    }
    this.buckets.set(key, bucket);
    const age = kept ?? this.nextAge++;
    this.ages.set(key, age);
    this.list(bucket.failures).insert(key, age);
    this.invalidate();
  }

  delete(key: string): void {
    const current = this.buckets.get(key);
    if (!current) return;
    this.deleteCounted(key, current.failures);
  }

  /** Remove a key whose failure count was already changed in place. */
  deleteCounted(key: string, indexedFailures: number): void {
    this.detach(key, indexedFailures);
    this.buckets.delete(key);
    this.ages.delete(key);
    this.invalidate();
  }

  findUnlocked(now: number): EvictedBucket | undefined {
    if (
      this.cached &&
      this.cachedAt === now &&
      this.cached.bucket.lockedUntil <= now &&
      this.buckets.get(this.cached.key) === this.cached.bucket
    ) {
      return this.cached;
    }
    if (now < this.noneUntil) return undefined;
    const counts = [...this.lists.keys()].sort((left, right) => left - right);
    let soonest = Number.POSITIVE_INFINITY;
    for (const count of counts) {
      let node = this.lists.get(count)?.head;
      while (node) {
        const bucket = this.buckets.get(node.key);
        if (!bucket) {
          node = node.next;
          continue;
        }
        if (bucket.lockedUntil > now) {
          if (bucket.lockedUntil < soonest) soonest = bucket.lockedUntil;
          node = node.next;
          continue;
        }
        this.cached = { key: node.key, bucket };
        this.cachedAt = now;
        this.noneUntil = 0;
        return this.cached;
      }
    }
    this.cached = undefined;
    this.cachedAt = now;
    this.noneUntil = soonest;
    return undefined;
  }

  evictUnlocked(now: number): EvictedBucket | undefined {
    const best = this.findUnlocked(now);
    if (!best) return undefined;
    const saved: EvictedBucket = { key: best.key, bucket: { ...best.bucket } };
    this.delete(best.key);
    return saved;
  }

  private list(failures: number): AgeList {
    let list = this.lists.get(failures);
    if (!list) {
      list = new AgeList();
      this.lists.set(failures, list);
    }
    return list;
  }

  private detach(key: string, failures: number): void {
    const list = this.lists.get(failures);
    if (!list) return;
    list.remove(key);
    if (list.size === 0) this.lists.delete(failures);
  }

  private invalidate(): void {
    this.cached = undefined;
    this.cachedAt = Number.NaN;
    this.noneUntil = 0;
  }
}

export { clientAddress, normalizeClientIp, type TrustedProxy };
