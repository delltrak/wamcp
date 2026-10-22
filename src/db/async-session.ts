// ============================================================
// WA MCP — Async Drizzle session for both storage drivers
// Query methods return promises, so a slow Postgres round-trip
// yields the event loop instead of stalling Baileys and HTTP.
// ============================================================

import { entityKind } from "drizzle-orm/entity";
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  type TablesRelationalConfig,
} from "drizzle-orm/relations";
import { fillPlaceholders, sql, type Query } from "drizzle-orm/sql";
import {
  BaseSQLiteDatabase,
  SQLiteAsyncDialect,
  SQLitePreparedQuery,
  SQLiteSession,
  SQLiteTransaction,
  type PreparedQueryConfig,
  type SQLiteExecuteMethod,
  type SQLiteTransactionConfig,
} from "drizzle-orm/sqlite-core";
import type { SelectedFieldsOrdered } from "drizzle-orm/sqlite-core/query-builders/select.types";
import * as drizzleUtils from "drizzle-orm/utils";
import type { SqlExecutor, SqlQueryResult } from "./executor.js";

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

type PreparedConfig = PreparedQueryConfig & {
  type: "async";
  run: RunResult;
  all: unknown[];
  get: unknown;
  values: unknown[][];
  execute: unknown;
};

type RelationSchema = {
  fullSchema: Record<string, unknown>;
  schema: TablesRelationalConfig;
  tableNamesMap: Record<string, string>;
};

