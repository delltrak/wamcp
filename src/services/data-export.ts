// ============================================================
// WA MCP — Files saved under the instance data directory
// ============================================================

import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { sanitizeMediaFileName, type SavedMediaDownload } from "./media.js";

const DEFAULT_DATABASE_PATH = "data/whatsapp.db";

/** Directory that holds the SQLite database. Existing database files stay where they are. */
export function dataDirectory(): string {
  return dirname(resolve(process.env.WA_DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH));
}

/**
 * Write an export under `<data directory>/exports`.
 * The database path itself is unchanged; only this new subdirectory is created on demand.
 */
export async function saveDataDirectoryFile(
  data: Buffer,
  fileName: string,
): Promise<SavedMediaDownload> {
  const requestedDirectory = resolve(dataDirectory(), "exports");
  await mkdir(requestedDirectory, { recursive: true });
  const directory = await realpath(requestedDirectory);
  const safeFileName = sanitizeMediaFileName(fileName);
  const filePath = resolve(directory, `${randomUUID()}-${safeFileName}`);
  assertPathInsideDirectory(directory, filePath);
  await writeFile(filePath, data, { flag: "wx", mode: 0o600 });
  return { path: filePath, fileName: safeFileName, size: data.length };
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
