import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveDatabaseConfig } from "../src/db/config.js";
import { PostgresSyncDatabase } from "../src/db/postgres-sync.js";
import { applySchemaSql } from "../src/db/schema-sql.js";

const config = resolveDatabaseConfig();

if (config.driver === "sqlite") {
  // drizzle-kit reads data/whatsapp.db from drizzle.config.ts and does not create the directory.
  mkdirSync("data", { recursive: true });
  mkdirSync(dirname(config.path), { recursive: true });
  const result = spawnSync(process.execPath, ["./node_modules/drizzle-kit/bin.cjs", "migrate"], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

const postgres = new PostgresSyncDatabase(config.url);
try {
  applySchemaSql((sql) => {
    postgres.exec(sql);
  }, "postgres");
} finally {
  postgres.close();
}

process.stdout.write("Postgres schema is up to date.\n");
