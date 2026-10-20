import { existsSync } from "node:fs";
import { resolveDatabaseConfig } from "../src/db/config.js";
import { migrateSqliteToPostgres } from "../src/db/sqlite-to-postgres.js";

const config = resolveDatabaseConfig();
if (config.driver !== "postgres") {
  process.stderr.write(
    "Set WA_DATABASE_URL to a postgres:// or postgresql:// URL. The SQLite database was not changed.\n",
  );
  process.exit(1);
}

const sqlitePath = process.argv[2] ? process.argv[2] : config.path;
if (!existsSync(sqlitePath)) {
  process.stderr.write(`SQLite database not found at ${sqlitePath}\n`);
  process.exit(1);
}

const result = await migrateSqliteToPostgres({
  sqlitePath,
  databaseUrl: config.url,
});
const total = Object.values(result.tables).reduce((sum, count) => sum + count, 0);
process.stdout.write(
  `Copied ${total} rows from ${sqlitePath} into Postgres. The SQLite file was not modified.\n`,
);
for (const [table, count] of Object.entries(result.tables)) {
  process.stdout.write(`  ${table}: ${count}\n`);
}
