// ============================================================
// WA MCP — Scheduled and recurring outbound messages
// Due sends go through MessageQueue so the existing per-instance
// rate limiter applies. Nothing is claimed while the gate is off.
// ============================================================

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  SCHEDULER_LEASE_MS,
  SCHEDULER_MAX_ATTEMPTS,
  SCHEDULER_MAX_PER_TICK,
  SCHEDULER_ON_TIME_SLACK_MS,
  SCHEDULER_POLL_MS,
  SCHEDULER_RETRY_DELAY_MS,
} from "../constants.js";
import type { ChannelType, MessageContent } from "../types/channel.types.js";
import { validateMediaInput } from "../utils/validation.js";
import { createChildLogger } from "../utils/logger.js";
import { nextOccurrence, parseScheduleRequest, type ScheduleSpec } from "./schedule-clock.js";
import {
  readSchedulerConfig,
  schedulerDisabledMessage,
  type SchedulerConfig,
} from "./schedule-config.js";
import { ScheduleStore, type ScheduleRecord, type ScheduleStatus } from "./schedule-store.js";

const logger = createChildLogger({ service: "scheduler" });

const INTERRUPTED_REASON = "execution interrupted before completion";
const SKIPPED_REASON = "missed occurrence skipped by WA_SCHEDULER_MISSED_POLICY=skip";

export type ScheduleEnqueue = (
  instanceId: string,
  to: string,
  content: MessageContent,
  channel: ChannelType,
) => Promise<{ jobId: string }>;

export interface CreateScheduleInput {
  instanceId: string;
  to: string;
  scheduledAt: string;
  timezone?: string;
  recurrence?: "once" | "daily" | "weekly" | "monthly";
  weekdays?: number[];
  dayOfMonth?: number;
  endAt?: string;
  occurrenceLimit?: number;
  content: MessageContent;
}

export interface ListSchedulesInput {
  instanceId: string;
  status?: ScheduleStatus;
  limit?: number;
  offset?: number;
}

export interface ScheduleView {
  id: string;
  instanceId: string;
  to: string;
  messageType: string;
  summary: string;
  timezone: string;
  recurrence: ScheduleRecord["recurrence"];
  weekdays: number[];
  dayOfMonth: number | null;
  scheduledAt: string;
  nextRunAt: string | null;
  endAt: string | null;
  occurrenceLimit: number | null;
  occurrenceCount: number;
  attempts: number;
  status: ScheduleStatus;
  lastRunAt: string | null;
  lastJobId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TickResult {
  dispatched: number;
  skipped: number;
}

export interface MessageSchedulerOptions {
  sqlite: Database.Database;
  enqueue: ScheduleEnqueue;
  resolveChannel: (instanceId: string) => ChannelType;
  instanceExists?: (instanceId: string) => void;
  now?: () => number;
  config?: SchedulerConfig;
  pollMs?: number;
}

export class MessageScheduler {
  private readonly store: ScheduleStore;
  private readonly enqueue: ScheduleEnqueue;
  private readonly resolveChannel: (instanceId: string) => ChannelType;
  private readonly instanceExists?: (instanceId: string) => void;
  private readonly now: () => number;
  private readonly configOverride?: SchedulerConfig;
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: MessageSchedulerOptions) {
    this.store = new ScheduleStore(options.sqlite);
    this.enqueue = options.enqueue;
    this.resolveChannel = options.resolveChannel;
    this.instanceExists = options.instanceExists;
    this.now = options.now ?? (() => Date.now());
    this.configOverride = options.config;
    this.pollMs = options.pollMs ?? SCHEDULER_POLL_MS;
    if (!options.config) readSchedulerConfig();
  }

