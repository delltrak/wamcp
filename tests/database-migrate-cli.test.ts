import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

describe("SQLite migration CLI", () => {
  it("migrates WA_DATABASE_PATH instead of the default database", () => {
    const directory = mkdtempSync(join(tmpdir(), "wamcp-cli-path-"));
    const path = join(directory, "nested", "custom.db");
    try {
      const result = spawnSync(
        process.execPath,
        ["./node_modules/tsx/dist/cli.mjs", "src/db/migrate-cli.ts"],
        {
          env: { ...process.env, WA_DATABASE_URL: "", WA_DATABASE_PATH: path },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const database = new Database(path, { readonly: true, fileMustExist: true });
      try {
        const names = database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[];
        expect(names.map((row) => row.name)).toEqual(
          expect.arrayContaining(["instances", "auth_keys", "__drizzle_migrations"]),
        );
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
