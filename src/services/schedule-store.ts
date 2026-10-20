// ============================================================
// WA MCP — SQLite persistence for scheduled sends
// ============================================================

import type Database from "better-sqlite3";
import { createScheduledMessagesTable } from "../db/scheduled-messages.js";
import type { Recurrence } from "./schedule-clock.js";

export type ScheduleStatus =
  "active" | "paused" | "running" | "completed" | "cancelled" | "failed" | "skipped";

export interface ScheduleRecord {
  id: string;
  instanceId: string;
  recipient: string;
  messageType: string;
  payloadJson: string;
  timezone: string;
  recurrence: Recurrence;
  scheduledAt: number;
  nextRunAt: number;
  weekdays: number[];
  dayOfMonth: number | null;
  endAt: number | null;
  occurrenceLimit: number | null;
  occurrenceCount: number;
  attempts: number;
  status: ScheduleStatus;
  leaseToken: string | null;
  leaseUntil: number | null;
  lastRunAt: number | null;
  lastJobId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ScheduleRow {
  id: string;
  instance_id: string;
  recipient: string;
  message_type: string;
  payload_json: string;
  timezone: string;
  recurrence: Recurrence;
  scheduled_at: number;
  next_run_at: number;
  weekdays_json: string | null;
  day_of_month: number | null;
  end_at: number | null;
  occurrence_limit: number | null;
  occurrence_count: number;
  attempts: number;
  status: ScheduleStatus;
  lease_token: string | null;
  lease_until: number | null;
  last_run_at: number | null;
  last_job_id: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface NewScheduleRow {
  id: string;
  instanceId: string;
  recipient: string;
  messageType: string;
  payloadJson: string;
  timezone: string;
  recurrence: Recurrence;
  scheduledAt: number;
  nextRunAt: number;
  weekdays: number[];
  dayOfMonth: number | null;
  endAt: number | null;
  occurrenceLimit: number | null;
  now: number;
}

export interface FinishScheduleUpdate {
  id: string;
  leaseToken: string | null;
  status: ScheduleStatus;
  occurrenceCount: number;
  nextRunAt: number;
  lastRunAt: number | null;
  lastJobId: string | null;
  lastError: string | null;
  attempts: number;
  now: number;
}

export class ScheduleStore {
  constructor(private readonly sqlite: Database.Database) {
    createScheduledMessagesTable(sqlite);
  }

  insert(row: NewScheduleRow): ScheduleRecord {
    this.sqlite
      .prepare(
        `INSERT INTO scheduled_messages (
          id, instance_id, recipient, message_type, payload_json, timezone, recurrence,
          scheduled_at, next_run_at, weekdays_json, day_of_month, end_at, occurrence_limit,
          occurrence_count, attempts, status, created_at, updated_at
        ) VALUES (
          @id, @instanceId, @recipient, @messageType, @payloadJson, @timezone, @recurrence,
          @scheduledAt, @nextRunAt, @weekdaysJson, @dayOfMonth, @endAt, @occurrenceLimit,
          0, 0, 'active', @now, @now
        )`,
      )
      .run({
        ...row,
        weekdaysJson: row.weekdays.length > 0 ? JSON.stringify(row.weekdays) : null,
      });
    const stored = this.get(row.instanceId, row.id);
    if (!stored) throw new Error("Invalid scheduled send; it could not be stored");
    return stored;
  }

  get(instanceId: string, id: string): ScheduleRecord | null {
    const row = this.sqlite
      .prepare(`SELECT * FROM scheduled_messages WHERE instance_id = ? AND id = ?`)
      .get(instanceId, id) as ScheduleRow | undefined;
    return row ? mapRow(row) : null;
  }

  list(
    instanceId: string,
    status: ScheduleStatus | null,
    limit: number,
    offset: number,
  ): { rows: ScheduleRecord[]; total: number } {
    const totalRow = this.sqlite
      .prepare(
        `SELECT COUNT(*) AS total FROM scheduled_messages
         WHERE instance_id = @instanceId AND (@status IS NULL OR status = @status)`,
      )
      .get({ instanceId, status }) as { total: number };
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM scheduled_messages
         WHERE instance_id = @instanceId AND (@status IS NULL OR status = @status)
         ORDER BY next_run_at ASC, id ASC
         LIMIT @limit OFFSET @offset`,
      )
      .all({ instanceId, status, limit, offset }) as ScheduleRow[];
    return { rows: rows.map(mapRow), total: totalRow.total };
  }

  /** Move one due active row to running. Returns null when nothing is due. */
  claimNext(now: number, leaseUntil: number, token: string): ScheduleRecord | null {
    const row = this.sqlite
      .prepare(
        `UPDATE scheduled_messages
         SET status = 'running', lease_token = @token, lease_until = @leaseUntil, updated_at = @now
         WHERE id = (
           SELECT id FROM scheduled_messages
           WHERE status = 'active' AND next_run_at <= @now
           ORDER BY next_run_at ASC, id ASC
           LIMIT 1
         )
         RETURNING *`,
      )
      .get({ now, leaseUntil, token }) as ScheduleRow | undefined;
    return row ? mapRow(row) : null;
  }

  listExpiredLeases(now: number): ScheduleRecord[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM scheduled_messages
         WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?`,
      )
      .all(now) as ScheduleRow[];
    return rows.map(mapRow);
  }

  setStatus(
    instanceId: string,
    id: string,
    from: ScheduleStatus[],
    status: ScheduleStatus,
    now: number,
  ): boolean {
    const placeholders = from.map(() => "?").join(", ");
    const result = this.sqlite
      .prepare(
        `UPDATE scheduled_messages
         SET status = ?, lease_token = NULL, lease_until = NULL, updated_at = ?
         WHERE instance_id = ? AND id = ? AND status IN (${placeholders})`,
      )
      .run(status, now, instanceId, id, ...from);
    return result.changes > 0;
  }

  finish(update: FinishScheduleUpdate): boolean {
    const result = this.sqlite
      .prepare(
        `UPDATE scheduled_messages
         SET status = @status,
             occurrence_count = @occurrenceCount,
             next_run_at = @nextRunAt,
             last_run_at = @lastRunAt,
             last_job_id = @lastJobId,
             last_error = @lastError,
             attempts = @attempts,
             lease_token = NULL,
             lease_until = NULL,
             updated_at = @now
         WHERE id = @id AND status = 'running' AND lease_token IS @leaseToken`,
      )
      .run(update);
    return result.changes > 0;
  }

  retry(
    id: string,
    leaseToken: string | null,
    nextRunAt: number,
    attempts: number,
    lastError: string,
    now: number,
  ): boolean {
    const result = this.sqlite
      .prepare(
        `UPDATE scheduled_messages
         SET status = 'active',
             next_run_at = @nextRunAt,
             attempts = @attempts,
             last_error = @lastError,
             lease_token = NULL,
             lease_until = NULL,
             updated_at = @now
         WHERE id = @id AND status = 'running' AND lease_token IS @leaseToken`,
      )
      .run({ id, leaseToken, nextRunAt, attempts, lastError, now });
    return result.changes > 0;
  }
}

function mapRow(row: ScheduleRow): ScheduleRecord {
  let weekdays: number[] = [];
  if (row.weekdays_json) {
    try {
      const parsed = JSON.parse(row.weekdays_json) as unknown;
      if (Array.isArray(parsed)) {
        weekdays = parsed.filter((value): value is number => typeof value === "number");
      }
    } catch {
      weekdays = [];
    }
  }
  return {
    id: row.id,
    instanceId: row.instance_id,
    recipient: row.recipient,
    messageType: row.message_type,
    payloadJson: row.payload_json,
    timezone: row.timezone,
    recurrence: row.recurrence,
    scheduledAt: row.scheduled_at,
    nextRunAt: row.next_run_at,
    weekdays,
    dayOfMonth: row.day_of_month,
    endAt: row.end_at,
    occurrenceLimit: row.occurrence_limit,
    occurrenceCount: row.occurrence_count,
    attempts: row.attempts,
    status: row.status,
    leaseToken: row.lease_token,
    leaseUntil: row.lease_until,
    lastRunAt: row.last_run_at,
    lastJobId: row.last_job_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
