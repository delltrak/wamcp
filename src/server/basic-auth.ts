import { createHash, createHmac, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

export const BASIC_AUTH_SCRYPT = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
  keylen: 32,
} as const;

const USERNAME_PATTERN = /^[A-Za-z0-9._~@+-]{1,128}$/;
const DUMMY_SALT = Buffer.from("0123456789abcdef");
const SCRYPT_OPTIONS: ScryptOptions = {
  N: BASIC_AUTH_SCRYPT.N,
  r: BASIC_AUTH_SCRYPT.r,
  p: BASIC_AUTH_SCRYPT.p,
  maxmem: BASIC_AUTH_SCRYPT.maxmem,
};
const SUCCESS_CACHE_TTL_MS = 30_000;
const SUCCESS_CACHE_MAX = 256;

export interface BasicAuthUser {
  username: string;
  kind: "plain" | "scrypt";
  password?: string;
  salt?: Buffer;
  hash?: Buffer;
}

export interface VerifyBasicOptions {
  now?: number;
  /** Recent successful sign-in from this client. May use the reserved scrypt slot. */
  priority?: boolean;
}

interface SuccessCacheEntry {
  expiresAt: number;
}

interface ScryptWaiter {
  priority: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export const BASIC_AUTH_SCRYPT_QUEUE_MAX = 8;
export const BASIC_AUTH_SCRYPT_QUEUE_TIMEOUT_MS = 2_000;

const successCache = new Map<string, SuccessCacheEntry>();
const scryptWaiters: ScryptWaiter[] = [];
let scryptOperations = 0;
let scryptInFlight = 0;
let scryptLimit = defaultBasicAuthScryptLimit();
let dummyHashPromise: Promise<Buffer> | undefined;

/** Leave one libuv thread free. The default pool size is 4, so this is 3. */
export function defaultBasicAuthScryptLimit(): number {
  const parsed = Number(process.env.UV_THREADPOOL_SIZE);
  const pool = Number.isInteger(parsed) && parsed > 1 ? parsed : 4;
  return Math.min(4, pool - 1);
}

export class ScryptBusyError extends Error {
  constructor() {
    super("scrypt_busy");
    this.name = "ScryptBusyError";
  }
}

/** Cap concurrent scrypt work so the libuv threadpool stays available. */
export function setBasicAuthScryptLimit(limit: number): void {
  scryptLimit = limit;
}

export function basicAuthScryptLimit(): number {
  return scryptLimit;
}

function slotsFor(priority: boolean): number {
  if (scryptLimit <= 0) return 0;
  if (priority) return scryptLimit;
  return Math.max(1, scryptLimit - 1);
}

function hasCapacity(priority: boolean): boolean {
  return scryptInFlight < slotsFor(priority);
}

function tryStart(priority: boolean): boolean {
  if (!hasCapacity(priority)) return false;
  if (scryptWaiters.length === 0) {
    scryptInFlight += 1;
    return true;
  }
  // The last slot stays available to a client that signed in recently, even when
  // attackers are already queued.
  if (priority && scryptInFlight >= slotsFor(false)) {
    scryptInFlight += 1;
    return true;
  }
  return false;
}

function pumpScryptQueue(): void {
  for (let index = 0; index < scryptWaiters.length; index += 1) {
    const waiter = scryptWaiters[index];
    if (!waiter || !hasCapacity(waiter.priority)) continue;
    scryptWaiters.splice(index, 1);
    clearTimeout(waiter.timer);
    scryptInFlight += 1;
    waiter.resolve();
    return;
  }
}

function releaseScryptSlot(): void {
  scryptInFlight = Math.max(0, scryptInFlight - 1);
  pumpScryptQueue();
}

function enqueueScrypt(priority: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const waiter: ScryptWaiter = {
      priority,
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = scryptWaiters.indexOf(waiter);
        if (index !== -1) scryptWaiters.splice(index, 1);
        reject(new ScryptBusyError());
      }, BASIC_AUTH_SCRYPT_QUEUE_TIMEOUT_MS),
    };
    waiter.timer.unref();
    scryptWaiters.push(waiter);
  });
}

function deriveKey(password: string, salt: Buffer, priority: boolean): Promise<Buffer> {
  if (tryStart(priority)) return runScrypt(password, salt);
  if (slotsFor(priority) <= 0 || scryptWaiters.length >= BASIC_AUTH_SCRYPT_QUEUE_MAX) {
    return Promise.reject(new ScryptBusyError());
  }
  return enqueueScrypt(priority).then(() => runScrypt(password, salt));
}

