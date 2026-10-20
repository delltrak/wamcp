// ============================================================
// WA MCP — Manual SQLite to Postgres copy
// Not called on startup. The source file is only read.
// ============================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getTableName, isTable } from "drizzle-orm";
import { Client } from "pg";
import { createChildLogger } from "../utils/logger.js";
import * as schema from "./schema.js";
import { applySchemaSql } from "./schema-sql.js";
import { bigintForSql, quoteIdent } from "./sql-compat.js";

const log = createChildLogger({ service: "sqlite-to-postgres" });
const COPY_BATCH = 100;

export interface SqliteToPostgresResult {
  tables: Record<string, number>;
  skipped: string[];
}

interface ColumnInfo {
  name: string;
  pk: number;
}

interface ForeignKeyInfo {
  table: string;
}

/**
 * Copies application tables, including Baileys `auth_keys`, into Postgres.
 * Refuses when the target already has instance or auth rows unless `force` is set.
 * The SQLite file is not modified or deleted.
 */
export async function migrateSqliteToPostgres(options: {
  sqlitePath: string;
  databaseUrl: string;
  force?: boolean;
}): Promise<SqliteToPostgresResult> {
  const snapshot = await snapshotDatabase(options.sqlitePath);
  const client = new Client({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: 10_000,
  });
  client.on("error", (err: Error) => {
    log.error({ err: err.message }, "Postgres copy connection dropped");
  });
  await client.connect();
  const source = new Database(snapshot.snapshotPath, { readonly: true, fileMustExist: true });
  try {
    await applySchemaSql(async (sql) => {
      await client.query(sql);
    }, "postgres");
    await assertCopyAllowed(client, options.force === true);

    const discovered = listTables(source);
    const allowed = new Set(applicationTableNames());
    const skipped = discovered.filter((table) => !allowed.has(table));
    for (const table of skipped) {
      log.warn({ table }, "Skipping SQLite table that is not in the Postgres schema");
    }
    const tables = orderTables(
      source,
      discovered.filter((table) => allowed.has(table)),
    );
    const counts: Record<string, number> = {};
    await client.query("BEGIN");
    try {
      for (const table of tables) {
        counts[table] = await copyTable(source, client, table);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    return { tables: counts, skipped };
  } finally {
    source.close();
    await client.end();
    rmSync(snapshot.directory, { recursive: true, force: true });
  }
}

export function applicationTableNames(): string[] {
  return Object.values(schema)
    .filter((value) => isTable(value))
    .map((table) => getTableName(table))
    .sort();
}

async function assertCopyAllowed(client: Client, force: boolean): Promise<void> {
  const result = await client.query<{ instances: string | number; auth_keys: string | number }>(
    `SELECT
       (SELECT count(*) FROM instances) AS instances,
       (SELECT count(*) FROM auth_keys) AS auth_keys`,
  );
  const row = result.rows[0];
  const instances = Number(row?.instances ?? 0);
  const authKeys = Number(row?.auth_keys ?? 0);
  if (!force && (instances > 0 || authKeys > 0)) {
    throw new Error(
      "Refusing to copy into Postgres because instances or auth_keys already has rows. Stop wa-mcp, copy once into an empty database, then start wa-mcp with WA_DATABASE_URL. Pass --force to overwrite those rows.",
    );
  }
}

async function snapshotDatabase(
  sqlitePath: string,
): Promise<{ directory: string; snapshotPath: string }> {
  const directory = mkdtempSync(join(tmpdir(), "wamcp-pg-migrate-"));
  const snapshotPath = join(directory, "snapshot.db");
  const source = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(snapshotPath);
  } finally {
    source.close();
  }
  return { directory, snapshotPath };
}

function listTables(source: Database.Database): string[] {
  const rows = source
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function orderTables(source: Database.Database, tables: string[]): string[] {
  const remaining = new Set(tables);
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((table) =>
        parentTables(source, table).every((parent) => !remaining.has(parent) || parent === table),
      )
      .sort();
    if (ready.length === 0) {
      ordered.push(...[...remaining].sort());
      break;
    }
    for (const table of ready) {
      ordered.push(table);
      remaining.delete(table);
    }
  }
  return ordered;
}

function parentTables(source: Database.Database, table: string): string[] {
  const rows = source
    .prepare(`PRAGMA foreign_key_list(${quoteIdent(table)})`)
    .all() as ForeignKeyInfo[];
  return rows.map((row) => row.table);
}

async function copyTable(
  source: Database.Database,
  client: Client,
  table: string,
): Promise<number> {
  const columns = source.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as ColumnInfo[];
  if (columns.length === 0) return 0;
  const names = columns.map((column) => column.name);
  const primaryKey = columns
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  const rows = source.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as Array<
    Record<string, unknown>
  >;
  for (let offset = 0; offset < rows.length; offset += COPY_BATCH) {
    await insertBatch(client, table, names, primaryKey, rows.slice(offset, offset + COPY_BATCH));
  }
  return rows.length;
}

async function insertBatch(
  client: Client,
  table: string,
  columns: string[],
  primaryKey: string[],
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const tuples = rows.map((row) => {
    const placeholders = columns.map((column) => {
      values.push(normalizeValue(row[column]));
      return `$${values.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  const quotedColumns = columns.map(quoteIdent).join(", ");
  let sql = `INSERT INTO ${quoteIdent(table)} (${quotedColumns}) VALUES ${tuples.join(", ")}`;
  if (primaryKey.length > 0) {
    const conflict = primaryKey.map(quoteIdent).join(", ");
    const updates = columns.filter((column) => !primaryKey.includes(column));
    sql += ` ON CONFLICT (${conflict}) DO `;
    sql +=
      updates.length === 0
        ? "NOTHING"
        : `UPDATE SET ${updates
            .map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`)
            .join(", ")}`;
  }
  await client.query(sql, values);
}

function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "string") return value.replaceAll("\u0000", "");
  if (typeof value === "bigint") return bigintForSql(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}
