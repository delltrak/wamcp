import { existsSync } from "node:fs";
import { resolveDatabaseConfig } from "./config.js";
import { migrateSqliteToPostgres } from "./sqlite-to-postgres.js";

const force = process.argv.includes("--force");
const args = process.argv.slice(2).filter((arg) => arg !== "--force");
const config = resolveDatabaseConfig();
if (config.driver !== "postgres") {
  process.stderr.write(
    "Set WA_DATABASE_URL to a postgres:// or postgresql:// URL. The SQLite database was not changed.\n",
  );
  process.exit(1);
}

const sqlitePath = args[0] ? args[0] : config.path;
if (!existsSync(sqlitePath)) {
  process.stderr.write(`SQLite database not found at ${sqlitePath}\n`);
  process.exit(1);
}

const result = await migrateSqliteToPostgres({
  sqlitePath,
  databaseUrl: config.url,
  force,
});
const total = Object.values(result.tables).reduce((sum, count) => sum + count, 0);
process.stdout.write(
  `Copied ${total} rows from ${sqlitePath} into Postgres. The SQLite file was not modified.\n`,
);
for (const [table, count] of Object.entries(result.tables)) {
  process.stdout.write(`  ${table}: ${count}\n`);
}
if (result.skipped.length > 0) {
  process.stderr.write(`Skipped tables not in the Postgres schema: ${result.skipped.join(", ")}\n`);
}
