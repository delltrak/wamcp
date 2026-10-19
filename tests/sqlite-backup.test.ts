import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { backup, backupSqlite, restore } from "../scripts/sqlite-backup.mjs";

const temporaryDirectories: string[] = [];
const sqliteBackupScript = fileURLToPath(new URL("../scripts/sqlite-backup.mjs", import.meta.url));

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "wamcp-history-backup-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createDatabase(databasePath: string, value: string): void {
  const database = new Database(databasePath);
  database.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT NOT NULL)");
  database.prepare("INSERT INTO messages VALUES (?, ?)").run("sample-1", value);
  database.close();
}

function fileMode(filePath: string): number {
  return statSync(filePath).mode & 0o777;
}

function temporaryArtifacts(directory: string): string[] {
  const artifacts: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) artifacts.push(...temporaryArtifacts(entryPath));
    else if (/\.tmp-\d+-[0-9a-f-]+(?:-(?:wal|shm|journal))?$/.test(entry.name)) {
      artifacts.push(entryPath);
    }
  }
  return artifacts;
}

function runRestore(
  databasePath: string,
  backupDirectory: string,
  environmentPath: string,
  force = false,
  workingDirectory = join(databasePath, ".."),
) {
  return spawnSync(
    process.execPath,
    [
      sqliteBackupScript,
      "restore",
      databasePath,
      backupDirectory,
      environmentPath,
      ...(force ? ["--force"] : []),
    ],
    { cwd: workingDirectory, encoding: "utf8" },
  );
}

async function startDatabaseHolder(databasePath: string, holdWriteTransaction: boolean) {
  const script = `
    import Database from "better-sqlite3";
    const db = new Database(process.argv[1], { timeout: 0 });
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, content TEXT NOT NULL)");
    db.prepare("INSERT OR REPLACE INTO messages VALUES (?, ?)").run("sample-1", "committed before lock");
    if (${holdWriteTransaction ? "true" : "false"}) {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE messages SET content = ? WHERE id = ?").run("uncommitted", "sample-1");
    }
    process.stdout.write("READY\\n");
    process.stdin.resume();
    process.stdin.once("data", () => {
      if (db.inTransaction) db.exec("ROLLBACK");
      db.close();
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, databasePath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdout = "";
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("READY\n")) resolve();
    });
    child.stderr.on("data", (chunk: string) => reject(new Error(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Database holder exited with ${code}`));
    });
  });
  return child;
}