  start(): void {
    const config = this.settings();
    if (!config.enabled) {
      logger.info("Scheduled sends are disabled (WA_SCHEDULER_ENABLED is not true)");
      return;
    }
    if (this.timer) return;
    logger.info({ missedPolicy: config.missedPolicy }, "Scheduled send worker started");
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        logger.error({ err }, "Scheduled send tick failed");
      });
    }, this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  create(input: CreateScheduleInput): ScheduleView {
    this.assertEnabled();
    this.instanceExists?.(input.instanceId);
    assertScheduledContent(input.content);
    const now = this.now();
    const parsed = parseScheduleRequest(input, now);
    const id = `sched_${randomUUID()}`;
    const stored = this.store.insert({
      id,
      instanceId: input.instanceId,
      recipient: input.to,
      messageType: input.content.type,
      payloadJson: JSON.stringify(input.content),
      timezone: parsed.timezone,
      recurrence: parsed.recurrence,
      scheduledAt: parsed.scheduledAt,
      nextRunAt: parsed.scheduledAt,
      weekdays: parsed.weekdays,
      dayOfMonth: parsed.dayOfMonth,
      endAt: parsed.endAt,
      occurrenceLimit: parsed.occurrenceLimit,
      now,
    });
    logger.info(
      { scheduleId: stored.id, instanceId: stored.instanceId, recurrence: stored.recurrence },
      "Scheduled send created",
    );
    return toView(stored);
  }

  list(input: ListSchedulesInput): {
    schedules: ScheduleView[];
    total: number;
    limit: number;
    offset: number;
  } {
    const limit = input.limit ?? 25;
    const offset = input.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Invalid limit; expected an integer from 1 to 100");
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error("Invalid offset; expected an integer greater than or equal to 0");
    }
    const page = this.store.list(input.instanceId, input.status ?? null, limit, offset);
    return {
      schedules: page.rows.map(toView),
      total: page.total,
      limit,
      offset,
    };
  }

  pause(instanceId: string, id: string): ScheduleView {
    this.assertEnabled();
    return this.transition(instanceId, id, ["active"], "paused", "paused");
  }

  resume(instanceId: string, id: string): ScheduleView {
    this.assertEnabled();
    return this.transition(instanceId, id, ["paused"], "active", "resumed");
  }

  cancel(instanceId: string, id: string): ScheduleView {
    this.assertEnabled();
    return this.transition(
      instanceId,
      id,
      ["active", "paused", "failed"],
      "cancelled",
      "cancelled",
    );
  }

  /** Claim due rows and either enqueue them or apply the missed-run policy. */
  async tick(): Promise<TickResult> {
    if (this.ticking) return { dispatched: 0, skipped: 0 };
    this.ticking = true;
    try {
      if (!this.settings().enabled) return { dispatched: 0, skipped: 0 };
      const result: TickResult = { dispatched: 0, skipped: 0 };
      for (const expired of this.store.listExpiredLeases(this.now())) {
        this.advanceWithoutSend(expired, INTERRUPTED_REASON, "failed");
        result.skipped += 1;
      }
      for (let count = 0; count < SCHEDULER_MAX_PER_TICK; count++) {
        const job = this.store.claimNext(this.now(), this.now() + SCHEDULER_LEASE_MS, randomUUID());
        if (!job) break;
        const outcome = await this.processClaimed(job);
        if (outcome === "sent") result.dispatched += 1;
        else result.skipped += 1;
      }
      return result;
    } finally {
      this.ticking = false;
    }
  }

  private async processClaimed(job: ScheduleRecord): Promise<"sent" | "skipped"> {
    const missed = this.now() - job.nextRunAt > SCHEDULER_ON_TIME_SLACK_MS;
    if (missed && this.settings().missedPolicy === "skip") {
      this.advanceWithoutSend(job, SKIPPED_REASON, "skipped");
      return "skipped";
    }
    if (job.endAt != null && this.now() > job.endAt) {
      this.advanceWithoutSend(job, "schedule ended before the occurrence was sent", "completed");
      return "skipped";
    }
    try {
      const channel = this.resolveChannel(job.instanceId);
      const content = parsePayload(job.payloadJson);
      const queued = await this.enqueue(job.instanceId, job.recipient, content, channel);
      this.markSent(job, queued.jobId);
      logger.info(
        { scheduleId: job.id, instanceId: job.instanceId, jobId: queued.jobId },
        "Scheduled send queued",
      );
      return "sent";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isPermanent(message)) {
        this.advanceWithoutSend(job, message, "failed");
        return "skipped";
      }
      const attempts = job.attempts + 1;
      if (attempts >= SCHEDULER_MAX_ATTEMPTS) {
        this.advanceWithoutSend(job, message, "failed");
        return "skipped";
      }
      this.store.retry(
        job.id,
        job.leaseToken,
        this.now() + SCHEDULER_RETRY_DELAY_MS,
        attempts,
        message,
        this.now(),
      );
      logger.warn({ scheduleId: job.id, attempts, err: message }, "Scheduled send enqueue failed");
      return "skipped";
    }
  }

  private markSent(job: ScheduleRecord, jobId: string): void {
    const now = this.now();
    const count = job.occurrenceCount + 1;
    const spec = specOf(job);
    let status: ScheduleStatus = "completed";
    let nextRunAt = job.nextRunAt;
    const underLimit = job.occurrenceLimit == null || count < job.occurrenceLimit;
    if (job.recurrence !== "once" && underLimit) {
      const next = nextOccurrence(spec, now);
      if (next != null) {
        status = "active";
        nextRunAt = next;
      }
    }
    this.store.finish({
      id: job.id,
      leaseToken: job.leaseToken,
      status,
      occurrenceCount: count,
      nextRunAt,
      lastRunAt: now,
      lastJobId: jobId,
      lastError: null,
      attempts: 0,
      now,
    });
  }

  /** Drop the current occurrence. Recurring rows move to the next future slot. */
  private advanceWithoutSend(
    job: ScheduleRecord,
    reason: string,
    terminalStatus: ScheduleStatus,
  ): void {
    const now = this.now();
    if (job.recurrence === "once") {
      this.store.finish({
        id: job.id,
        leaseToken: job.leaseToken,
        status: terminalStatus,
        occurrenceCount: job.occurrenceCount,
        nextRunAt: job.nextRunAt,
        lastRunAt: job.lastRunAt,
        lastJobId: job.lastJobId,
        lastError: reason,
        attempts: 0,
        now,
      });
      return;
    }
    const next = nextOccurrence(specOf(job), now);
    if (next == null) {
      this.store.finish({
        id: job.id,
        leaseToken: job.leaseToken,
        status: "completed",
        occurrenceCount: job.occurrenceCount,
        nextRunAt: job.nextRunAt,
        lastRunAt: job.lastRunAt,
        lastJobId: job.lastJobId,
        lastError: reason,
        attempts: 0,
        now,
      });
      return;
    }
    this.store.finish({
      id: job.id,
      leaseToken: job.leaseToken,
      status: "active",
      occurrenceCount: job.occurrenceCount,
      nextRunAt: next,
      lastRunAt: job.lastRunAt,
      lastJobId: job.lastJobId,
      lastError: reason,
      attempts: 0,
      now,
    });
  }

  private transition(
    instanceId: string,
    id: string,
    from: ScheduleStatus[],
    status: ScheduleStatus,
    action: string,
  ): ScheduleView {
    const current = this.require(instanceId, id);
    if (!from.includes(current.status)) {
      throw new Error(`Scheduled send cannot be ${action} while ${current.status}`);
    }
    const changed = this.store.setStatus(instanceId, id, from, status, this.now());
    if (!changed) {
      throw new Error(`Scheduled send cannot be ${action} while ${current.status}`);
    }
    return toView(this.require(instanceId, id));
  }

  private require(instanceId: string, id: string): ScheduleRecord {
    const row = this.store.get(instanceId, id);
    if (!row) throw new Error(`Unknown scheduled send '${id}'`);
    return row;
  }

  private assertEnabled(): void {
    if (!this.settings().enabled) throw new Error(schedulerDisabledMessage());
  }

  private settings(): SchedulerConfig {
    return this.configOverride ?? readSchedulerConfig();
  }
}

