import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { POSTGRES_BASELINE_MIGRATION_ID, applySchemaSql } from "../src/db/schema-sql.js";
import {
  replaceScalarMax,
  replaceSqlitePlaceholders,
  splitSqlStatements,
  sqliteDdlToPostgres,
  toPostgresQuery,
} from "../src/db/sql-compat.js";

describe("SQL compatibility", () => {
  it("numbers placeholders outside string literals", () => {
    expect(replaceSqlitePlaceholders("select '?' where id = ? and name = ?")).toBe(
      "select '?' where id = $1 and name = $2",
    );
  });

  it("rewrites scalar MAX and keeps aggregate MAX", () => {
    const sql = `MAX("message_receipts"."timestamp", excluded.timestamp), MAX(candidate_at)`;
    expect(replaceScalarMax(sql)).toBe(
      `GREATEST("message_receipts"."timestamp", excluded.timestamp), MAX(candidate_at)`,
    );
  });

  it("widens SQLite INTEGER columns to BIGINT", () => {
    expect(sqliteDdlToPostgres("created_at INTEGER NOT NULL, note TEXT DEFAULT 'INTEGER'")).toBe(
      "created_at BIGINT NOT NULL, note TEXT DEFAULT 'INTEGER'",
    );
  });

  it("splits statements without breaking quoted semicolons", () => {
    expect(splitSqlStatements("select 'a;b'; select 1;")).toEqual(["select 'a;b'", "select 1"]);
  });

  it("maps SQLite rowid to Postgres ctid outside string literals", () => {
    expect(toPostgresQuery("SELECT type FROM messages ORDER BY rowid, 'rowid'")).toBe(
      "SELECT type FROM messages ORDER BY ctid, 'rowid'",
    );
  });

  it("prepares a drizzle-style upsert for Postgres", () => {
    expect(
      toPostgresQuery(
        `insert into "messages" ("id") values (?) on conflict ("messages"."instance_id", "messages"."id") do update set "timestamp" = MAX("messages"."timestamp", excluded.timestamp)`,
      ),
    ).toBe(
      `insert into "messages" ("id") values ($1) on conflict ("instance_id", "id") do update set "timestamp" = GREATEST("messages"."timestamp", excluded.timestamp)`,
    );
  });
});

describe("SQLite schema initialization", () => {
  it("creates the application tables and does not add a Postgres migration journal", () => {
    const database = new Database(":memory:");
    applySchemaSql((sql) => {
      database.exec(sql);
    }, "sqlite");
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((table) => table.name);
    expect(names).toContain("instances");
    expect(names).toContain("auth_keys");
    expect(names).toContain("messages");
    expect(names).not.toContain("schema_migrations");
    const contacts = database.prepare("PRAGMA table_info(contacts)").all() as Array<{
      name: string;
    }>;
    expect(contacts.map((column) => column.name)).toContain("lid");
    expect(POSTGRES_BASELINE_MIGRATION_ID).toBe("0001_baseline");
    database.close();
  });
});
