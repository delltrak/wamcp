// ============================================================
// WA MCP — Scheduled and recurring outbound messages
// Due sends go through MessageQueue so the existing per-instance
// rate limiter applies. Nothing is claimed while the gate is off.
// ============================================================

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  DEFAULT_BAILEYS_RATE_LIMIT,
  DEFAULT_CLOUD_RATE_LIMIT,
  DEFAULT_SCHEDULER_MAX_ACTIVE,
  SCHEDULER_LEASE_MS,
  SCHEDULER_MAX_ATTEMPTS,
  SCHEDULER_MAX_PER_TICK,
  SCHEDULER_ON_TIME_SLACK_MS,
  SCHEDULER_POLL_MS,
  SCHEDULER_RATE_WINDOW_MS,
  SCHEDULER_RETRY_DELAY_MS,
} from "../constants.js";
import type { ChannelType, MessageContent } from "../types/channel.types.js";
import { normalizeScheduledRecipient, validateMediaInput } from "../utils/validation.js";
import { createChildLogger } from "../utils/logger.js";
import { nextOccurrence, parseScheduleRequest, type ScheduleSpec } from "./schedule-clock.js";
import {
  readSchedulerConfig,
  schedulerDisabledMessage,
  type SchedulerConfig,
} from "./schedule-config.js";
import {
  ScheduleStore,
  type ScheduleRecord,
  type ScheduleSqlDialect,
  type ScheduleStatus,
} from "./schedule-store.js";

const logger = createChildLogger({ service: "scheduler" });

const INTERRUPTED_REASON = "execution interrupted before completion";
const SKIPPED_REASON = "missed occurrence skipped by WA_SCHEDULER_MISSED_POLICY=skip";
/** Set on errors that must fail the occurrence instead of retrying. */
export const SCHEDULE_PERMANENT_CODE = "schedule_permanent";

export class SchedulePermanentError extends Error {
  readonly code = SCHEDULE_PERMANENT_CODE;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SchedulePermanentError";
  }
}

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
  /** Messages per minute for one instance. Defaults to the channel outbound limiter. */
  rateLimitFor?: (instanceId: string) => number;
  /**
   * Claim statement dialect for the database that is open. This process opens
   * SQLite. Postgres storage passes "postgres" so locked rows are skipped.
   */
  driver?: ScheduleSqlDialect;
}

