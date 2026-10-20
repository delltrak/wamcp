import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEDULED_MESSAGES_DDL } from "../src/db/scheduled-messages.js";
import {
  claimNextScheduleSql,
  finishScheduleSql,
  insertScheduleSql,
  listScheduleCountSql,
  listScheduleRowsSql,
  releaseScheduleSql,
  retryScheduleSql,
} from "../src/services/schedule-store.js";

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

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value !== "") return Number(value);
  throw new Error(`Expected a numeric SQL value, received ${typeof value}`);
}

function changed(result: { affectedRows?: number; rowCount?: number | null }): number {
  return result.affectedRows ?? result.rowCount ?? 0;
}

describe("schedule store queries on Postgres", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.close()));
  });

  it("keeps millisecond timestamps and runs claim, list, and lease updates", async () => {
    expect(SCHEDULED_MESSAGES_DDL).toMatch(/scheduled_at\s+BIGINT NOT NULL/);
    expect(SCHEDULED_MESSAGES_DDL).toMatch(/next_run_at\s+BIGINT NOT NULL/);
    expect(SCHEDULED_MESSAGES_DDL).toMatch(/created_at\s+BIGINT NOT NULL/);
    expect(SCHEDULED_MESSAGES_DDL).not.toMatch(/scheduled_at\s+INTEGER/);
    expect(listScheduleCountSql(null)).not.toMatch(/\? IS NULL/);
    expect(listScheduleRowsSql("active")).toMatch(/AND status = \?/);
    expect(listScheduleRowsSql("active")).not.toMatch(/\? IS NULL/);
    expect(releaseScheduleSql()).toMatch(/lease_token = \?/);
    expect(finishScheduleSql()).not.toMatch(/lease_token IS/);
    expect(retryScheduleSql()).toMatch(/lease_token = \?/);

    const db = new PGlite();
    databases.push(db);
    await db.exec(`
      CREATE TABLE instances (
        id TEXT PRIMARY KEY
      );
      INSERT INTO instances (id) VALUES ('inst-a'), ('inst-b');
    `);
    await db.exec(SCHEDULED_MESSAGES_DDL);

    const insert = replaceSqlitePlaceholders(insertScheduleSql());
    const due = FAR_MS;
    await db.query(insert, row("sched-b", "inst-a", due, "second"));
    await db.query(insert, row("sched-a", "inst-a", due, "first"));
    await db.query(insert, row("sched-other", "inst-b", due + 60_000, "other"));

    const stored = await db.query<{ scheduled_at: unknown; seq: unknown }>(
      "SELECT scheduled_at, seq FROM scheduled_messages WHERE id = $1",
      ["sched-b"],
    );
    expect(asNumber(stored.rows[0]?.scheduled_at)).toBe(FAR_MS);
    expect(asNumber(stored.rows[0]?.seq)).toBe(1);

    const unfiltered = await db.query<{ id: string }>(
      replaceSqlitePlaceholders(listScheduleRowsSql(null)),
      ["inst-a", 10, 0],
    );
    expect(unfiltered.rows.map((item) => item.id)).toEqual(["sched-b", "sched-a"]);
    const counted = await db.query<{ total: unknown }>(
      replaceSqlitePlaceholders(listScheduleCountSql(null)),
      ["inst-a"],
    );
    expect(asNumber(counted.rows[0]?.total)).toBe(2);
    const active = await db.query<{ total: unknown }>(
      replaceSqlitePlaceholders(listScheduleCountSql("active")),
      ["inst-a", "active"],
    );
    expect(asNumber(active.rows[0]?.total)).toBe(2);

    const claimed = await db.query<{ id: string; lease_token: string }>(
      replaceSqlitePlaceholders(claimNextScheduleSql(1)),
      ["lease-1", due + 60_000, due, due, "inst-b"],
    );
    expect(claimed.rows[0]?.id).toBe("sched-b");
    expect(claimed.rows[0]?.lease_token).toBe("lease-1");

    const released = await db.query(replaceSqlitePlaceholders(releaseScheduleSql()), [
      due,
      due,
      "sched-b",
      "lease-1",
    ]);
    expect(changed(released)).toBe(1);

    const again = await db.query<{ id: string; lease_token: string }>(
      replaceSqlitePlaceholders(claimNextScheduleSql(0)),
      ["lease-2", due + 60_000, due, due],
    );
    expect(again.rows[0]?.id).toBe("sched-b");

    const finished = await db.query(replaceSqlitePlaceholders(finishScheduleSql()), [
      "completed",
      1,
      due,
      due,
      "job-1",
      null,
      1,
      due,
      "sched-b",
      "lease-2",
    ]);
    expect(changed(finished)).toBe(1);

    const next = await db.query<{ id: string; lease_token: string }>(
      replaceSqlitePlaceholders(claimNextScheduleSql(0)),
      ["lease-3", due + 60_000, due, due],
    );
    expect(next.rows[0]?.id).toBe("sched-a");

    const wrongToken = await db.query(replaceSqlitePlaceholders(retryScheduleSql()), [
      due + 30_000,
      1,
      "temporary",
      due,
      "sched-a",
      "not-the-lease",
    ]);
    expect(changed(wrongToken)).toBe(0);
    const retried = await db.query(replaceSqlitePlaceholders(retryScheduleSql()), [
      due + 30_000,
      1,
      "temporary",
      due,
      "sched-a",
      "lease-3",
    ]);
    expect(changed(retried)).toBe(1);

    const after = await db.query<{ id: string; status: string }>(
      replaceSqlitePlaceholders(listScheduleRowsSql("active")),
      ["inst-a", "active", 10, 0],
    );
    expect(after.rows.map((item) => item.id)).toEqual(["sched-a"]);
  });
});

function row(
  id: string,
  instanceId: string,
  due: number,
  text: string,
): Array<string | number | null> {
  return [
    id,
    instanceId,
    "5500000000001@s.whatsapp.net",
    "text",
    JSON.stringify({ type: "text", text }),
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
  ];
}