function runScrypt(password: string, salt: Buffer): Promise<Buffer> {
  scryptOperations += 1;
  return new Promise((resolve, reject) => {
    scrypt(password, salt, BASIC_AUTH_SCRYPT.keylen, SCRYPT_OPTIONS, (error, derived) => {
      releaseScryptSlot();
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

function dummyHash(priority: boolean): Promise<Buffer> {
  dummyHashPromise ??= deriveKey("wamcp-basic-auth-dummy", DUMMY_SALT, priority).catch(
    (error: unknown) => {
      dummyHashPromise = undefined;
      throw error;
    },
  );
  return dummyHashPromise;
}

/** Successful scrypt derivations since process start. Failures are not cached. */
export function basicAuthScryptOperations(): number {
  return scryptOperations;
}

export function clearBasicAuthSuccessCache(): void {
  successCache.clear();
}

function safeEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest(),
  );
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length > 0 ? decoded : undefined;
}

function parsePassword(
  password: string,
): Pick<BasicAuthUser, "kind" | "password" | "salt" | "hash"> {
  if (!password.startsWith("$scrypt$")) return { kind: "plain", password };

  const parts = password.split("$");
  const salt = parts.length === 4 ? decodeBase64Url(parts[2] ?? "") : undefined;
  const hash = parts.length === 4 ? decodeBase64Url(parts[3] ?? "") : undefined;
  if (
    parts[1] !== "scrypt" ||
    !salt ||
    salt.length < 16 ||
    !hash ||
    hash.length !== BASIC_AUTH_SCRYPT.keylen
  ) {
    throw new Error("Invalid WA_BASIC_AUTH; a $scrypt$ password hash is malformed");
  }
  return { kind: "scrypt", salt, hash };
}

/** Parse `user:pass,user2:pass2`. A password may be a `$scrypt$salt$hash` verifier. */
export function parseBasicAuthUsers(raw: string | undefined): BasicAuthUser[] {
  if (raw === undefined || raw.trim() === "") return [];

  const entries = raw.split(",");
  if (entries.length > 100) throw new Error("Invalid WA_BASIC_AUTH; too many users");

  const users: BasicAuthUser[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const trimmed = entry.trim();
    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      throw new Error("Invalid WA_BASIC_AUTH; expected user:password pairs separated by commas");
    }

    const username = trimmed.slice(0, separator);
    const password = trimmed.slice(separator + 1);
    if (!USERNAME_PATTERN.test(username) || password.length < 1 || password.length > 256) {
      throw new Error("Invalid WA_BASIC_AUTH; expected user:password pairs separated by commas");
    }
    if (seen.has(username)) throw new Error("Invalid WA_BASIC_AUTH; usernames must be unique");
    seen.add(username);
    users.push({ username, ...parsePassword(password) });
  }
  return users;
}

export function findBasicUser(
  users: readonly BasicAuthUser[],
  username: string,
): BasicAuthUser | undefined {
  let matched: BasicAuthUser | undefined;
  for (const candidate of users) {
    if (safeEqual(candidate.username, username)) matched = candidate;
  }
  return matched;
}

/** HMAC of the configured verifier. Password rotation changes it. The key stays out of oauth.db. */
export function credentialFingerprint(user: BasicAuthUser, macKey: Buffer): string {
  const material =
    user.kind === "scrypt"
      ? `scrypt\0${user.salt?.toString("base64url") ?? ""}\0${user.hash?.toString("base64url") ?? ""}`
      : `plain\0${user.password ?? ""}`;
  return createHmac("sha256", macKey).update(`${user.username}\0${material}`).digest("hex");
}

function verifierCacheId(user: BasicAuthUser): string {
  const material =
    user.kind === "scrypt"
      ? `scrypt\0${user.salt?.toString("base64url") ?? ""}\0${user.hash?.toString("base64url") ?? ""}`
      : `plain\0${user.password ?? ""}`;
  return createHash("sha256").update(material).digest("hex");
}

function successCacheKey(username: string, password: string, fingerprint: string): string {
  return createHash("sha256").update(`${username}\0${password}\0${fingerprint}`).digest("hex");
}

function rememberSuccess(key: string, now: number): void {
  if (successCache.has(key)) successCache.delete(key);
  successCache.set(key, { expiresAt: now + SUCCESS_CACHE_TTL_MS });
  while (successCache.size > SUCCESS_CACHE_MAX) {
    const oldest = successCache.keys().next().value;
    if (oldest === undefined) break;
    successCache.delete(oldest);
  }
}

async function verifyScrypt(
  password: string,
  salt: Buffer,
  expected: Buffer,
  priority: boolean,
): Promise<boolean> {
  const actual = await deriveKey(password, salt, priority);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function verifyBasicCredentials(
  users: readonly BasicAuthUser[],
  username: string,
  password: string,
  options?: VerifyBasicOptions,
): Promise<boolean> {
  const now = options?.now ?? Date.now();
  const priority = options?.priority === true;
  const bounded = password.length > 0 && password.length <= 256 ? password : "invalid-password";
  const matched = findBasicUser(users, username);
  if (!matched || password.length < 1 || password.length > 256) {
    await verifyScrypt(bounded, DUMMY_SALT, await dummyHash(priority), priority);
    return false;
  }

  const key = successCacheKey(username, bounded, verifierCacheId(matched));
  const cached = successCache.get(key);
  if (cached && cached.expiresAt > now) {
    rememberSuccess(key, now);
    return true;
  }
  if (cached) successCache.delete(key);

  if (matched.kind === "scrypt" && matched.salt && matched.hash) {
    const accepted = await verifyScrypt(bounded, matched.salt, matched.hash, priority);
    if (accepted) rememberSuccess(key, now);
    return accepted;
  }
  await verifyScrypt(bounded, DUMMY_SALT, await dummyHash(priority), priority);
  const accepted = matched.password !== undefined && safeEqual(matched.password, password);
  if (accepted) rememberSuccess(key, now);
  return accepted;
}
