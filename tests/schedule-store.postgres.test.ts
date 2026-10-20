import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  SCHEDULED_MESSAGES_INDEX_DDL,
  SCHEDULED_MESSAGES_TABLE_DDL,
  SCHEDULED_MESSAGES_UPGRADE_SQL,
} from "../src/db/scheduled-messages.js";
import {
  claimNextScheduleSql,
  finishScheduleSql,
  insertScheduleSql,
  listScheduleCountSql,
  listScheduleRowsSql,
  releaseScheduleSql,
  retryScheduleSql,
} from "../src/services/schedule-store.js";

const databaseUrl = process.env.WA_DATABASE_URL?.trim() ?? "";
const FAR_MS = 1_800_000_000_000;

/**
 * Same `?` to `$n` translation the Postgres storage applies: placeholders
 * outside quotes and line comments become `$1`, `$2`, ...
 */
function replaceSqlitePlaceholders(sql: string): string {
  let out = "";
  let index = 0;
  let param = 1;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'") {
      const end = endQuoted(sql, index, "'");
      out += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === '"') {
      const end = endQuoted(sql, index, '"');
      out += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index);
      const end = newline === -1 ? sql.length : newline;
      out += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === "?") {
      out += `$${param}`;
      param += 1;
      index += 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function endQuoted(sql: string, start: number, quote: "'" | '"'): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote && sql[index + 1] === quote) {
      index += 2;
      continue;
    }
    if (sql[index] === quote) return index + 1;
    index += 1;
  }
  return sql.length;
}

function statements(sql: string): string[] {
  return sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value !== "") return Number(value);
  throw new Error(`Expected a numeric SQL value, received ${typeof value}`);
}

function pgSql(sql: string): string {
  return replaceSqlitePlaceholders(sql);
}