async function stopDatabaseHolder(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end("stop\n");
  await new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Database holder exited with ${code}`));
    });
    child.once("error", reject);
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite backup and restore", () => {
  it("backs up a live WAL database and restores it with private files and a pre-restore copy", async () => {
    const directory = createTemporaryDirectory();
    const backupDirectory = join(directory, "backup");
    const databasePath = join(directory, "whatsapp.db");
    const environmentPath = join(directory, ".env");

    const database = new Database(databasePath);
    database.pragma("journal_mode = WAL");
    database.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT NOT NULL)");
    database.prepare("INSERT INTO messages VALUES (?, ?)").run("sample-1", "before backup");
    writeFileSync(environmentPath, "WA_TRANSPORT=http\n", { mode: 0o600 });

    const backupResult = await backup(databasePath, backupDirectory, environmentPath);
    database
      .prepare("UPDATE messages SET content = ? WHERE id = ?")
      .run("after backup", "sample-1");
    database.close();

    const environmentRestorePath = join(directory, "restored", ".env");
    const restoredDatabasePath = join(directory, "restored", "whatsapp.db");
    mkdirSync(join(directory, "restored"), { recursive: true });
    createDatabase(restoredDatabasePath, "old destination");
    const restoreResult = await restore(
      restoredDatabasePath,
      backupDirectory,
      environmentRestorePath,
    );

    const restored = new Database(restoredDatabasePath, { readonly: true });
    expect(restored.prepare("SELECT content FROM messages WHERE id = ?").get("sample-1")).toEqual({
      content: "before backup",
    });
    expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
    restored.close();

    const preRestorePath = readdirSync(join(directory, "restored"))
      .map((name) => join(directory, "restored", name))
      .find((path) => path.includes(".pre-restore-"));
    expect(preRestorePath).toBeDefined();
    const preRestore = new Database(preRestorePath!, { readonly: true });
    expect(preRestore.prepare("SELECT content FROM messages WHERE id = ?").get("sample-1")).toEqual(
      { content: "old destination" },
    );
    preRestore.close();

    expect(backupResult.sqlitePath).toBe(join(backupDirectory, "whatsapp.db.backup"));
    expect(restoreResult.sqlitePath).toBe(restoredDatabasePath);
    expect(restoreResult.configPath).toBe(environmentRestorePath);
    expect(readFileSync(environmentRestorePath, "utf8")).toBe("WA_TRANSPORT=http\n");
    expect(fileMode(backupResult.sqlitePath)).toBe(0o600);
    expect(fileMode(join(backupDirectory, ".env"))).toBe(0o600);
    expect(fileMode(preRestorePath!)).toBe(0o600);
    expect(fileMode(restoredDatabasePath)).toBe(0o600);
    expect(fileMode(environmentRestorePath)).toBe(0o600);
    expect(temporaryArtifacts(directory)).toEqual([]);
  });

  it("refuses a WAL file without --force and leaves the database and sidecars untouched", async () => {
    const directory = createTemporaryDirectory();
    const backupDirectory = join(directory, "backup");
    const databasePath = join(directory, "whatsapp.db");
    createDatabase(databasePath, "original");
    await backupSqlite(databasePath, backupDirectory);

    const holder = await startDatabaseHolder(databasePath, false);
    try {
      const databaseBefore = readFileSync(databasePath);
      const walBefore = readFileSync(`${databasePath}-wal`);
      const shmBefore = readFileSync(`${databasePath}-shm`);
      const result = runRestore(
        databasePath,
        backupDirectory,
        join(directory, "restored.env"),
        false,
        directory,
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("WAL file exists");
      expect(readFileSync(databasePath)).toEqual(databaseBefore);
      expect(readFileSync(`${databasePath}-wal`)).toEqual(walBefore);
      expect(readFileSync(`${databasePath}-shm`)).toEqual(shmBefore);
      expect(temporaryArtifacts(directory)).toEqual([]);
    } finally {
      await stopDatabaseHolder(holder);
    }
  });

  it("refuses a locked WAL database even with --force and preserves its files", async () => {
    const directory = createTemporaryDirectory();
    const backupDirectory = join(directory, "backup");
    const databasePath = join(directory, "whatsapp.db");
    createDatabase(databasePath, "original");
    await backupSqlite(databasePath, backupDirectory);

    const holder = await startDatabaseHolder(databasePath, true);
    try {
      const databaseBefore = readFileSync(databasePath);
      const walBefore = readFileSync(`${databasePath}-wal`);
      const shmBefore = readFileSync(`${databasePath}-shm`);
      const result = runRestore(
        databasePath,
        backupDirectory,
        join(directory, "restored.env"),
        true,
        directory,
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("destination database is in use");
      expect(readFileSync(databasePath)).toEqual(databaseBefore);
      expect(readFileSync(`${databasePath}-wal`)).toEqual(walBefore);
      expect(readFileSync(`${databasePath}-shm`)).toEqual(shmBefore);
      expect(temporaryArtifacts(directory)).toEqual([]);
    } finally {
      await stopDatabaseHolder(holder);
    }
  });

  it("allows --force with a WAL sidecar, removes old sidecars before installing the backup", async () => {
    const directory = createTemporaryDirectory();
    const backupDirectory = join(directory, "backup");
    const databasePath = join(directory, "whatsapp.db");
    createDatabase(databasePath, "old contents");
    await backupSqlite(databasePath, backupDirectory);
    writeFileSync(`${databasePath}-wal`, "stale WAL marker");
    writeFileSync(`${databasePath}-shm`, "stale SHM marker");

    const result = runRestore(
      databasePath,
      backupDirectory,
      join(directory, "restored.env"),
      true,
      directory,
    );

    expect(result.status).toBe(0);
    expect(existsSync(`${databasePath}-wal`)).toBe(false);
    expect(existsSync(`${databasePath}-shm`)).toBe(false);
    const restored = new Database(databasePath, { readonly: true });
    expect(restored.prepare("SELECT content FROM messages WHERE id = ?").get("sample-1")).toEqual({
      content: "old contents",
    });
    restored.close();
    expect(fileMode(databasePath)).toBe(0o600);
    expect(temporaryArtifacts(directory)).toEqual([]);
  });

  it("cleans staged files after failed backup and restore operations", async () => {
    const directory = createTemporaryDirectory();
    const backupDirectory = join(directory, "backup");
    const badDatabasePath = join(directory, "bad.db");
    const targetPath = join(directory, "whatsapp.db");
    writeFileSync(badDatabasePath, "not a SQLite database");
    await expect(backupSqlite(badDatabasePath, backupDirectory)).rejects.toThrow();
    expect(temporaryArtifacts(directory)).toEqual([]);

    createDatabase(targetPath, "unchanged");
    writeFileSync(join(backupDirectory, "whatsapp.db.backup"), "not a SQLite database");
    const result = runRestore(
      targetPath,
      backupDirectory,
      join(directory, "restored.env"),
      false,
      directory,
    );
    expect(result.status).not.toBe(0);
    expect(temporaryArtifacts(directory)).toEqual([]);
  });

  it("uses the database directory for the default restore environment path", async () => {
    const directory = createTemporaryDirectory();
    const databaseDirectory = join(directory, "data");
    const backupDirectory = join(directory, "backup");
    const databasePath = join(databaseDirectory, "whatsapp.db");
    const environmentPath = join(directory, ".env");
    mkdirSync(databaseDirectory, { recursive: true });
    createDatabase(databasePath, "saved");
    writeFileSync(environmentPath, "WA_TRANSPORT=http\n", { mode: 0o600 });
    await backup(databasePath, backupDirectory, environmentPath);

    const noEnvironmentArgument = runRestore(databasePath, backupDirectory, "", false, directory);

    expect(noEnvironmentArgument.status).toBe(0);
    expect(existsSync(join(databaseDirectory, ".env"))).toBe(true);
    expect(existsSync(join(directory, ".env"))).toBe(true);
    expect(fileMode(join(databaseDirectory, ".env"))).toBe(0o600);
    expect(temporaryArtifacts(directory)).toEqual([]);
  });
});