type ColumnField = { mapFromDriverValue(value: unknown): unknown };
type ResultMapper = (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown;

const mapResultRow = (
  drizzleUtils as unknown as {
    mapResultRow: (
      columns: ReadonlyArray<{ path: string[]; field: ColumnField }>,
      row: unknown[],
      joinsNotNullableMap: Record<string, boolean> | undefined,
    ) => Record<string, unknown>;
  }
).mapResultRow;

class AsyncPreparedQuery extends SQLitePreparedQuery<PreparedConfig> {
  static readonly [entityKind] = "AsyncPreparedQuery";
  joinsNotNullableMap: Record<string, boolean> | undefined;

  constructor(
    private readonly executor: SqlExecutor,
    query: Query,
    private readonly fields: SelectedFieldsOrdered | undefined,
    private readonly rowMapper: ResultMapper | undefined,
    executeMethod: SQLiteExecuteMethod,
  ) {
    super("async", executeMethod, query);
  }

  async run(placeholderValues?: Record<string, unknown>): Promise<RunResult> {
    const result = await this.executeQuery(placeholderValues);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  async all(placeholderValues?: Record<string, unknown>): Promise<unknown[]> {
    if (!this.fields && !this.rowMapper) {
      return rowsAsObjects(await this.executeQuery(placeholderValues));
    }
    const rows = await this.values(placeholderValues);
    if (this.rowMapper) {
      const mapped = this.rowMapper(rows);
      return Array.isArray(mapped) ? mapped : [mapped];
    }
    return rows.map((row) =>
      mapResultRow(
        (this.fields ?? []) as ReadonlyArray<{ path: string[]; field: ColumnField }>,
        row,
        this.joinsNotNullableMap,
      ),
    );
  }

  async get(placeholderValues?: Record<string, unknown>): Promise<unknown> {
    if (!this.fields && !this.rowMapper) {
      return rowsAsObjects(await this.executeQuery(placeholderValues))[0];
    }
    const rows = await this.values(placeholderValues);
    const row = rows[0];
    if (!row) return undefined;
    if (this.rowMapper) return this.rowMapper([row]);
    return mapResultRow(
      (this.fields ?? []) as ReadonlyArray<{ path: string[]; field: ColumnField }>,
      row,
      this.joinsNotNullableMap,
    );
  }

  async values(placeholderValues?: Record<string, unknown>): Promise<unknown[][]> {
    return (await this.executeQuery(placeholderValues)).values;
  }

  private executeQuery(placeholderValues?: Record<string, unknown>): Promise<SqlQueryResult> {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    return this.executor.query(this.query.sql, params);
  }
}

class AsyncSqliteSession extends SQLiteSession<
  "async",
  RunResult,
  Record<string, unknown>,
  TablesRelationalConfig
> {
  static readonly [entityKind] = "AsyncSqliteSession";
  declare dialect: SQLiteAsyncDialect;

  constructor(
    dialect: SQLiteAsyncDialect,
    private readonly executor: SqlExecutor,
    private readonly relations: RelationSchema | undefined,
  ) {
    super(dialect);
  }

  prepareQuery(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    _isResponseInArrayMode: boolean,
    customResultMapper?: ResultMapper,
  ): AsyncPreparedQuery {
    return new AsyncPreparedQuery(this.executor, query, fields, customResultMapper, executeMethod);
  }

  override transaction<T>(
    transaction: (
      tx: SQLiteTransaction<"async", RunResult, Record<string, unknown>, TablesRelationalConfig>,
    ) => Promise<T>,
    _config?: SQLiteTransactionConfig,
  ): Promise<T> {
    return this.executor.transaction(async () => {
      const tx = new AsyncSqliteTransaction(this.dialect, this, this.relations, 0);
      return transaction(tx);
    });
  }

  extractRawAllValueFromBatchResult(result: unknown): unknown {
    return result;
  }

  extractRawGetValueFromBatchResult(result: unknown): unknown {
    return Array.isArray(result) ? result[0] : result;
  }

  extractRawValuesValueFromBatchResult(result: unknown): unknown {
    return result;
  }
}

class AsyncSqliteTransaction extends SQLiteTransaction<
  "async",
  RunResult,
  Record<string, unknown>,
  TablesRelationalConfig
> {
  static readonly [entityKind] = "AsyncSqliteTransaction";

  constructor(
    private readonly asyncDialect: SQLiteAsyncDialect,
    private readonly asyncSession: AsyncSqliteSession,
    private readonly relations: RelationSchema | undefined,
    nestedIndex: number,
  ) {
    super("async", asyncDialect, asyncSession, relations, nestedIndex);
  }

  override async transaction<T>(
    transaction: (
      tx: SQLiteTransaction<"async", RunResult, Record<string, unknown>, TablesRelationalConfig>,
    ) => Promise<T>,
  ): Promise<T> {
    const name = `sp${this.nestedIndex + 1}`;
    const tx = new AsyncSqliteTransaction(
      this.asyncDialect,
      this.asyncSession,
      this.relations,
      this.nestedIndex + 1,
    );
    await this.asyncSession.run(sql.raw(`SAVEPOINT ${name}`));
    try {
      const result = await transaction(tx);
      await this.asyncSession.run(sql.raw(`RELEASE SAVEPOINT ${name}`));
      return result;
    } catch (error) {
      await this.asyncSession.run(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`));
      throw error;
    }
  }
}

export type AppDatabase<TSchema extends Record<string, unknown>> = BaseSQLiteDatabase<
  "async",
  RunResult,
  TSchema
>;

export function createAsyncDatabase<TSchema extends Record<string, unknown>>(
  executor: SqlExecutor,
  schema: TSchema,
): AppDatabase<TSchema> {
  const dialect = new SQLiteAsyncDialect();
  const tables = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
  const relations: RelationSchema = {
    fullSchema: schema,
    schema: tables.tables,
    tableNamesMap: tables.tableNamesMap,
  };
  const session = new AsyncSqliteSession(dialect, executor, relations);
  return new BaseSQLiteDatabase("async", dialect, session, relations) as AppDatabase<TSchema>;
}

function rowsAsObjects(result: SqlQueryResult): Record<string, unknown>[] {
  return result.values.map((row) => {
    const object: Record<string, unknown> = {};
    result.columns.forEach((column, index) => {
      object[column] = row[index];
    });
    return object;
  });
}