describe.skipIf(databaseUrl === "")("schedule store on Postgres", () => {
  const clients: pg.Client[] = [];
  const schemas: string[] = [];

  afterAll(async () => {
    await Promise.all(clients.splice(0).map((client) => client.end()));
  });

  it("runs store queries and keeps millisecond timestamps", async () => {
    const db = await openClient();
    const schema = await createSchema(db);
    await db.query(SCHEDULED_MESSAGES_TABLE_DDL);
    for (const statement of statements(SCHEDULED_MESSAGES_INDEX_DDL)) {
      await db.query(statement);
    }

    const due = FAR_MS;
    await db.query(pgSql(insertScheduleSql()), row("sched-b", due, 2));
    await db.query(pgSql(insertScheduleSql()), row("sched-a", due, 1));

    const stored = await db.query<{ scheduled_at: unknown; seq: unknown }>(
      "SELECT scheduled_at, seq FROM scheduled_messages WHERE id = $1",
      ["sched-b"],
    );
    expect(asNumber(stored.rows[0]?.scheduled_at)).toBe(FAR_MS);
    expect(asNumber(stored.rows[0]?.seq)).toBe(2);

    const listed = await db.query<{ id: string }>(pgSql(listScheduleRowsSql(null)), [
      "inst",
      10,
      0,
    ]);
    expect(listed.rows.map((item) => item.id)).toEqual(["sched-a", "sched-b"]);
    const counted = await db.query<{ total: unknown }>(pgSql(listScheduleCountSql(null)), ["inst"]);
    expect(asNumber(counted.rows[0]?.total)).toBe(2);
    const active = await db.query<{ total: unknown }>(pgSql(listScheduleCountSql("active")), [
      "inst",
      "active",
    ]);
    expect(asNumber(active.rows[0]?.total)).toBe(2);

    const claimed = await db.query<{ id: string; lease_token: string }>(
      pgSql(claimNextScheduleSql(0, "postgres")),
      ["lease-1", due + 60_000, due, due],
    );
    expect(claimed.rows[0]?.id).toBe("sched-a");

    const released = await db.query(pgSql(releaseScheduleSql()), [due, due, "sched-a", "lease-1"]);
    expect(released.rowCount).toBe(1);

    const again = await db.query<{ id: string }>(pgSql(claimNextScheduleSql(0, "postgres")), [
      "lease-2",
      due + 60_000,
      due,
      due,
    ]);
    expect(again.rows[0]?.id).toBe("sched-a");
    const finished = await db.query(pgSql(finishScheduleSql()), [
      "completed",
      1,
      due,
      due,
      "job-1",
      null,
      1,
      due,
      "sched-a",
      "lease-2",
    ]);
    expect(finished.rowCount).toBe(1);

    const next = await db.query<{ id: string; lease_token: string }>(
      pgSql(claimNextScheduleSql(0, "postgres")),
      ["lease-3", due + 60_000, due, due],
    );
    expect(next.rows[0]?.id).toBe("sched-b");
    const wrongToken = await db.query(pgSql(retryScheduleSql()), [
      due + 30_000,
      1,
      "temporary",
      due,
      "sched-b",
      "not-the-lease",
    ]);
    expect(wrongToken.rowCount).toBe(0);
    const retried = await db.query(pgSql(retryScheduleSql()), [
      due + 30_000,
      1,
      "temporary",
      due,
      "sched-b",
      "lease-3",
    ]);
    expect(retried.rowCount).toBe(1);

    await db.query(`DROP SCHEMA ${schema} CASCADE`);
  });

  it("adds seq before the due index when upgrading an older table", async () => {
    const db = await openClient();
    const schema = await createSchema(db);
    await db.query(`
      CREATE TABLE scheduled_messages (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        message_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        timezone TEXT NOT NULL,
        recurrence TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        next_run_at INTEGER NOT NULL,
        weekdays_json TEXT,
        day_of_month INTEGER,
        end_at INTEGER,
        occurrence_limit INTEGER,
        occurrence_count INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        lease_token TEXT,
        lease_until INTEGER,
        last_run_at INTEGER,
        last_job_id TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    const before = await columnNames(db, schema);
    expect(before).not.toContain("seq");
    const dueIndex = statements(SCHEDULED_MESSAGES_INDEX_DDL).find((statement) =>
      statement.includes("idx_scheduled_messages_due_v2"),
    );
    await expect(db.query(dueIndex!)).rejects.toThrow(/seq/);

    if (!before.includes("seq")) await db.query(SCHEDULED_MESSAGES_UPGRADE_SQL);
    for (const statement of statements(SCHEDULED_MESSAGES_INDEX_DDL)) {
      await db.query(statement);
    }
    const after = await columnNames(db, schema);
    expect(after).toContain("seq");
    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'scheduled_messages'`,
      [schema],
    );
    const names = indexes.rows.map((index) => index.indexname);
    expect(names).toContain("idx_scheduled_messages_due_v2");
    expect(names).not.toContain("idx_scheduled_messages_due");
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
  });

  it("lets a second connection claim zero rows while the first claim is open", async () => {
    const holder = await openClient();
    const other = await openClient();
    const schema = await createSchema(holder);
    await other.query(`SET search_path TO ${schema}`);
    await holder.query(SCHEDULED_MESSAGES_TABLE_DDL);
    for (const statement of statements(SCHEDULED_MESSAGES_INDEX_DDL)) {
      await holder.query(statement);
    }
    const due = FAR_MS;
    await holder.query(pgSql(insertScheduleSql()), row("sched-one", due, 1));

    await other.query("SET lock_timeout = '3s'");
    await holder.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await other.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      const first = await holder.query<{ id: string }>(pgSql(claimNextScheduleSql(0, "postgres")), [
        "lease-a",
        due + 60_000,
        due,
        due,
      ]);
      expect(first.rows).toHaveLength(1);
      const second = await other.query(pgSql(claimNextScheduleSql(0, "postgres")), [
        "lease-b",
        due + 60_000,
        due,
        due,
      ]);
      expect(second.rows).toHaveLength(0);
      const kept = await holder.query<{ status: string; lease_token: string }>(
        "SELECT status, lease_token FROM scheduled_messages WHERE id = $1",
        ["sched-one"],
      );
      expect(kept.rows[0]).toEqual({ status: "running", lease_token: "lease-a" });
      await holder.query("COMMIT");
      await other.query("COMMIT");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await other.query("ROLLBACK").catch(() => undefined);
      await holder.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  });

  async function openClient(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    clients.push(client);
    return client;
  }

  async function createSchema(client: pg.Client): Promise<string> {
    const schema = `sched_${randomUUID().replace(/-/g, "")}`;
    schemas.push(schema);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`CREATE TABLE instances (id TEXT PRIMARY KEY)`);
    await client.query(`INSERT INTO instances (id) VALUES ('inst')`);
    return schema;
  }
});

async function columnNames(client: pg.Client, schema: string): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'scheduled_messages'`,
    [schema],
  );
  return result.rows.map((column) => column.column_name);
}

function row(id: string, due: number, seq: number): Array<string | number | null> {
  return [
    id,
    "inst",
    "5500000000001@s.whatsapp.net",
    "text",
    JSON.stringify({ type: "text", text: id }),
    "UTC",
    "once",
    due,
    due,
    null,
    null,
    null,
    null,
    due,
    due,
    seq,
  ];
}
