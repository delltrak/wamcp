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
}

interface SuccessCacheEntry {
  expiresAt: number;
}

const DEFAULT_SCRYPT_LIMIT = 2;

const successCache = new Map<string, SuccessCacheEntry>();
let scryptOperations = 0;
let scryptInFlight = 0;
let scryptLimit = DEFAULT_SCRYPT_LIMIT;
let dummyHashPromise: Promise<Buffer> | undefined;

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

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  if (scryptInFlight >= scryptLimit) throw new ScryptBusyError();
  scryptInFlight += 1;
  scryptOperations += 1;
  return new Promise((resolve, reject) => {
    scrypt(password, salt, BASIC_AUTH_SCRYPT.keylen, SCRYPT_OPTIONS, (error, derived) => {
      scryptInFlight -= 1;
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

function dummyHash(): Promise<Buffer> {
  dummyHashPromise ??= deriveKey("wamcp-basic-auth-dummy", DUMMY_SALT);
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

async function verifyScrypt(password: string, salt: Buffer, expected: Buffer): Promise<boolean> {
  const actual = await deriveKey(password, salt);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function verifyBasicCredentials(
  users: readonly BasicAuthUser[],
  username: string,
  password: string,
  options?: VerifyBasicOptions,
): Promise<boolean> {
  const now = options?.now ?? Date.now();
  const bounded = password.length > 0 && password.length <= 256 ? password : "invalid-password";
  const matched = findBasicUser(users, username);
  if (!matched || password.length < 1 || password.length > 256) {
    await verifyScrypt(bounded, DUMMY_SALT, await dummyHash());
    return false;
  }

  const key = successCacheKey(username, bounded, verifierCacheId(matched));
  const cached = successCache.get(key);
  if (cached && cached.expiresAt > now) {
    rememberSuccess(key, cached.expiresAt - SUCCESS_CACHE_TTL_MS);
    return true;
  }
  if (cached) successCache.delete(key);

  if (matched.kind === "scrypt" && matched.salt && matched.hash) {
    const accepted = await verifyScrypt(bounded, matched.salt, matched.hash);
    if (accepted) rememberSuccess(key, now);
    return accepted;
  }
  await verifyScrypt(bounded, DUMMY_SALT, await dummyHash());
  const accepted = matched.password !== undefined && safeEqual(matched.password, password);
  if (accepted) rememberSuccess(key, now);
  return accepted;
}
