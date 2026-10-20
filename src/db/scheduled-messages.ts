// ============================================================
// WA MCP — Scheduled message table
// Created in the existing SQLite database. The file path does not change.
//
// Millisecond timestamps and the tie-break sequence are BIGINT. SQLite gives
// any declared type that contains "INT" INTEGER affinity and stores values
// in 64 bits, so BIGINT is a normal integer column here. Postgres INTEGER
// is int4 and overflows a millisecond timestamp; BIGINT is int8.
//
// Fold-in order for the shared schema:
// 1. SCHEDULED_MESSAGES_UPGRADE_SQL in ADDITIVE_COLUMNS_BEFORE_SCHEMA.
// 2. SCHEDULED_MESSAGES_TABLE_DDL, then SCHEDULED_MESSAGES_INDEX_DDL, in SCHEMA_SQL.
// An older table has no seq column. The upgrade runs before the index that
// names seq. CREATE TABLE IF NOT EXISTS does not add that column itself.
// The INTEGER keyword rewrite leaves BIGINT unchanged.
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

/**
 * Adds columns missing from tables created before seq existed.
 * Run this before SCHEDULED_MESSAGES_INDEX_DDL. On SQLite, check
 * PRAGMA table_info first. On Postgres, check information_schema.columns.
 * The only expected repeat is "duplicate column".
 */
export const SCHEDULED_MESSAGES_UPGRADE_SQL = `ALTER TABLE scheduled_messages ADD COLUMN seq BIGINT NOT NULL DEFAULT 0`;

export const SCHEDULED_MESSAGES_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_instance
  ON scheduled_messages(instance_id, status);
DROP INDEX IF EXISTS idx_scheduled_messages_due;
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due_v2
  ON scheduled_messages(status, next_run_at, created_at, seq);
`;

export function createScheduledMessagesTable(sqlite: Database.Database): void {
  sqlite.exec(SCHEDULED_MESSAGES_TABLE_DDL);
  ensureScheduledMessageColumns(sqlite);
  sqlite.exec(SCHEDULED_MESSAGES_INDEX_DDL);
}

function ensureScheduledMessageColumns(sqlite: Database.Database): void {
  const table = sqlite
    .prepare(
      `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_messages'`,
    )
    .get() as { present: number } | undefined;
  if (!table) return;
  const columns = sqlite.prepare(`PRAGMA table_info(scheduled_messages)`).all() as Array<{
    name: string;
  }>;
  if (columns.some((column) => column.name === "seq")) return;
  sqlite.exec(SCHEDULED_MESSAGES_UPGRADE_SQL);
}
