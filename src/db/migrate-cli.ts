import "dotenv/config";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveDatabaseConfig } from "./config.js";
import { PostgresExecutor } from "./executor.js";
import { applySchemaSql } from "./schema-sql.js";

const config = resolveDatabaseConfig();

if (config.driver === "sqlite") {
  // drizzle-kit reads WA_DATABASE_PATH from drizzle.config.ts and needs its directory.
  // The production image does not include drizzle-kit; run this SQLite path from a checkout.
  mkdirSync(dirname(config.path), { recursive: true });
  const result = spawnSync(process.execPath, ["./node_modules/drizzle-kit/bin.cjs", "migrate"], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

const postgres = new PostgresExecutor(config.url);
try {
  await applySchemaSql((sql) => postgres.exec(sql), "postgres");
} finally {
  await postgres.close();
}

process.stdout.write("Postgres schema is up to date.\n");
