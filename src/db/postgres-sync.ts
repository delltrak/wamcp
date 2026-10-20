// ============================================================
// WA MCP — Synchronous Postgres driver
// Drizzle's SQLite session calls prepare/run/get/all/transaction.
// A worker thread owns the Postgres connection and blocks the
// caller with Atomics so those call sites stay synchronous.
// ============================================================

import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { splitSqlStatements, toPostgresQuery } from "./sql-compat.js";

const HEADER_BYTES = 16;
const STATE = 0;
const LENGTH = 1;
const STATUS = 2;
const READY = 3;
const STATE_IDLE = 0;
const STATE_REQUEST = 1;
const STATE_RESPONSE = 2;
const READY_OK = 1;
const READY_FAILED = 2;
const INITIAL_BYTES = 1 << 20;
const MAX_BYTES = 256 << 20;
const READY_TIMEOUT_MS = 20_000;
const QUERY_TIMEOUT_MS = 120_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface GrowableSharedArrayBuffer extends SharedArrayBuffer {
  grow(newByteLength: number): void;
  readonly maxByteLength: number;
}

function createSharedBuffer(): GrowableSharedArrayBuffer {
  const BufferCtor = SharedArrayBuffer as unknown as new (
    byteLength: number,
    options: { maxByteLength: number },
  ) => GrowableSharedArrayBuffer;
  return new BufferCtor(INITIAL_BYTES, { maxByteLength: MAX_BYTES });
}

interface QueryResult {
  fields: string[];
  rows: unknown[][];
  rowCount: number;
}

interface WorkerSuccess extends QueryResult {
  message?: undefined;
}

interface WorkerFailure {
  message: string;
  fields?: undefined;
}

type WorkerResponse = WorkerSuccess | WorkerFailure;

type WorkerRequest = { op: "query"; sql: string; params: unknown[] } | { op: "close" };

interface TransactionFunction {
  (...args: unknown[]): unknown;
  deferred: TransactionFunction;
  immediate: TransactionFunction;
  exclusive: TransactionFunction;
}

export interface SyncRunResult {
  changes: number;
  lastInsertRowid: number;
}

class PostgresStatement {
  private arrayMode = false;

  constructor(
    private readonly database: PostgresSyncDatabase,
    private readonly sql: string,
  ) {}

  raw(): this {
    this.arrayMode = true;
    return this;
  }

  all(...params: unknown[]): unknown[] {
    const result = this.database.query(this.sql, params);
    if (this.arrayMode) return result.rows;
    return result.rows.map((row) => rowObject(result.fields, row));
  }

  get(...params: unknown[]): unknown {
    return this.all(...params)[0];
  }

  run(...params: unknown[]): SyncRunResult {
    const result = this.database.query(this.sql, params);
    return { changes: result.rowCount, lastInsertRowid: 0 };
  }
}

export class PostgresSyncDatabase {
  private readonly sab: GrowableSharedArrayBuffer;
  private readonly state: Int32Array;
  private readonly worker: Worker;
  private closed = false;

  constructor(connectionString: string) {
    this.sab = createSharedBuffer();
    this.state = new Int32Array(this.sab, 0, 4);
    this.worker = new Worker(postgresWorkerSource(), {
      eval: true,
      workerData: {
        connectionString,
        sab: this.sab,
        modulePath: fileURLToPath(new URL("../../package.json", import.meta.url)),
      },
    });
    this.worker.unref();
    this.worker.on("error", () => {
      // The ready flag carries startup failures. Later failures time out the request.
    });

    const ready = Atomics.wait(this.state, READY, 0, READY_TIMEOUT_MS);
    if (Atomics.load(this.state, READY) !== READY_OK) {
      const message = this.readBody();
      this.closed = true;
      void this.worker.terminate();
      const detail = message ? decodeFailure(message) : ready;
      throw new Error(`Postgres connection failed (${detail})`);
    }
  }

  prepare(sql: string): PostgresStatement {
    this.assertOpen();
    return new PostgresStatement(this, sql);
  }

