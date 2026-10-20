import { createHash, scryptSync, timingSafeEqual } from "node:crypto";

export const BASIC_AUTH_SCRYPT = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
  keylen: 32,
} as const;

const USERNAME_PATTERN = /^[A-Za-z0-9._~@+-]{1,128}$/;
const DUMMY_SALT = Buffer.from("0123456789abcdef");
const DUMMY_HASH = scryptSync("wamcp-basic-auth-dummy", DUMMY_SALT, BASIC_AUTH_SCRYPT.keylen, {
  N: BASIC_AUTH_SCRYPT.N,
  r: BASIC_AUTH_SCRYPT.r,
  p: BASIC_AUTH_SCRYPT.p,
  maxmem: BASIC_AUTH_SCRYPT.maxmem,
});

export interface BasicAuthUser {
  username: string;
  kind: "plain" | "scrypt";
  password?: string;
  salt?: Buffer;
  hash?: Buffer;
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

function verifyScrypt(password: string, salt: Buffer, expected: Buffer): boolean {
  const actual = scryptSync(password, salt, expected.length, {
    N: BASIC_AUTH_SCRYPT.N,
    r: BASIC_AUTH_SCRYPT.r,
    p: BASIC_AUTH_SCRYPT.p,
    maxmem: BASIC_AUTH_SCRYPT.maxmem,
  });
  return timingSafeEqual(actual, expected);
}

export function verifyBasicCredentials(
  users: readonly BasicAuthUser[],
  username: string,
  password: string,
): boolean {
  const bounded = password.length > 0 && password.length <= 256 ? password : "invalid-password";
  let matched: BasicAuthUser | undefined;
  for (const candidate of users) {
    if (safeEqual(candidate.username, username)) matched = candidate;
  }

  const scryptMatch =
    matched?.kind === "scrypt" && matched.salt && matched.hash
      ? verifyScrypt(bounded, matched.salt, matched.hash)
      : verifyScrypt(bounded, DUMMY_SALT, DUMMY_HASH);
  if (!matched || password.length < 1 || password.length > 256) return false;
  if (matched.kind === "scrypt") return scryptMatch;
  return matched.password !== undefined && safeEqual(matched.password, password);
}
