// ============================================================
// WA MCP — Files saved under the instance data directory
// ============================================================

import { chmod, lstat, mkdir, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { sanitizeMediaFileName, type SavedMediaDownload } from "./media.js";
import { createChildLogger } from "../utils/logger.js";

const DEFAULT_DATABASE_PATH = "data/whatsapp.db";
/** Drop export files older than this the next time an export is written. */
export const EXPORT_RETENTION_MS = 24 * 60 * 60 * 1000;

const log = createChildLogger({ service: "data-export" });

/** Directory that holds the SQLite database. Existing database files stay where they are. */
export function dataDirectory(): string {
  return dirname(resolve(process.env.WA_DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH));
}

/**
 * Write an export under `<data directory>/exports`.
 * The database path itself is unchanged; only this new subdirectory is created on demand.
 * The directory is mode 0700. Regular files older than {@link EXPORT_RETENTION_MS} are removed
 * before the new file is written.
 */
export async function saveDataDirectoryFile(
  data: Buffer,
  fileName: string,
): Promise<SavedMediaDownload> {
  const requestedDirectory = resolve(dataDirectory(), "exports");
  await mkdir(requestedDirectory, { recursive: true });
  // Refuse a pre-existing link before chmod or retention can touch an outside directory.
  if ((await lstat(requestedDirectory)).isSymbolicLink()) {
    throw new Error("Export directory must not be a symbolic link");
  }
  await chmod(requestedDirectory, 0o700);
  const directory = await realpath(requestedDirectory);
  await removeExpiredExports(directory);
  const safeFileName = sanitizeMediaFileName(fileName);
  const filePath = resolve(directory, `${randomUUID()}-${safeFileName}`);
  assertPathInsideDirectory(directory, filePath);
  await writeFile(filePath, data, { flag: "wx", mode: 0o600 });
  return { path: filePath, fileName: safeFileName, size: data.length };
}

async function removeExpiredExports(directory: string): Promise<void> {
  const cutoff = Date.now() - EXPORT_RETENTION_MS;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    log.warn({ err: error }, "Could not list export files for retention");
    return;
  }

  await Promise.all(
    names.map(async (name) => {
      const filePath = resolve(directory, name);
      try {
        assertPathInsideDirectory(directory, filePath);
        const info = await lstat(filePath);
        if (!info.isFile() || info.mtimeMs >= cutoff) return;
        await unlink(filePath);
      } catch (error) {
        log.warn({ err: error, fileName: name }, "Could not remove an expired export");
      }
    }),
  );
}

function assertPathInsideDirectory(directory: string, filePath: string): void {
  const pathFromDirectory = relative(directory, filePath);
  if (
    !pathFromDirectory ||
    pathFromDirectory.startsWith(`..${sep}`) ||
    pathFromDirectory === ".." ||
    isAbsolute(pathFromDirectory)
  ) {
    throw new Error("Export path must stay inside the data directory");
  }
}
