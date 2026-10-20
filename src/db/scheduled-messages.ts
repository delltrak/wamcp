// ============================================================
// WA MCP — Scheduled message table
// Created in the existing SQLite database. The file path does not change.
//
// Millisecond timestamps and the insert sequence are BIGINT. SQLite gives
// any declared type that contains "INT" INTEGER affinity and stores values
// in 64 bits, so BIGINT is a normal integer column here. Postgres INTEGER
// is int4 and overflows a millisecond timestamp; BIGINT is int8.
//
// SCHEDULED_MESSAGES_DDL is the script to append to SCHEMA_SQL. The Postgres
// applier rewrites the INTEGER keyword to BIGINT and leaves BIGINT in place,
// so pasting this constant does not narrow timestamps back to 32 bits.
// Queries use positional `?`.
// ============================================================

import type Database from "better-sqlite3";

export const SCHEDULED_MESSAGES_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id                TEXT PRIMARY KEY,
  instance_id       TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  recipient         TEXT NOT NULL,
  message_type      TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  timezone          TEXT NOT NULL,
  recurrence        TEXT NOT NULL,
  scheduled_at      BIGINT NOT NULL,
  next_run_at       BIGINT NOT NULL,
  weekdays_json     TEXT,
  day_of_month      INTEGER,
  end_at            BIGINT,
  occurrence_limit  INTEGER,
  occurrence_count  INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,
  lease_token       TEXT,
  lease_until       BIGINT,
  last_run_at       BIGINT,
  last_job_id       TEXT,
  last_error        TEXT,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  seq               BIGINT NOT NULL DEFAULT 0
);
`;

export const SCHEDULED_MESSAGES_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_instance
  ON scheduled_messages(instance_id, status);
DROP INDEX IF EXISTS idx_scheduled_messages_due;
CREATE INDEX idx_scheduled_messages_due
  ON scheduled_messages(status, next_run_at, created_at, seq);
`;

/** Fresh-database script. Append to SCHEMA_SQL; do not run the upgrade ALTER with it. */
export const SCHEDULED_MESSAGES_DDL = `${SCHEDULED_MESSAGES_TABLE_DDL}${SCHEDULED_MESSAGES_INDEX_DDL}`;

export function createScheduledMessagesTable(sqlite: Database.Database): void {
  sqlite.exec(SCHEDULED_MESSAGES_TABLE_DDL);
  try {
    sqlite.exec(`ALTER TABLE scheduled_messages ADD COLUMN seq BIGINT NOT NULL DEFAULT 0`);
  } catch {
    // The CREATE TABLE above already includes seq.
  }
  sqlite.exec(SCHEDULED_MESSAGES_INDEX_DDL);
}
