// ============================================================
// WA MCP — Database target
// Empty WA_DATABASE_URL keeps SQLite at WA_DATABASE_PATH.
// ============================================================

import { resolve } from "node:path";

export type DatabaseDriverName = "sqlite" | "postgres";

export interface SqliteDatabaseConfig {
  driver: "sqlite";
  path: string;
}

export interface PostgresDatabaseConfig {
  driver: "postgres";
  url: string;
  /** Unchanged SQLite path. The app does not open it while Postgres is selected. */
  path: string;
}

export type DatabaseConfig = SqliteDatabaseConfig | PostgresDatabaseConfig;

const INVALID_URL_MESSAGE =
  "WA_DATABASE_URL must be empty or a postgres:// or postgresql:// URL with a host and database name";

/**
 * Selects the storage backend.
 * An empty or unset WA_DATABASE_URL is SQLite at WA_DATABASE_PATH (default data/whatsapp.db).
 */
export function resolveDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const path = resolve(env.WA_DATABASE_PATH?.trim() || "data/whatsapp.db");
  const rawUrl = env.WA_DATABASE_URL;
  if (rawUrl === undefined || rawUrl.trim() === "") {
    return { driver: "sqlite", path };
  }

  const url = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(INVALID_URL_MESSAGE);
  }

  const allowed = parsed.protocol === "postgres:" || parsed.protocol === "postgresql:";
  if (!allowed || !parsed.hostname || parsed.pathname === "" || parsed.pathname === "/") {
    throw new Error(INVALID_URL_MESSAGE);
  }

  return { driver: "postgres", url, path };
}