  exec(sql: string): this {
    this.assertOpen();
    for (const statement of splitSqlStatements(sql)) {
      this.call({ op: "query", sql: statement, params: [] });
    }
    return this;
  }

  query(sql: string, params: unknown[]): QueryResult {
    this.assertOpen();
    const response = this.call({
      op: "query",
      sql: toPostgresQuery(sql),
      params: params.map(normalizeParam),
    });
    if (!isQueryResult(response)) {
      throw new Error("Postgres worker returned an unexpected result");
    }
    return response;
  }

  transaction(fn: (...args: unknown[]) => unknown): TransactionFunction {
    const run = ((...args: unknown[]) => {
      this.exec("BEGIN");
      try {
        const result = fn(...args);
        this.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.exec("ROLLBACK");
        } catch {
          // Keep the original failure.
        }
        throw error;
      }
    }) as TransactionFunction;
    run.deferred = run;
    run.immediate = run;
    run.exclusive = run;
    return run;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.call({ op: "close" });
    } catch {
      // The worker is terminated below either way.
    }
    void this.worker.terminate();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Postgres connection is closed");
  }

  private call(request: WorkerRequest): WorkerResponse {
    const payload = encoder.encode(JSON.stringify(request));
    this.writePayload(payload);
    Atomics.store(this.state, STATUS, 0);
    Atomics.store(this.state, STATE, STATE_REQUEST);
    Atomics.notify(this.state, STATE);
    const wait = Atomics.wait(this.state, STATE, STATE_REQUEST, QUERY_TIMEOUT_MS);
    if (Atomics.load(this.state, STATE) === STATE_REQUEST) {
      throw new Error(
        wait === "timed-out" ? "Postgres request timed out" : "Postgres worker stopped responding",
      );
    }
    const status = Atomics.load(this.state, STATUS);
    const body = this.readBody();
    Atomics.store(this.state, STATE, STATE_IDLE);
    Atomics.notify(this.state, STATE);
    let parsed: WorkerResponse;
    try {
      parsed = JSON.parse(body) as WorkerResponse;
    } catch {
      throw new Error("Postgres worker returned an unreadable result");
    }
    if (status !== 0) {
      throw new Error(decodeFailure(body));
    }
    return parsed;
  }

  private writePayload(payload: Uint8Array): void {
    this.ensureCapacity(HEADER_BYTES + payload.byteLength);
    new Uint8Array(this.sab, HEADER_BYTES, payload.byteLength).set(payload);
    Atomics.store(this.state, LENGTH, payload.byteLength);
  }

  private readBody(): string {
    const length = Atomics.load(this.state, LENGTH);
    if (length <= 0) return "";
    return decoder.decode(new Uint8Array(this.sab, HEADER_BYTES, length));
  }

  private ensureCapacity(bytes: number): void {
    if (this.sab.byteLength >= bytes) return;
    const next = Math.min(this.sab.maxByteLength, Math.max(bytes, this.sab.byteLength * 2));
    if (next < bytes) {
      throw new Error("Postgres response exceeded the driver buffer");
    }
    this.sab.grow(next);
  }
}

function rowObject(fields: string[], values: unknown[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (let index = 0; index < fields.length; index += 1) {
    row[fields[index] ?? ""] = values[index];
  }
  return row;
}

function normalizeParam(value: unknown): unknown {
  if (value === undefined) {
    throw new Error("SQL bind value is undefined");
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    if (!Number.isSafeInteger(asNumber)) {
      throw new Error("integer value exceeds Number.MAX_SAFE_INTEGER");
    }
    return asNumber;
  }
  return value;
}

function isQueryResult(value: WorkerResponse): value is WorkerSuccess {
  return "rows" in value && Array.isArray(value.rows) && Array.isArray(value.fields);
}

function decodeFailure(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed.message) return parsed.message;
  } catch {
    // The body is not JSON.
  }
  return body || "Postgres query failed";
}

