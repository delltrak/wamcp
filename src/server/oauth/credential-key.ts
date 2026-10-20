import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { logger } from "../../utils/logger.js";

const KEY_BYTES = 32;

/** Path of the per-install HMAC key stored next to an OAuth database. */
export function credentialMacKeyPath(dbPath: string): string {
  return join(dirname(dbPath), `${basename(dbPath)}.mac`);
}

/**
 * Load or create the key used to bind tokens to a Basic Auth credential.
 * The file is mode 0600. An in-memory database gets an ephemeral key.
 * Creating a key beside an existing database invalidates sessions that were
 * issued under a missing or different key.
 */
export function loadCredentialMacKey(dbPath: string): Buffer {
  if (dbPath === ":memory:") return randomBytes(KEY_BYTES);
  const path = credentialMacKeyPath(dbPath);
  const key = randomBytes(KEY_BYTES);
  const databaseExisted = existsSync(dbPath);
  try {
    writeFileSync(path, key, { mode: 0o600, flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    return readCredentialMacKey(path);
  }
  chmodSync(path, 0o600);
  if (databaseExisted) {
    logger.warn(
      "OAuth credential key was created beside an existing database; back up oauth.db.mac with oauth.db, because losing the key signs every session out",
    );
  }
  return key;
}

function readCredentialMacKey(path: string): Buffer {
  const key = readFileSync(path);
  if (key.length !== KEY_BYTES) {
    throw new Error("Invalid OAuth credential key; expected 32 bytes");
  }
  chmodSync(path, 0o600);
  return key;
}