export function createIdleScheduler(): MessageScheduler {
  return new MessageScheduler({
    sqlite: new Database(":memory:"),
    enqueue: async () => ({ jobId: "idle" }),
    resolveChannel: () => "baileys",
    config: { enabled: false, missedPolicy: "skip" },
  });
}

function specOf(job: ScheduleRecord): ScheduleSpec {
  return {
    scheduledAt: job.scheduledAt,
    timezone: job.timezone,
    recurrence: job.recurrence,
    weekdays: job.weekdays,
    dayOfMonth: job.dayOfMonth,
    endAt: job.endAt,
  };
}

function parsePayload(payloadJson: string): MessageContent {
  try {
    const value = JSON.parse(payloadJson) as MessageContent;
    if (!value || typeof value !== "object" || typeof value.type !== "string") {
      throw new Error("Invalid scheduled payload");
    }
    return value;
  } catch (err) {
    if (err instanceof Error && err.message === "Invalid scheduled payload") throw err;
    throw new Error("Invalid scheduled payload", { cause: err });
  }
}

function isPermanent(message: string): boolean {
  return message.includes("not found") || message.includes("Invalid scheduled payload");
}

function assertScheduledContent(content: MessageContent): void {
  switch (content.type) {
    case "text":
      if (content.text.trim().length === 0 || content.text.length > 65536) {
        throw new Error("Invalid text; expected 1 to 65536 characters");
      }
      return;
    case "image":
    case "video":
    case "audio":
    case "sticker": {
      const field =
        content.type === "image"
          ? content.image
          : content.type === "video"
            ? content.video
            : content.type === "audio"
              ? content.audio
              : content.sticker;
      const error = validateMediaInput(field);
      if (error) throw new Error(`Invalid ${content.type}; ${error}`);
      return;
    }
    case "document": {
      const error = validateMediaInput(content.document);
      if (error) throw new Error(`Invalid document; ${error}`);
      if (content.fileName.trim() === "" || content.mimeType.trim() === "") {
        throw new Error("Invalid document; fileName and mimeType are required");
      }
      return;
    }
    default:
      throw new Error(
        "Invalid message type; expected text, image, video, audio, document, or sticker",
      );
  }
}

