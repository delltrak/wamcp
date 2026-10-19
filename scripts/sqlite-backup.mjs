import { chmod, lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";

const PRIVATE_FILE_MODE = 0o600;
const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"];

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

async function createPrivateFile(filePath) {
  const file = await open(filePath, "wx", PRIVATE_FILE_MODE);
  try {
    await file.chmod(PRIVATE_FILE_MODE);
  } finally {
    await file.close();
  }
}

async function copyFilePrivate(sourcePath, destinationPath) {
  await createPrivateFile(destinationPath);
  try {
    await pipeline(createReadStream(sourcePath), createWriteStream(destinationPath));
    await chmod(destinationPath, PRIVATE_FILE_MODE);
  } finally {
    await chmod(destinationPath, PRIVATE_FILE_MODE).catch(() => {});
  }
}

async function backupConnectionConsistently(source, destinationPath) {
  await createPrivateFile(destinationPath);
  await source.backup(destinationPath);
  await chmod(destinationPath, PRIVATE_FILE_MODE);
  await assertHealthyDatabase(destinationPath);
}

async function copyDatabaseConsistently(sourcePath, destinationPath) {
  const source = new Database(sourcePath, { fileMustExist: true, timeout: 0 });
  try {
    await backupConnectionConsistently(source, destinationPath);
  } finally {
    source.close();
  }
}

function temporaryPath(targetPath) {
  return `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
}

async function cleanTemporaryPath(filePath) {
  await Promise.all(
    [filePath, ...SQLITE_SIDECARS.map((suffix) => `${filePath}${suffix}`)].map((path) =>
      rm(path, { force: true }),
    ),
  );
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function acquireRestoreLock(databasePath) {
  if (!(await pathExists(databasePath))) return null;

  let database;
  try {
    database = new Database(databasePath, { fileMustExist: true, timeout: 0 });
    database.pragma("busy_timeout = 0");
    database.pragma("locking_mode = EXCLUSIVE");
    database.exec("BEGIN EXCLUSIVE");
    // The exclusive locking mode retains the acquired file lock after the transaction ends.
    database.exec("ROLLBACK");
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Keep the lock error as the reported cause.
    }
    throw new Error(
      `Refusing to restore: destination database is in use (${databasePath}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function copyCurrentDatabaseBeforeRestore(databasePath, lock) {
  if (!lock || !(await pathExists(databasePath))) return null;

  const timestamp = new Date().toISOString().replace(/:/g, "-");
  const preRestorePath = `${databasePath}.pre-restore-${timestamp}`;
  const stagedPath = temporaryPath(preRestorePath);
  try {
    await backupConnectionConsistently(lock, stagedPath);
    await rename(stagedPath, preRestorePath);
    await chmod(preRestorePath, PRIVATE_FILE_MODE);
  } finally {
    await cleanTemporaryPath(stagedPath);
  }
  return preRestorePath;
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
    await chmod(backupPath, PRIVATE_FILE_MODE);
  } finally {
    await cleanTemporaryPath(stagedPath);
  }
  return backupPath;
}

export async function restoreSqlite(databasePath, backupDirectory, { force = false } = {}) {
  const destinationPath = resolve(databasePath);
  const directory = resolve(backupDirectory);
  const backupPath = join(directory, `${basename(destinationPath)}.backup`);
  if (destinationPath === backupPath)
    throw new Error("Restore source must differ from the database");

  await stat(backupPath);
  const walPath = `${destinationPath}-wal`;
  if (!force && (await pathExists(walPath))) {
    throw new Error(
      `Refusing to restore: WAL file exists at ${walPath}; stop the process or pass --force to override`,
    );
  }

  const lock = await acquireRestoreLock(destinationPath);
  const stagedPath = temporaryPath(destinationPath);
  let replaced = false;
  try {
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyDatabaseConsistently(backupPath, stagedPath);
    await copyCurrentDatabaseBeforeRestore(destinationPath, lock);
    await rm(walPath, { force: true });
    await rm(`${destinationPath}-shm`, { force: true });
    await rename(stagedPath, destinationPath);
    replaced = true;
    await chmod(destinationPath, PRIVATE_FILE_MODE);
  } finally {
    try {
      await cleanTemporaryPath(stagedPath);
    } finally {
      try {
        if (lock) {
          try {
            if (lock.inTransaction) lock.exec("ROLLBACK");
          } finally {
            lock.close();
          }
        }
      } finally {
        if (replaced) {
          await rm(walPath, { force: true });
          await rm(`${destinationPath}-shm`, { force: true });
        }
      }
    }
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
    const stagedPath = temporaryPath(destinationPath);
    try {
      await copyFilePrivate(sourcePath, stagedPath);
      await rename(stagedPath, destinationPath);
      await chmod(destinationPath, PRIVATE_FILE_MODE);
    } finally {
      await cleanTemporaryPath(stagedPath);
    }
  } else {
    await chmod(destinationPath, PRIVATE_FILE_MODE);
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
      await copyFilePrivate(sourcePath, stagedPath);
      await rename(stagedPath, destinationPath);
      await chmod(destinationPath, PRIVATE_FILE_MODE);
    } finally {
      await cleanTemporaryPath(stagedPath);
    }
  } else {
    await chmod(destinationPath, PRIVATE_FILE_MODE);
  }
  return destinationPath;
}

export async function backup(databasePath, backupDirectory, environmentPath = ".env") {
  const sqlitePath = await backupSqlite(databasePath, backupDirectory);
  const configPath = await backupEnvironmentFile(environmentPath, backupDirectory);
  return { sqlitePath, configPath };
}

export async function restore(
  databasePath,
  backupDirectory,
  environmentPath = join(dirname(resolve(databasePath)), ".env"),
  force = false,
) {
  const sqlitePath = await restoreSqlite(databasePath, backupDirectory, { force });
  const configPath = await restoreEnvironmentFile(environmentPath, backupDirectory);
  return { sqlitePath, configPath };
}

async function run() {
  const [mode, ...rawArguments] = process.argv.slice(2);
  if (mode !== "backup" && mode !== "restore") {
    throw new Error(
      "Usage: sqlite-backup.mjs <backup|restore> [database-path] [backup-dir] [env-file] [--force]",
    );
  }

  const force = rawArguments.includes("--force");
  if (force && mode !== "restore") throw new Error("--force is only supported by restore");
  const arguments_ = rawArguments.filter((argument) => argument !== "--force");
  if (arguments_.length > 3 || arguments_.some((argument) => argument.startsWith("--"))) {
    throw new Error(
      "Usage: sqlite-backup.mjs <backup|restore> [database-path] [backup-dir] [env-file] [--force]",
    );
  }

  const databasePath = resolve(arguments_[0] || process.env.WA_DATABASE_PATH || "data/whatsapp.db");
  const backupDirectory = resolve(
    arguments_[1] || process.env.WA_BACKUP_DIR || dirname(databasePath),
  );
  const defaultEnvironmentPath = mode === "restore" ? join(dirname(databasePath), ".env") : ".env";
  const environmentPath = arguments_[2] || process.env.WA_ENV_FILE || defaultEnvironmentPath;
  const result =
    mode === "backup"
      ? await backup(databasePath, backupDirectory, environmentPath)
      : await restore(databasePath, backupDirectory, environmentPath, force);

  process.stdout.write(`${mode} completed: ${result.sqlitePath}\n`);
  if (result.configPath) process.stdout.write(`configuration file: ${result.configPath}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
