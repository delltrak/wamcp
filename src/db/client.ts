// ============================================================
// WA MCP — Database Client
// SQLite at WA_DATABASE_PATH unless WA_DATABASE_URL is set.
// ============================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { createChildLogger } from "../utils/logger.js";
import { createAsyncDatabase, type AppDatabase, type RunResult } from "./async-session.js";
import { resolveDatabaseConfig } from "./config.js";
import {
  PostgresExecutor,
  SqliteExecutor,
  type SqlExecutor,
  type SqlQueryResult,
} from "./executor.js";
import * as schema from "./schema.js";
import { applySchemaSql } from "./schema-sql.js";

const databaseConfig = resolveDatabaseConfig();
const log = createChildLogger({ service: "database" });

function openSqlite(path: string): Database.Database {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  return database;
}

const executor: SqlExecutor =
  databaseConfig.driver === "sqlite"
    ? new SqliteExecutor(openSqlite(databaseConfig.path))
    : new PostgresExecutor(databaseConfig.url);

export interface SqlStatement {
  all(...params: unknown[]): Promise<Record<string, unknown>[]>;
  get(...params: unknown[]): Promise<Record<string, unknown> | undefined>;
  run(...params: unknown[]): Promise<RunResult>;
}

export interface SqlTransaction {
  (): Promise<unknown>;
  deferred: SqlTransaction;
  immediate: SqlTransaction;
  exclusive: SqlTransaction;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  transaction(fn: () => unknown): SqlTransaction;
}

export const sqlite: SqlDatabase = {
  prepare(sql: string): SqlStatement {
    return {
      async all(...params: unknown[]) {
        return rowsAsObjects(await executor.query(sql, params));
      },
      async get(...params: unknown[]) {
        return rowsAsObjects(await executor.query(sql, params))[0];
      },
      async run(...params: unknown[]) {
        const result = await executor.query(sql, params);
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
      },
    };
  },
  exec(sql: string) {
    return executor.exec(sql);
  },
  close() {
    return executor.close();
  },
  transaction(fn: () => unknown): SqlTransaction {
    const run = (() => executor.transaction(async () => fn())) as SqlTransaction;
    run.deferred = run;
    run.immediate = run;
    run.exclusive = run;
    return run;
  },
};

export const db: AppDatabase<typeof schema> = createAsyncDatabase(executor, schema);

await applySchemaSql((sql) => executor.exec(sql), databaseConfig.driver);

if (databaseConfig.driver === "postgres") {
  log.info({ driver: "postgres" }, "Postgres storage enabled");
}

let databaseClosed = false;

/** Closes the process-wide connection. Used by tests and shutdown. */
export async function closeDatabase(): Promise<void> {
  if (databaseClosed) return;
  databaseClosed = true;
  await executor.close();
}

export const databaseDriver = databaseConfig.driver;

function rowsAsObjects(result: SqlQueryResult): Record<string, unknown>[] {
  return result.values.map((row) => {
    const object: Record<string, unknown> = {};
    result.columns.forEach((column, index) => {
      object[column] = row[index];
    });
    return object;
  });
}