function toView(row: ScheduleRecord): ScheduleView {
  const terminal =
    row.status === "completed" ||
    row.status === "failed" ||
    row.status === "cancelled" ||
    row.status === "skipped";
  let summary: string;
  try {
    summary = summarize(parsePayload(row.payloadJson));
  } catch {
    summary = row.messageType;
  }
  return {
    id: row.id,
    instanceId: row.instanceId,
    to: row.recipient,
    messageType: row.messageType,
    summary,
    timezone: row.timezone,
    recurrence: row.recurrence,
    weekdays: row.weekdays,
    dayOfMonth: row.dayOfMonth,
    scheduledAt: new Date(row.scheduledAt).toISOString(),
    nextRunAt: terminal ? null : new Date(row.nextRunAt).toISOString(),
    endAt: row.endAt == null ? null : new Date(row.endAt).toISOString(),
    occurrenceLimit: row.occurrenceLimit,
    occurrenceCount: row.occurrenceCount,
    attempts: row.attempts,
    status: row.status,
    lastRunAt: row.lastRunAt == null ? null : new Date(row.lastRunAt).toISOString(),
    lastJobId: row.lastJobId,
    lastError: row.lastError,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function summarize(content: MessageContent): string {
  if (content.type === "text") return content.text.slice(0, 160);
  if (content.type === "image" || content.type === "video") {
    return (content.caption ?? content.type).slice(0, 160);
  }
  if (content.type === "audio") return content.ptt ? "voice note" : "audio";
  if (content.type === "document") return content.fileName.slice(0, 160);
  if (content.type === "sticker") return "sticker";
  return content.type;
}
