import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

async function assertHealthyDatabase(databasePath) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const result = database.pragma("integrity_check", { simple: true });
    if (result !== "ok") {
      throw new Error(`SQLite integrity check failed for ${databasePath}`);
    }
  } finally {
    database.close();
  }
}

async function copyDatabaseConsistently(sourcePath, destinationPath) {
  const source = new Database(sourcePath, { fileMustExist: true });
  try {
    await source.backup(destinationPath);
  } finally {
    source.close();
  }
  await assertHealthyDatabase(destinationPath);
}

function temporaryPath(targetPath) {
  return `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
}

export async function backupSqlite(databasePath, backupDirectory) {
  const sourcePath = resolve(databasePath);
  const directory = resolve(backupDirectory);
  const backupPath = join(directory, `${basename(sourcePath)}.backup`);
  if (sourcePath === backupPath)
    throw new Error("Backup destination must differ from the database");

  await stat(sourcePath);
  await mkdir(directory, { recursive: true });
  const stagedPath = temporaryPath(backupPath);
  try {
    await copyDatabaseConsistently(sourcePath, stagedPath);
    await rename(stagedPath, backupPath);
  } finally {
    await rm(stagedPath, { force: true });
  }
  return backupPath;
}

export async function restoreSqlite(databasePath, backupDirectory) {
  const destinationPath = resolve(databasePath);
  const directory = resolve(backupDirectory);
  const backupPath = join(directory, `${basename(destinationPath)}.backup`);
  if (destinationPath === backupPath)
    throw new Error("Restore source must differ from the database");

  await stat(backupPath);
  await mkdir(dirname(destinationPath), { recursive: true });
  const stagedPath = temporaryPath(destinationPath);
  try {
    await copyDatabaseConsistently(backupPath, stagedPath);
    await rename(stagedPath, destinationPath);
    await rm(`${destinationPath}-wal`, { force: true });
    await rm(`${destinationPath}-shm`, { force: true });
  } finally {
    await rm(stagedPath, { force: true });
  }
  return destinationPath;
}

async function backupEnvironmentFile(environmentPath, backupDirectory) {
  if (!environmentPath) return null;
  const sourcePath = resolve(environmentPath);
  try {
    await stat(sourcePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const destinationPath = join(resolve(backupDirectory), basename(sourcePath));
  if (sourcePath !== destinationPath) {
    await copyFile(sourcePath, destinationPath);
  }
  return destinationPath;
}

async function restoreEnvironmentFile(environmentPath, backupDirectory) {
  if (!environmentPath) return null;
  const destinationPath = resolve(environmentPath);
  const sourcePath = join(resolve(backupDirectory), basename(destinationPath));
  try {
    await stat(sourcePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  await mkdir(dirname(destinationPath), { recursive: true });
  if (sourcePath !== destinationPath) {
    const stagedPath = temporaryPath(destinationPath);
    try {
      await copyFile(sourcePath, stagedPath);
      await rename(stagedPath, destinationPath);
    } finally {
      await rm(stagedPath, { force: true });
    }
  }
  return destinationPath;
}

export async function backup(databasePath, backupDirectory, environmentPath = ".env") {
  const sqlitePath = await backupSqlite(databasePath, backupDirectory);
  const configPath = await backupEnvironmentFile(environmentPath, backupDirectory);
  return { sqlitePath, configPath };
}

export async function restore(databasePath, backupDirectory, environmentPath = ".env") {
  const sqlitePath = await restoreSqlite(databasePath, backupDirectory);
  const configPath = await restoreEnvironmentFile(environmentPath, backupDirectory);
  return { sqlitePath, configPath };
}

async function run() {
  const [mode, ...arguments_] = process.argv.slice(2);
  if (mode !== "backup" && mode !== "restore") {
    throw new Error(
      "Usage: sqlite-backup.mjs <backup|restore> [database-path] [backup-dir] [env-file]",
    );
  }

  const databasePath = resolve(arguments_[0] || process.env.WA_DATABASE_PATH || "data/whatsapp.db");
  const backupDirectory = resolve(
    arguments_[1] || process.env.WA_BACKUP_DIR || dirname(databasePath),
  );
  const environmentPath = arguments_[2] || process.env.WA_ENV_FILE || ".env";
  const result =
    mode === "backup"
      ? await backup(databasePath, backupDirectory, environmentPath)
      : await restore(databasePath, backupDirectory, environmentPath);

  process.stdout.write(`${mode} completed: ${result.sqlitePath}\n`);
  if (result.configPath) process.stdout.write(`configuration file: ${result.configPath}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
