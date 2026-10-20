import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { POSTGRES_BASELINE_MIGRATION_ID, applySchemaSql } from "../src/db/schema-sql.js";
import {
  bindParameters,
  isIdempotentRead,
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

  it("keeps ? inside comments, dollar quotes, and jsonb operators", () => {
    expect(bindParameters("select /* ? */ $tag$?$tag$ || $$?$$ where id = ?", [7])).toEqual({
      sql: "select /* ? */ $tag$?$tag$ || $$?$$ where id = $1",
      values: [7],
    });
    expect(bindParameters("select data ? 'a' and data ?| array['b'] and id = ?", [3])).toEqual({
      sql: "select data ? 'a' and data ?| array['b'] and id = $1",
      values: [3],
    });
    expect(
      bindParameters('select "id" from "t" where "id" in (?, ?) order by "id" desc limit ?', [
        "a",
        "b",
        10,
      ]),
    ).toEqual({
      sql: 'select "id" from "t" where "id" in ($1, $2) order by "id" desc limit $3',
      values: ["a", "b", 10],
    });
  });

  it("does not treat a Postgres cast as a named parameter", () => {
    expect(bindParameters("select ?::bigint", [1])).toEqual({
      sql: "select $1::bigint",
      values: [1],
    });
    expect(bindParameters("select id::bigint from t where id = :id", [{ id: 4 }])).toEqual({
      sql: "select id::bigint from t where id = $1",
      values: [4],
    });
  });

  it("retries only read statements", () => {
    expect(isIdempotentRead("/* note */ select 1")).toBe(true);
    expect(isIdempotentRead("WITH rows AS (SELECT 1) INSERT INTO t SELECT * FROM rows")).toBe(
      false,
    );
    expect(isIdempotentRead("insert into t (id) values (?)")).toBe(false);
    expect(isIdempotentRead("UPDATE t SET id = 1")).toBe(false);
  });

  it("binds named parameters from one object", () => {
    expect(
      bindParameters("select * from t where id = @id and name = :name", [
        { id: "a", "@name": "b" },
      ]),
    ).toEqual({
      sql: "select * from t where id = $1 and name = $2",
      values: ["a", "b"],
    });
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
  it("creates the application tables and does not add a Postgres migration journal", async () => {
    const database = new Database(":memory:");
    await applySchemaSql((sql) => {
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
