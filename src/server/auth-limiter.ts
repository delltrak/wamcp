import type { IncomingMessage } from "node:http";

const DEFAULT_FREE_FAILURES = 8;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 15 * 60 * 1000;
const MAX_BUCKETS = 10_000;

export interface AuthLimiterOptions {
  freeFailures?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
}

interface AttemptBucket {
  failures: number;
  lockedUntil: number;
}

/**
 * Failed-sign-in backoff keyed by the socket address and by the username.
 * A successful password resets only the username bucket.
 */
export class AuthAttemptLimiter {
  private readonly freeFailures: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly now: () => number;
  private readonly byIp = new Map<string, AttemptBucket>();
  private readonly byUser = new Map<string, AttemptBucket>();

  constructor(options: AuthLimiterOptions = {}) {
    this.freeFailures = options.freeFailures ?? DEFAULT_FREE_FAILURES;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.now = options.now ?? Date.now;
  }

  retryAfterMs(ip: string, username?: string): number {
    const now = this.now();
    const ipWait = this.wait(this.byIp.get(normalizeIp(ip)), now);
    const userWait = username ? this.wait(this.byUser.get(normalizeUser(username)), now) : 0;
    return Math.max(ipWait, userWait);
  }

  recordFailure(ip: string, username: string): number {
    const now = this.now();
    this.bump(this.byIp, normalizeIp(ip), now);
    this.bump(this.byUser, normalizeUser(username), now);
    return this.retryAfterMs(ip, username);
  }

  recordSuccess(username: string): void {
    this.byUser.delete(normalizeUser(username));
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
}

/** Socket peer only. Forwarded headers are not a client address. */
export function clientAddress(req: IncomingMessage): string {
  const address = req.socket?.remoteAddress;
  if (!address || address.length > 128) return "unknown";
  return address;
}

function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  if (!trimmed || trimmed.length > 128) return "unknown";
  return trimmed;
}

function normalizeUser(username: string): string {
  if (!username || username.length > 128) return "\0invalid";
  return username;
}