export class MessageScheduler {
  private readonly store: ScheduleStore;
  private readonly enqueue: ScheduleEnqueue;
  private readonly resolveChannel: (instanceId: string) => ChannelType;
  private readonly instanceExists?: (instanceId: string) => void;
  private readonly now: () => number;
  private readonly configOverride?: SchedulerConfig;
  private readonly pollMs: number;
  private readonly rateLimitFor?: (instanceId: string) => number;
  private readonly dispatchedAt = new Map<string, number[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeTick: Promise<void> | null = null;

  constructor(options: MessageSchedulerOptions) {
    this.store = new ScheduleStore(options.sqlite, options.driver ?? "sqlite");
    this.enqueue = options.enqueue;
    this.resolveChannel = options.resolveChannel;
    this.instanceExists = options.instanceExists;
    this.now = options.now ?? (() => Date.now());
    this.configOverride = options.config;
    this.pollMs = options.pollMs ?? SCHEDULER_POLL_MS;
    this.rateLimitFor = options.rateLimitFor;
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

  /** Stop the poll timer and wait for a tick that has already claimed work. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const pending = this.activeTick;
    if (pending) await pending;
  }

  create(input: CreateScheduleInput): ScheduleView {
    this.assertEnabled();
    this.instanceExists?.(input.instanceId);
    const recipient = normalizeScheduledRecipient(input.to);
    assertScheduledContent(input.content);
    const now = this.now();
    const parsed = parseScheduleRequest(input, now);
    const maxActive = this.settings().maxActive;
    if (this.store.countOccupying(input.instanceId) >= maxActive) {
      throw new Error(
        `Invalid schedule; this instance already has the maximum of ${maxActive} active schedules`,
      );
    }
    const id = `sched_${randomUUID()}`;
    const stored = this.store.insert({
      id,
      instanceId: input.instanceId,
      recipient,
      messageType: input.content.type,
      payloadJson: JSON.stringify(input.content),
      timezone: parsed.timezone,
      recurrence: parsed.recurrence,
      scheduledAt: parsed.scheduledAt,
      nextRunAt: parsed.nextRunAt,
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

  // Pause and cancel stay available while the worker is off so overdue rows
  // can be stopped before WA_SCHEDULER_ENABLED is turned back on.
  pause(instanceId: string, id: string): ScheduleView {
    return this.transition(instanceId, id, ["active"], "paused", "paused");
  }

  resume(instanceId: string, id: string): ScheduleView {
    this.assertEnabled();
    return this.transition(instanceId, id, ["paused"], "active", "resumed");
  }

  cancel(instanceId: string, id: string): ScheduleView {
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
    if (this.activeTick) return { dispatched: 0, skipped: 0 };
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.activeTick = done;
    try {
      return await this.runTick();
    } finally {
      this.activeTick = null;
      resolveDone();
    }
  }

  private async runTick(): Promise<TickResult> {
    if (!this.settings().enabled) return { dispatched: 0, skipped: 0 };
    const result: TickResult = { dispatched: 0, skipped: 0 };
    for (const expired of await this.store.listExpiredLeases(this.now())) {
      await this.advanceWithoutSend(expired, INTERRUPTED_REASON, "failed");
      result.skipped += 1;
    }
    const blocked = new Set<string>();
    for (let count = 0; count < SCHEDULER_MAX_PER_TICK; count++) {
      const job = await this.store.claimNext(
        this.now(),
        this.now() + SCHEDULER_LEASE_MS,
        randomUUID(),
        [...blocked],
      );
      if (!job) break;
      const outcome = await this.processClaimed(job);
      if (outcome === "sent") result.dispatched += 1;
      else if (outcome === "skipped") result.skipped += 1;
      else blocked.add(job.instanceId);
    }
    return result;
  }

  private async processClaimed(job: ScheduleRecord): Promise<"sent" | "skipped" | "deferred"> {
    if (this.shouldSkipMissed(job)) {
      await this.advanceWithoutSend(job, SKIPPED_REASON, "skipped");
      return "skipped";
    }
    if (job.endAt != null && this.now() > job.endAt) {
      await this.advanceWithoutSend(
        job,
        "schedule ended before the occurrence was sent",
        "completed",
      );
      return "skipped";
    }
    try {
      if (!this.hasDispatchBudget(job.instanceId)) {
        await this.releaseClaim(job);
        logger.debug(
          { scheduleId: job.id, instanceId: job.instanceId },
          "Scheduled send left active until the outbound window has room",
        );
        return "deferred";
      }
      // Lateness is decided again at send time. A row can cross the slack
      // window while earlier sends in this tick are still in flight.
      if (this.shouldSkipMissed(job)) {
        await this.advanceWithoutSend(job, SKIPPED_REASON, "skipped");
        return "skipped";
      }
      const channel = this.resolveChannel(job.instanceId);
      const content = parsePayload(job.payloadJson);
      const queued = await this.enqueue(job.instanceId, job.recipient, content, channel);
      this.noteDispatch(job.instanceId);
      await this.markSent(job, queued.jobId);
      logger.info(
        { scheduleId: job.id, instanceId: job.instanceId, jobId: queued.jobId },
        "Scheduled send queued",
      );
      return "sent";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isPermanent(err)) {
        await this.advanceWithoutSend(job, message, "failed");
        return "skipped";
      }
      const attempts = job.attempts + 1;
      if (attempts >= SCHEDULER_MAX_ATTEMPTS) {
        await this.advanceWithoutSend(job, message, "failed");
        return "skipped";
      }
      await this.store.retry(
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

  private async markSent(job: ScheduleRecord, jobId: string): Promise<void> {
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
    await this.store.finish({
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
  private async advanceWithoutSend(
    job: ScheduleRecord,
    reason: string,
    terminalStatus: ScheduleStatus,
  ): Promise<void> {
    const now = this.now();
    if (job.recurrence === "once") {
      await this.store.finish({
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
      await this.store.finish({
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
    await this.store.finish({
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
    const config = this.configOverride ?? readSchedulerConfig();
    return {
      enabled: config.enabled,
      missedPolicy: config.missedPolicy,
      maxActive: config.maxActive ?? DEFAULT_SCHEDULER_MAX_ACTIVE,
    };
  }

  private shouldSkipMissed(job: ScheduleRecord): boolean {
    const late = this.now() - job.nextRunAt > SCHEDULER_ON_TIME_SLACK_MS;
    return late && this.settings().missedPolicy === "skip";
  }

  private hasDispatchBudget(instanceId: string): boolean {
    const limit = this.limitFor(instanceId);
    const now = this.now();
    const recent = (this.dispatchedAt.get(instanceId) ?? []).filter(
      (at) => now - at < SCHEDULER_RATE_WINDOW_MS,
    );
    this.dispatchedAt.set(instanceId, recent);
    return recent.length < limit;
  }

  private noteDispatch(instanceId: string): void {
    const now = this.now();
    const recent = (this.dispatchedAt.get(instanceId) ?? []).filter(
      (at) => now - at < SCHEDULER_RATE_WINDOW_MS,
    );
    recent.push(now);
    this.dispatchedAt.set(instanceId, recent);
  }

  private limitFor(instanceId: string): number {
    if (this.rateLimitFor) {
      const limit = this.rateLimitFor(instanceId);
      if (!Number.isSafeInteger(limit) || limit < 1) {
        return outboundRateLimit("baileys");
      }
      return limit;
    }
    return outboundRateLimit(this.resolveChannel(instanceId));
  }

  private async releaseClaim(job: ScheduleRecord): Promise<void> {
    const now = this.now();
    // The row was not late when it was picked up. Waiting for the outbound
    // limiter must not turn that wait into a missed run.
    const nextRunAt = Math.max(job.nextRunAt, now);
    if (await this.store.release(job.id, job.leaseToken, now, nextRunAt)) return;
    await this.store.setStatus(job.instanceId, job.id, ["running"], "active", now);
  }
}

export function createIdleScheduler(): MessageScheduler {
  return new MessageScheduler({
    sqlite: new Database(":memory:"),
    enqueue: async () => ({ jobId: "idle" }),
    resolveChannel: () => "baileys",
    config: { enabled: false, missedPolicy: "skip", maxActive: DEFAULT_SCHEDULER_MAX_ACTIVE },
  });
}

function outboundRateLimit(channel: ChannelType): number {
  const cloud = channel === "cloud";
  const fallback = cloud ? DEFAULT_CLOUD_RATE_LIMIT : DEFAULT_BAILEYS_RATE_LIMIT;
  const variable = cloud ? "WA_CLOUD_RATE_LIMIT" : "WA_BAILEYS_RATE_LIMIT";
  const parsed = Number(process.env[variable] ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return parsed;
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
      throw new SchedulePermanentError("Invalid scheduled payload");
    }
    return value;
  } catch (err) {
    if (isPermanent(err)) throw err;
    throw new SchedulePermanentError("Invalid scheduled payload", { cause: err });
  }
}

function isPermanent(err: unknown): boolean {
  if (err instanceof SchedulePermanentError) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === SCHEDULE_PERMANENT_CODE
  );
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
