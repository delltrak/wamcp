import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { backup, restore } from "../scripts/sqlite-backup.mjs";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "wamcp-history-backup-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite backup and restore", () => {
  it("backs up a live WAL database and restores it with its environment file", async () => {
    const directory = createTemporaryDirectory();
    const backupDirectory = join(directory, "backup");
    const databasePath = join(directory, "whatsapp.db");
    const environmentPath = join(directory, ".env");

    const database = new Database(databasePath);
    database.pragma("journal_mode = WAL");
    database.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT NOT NULL)");
    database.prepare("INSERT INTO messages VALUES (?, ?)").run("sample-1", "before backup");
    writeFileSync(environmentPath, "WA_TRANSPORT=http\n");

    const backupResult = await backup(databasePath, backupDirectory, environmentPath);
    database
      .prepare("UPDATE messages SET content = ? WHERE id = ?")
      .run("after backup", "sample-1");
    database.close();

    const environmentRestorePath = join(directory, "restored", ".env");
    const restoredDatabasePath = join(directory, "restored", "whatsapp.db");
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

    expect(backupResult.sqlitePath).toBe(join(backupDirectory, "whatsapp.db.backup"));
    expect(restoreResult.sqlitePath).toBe(restoredDatabasePath);
    expect(restoreResult.configPath).toBe(environmentRestorePath);
    expect(readFileSync(environmentRestorePath, "utf8")).toBe("WA_TRANSPORT=http\n");
  });
});