function postgresWorkerSource(): string {
  return `
"use strict";
var workerThreads = require("worker_threads");
var createRequire = require("module").createRequire;
var pg = createRequire(workerDataModule())("pg");
var Client = pg.Client;
var types = pg.types;
var workerData = workerThreads.workerData;
var sab = workerData.sab;
var view = new Int32Array(sab, 0, 4);
var HEADER_BYTES = ${HEADER_BYTES};
var STATE = ${STATE};
var LENGTH = ${LENGTH};
var STATUS = ${STATUS};
var READY = ${READY};
var STATE_IDLE = ${STATE_IDLE};
var STATE_REQUEST = ${STATE_REQUEST};
var STATE_RESPONSE = ${STATE_RESPONSE};
var READY_OK = ${READY_OK};
var READY_FAILED = ${READY_FAILED};
var encoder = new TextEncoder();
var decoder = new TextDecoder();

function workerDataModule() {
  return workerThreads.workerData.modulePath;
}

types.setTypeParser(20, function (value) {
  var parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("integer value exceeds Number.MAX_SAFE_INTEGER");
  }
  return parsed;
});

var client = new Client({ connectionString: workerData.connectionString });

function ensure(bytes) {
  if (sab.byteLength >= bytes) return;
  var next = Math.min(sab.maxByteLength, Math.max(bytes, sab.byteLength * 2));
  if (next < bytes) throw new Error("Postgres response exceeded the driver buffer");
  sab.grow(next);
}

function writeJson(payload, status) {
  var bytes = encoder.encode(JSON.stringify(payload));
  ensure(HEADER_BYTES + bytes.byteLength);
  new Uint8Array(sab, HEADER_BYTES, bytes.byteLength).set(bytes);
  Atomics.store(view, LENGTH, bytes.byteLength);
  Atomics.store(view, STATUS, status);
  Atomics.store(view, STATE, STATE_RESPONSE);
  Atomics.notify(view, STATE);
}

function signalReady(code, message) {
  if (message) {
    var bytes = encoder.encode(JSON.stringify({ message: message }));
    ensure(HEADER_BYTES + bytes.byteLength);
    new Uint8Array(sab, HEADER_BYTES, bytes.byteLength).set(bytes);
    Atomics.store(view, LENGTH, bytes.byteLength);
  }
  Atomics.store(view, READY, code);
  Atomics.notify(view, READY);
}

function readRequest() {
  var length = Atomics.load(view, LENGTH);
  return JSON.parse(decoder.decode(new Uint8Array(sab, HEADER_BYTES, length)));
}

function fail(error) {
  var message = error && error.message ? error.message : String(error);
  try {
    signalReady(READY_FAILED, message);
  } catch (_error) {
    Atomics.store(view, READY, READY_FAILED);
    Atomics.notify(view, READY);
  }
}

client.connect().then(run).catch(fail);

async function run() {
  signalReady(READY_OK);
  while (true) {
    var state = Atomics.load(view, STATE);
    if (state === STATE_IDLE) {
      Atomics.wait(view, STATE, STATE_IDLE);
      continue;
    }
    if (state === STATE_RESPONSE) {
      Atomics.wait(view, STATE, STATE_RESPONSE);
      continue;
    }
    if (state !== STATE_REQUEST) continue;
    var request = readRequest();
    try {
      if (request.op === "close") {
        await client.end();
        writeJson({ fields: [], rows: [], rowCount: 0 }, 0);
        return;
      }
      var config = { text: request.sql, rowMode: "array" };
      if (request.params && request.params.length > 0) config.values = request.params;
      var result = await client.query(config);
      var fields = [];
      var fieldIndex = 0;
      var fieldList = result.fields || [];
      for (; fieldIndex < fieldList.length; fieldIndex += 1) fields.push(fieldList[fieldIndex].name);
      writeJson({
        fields: fields,
        rows: result.rows || [],
        rowCount: result.rowCount || 0,
      }, 0);
    } catch (error) {
      writeJson({ message: error && error.message ? error.message : String(error) }, 1);
    }
  }
}
`;
}
