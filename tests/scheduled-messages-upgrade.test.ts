import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  SCHEDULED_MESSAGES_INDEX_DDL,
  SCHEDULED_MESSAGES_TABLE_DDL,
  SCHEDULED_MESSAGES_UPGRADE_SQL,
  createScheduledMessagesTable,
} from "../src/db/scheduled-messages.js";
import { ScheduleStore, claimNextScheduleSql } from "../src/services/schedule-store.js";

const LEGACY_DDL = `
CREATE TABLE instances (
  id TEXT PRIMARY KEY
);
CREATE TABLE scheduled_messages (
  id                TEXT PRIMARY KEY,
  instance_id       TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  recipient         TEXT NOT NULL,
  message_type      TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  timezone          TEXT NOT NULL,
  recurrence        TEXT NOT NULL,
  scheduled_at      INTEGER NOT NULL,
  next_run_at       INTEGER NOT NULL,
  weekdays_json     TEXT,
  day_of_month      INTEGER,
  end_at            INTEGER,
  occurrence_limit  INTEGER,
  occurrence_count  INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,
  lease_token       TEXT,
  lease_until       INTEGER,
  last_run_at       INTEGER,
  last_job_id       TEXT,
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_scheduled_messages_due
  ON scheduled_messages(status, next_run_at);
CREATE INDEX idx_scheduled_messages_instance
  ON scheduled_messages(instance_id, status);
`;

describe("scheduled message table upgrade", () => {
  it("rejects a claim that is no longer active and locks rows only on Postgres", () => {
    const sqliteSql = claimNextScheduleSql(0);
    expect(sqliteSql).toMatch(/AND status = 'active'\s+RETURNING \*/);
    expect(sqliteSql).not.toMatch(/FOR UPDATE/);
    const postgresSql = claimNextScheduleSql(0, "postgres");
    expect(postgresSql).toMatch(/LIMIT 1 FOR UPDATE SKIP LOCKED/);
    expect(postgresSql).toMatch(/AND status = 'active'\s+RETURNING \*/);
    expect(SCHEDULED_MESSAGES_TABLE_DDL).toMatch(/scheduled_at\s+BIGINT NOT NULL/);
    expect(SCHEDULED_MESSAGES_INDEX_DDL).toMatch(/idx_scheduled_messages_due_v2/);
    expect(SCHEDULED_MESSAGES_INDEX_DDL).not.toMatch(/CREATE INDEX idx_scheduled_messages_due\b/);
  });

  it("adds seq before creating the due index on a table from before seq", async () => {
    const early = new Database(":memory:");
    early.exec(LEGACY_DDL);
    expect(() => early.exec(SCHEDULED_MESSAGES_INDEX_DDL)).toThrow(/no such column: seq/);
    early.close();

    const sqlite = new Database(":memory:");
    (await sqlite.exec(LEGACY_DDL));
    createScheduledMessagesTable(sqlite);
    const columns = (await sqlite.prepare(`PRAGMA table_info(scheduled_messages)`).all()) as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toContain("seq");
    const indexes = (await sqlite.prepare(`PRAGMA index_list(scheduled_messages)`).all()) as Array<{
      name: string;
    }>;
    const names = indexes.map((index) => index.name);
    expect(names).toContain("idx_scheduled_messages_due_v2");
    expect(names).not.toContain("idx_scheduled_messages_due");

    expect(() => sqlite.exec(SCHEDULED_MESSAGES_UPGRADE_SQL)).toThrow(/duplicate column name: seq/);
    expect(() => createScheduledMessagesTable(sqlite)).not.toThrow();

    (await sqlite.prepare(`INSERT INTO instances (id) VALUES ('inst-legacy')`).run());
    const store = new ScheduleStore(sqlite);
    const now = 1_800_000_000_000;
    const stored = (await store.insert({
      id: "sched-legacy",
      instanceId: "inst-legacy",
      recipient: "5500000000001@s.whatsapp.net",
      messageType: "text",
      payloadJson: JSON.stringify({ type: "text", text: "upgraded" }),
      timezone: "UTC",
      recurrence: "once",
      scheduledAt: now,
      nextRunAt: now,
      weekdays: [],
      dayOfMonth: null,
      endAt: null,
      occurrenceLimit: null,
      now,
    }));
    expect(stored.nextRunAt).toBe(now);
    const claimed = (await store.claimNext(now, now + 1_000, "lease-legacy"));
    expect(claimed?.id).toBe("sched-legacy");
    expect((await store.claimNext(now, now + 1_000, "lease-again"))).toBeNull();
    (await sqlite.close());
  });
});
