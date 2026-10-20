// ============================================================
// WA MCP — Database Client
// SQLite at WA_DATABASE_PATH unless WA_DATABASE_URL is set.
// ============================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createChildLogger } from "../utils/logger.js";
import { resolveDatabaseConfig } from "./config.js";
import { PostgresSyncDatabase } from "./postgres-sync.js";
import * as schema from "./schema.js";
import { applySchemaSql } from "./schema-sql.js";

const databaseConfig = resolveDatabaseConfig();
const log = createChildLogger({ service: "database" });

function openSqlite(path: string): DatabaseType {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  return database;
}

const sqlite = (
  databaseConfig.driver === "sqlite"
    ? openSqlite(databaseConfig.path)
    : new PostgresSyncDatabase(databaseConfig.url)
) as DatabaseType;

applySchemaSql((sql) => {
  sqlite.exec(sql);
}, databaseConfig.driver);

if (databaseConfig.driver === "postgres") {
  log.info({ driver: "postgres" }, "Postgres storage enabled");
}

export const db = drizzle(sqlite, { schema });

let databaseClosed = false;

/** Closes the process-wide connection. Used by tests and shutdown. */
export function closeDatabase(): void {
  if (databaseClosed) return;
  databaseClosed = true;
  sqlite.close();
}

export { sqlite };
export const databaseDriver = databaseConfig.driver;
