import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_SCHEDULER_TIMEZONE } from "../src/constants.js";
import { createScheduledMessagesTable } from "../src/db/scheduled-messages.js";
import { ScheduleMessageSchema } from "../src/schemas/schedule.schema.js";
import { nextOccurrence, zonedParts, zonedWallTimeToEpoch } from "../src/services/schedule-clock.js";
import { readSchedulerConfig } from "../src/services/schedule-config.js";
import { MessageScheduler } from "../src/services/scheduler.js";
import { registerScheduleTools } from "../src/tools/schedule.tools.js";
import type { ChannelType, MessageContent } from "../src/types/channel.types.js";

const INSTANCE_ID = "inst-sched";

function openDatabase(path = ":memory:") {
  const sqlite = new Database(path);
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  createScheduledMessagesTable(sqlite);
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO instances (id, name, channel, status, created_at, updated_at)
       VALUES (?, 'scheduled', 'baileys', 'connected', 1, 1)`,
    )
    .run(INSTANCE_ID);
  return sqlite;
}

function harness(options: {
  now: () => number;
  enabled?: boolean;
  missedPolicy?: "skip" | "send";
  path?: string;
}) {
  const sent: Array<{ to: string; content: MessageContent; channel: ChannelType }> = [];
  const sqlite = openDatabase(options.path);
  const enqueue = vi.fn(
    async (_instanceId: string, to: string, content: MessageContent, channel: ChannelType) => {
      sent.push({ to, content, channel });
      return { jobId: `job-${sent.length}` };
    },
  );
  const scheduler = new MessageScheduler({
    sqlite,
    enqueue,
    resolveChannel: () => "baileys",
    instanceExists: (instanceId) => {
      if (instanceId !== INSTANCE_ID) throw new Error(`Instance ${instanceId} not found`);
    },
    now: options.now,
    config: {
      enabled: options.enabled ?? true,
      missedPolicy: options.missedPolicy ?? "skip",
    },
  });
  return { scheduler, sent, enqueue, sqlite };
}

describe("schedule clock", () => {
  it("uses America/Bahia as the default timezone", () => {
    expect(DEFAULT_SCHEDULER_TIMEZONE).toBe("America/Bahia");
  });

  it("repeats a daily wall clock in America/Bahia", () => {
    const scheduledAt = Date.parse("2026-10-21T09:00:00-03:00");
    const next = nextOccurrence(
      {
        scheduledAt,
        timezone: "America/Bahia",
        recurrence: "daily",
        weekdays: [],
        dayOfMonth: null,
        endAt: null,
      },
      scheduledAt,
    );
    expect(next).toBe(Date.parse("2026-10-22T09:00:00-03:00"));
    expect(zonedParts(next!, "America/Bahia").hour).toBe(9);
  });

  it("keeps the next daily occurrence on the timezone wall clock across a DST change", () => {
    const scheduledAt = Date.parse("2026-03-07T12:00:00Z");
    const next = nextOccurrence(
      {
        scheduledAt,
        timezone: "America/New_York",
        recurrence: "daily",
        weekdays: [],
        dayOfMonth: null,
        endAt: null,
      },
      scheduledAt,
    );
    expect(zonedParts(scheduledAt, "America/New_York").hour).toBe(7);
    expect(next).toBe(Date.parse("2026-03-08T11:00:00Z"));
  });

  it("selects the next listed weekday", () => {
    const scheduledAt = Date.parse("2026-10-21T09:00:00-03:00");
    const next = nextOccurrence(
      {
        scheduledAt,
        timezone: "America/Bahia",
        recurrence: "weekly",
        weekdays: [1],
        dayOfMonth: null,
        endAt: null,
      },
      scheduledAt,
    );
    expect(new Date(next!).toISOString()).toBe("2026-10-26T12:00:00.000Z");
    expect(zonedParts(next!, "America/Bahia").weekday).toBe(1);
  });

  it("clamps a monthly day to the last day of a short month", () => {
    const scheduledAt = Date.parse("2026-01-31T09:00:00-03:00");
    const next = nextOccurrence(
      {
        scheduledAt,
        timezone: "America/Bahia",
        recurrence: "monthly",
        weekdays: [],
        dayOfMonth: 31,
        endAt: null,
      },
      scheduledAt,
    );
    expect(zonedParts(next!, "America/Bahia")).toMatchObject({
      year: 2026,
      month: 2,
      day: 28,
      hour: 9,
    });
  });

  it("does not schedule another occurrence for a one-shot", () => {
    expect(
      nextOccurrence(
        {
          scheduledAt: Date.parse("2026-10-21T12:00:00Z"),
          timezone: "America/Bahia",
          recurrence: "once",
          weekdays: [],
          dayOfMonth: null,
          endAt: null,
        },
        Date.parse("2026-10-21T12:00:00Z"),
      ),
    ).toBeNull();
  });

  it("stops a series at endAt", () => {
    const scheduledAt = Date.parse("2026-10-21T09:00:00-03:00");
    expect(
      nextOccurrence(
        {
          scheduledAt,
          timezone: "America/Bahia",
          recurrence: "daily",
          weekdays: [],
          dayOfMonth: null,
          endAt: Date.parse("2026-10-22T08:00:00-03:00"),
        },
        scheduledAt,
      ),
    ).toBeNull();
  });

  it("pushes a wall time inside a DST gap forward", () => {
    const epoch = zonedWallTimeToEpoch(2026, 3, 8, 2, 30, 0, "America/New_York");
    const parts = zonedParts(epoch, "America/New_York");
    expect(parts.hour).toBeGreaterThanOrEqual(3);
    expect(parts.day).toBe(8);
  });
});

describe("scheduler config", () => {
  const previousEnabled = process.env.WA_SCHEDULER_ENABLED;
  const previousPolicy = process.env.WA_SCHEDULER_MISSED_POLICY;

  afterEach(() => {
    if (previousEnabled === undefined) delete process.env.WA_SCHEDULER_ENABLED;
    else process.env.WA_SCHEDULER_ENABLED = previousEnabled;
    if (previousPolicy === undefined) delete process.env.WA_SCHEDULER_MISSED_POLICY;
    else process.env.WA_SCHEDULER_MISSED_POLICY = previousPolicy;
  });

  it("defaults to disabled and skip", () => {
    delete process.env.WA_SCHEDULER_ENABLED;
    delete process.env.WA_SCHEDULER_MISSED_POLICY;
    expect(readSchedulerConfig()).toEqual({ enabled: false, missedPolicy: "skip" });
  });

  it("accepts true and send", () => {
    process.env.WA_SCHEDULER_ENABLED = "true";
    process.env.WA_SCHEDULER_MISSED_POLICY = "send";
    expect(readSchedulerConfig()).toEqual({ enabled: true, missedPolicy: "send" });
  });

  it("rejects invalid values", () => {
    process.env.WA_SCHEDULER_ENABLED = "yes";
    expect(() => readSchedulerConfig()).toThrow(/WA_SCHEDULER_ENABLED/);
    process.env.WA_SCHEDULER_ENABLED = "false";
    process.env.WA_SCHEDULER_MISSED_POLICY = "drop";
    expect(() => readSchedulerConfig()).toThrow(/WA_SCHEDULER_MISSED_POLICY/);
  });
});

describe("scheduled sends", () => {
  it("sends a daily schedule at the next due time after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wamcp-sched-"));
    const path = join(dir, "whatsapp.db");
    let now = Date.parse("2026-10-20T12:00:00Z");
    const first = harness({ now: () => now, path });
    const created = first.scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000001",
      scheduledAt: "2026-10-21T09:00:00-03:00",
      recurrence: "daily",
      content: { type: "text", text: "daily hello" },
    });
    expect(created.timezone).toBe("America/Bahia");
    expect(created.scheduledAt).toBe("2026-10-21T12:00:00.000Z");
    first.sqlite.close();

    now = Date.parse("2026-10-21T12:00:00Z");
    const restarted = harness({ now: () => now, path });
    const tick = await restarted.scheduler.tick();
    expect(tick.dispatched).toBe(1);
    expect(restarted.sent).toEqual([
      {
        to: "5500000000001",
        content: { type: "text", text: "daily hello" },
        channel: "baileys",
      },
    ]);
    const listed = restarted.scheduler.list({ instanceId: INSTANCE_ID });
    expect(listed.schedules[0]?.occurrenceCount).toBe(1);
    expect(listed.schedules[0]?.nextRunAt).toBe("2026-10-22T12:00:00.000Z");
    expect(listed.schedules[0]?.status).toBe("active");
    restarted.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips an occurrence missed during downtime and waits for the following slot", async () => {
    let now = Date.parse("2026-10-20T12:00:00Z");
    const { scheduler, sent } = harness({ now: () => now, missedPolicy: "skip" });
    scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000001",
      scheduledAt: "2026-10-21T09:00:00-03:00",
      recurrence: "daily",
      content: { type: "text", text: "skip me" },
    });
    now = Date.parse("2026-10-21T15:00:00Z");
    const tick = await scheduler.tick();
    expect(tick).toEqual({ dispatched: 0, skipped: 1 });
    expect(sent).toEqual([]);
    const listed = scheduler.list({ instanceId: INSTANCE_ID });
    expect(listed.schedules[0]?.status).toBe("active");
    expect(listed.schedules[0]?.nextRunAt).toBe("2026-10-22T12:00:00.000Z");
    expect(listed.schedules[0]?.occurrenceCount).toBe(0);
    expect(listed.schedules[0]?.lastError).toMatch(/skipped/);
  });

  it("sends one catch-up message when the missed policy is send", async () => {
    let now = Date.parse("2026-10-20T12:00:00Z");
    const { scheduler, sent } = harness({ now: () => now, missedPolicy: "send" });
    scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000001",
      scheduledAt: "2026-10-21T09:00:00-03:00",
      recurrence: "daily",
      content: { type: "text", text: "catch up" },
    });
    now = Date.parse("2026-10-23T15:00:00Z");
    await scheduler.tick();
    expect(sent).toHaveLength(1);
    const listed = scheduler.list({ instanceId: INSTANCE_ID });
    expect(listed.schedules[0]?.occurrenceCount).toBe(1);
    expect(listed.schedules[0]?.nextRunAt).toBe("2026-10-24T12:00:00.000Z");
  });

  it("still sends a one-shot that is only slightly late", async () => {
    let now = Date.parse("2026-10-20T12:00:00Z");
    const { scheduler, sent } = harness({ now: () => now, missedPolicy: "skip" });
    scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000001",
      scheduledAt: "2026-10-21T09:00:00-03:00",
      content: { type: "text", text: "on time" },
    });
    now = Date.parse("2026-10-21T12:00:30Z");
    await scheduler.tick();
    expect(sent).toHaveLength(1);
    expect(scheduler.list({ instanceId: INSTANCE_ID }).schedules[0]?.status).toBe("completed");
  });

  it("marks a one-shot missed under skip and does not send it", async () => {
    let now = Date.parse("2026-10-20T12:00:00Z");
    const { scheduler, sent } = harness({ now: () => now, missedPolicy: "skip" });
    scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000001",
      scheduledAt: "2026-10-21T09:00:00-03:00",
      content: { type: "text", text: "too late" },
    });
    now = Date.parse("2026-10-21T15:00:00Z");
    await scheduler.tick();
    expect(sent).toEqual([]);
    expect(scheduler.list({ instanceId: INSTANCE_ID }).schedules[0]?.status).toBe("skipped");
  });

  it("does not send a paused or cancelled schedule", async () => {
    let now = Date.parse("2026-10-20T12:00:00Z");
    const { scheduler, sent } = harness({ now: () => now });
    const paused = scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000001",
      scheduledAt: "2026-10-21T09:00:00-03:00",
      content: { type: "text", text: "paused" },
    });
    const cancelled = scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000002",
      scheduledAt: "2026-10-21T09:05:00-03:00",
      content: { type: "text", text: "cancelled" },
    });
    expect(scheduler.pause(INSTANCE_ID, paused.id).status).toBe("paused");
    expect(scheduler.cancel(INSTANCE_ID, cancelled.id).status).toBe("cancelled");
    now = Date.parse("2026-10-21T12:10:00Z");
    await scheduler.tick();
    expect(sent).toEqual([]);
    expect(scheduler.list({ instanceId: INSTANCE_ID, status: "paused" }).total).toBe(1);
  });

  it("sends nothing while the scheduler is disabled", async () => {
    let now = Date.parse("2026-10-21T12:00:00Z");
    const { scheduler, sent, sqlite } = harness({ now: () => now, enabled: false });
    sqlite
      .prepare(
        `INSERT INTO scheduled_messages (
          id, instance_id, recipient, message_type, payload_json, timezone, recurrence,
          scheduled_at, next_run_at, occurrence_count, attempts, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'text', ?, 'America/Bahia', 'once', ?, ?, 0, 0, 'active', ?, ?)`,
      )
      .run(
        "sched-disabled",
        INSTANCE_ID,
        "5500000000001",
        JSON.stringify({ type: "text", text: "nope" }),
        now,
        now,
        now,
        now,
      );
    expect(await scheduler.tick()).toEqual({ dispatched: 0, skipped: 0 });
    expect(sent).toEqual([]);
    expect(() =>
      scheduler.create({
        instanceId: INSTANCE_ID,
        to: "5500000000001",
        scheduledAt: "2026-10-22T09:00:00-03:00",
        content: { type: "text", text: "blocked" },
      }),
    ).toThrow(/WA_SCHEDULER_ENABLED=true/);
    expect(scheduler.list({ instanceId: INSTANCE_ID }).total).toBe(1);
  });

  it("rejects a private media URL before storing it", () => {
    const { scheduler } = harness({ now: () => Date.parse("2026-10-20T12:00:00Z") });
    expect(() =>
      scheduler.create({
        instanceId: INSTANCE_ID,
        to: "5500000000001",
        scheduledAt: "2026-10-21T09:00:00-03:00",
        content: { type: "image", image: "http://127.0.0.1/secret.png" },
      }),
    ).toThrow(/HTTPS/);
  });

  it("does not resend an interrupted one-shot", async () => {
    let now = Date.parse("2026-10-21T12:00:00Z");
    const { scheduler, sent, sqlite } = harness({ now: () => now, missedPolicy: "send" });
    sqlite
      .prepare(
        `INSERT INTO scheduled_messages (
          id, instance_id, recipient, message_type, payload_json, timezone, recurrence,
          scheduled_at, next_run_at, occurrence_count, attempts, status, lease_token, lease_until,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'text', ?, 'America/Bahia', 'once', ?, ?, 0, 1, 'running', 'lease', ?, ?, ?)`,
      )
      .run(
        "sched-interrupted",
        INSTANCE_ID,
        "5500000000001",
        JSON.stringify({ type: "text", text: "maybe sent" }),
        now - 60_000,
        now - 60_000,
        now - 1_000,
        now,
        now,
      );
    await scheduler.tick();
    expect(sent).toEqual([]);
    expect(scheduler.list({ instanceId: INSTANCE_ID }).schedules[0]?.status).toBe("failed");
  });
});

describe("schedule tools", () => {
  it("rejects unknown fields and reports the disabled gate", async () => {
    const parsed = ScheduleMessageSchema.safeParse({
      instanceId: INSTANCE_ID,
      to: "5500000000001",
      scheduledAt: "2026-10-21T09:00:00-03:00",
      content: { type: "text", text: "hello" },
      extra: true,
    });
    expect(parsed.success).toBe(false);

    const tools = new Map<string, (params: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>>();
    const server = {
      registerTool(name: string, _config: unknown, handler: (params: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>) {
        tools.set(name, handler);
      },
    } as unknown as McpServer;
    const { scheduler } = harness({
      now: () => Date.parse("2026-10-20T12:00:00Z"),
      enabled: false,
    });
    registerScheduleTools(server, scheduler);
    expect([...tools.keys()]).toEqual([
      "wa_schedule_message",
      "wa_list_scheduled",
      "wa_pause_scheduled",
      "wa_resume_scheduled",
      "wa_cancel_scheduled",
    ]);
    const result = await tools.get("wa_schedule_message")!({
      instanceId: INSTANCE_ID,
      to: "5500000000001",
      scheduledAt: "2026-10-21T09:00:00-03:00",
      timezone: "America/Bahia",
      recurrence: "once",
      content: { type: "text", text: "hello" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/WA_SCHEDULER_ENABLED=true/);
  });
});
