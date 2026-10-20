// ============================================================
// WA MCP — Scheduled message table
// Created in the existing SQLite database. The file path does not change.
// ============================================================

import type Database from "better-sqlite3";

export const SCHEDULED_MESSAGES_DDL = `
CREATE TABLE IF NOT EXISTS scheduled_messages (
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
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
  ON scheduled_messages(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_instance
  ON scheduled_messages(instance_id, status);
`;

export function createScheduledMessagesTable(sqlite: Database.Database): void {
  sqlite.exec(SCHEDULED_MESSAGES_DDL);
}
