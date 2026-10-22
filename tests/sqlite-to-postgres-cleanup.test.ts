import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";

import { migrateSqliteToPostgres } from "../src/db/sqlite-to-postgres.js";

function snapshots(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("wamcp-pg-migrate-"))
    .sort();
}

describe("SQLite copy snapshot cleanup", () => {
  it("removes the temporary auth snapshot when Postgres cannot connect", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wamcp-copy-cleanup-"));
    const sqlitePath = join(directory, "source.db");
    const source = new Database(sqlitePath);
    source.exec(
      "CREATE TABLE auth_keys (key_data TEXT); INSERT INTO auth_keys VALUES ('fixture');",
    );
    source.close();
    const before = snapshots();
    vi.spyOn(Client.prototype, "connect").mockImplementationOnce(async () => {
      throw new Error("test connection refused");
    });
    const end = vi.spyOn(Client.prototype, "end");
    try {
      await expect(
        migrateSqliteToPostgres({ sqlitePath, databaseUrl: "postgres://unused/test" }),
      ).rejects.toThrow("test connection refused");
      expect(end).toHaveBeenCalledOnce();
      expect(snapshots()).toEqual(before);
    } finally {
      vi.restoreAllMocks();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes the temporary directory when the SQLite source does not exist", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wamcp-copy-missing-"));
    const before = snapshots();
    try {
      await expect(
        migrateSqliteToPostgres({
          sqlitePath: join(directory, "missing.db"),
          databaseUrl: "postgres://unused/test",
        }),
      ).rejects.toThrow();
      expect(snapshots()).toEqual(before);
    } finally {
      vi.restoreAllMocks();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
