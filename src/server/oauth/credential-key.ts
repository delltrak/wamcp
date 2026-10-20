import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const KEY_BYTES = 32;

/** Path of the per-install HMAC key stored next to an OAuth database. */
export function credentialMacKeyPath(dbPath: string): string {
  return join(dirname(dbPath), `${basename(dbPath)}.mac`);
}

/**
 * Load or create the key used to bind tokens to a Basic Auth credential.
 * The file is mode 0600. An in-memory database gets an ephemeral key.
 */
export function loadCredentialMacKey(dbPath: string): Buffer {
  if (dbPath === ":memory:") return randomBytes(KEY_BYTES);
  const path = credentialMacKeyPath(dbPath);
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.length !== KEY_BYTES) {
      throw new Error("Invalid OAuth credential key; expected 32 bytes");
    }
    chmodSync(path, 0o600);
    return key;
  }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(path, key, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}
