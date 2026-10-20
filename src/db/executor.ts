// ============================================================
// WA MCP — Async SQL executors
// SQLite stays on the local file. Postgres uses the network
// without blocking the event loop.
// ============================================================

import { AsyncLocalStorage } from "node:async_hooks";
import Database from "better-sqlite3";
import pg from "pg";
import { createChildLogger } from "../utils/logger.js";
import {
  adaptSqliteStatement,
  bindParameters,
  splitSqlStatements,
  sqliteDdlToPostgres,
} from "./sql-compat.js";

const log = createChildLogger({ service: "database" });

/** Fail fast when Postgres is unreachable instead of hanging the process. */
export const POSTGRES_QUERY_TIMEOUT_MS = 10_000;
export const POSTGRES_CONNECTION_TIMEOUT_MS = 5_000;

export interface SqlQueryResult {
  columns: string[];
  values: unknown[][];
  changes: number;
  lastInsertRowid: number;
}

export interface SqlExecutor {
  query(sql: string, params: readonly unknown[]): Promise<SqlQueryResult>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface TransactionScope {
  depth: number;
  client?: pg.PoolClient;
}

const TRANSIENT_CODES = new Set([
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
]);

pg.types.setTypeParser(20, (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
});

export class SqliteExecutor implements SqlExecutor {
  private readonly scope = new AsyncLocalStorage<TransactionScope>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly database: Database.Database) {}

  query(sql: string, params: readonly unknown[]): Promise<SqlQueryResult> {
    return this.enqueue(() => this.execute(sql, params));
  }

  async exec(sql: string): Promise<void> {
    await this.enqueue(() => {
      this.database.exec(sql);
    });
  }

  transaction<T>(fn: () => Promise<T>): Promise<T> {
    const existing = this.scope.getStore();
    if (existing) return this.nested(existing, fn);
    return this.enqueue(async () => {
      const scope: TransactionScope = { depth: 0 };
      return await this.scope.run(scope, async () => {
        this.database.exec("BEGIN");
        try {
          const result = await fn();
          this.database.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            this.database.exec("ROLLBACK");
          } catch {
            // Keep the original failure.
          }
          throw error;
        }
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.scope.getStore()) return Promise.resolve().then(fn);
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private execute(sql: string, params: readonly unknown[]): SqlQueryResult {
    const statement = this.database.prepare(sql);
    const bound = params.length === 1 && isPlainObject(params[0]) ? [params[0]] : [...params];
    if (!statement.reader) {
      const result = statement.run(...bound);
      return {
        columns: [],
        values: [],
        changes: result.changes,
        lastInsertRowid: rowId(result.lastInsertRowid),
      };
    }
    const columns = statement.columns().map((column) => column.name);
    const values = statement.raw().all(...bound) as unknown[][];
    return { columns, values, changes: values.length, lastInsertRowid: 0 };
  }

  private async nested<T>(scope: TransactionScope, fn: () => Promise<T>): Promise<T> {
    const name = `sp_${scope.depth}`;
    scope.depth += 1;
    try {
      this.database.exec(`SAVEPOINT ${name}`);
      try {
        const result = await fn();
        this.database.exec(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        this.database.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        throw error;
      }
    } finally {
      scope.depth -= 1;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SQLite connection is closed");
  }
}

export class PostgresExecutor implements SqlExecutor {
  private readonly scope = new AsyncLocalStorage<TransactionScope>();
  private readonly pool: pg.Pool;
  private closed = false;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: POSTGRES_CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      query_timeout: POSTGRES_QUERY_TIMEOUT_MS,
      statement_timeout: POSTGRES_QUERY_TIMEOUT_MS,
      keepAlive: true,
      allowExitOnIdle: true,
    });
    this.pool.on("error", (err: Error) => {
      log.error({ err: err.message }, "Postgres connection dropped");
    });
  }

  async query(sql: string, params: readonly unknown[]): Promise<SqlQueryResult> {
    this.assertOpen();
    const bound = bindParameters(adaptSqliteStatement(sql), params);
    const scope = this.scope.getStore();
    try {
      return await this.run(bound.sql, bound.values, scope?.client);
    } catch (error) {
      if (scope?.client || !isTransientConnectionError(error)) throw error;
      log.warn({ err: errorMessage(error) }, "Retrying Postgres query on a new connection");
      return await this.run(bound.sql, bound.values);
    }
  }

  async exec(sql: string): Promise<void> {
    for (const statement of splitSqlStatements(sql)) {
      await this.query(sqliteDdlToPostgres(statement), []);
    }
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const existing = this.scope.getStore();
    if (existing?.client) return this.nested(existing, fn);
    this.assertOpen();
    const client = await this.pool.connect();
    const scope: TransactionScope = { depth: 0, client };
    try {
      return await this.scope.run(scope, async () => {
        await client.query("BEGIN");
        try {
          const result = await fn();
          await client.query("COMMIT");
          return result;
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Keep the original failure.
          }
          throw error;
        }
      });
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  private async run(
    text: string,
    values: unknown[],
    client?: pg.PoolClient,
  ): Promise<SqlQueryResult> {
    const config: pg.QueryArrayConfig = {
      text,
      values: [...values],
      rowMode: "array",
    };
    const result = client ? await client.query(config) : await this.pool.query(config);
    return {
      columns: result.fields.map((field) => field.name),
      values: result.rows as unknown[][],
      changes: result.rowCount ?? 0,
      lastInsertRowid: 0,
    };
  }

  private async nested<T>(scope: TransactionScope, fn: () => Promise<T>): Promise<T> {
    const name = `sp_${scope.depth}`;
    const client = scope.client;
    if (!client) throw new Error("Postgres transaction has no connection");
    scope.depth += 1;
    try {
      await client.query(`SAVEPOINT ${name}`);
      try {
        const result = await fn();
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw error;
      }
    } finally {
      scope.depth -= 1;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Postgres connection is closed");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Date)
  );
}

function rowId(value: number | bigint): number {
  if (typeof value === "bigint") {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : 0;
  }
  return value;
}

function isTransientConnectionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? String(error.code) : "";
  if (TRANSIENT_CODES.has(code)) return true;
  return /connection terminated|connection ended|server closed the connection|timeout expired|ECONNRESET/i.test(
    errorMessage(error),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
