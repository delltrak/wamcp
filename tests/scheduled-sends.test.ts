import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_SCHEDULER_TIMEZONE } from "../src/constants.js";
import { createScheduledMessagesTable } from "../src/db/scheduled-messages.js";
import { ScheduleMessageSchema } from "../src/schemas/schedule.schema.js";
import {
  canonicalTimeZone,
  firstOccurrence,
  isValidTimeZone,
  nextOccurrence,
  parseScheduleRequest,
  zonedParts,
  zonedWallTimeToEpoch,
} from "../src/services/schedule-clock.js";
import { readSchedulerConfig } from "../src/services/schedule-config.js";
import { databaseDialect, type ScheduleSqlDialect } from "../src/services/schedule-store.js";
import { MessageScheduler, SCHEDULE_PERMANENT_CODE } from "../src/services/scheduler.js";
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
  maxActive?: number;
  rateLimit?: number;
  driver?: ScheduleSqlDialect;
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
      maxActive: options.maxActive ?? 100,
    },
    rateLimitFor: options.rateLimit === undefined ? undefined : () => options.rateLimit ?? 1,
    driver: options.driver,
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

  it("moves the first weekly fire to the next listed weekday", () => {
    const scheduledAt = Date.parse("2026-10-20T09:00:00-03:00");
    expect(zonedParts(scheduledAt, "America/Bahia").weekday).toBe(2);
    const spec = {
      scheduledAt,
      timezone: "America/Bahia",
      recurrence: "weekly" as const,
      weekdays: [1],
      dayOfMonth: null,
      endAt: null,
    };
    const first = firstOccurrence(spec);
    expect(new Date(first!).toISOString()).toBe("2026-10-26T12:00:00.000Z");
    expect(zonedParts(first!, "America/Bahia").weekday).toBe(1);
    const monday = Date.parse("2026-10-26T09:00:00-03:00");
    expect(firstOccurrence({ ...spec, scheduledAt: monday })).toBe(monday);
  });

  it("moves the first monthly fire to dayOfMonth in the same month", () => {
    const scheduledAt = Date.parse("2026-10-10T09:00:00-03:00");
    const spec = {
      scheduledAt,
      timezone: "America/Bahia",
      recurrence: "monthly" as const,
      weekdays: [],
      dayOfMonth: 15,
      endAt: null,
    };
    expect(new Date(firstOccurrence(spec)!).toISOString()).toBe("2026-10-15T12:00:00.000Z");
    const onTheDay = Date.parse("2026-10-15T09:00:00-03:00");
    expect(firstOccurrence({ ...spec, scheduledAt: onTheDay })).toBe(onTheDay);
  });

  it("accepts IANA timezone names and rejects offsets, abbreviations, and offset Etc zones", () => {
    expect(isValidTimeZone("America/Bahia")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Etc/UTC")).toBe(true);
    expect(canonicalTimeZone("america/bahia")).toBe("America/Bahia");
    expect(canonicalTimeZone("Etc/UTC")).toBe("UTC");
    expect(canonicalTimeZone("Etc/GMT")).toBe("UTC");
    expect(canonicalTimeZone("GMT")).toBe("UTC");
    expect(canonicalTimeZone("gmt")).toBe("UTC");
    expect(canonicalTimeZone("UCT")).toBe("UTC");
    expect(canonicalTimeZone("Zulu")).toBe("UTC");
    expect(isValidTimeZone("+03:00")).toBe(false);
    expect(isValidTimeZone("EST")).toBe(false);
    expect(isValidTimeZone("WET")).toBe(false);
    expect(isValidTimeZone("Etc/GMT+3")).toBe(false);
    const now = Date.parse("2026-10-20T12:00:00Z");
    expect(() =>
      parseScheduleRequest({ scheduledAt: "2026-10-21T09:00:00-03:00", timezone: "+03:00" }, now),
    ).toThrow(/IANA/);
    expect(() =>
      parseScheduleRequest({ scheduledAt: "2026-10-21T09:00:00-03:00", timezone: "EST" }, now),
    ).toThrow(/IANA/);
    expect(() =>
      parseScheduleRequest(
        { scheduledAt: "2026-10-21T09:00:00-03:00", timezone: "Etc/GMT+3" },
        now,
      ),
    ).toThrow(/IANA/);
    expect(
      parseScheduleRequest(
        { scheduledAt: "2026-10-21T09:00:00-03:00", timezone: "america/bahia" },
        now,
      ).timezone,
    ).toBe("America/Bahia");
    expect(
      parseScheduleRequest({ scheduledAt: "2026-10-21T09:00:00Z", timezone: "Etc/UTC" }, now)
        .timezone,
    ).toBe("UTC");
    expect(
      parseScheduleRequest({ scheduledAt: "2026-10-21T09:00:00Z", timezone: "GMT" }, now).timezone,
    ).toBe("UTC");
    expect(
      parseScheduleRequest({ scheduledAt: "2026-10-21T09:00:00Z", timezone: "UCT" }, now).timezone,
    ).toBe("UTC");
    expect(
      parseScheduleRequest({ scheduledAt: "2026-10-21T09:00:00Z", timezone: "Zulu" }, now).timezone,
    ).toBe("UTC");
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
  const previousMax = process.env.WA_SCHEDULER_MAX_ACTIVE;

  afterEach(() => {
    if (previousEnabled === undefined) delete process.env.WA_SCHEDULER_ENABLED;
    else process.env.WA_SCHEDULER_ENABLED = previousEnabled;
    if (previousPolicy === undefined) delete process.env.WA_SCHEDULER_MISSED_POLICY;
    else process.env.WA_SCHEDULER_MISSED_POLICY = previousPolicy;
    if (previousMax === undefined) delete process.env.WA_SCHEDULER_MAX_ACTIVE;
    else process.env.WA_SCHEDULER_MAX_ACTIVE = previousMax;
  });

  it("selects postgres only when WA_DATABASE_URL is set", () => {
    expect(databaseDialect({})).toBe("sqlite");
    expect(databaseDialect({ WA_DATABASE_URL: "  " })).toBe("sqlite");
    expect(databaseDialect({ WA_DATABASE_URL: "postgres://localhost/db" })).toBe("postgres");
  });

  it("defaults to disabled, skip, and 100 active schedules", () => {
    delete process.env.WA_SCHEDULER_ENABLED;
    delete process.env.WA_SCHEDULER_MISSED_POLICY;
    delete process.env.WA_SCHEDULER_MAX_ACTIVE;
    expect(readSchedulerConfig()).toEqual({ enabled: false, missedPolicy: "skip", maxActive: 100 });
  });

  it("accepts true and send", () => {
    process.env.WA_SCHEDULER_ENABLED = "true";
    process.env.WA_SCHEDULER_MISSED_POLICY = "send";
    process.env.WA_SCHEDULER_MAX_ACTIVE = "25";
    expect(readSchedulerConfig()).toEqual({ enabled: true, missedPolicy: "send", maxActive: 25 });
  });

  it("rejects invalid values", () => {
    process.env.WA_SCHEDULER_ENABLED = "yes";
    expect(() => readSchedulerConfig()).toThrow(/WA_SCHEDULER_ENABLED/);
    process.env.WA_SCHEDULER_ENABLED = "false";
    process.env.WA_SCHEDULER_MISSED_POLICY = "drop";
    expect(() => readSchedulerConfig()).toThrow(/WA_SCHEDULER_MISSED_POLICY/);
    process.env.WA_SCHEDULER_MISSED_POLICY = "skip";
    process.env.WA_SCHEDULER_MAX_ACTIVE = "0";
    expect(() => readSchedulerConfig()).toThrow(/WA_SCHEDULER_MAX_ACTIVE/);
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
        to: "5500000000001@s.whatsapp.net",
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

  it("pauses and cancels overdue rows while the scheduler is disabled", async () => {
    const now = Date.parse("2026-10-21T15:00:00Z");
    const disabled = harness({ now: () => now, enabled: false, missedPolicy: "send" });
    insertDue(disabled.sqlite, "sched-pause", now - 60 * 60_000, "paused later");
    insertDue(disabled.sqlite, "sched-cancel", now - 60 * 60_000, "cancelled later");
    insertDue(disabled.sqlite, "sched-keep", now - 60 * 60_000, "still due");
    expect(disabled.scheduler.pause(INSTANCE_ID, "sched-pause").status).toBe("paused");
    expect(disabled.scheduler.cancel(INSTANCE_ID, "sched-cancel").status).toBe("cancelled");
    expect(() => disabled.scheduler.resume(INSTANCE_ID, "sched-pause")).toThrow(
      /WA_SCHEDULER_ENABLED=true/,
    );

    const enabled = new MessageScheduler({
      sqlite: disabled.sqlite,
      enqueue: disabled.enqueue,
      resolveChannel: () => "baileys",
      now: () => now,
      config: { enabled: true, missedPolicy: "send", maxActive: 100 },
    });
    const tick = await enabled.tick();
    expect(tick.dispatched).toBe(1);
    expect(disabled.sent.map((row) => row.content)).toEqual([{ type: "text", text: "still due" }]);
    expect(enabled.list({ instanceId: INSTANCE_ID, status: "paused" }).total).toBe(1);
    expect(enabled.list({ instanceId: INSTANCE_ID, status: "cancelled" }).total).toBe(1);
  });

  it("stores the first weekly and monthly slot instead of scheduledAt", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    const { scheduler } = harness({ now: () => now });
    const weekly = scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000001",
      scheduledAt: "2026-10-20T09:00:00-03:00",
      recurrence: "weekly",
      weekdays: [1],
      content: { type: "text", text: "monday" },
    });
    expect(weekly.scheduledAt).toBe("2026-10-20T12:00:00.000Z");
    expect(weekly.nextRunAt).toBe("2026-10-26T12:00:00.000Z");
    expect(weekly.to).toBe("5500000000001@s.whatsapp.net");

    const monthly = scheduler.create({
      instanceId: INSTANCE_ID,
      to: "120363000000000000@g.us",
      scheduledAt: "2026-10-10T09:00:00-03:00",
      recurrence: "monthly",
      dayOfMonth: 15,
      content: { type: "text", text: "fifteenth" },
    });
    expect(monthly.nextRunAt).toBe("2026-10-15T12:00:00.000Z");
    expect(monthly.to).toBe("120363000000000000@g.us");
  });

  it("rejects a recipient that is not a phone number or group JID", () => {
    const { scheduler } = harness({ now: () => Date.parse("2026-10-20T12:00:00Z") });
    for (const to of ["hello there", "status@broadcast", "1234567890@newsletter"]) {
      expect(() =>
        scheduler.create({
          instanceId: INSTANCE_ID,
          to,
          scheduledAt: "2026-10-21T09:00:00-03:00",
          content: { type: "text", text: "nope" },
        }),
      ).toThrow(/Invalid recipient/);
    }
  });

  it("rejects scheduledAt more than a year ahead", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    const { scheduler } = harness({ now: () => now });
    expect(() =>
      scheduler.create({
        instanceId: INSTANCE_ID,
        to: "5500000000001",
        scheduledAt: new Date(now + 366 * 24 * 60 * 60 * 1000).toISOString(),
        content: { type: "text", text: "too far" },
      }),
    ).toThrow(/1 year/);
  });

  it("counts a recurring schedule toward the cap and still allows cancel", () => {
    let now = Date.parse("2026-10-20T12:00:00Z");
    const { scheduler, sent } = harness({ now: () => now, maxActive: 1 });
    const recurring = scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000001",
      scheduledAt: "2026-10-21T09:00:00-03:00",
      recurrence: "daily",
      content: { type: "text", text: "one slot" },
    });
    expect(() =>
      scheduler.create({
        instanceId: INSTANCE_ID,
        to: "5500000000002",
        scheduledAt: "2026-10-21T10:00:00-03:00",
        content: { type: "text", text: "second" },
      }),
    ).toThrow(/maximum of 1 active schedules/);
    now = Date.parse("2026-10-21T12:00:00Z");
    return scheduler.tick().then(async () => {
      expect(sent).toHaveLength(1);
      expect(scheduler.list({ instanceId: INSTANCE_ID }).schedules[0]?.status).toBe("active");
      expect(() =>
        scheduler.create({
          instanceId: INSTANCE_ID,
          to: "5500000000002",
          scheduledAt: "2026-10-22T10:00:00-03:00",
          content: { type: "text", text: "still full" },
        }),
      ).toThrow(/maximum of 1/);
      expect(scheduler.cancel(INSTANCE_ID, recurring.id).status).toBe("cancelled");
      const replacement = scheduler.create({
        instanceId: INSTANCE_ID,
        to: "+55 (00) 00000-0002",
        scheduledAt: "2026-10-22T10:00:00-03:00",
        content: { type: "text", text: "after cancel" },
      });
      expect(replacement.to).toBe("5500000000002@s.whatsapp.net");
    });
  });

  it("sends a missed backlog only as fast as the outbound rate limit", async () => {
    let now = Date.parse("2026-10-20T12:00:00Z");
    const { scheduler, sent } = harness({
      now: () => now,
      missedPolicy: "send",
      rateLimit: 1,
    });
    scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000001",
      scheduledAt: "2026-10-21T09:00:00-03:00",
      content: { type: "text", text: "first" },
    });
    const recurring = scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000002",
      scheduledAt: "2026-10-21T09:05:00-03:00",
      recurrence: "daily",
      content: { type: "text", text: "daily" },
    });
    scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000003",
      scheduledAt: "2026-10-21T09:10:00-03:00",
      content: { type: "text", text: "third" },
    });
    now = Date.parse("2026-10-21T15:00:00Z");
    const first = await scheduler.tick();
    expect(first).toEqual({ dispatched: 1, skipped: 0 });
    expect(sent).toHaveLength(1);
    const waiting = scheduler.list({ instanceId: INSTANCE_ID, status: "active" });
    expect(waiting.total).toBe(2);
    expect(waiting.schedules.map((row) => row.id).sort()).toEqual(
      [recurring.id, waiting.schedules.find((row) => row.recurrence === "once")?.id].sort(),
    );
    expect(
      scheduler.list({ instanceId: INSTANCE_ID }).schedules.find((row) => row.id === recurring.id)
        ?.nextRunAt,
    ).toBe("2026-10-21T15:00:00.000Z");

    expect((await scheduler.tick()).dispatched).toBe(0);
    expect(sent).toHaveLength(1);
    expect(scheduler.cancel(INSTANCE_ID, recurring.id).status).toBe("cancelled");

    now += 60_000;
    const third = await scheduler.tick();
    expect(third.dispatched).toBe(1);
    expect(sent).toHaveLength(2);
    expect(scheduler.list({ instanceId: INSTANCE_ID, status: "active" }).total).toBe(0);
    expect(scheduler.list({ instanceId: INSTANCE_ID, status: "cancelled" }).total).toBe(1);
  });

  it("uses postgres row locks when that driver is selected", async () => {
    let now = Date.parse("2026-10-20T12:00:00Z");
    const { scheduler } = harness({ now: () => now, driver: "postgres" });
    scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000001",
      scheduledAt: "2026-10-21T09:00:00-03:00",
      content: { type: "text", text: "locked" },
    });
    now = Date.parse("2026-10-21T12:00:00Z");
    await expect(scheduler.tick()).rejects.toThrow(/syntax error/);
  });

  it("claims sends that share a due time in creation order", async () => {
    let now = Date.parse("2026-10-20T12:00:00Z");
    const { scheduler, sent } = harness({ now: () => now, rateLimit: 1 });
    const first = scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000001",
      scheduledAt: "2026-10-21T09:00:00-03:00",
      content: { type: "text", text: "first" },
    });
    const second = scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000002",
      scheduledAt: "2026-10-21T09:00:00-03:00",
      content: { type: "text", text: "second" },
    });
    expect(scheduler.list({ instanceId: INSTANCE_ID }).schedules.map((row) => row.id)).toEqual([
      first.id,
      second.id,
    ]);
    now = Date.parse("2026-10-21T12:00:00Z");
    await scheduler.tick();
    expect(sent.map((row) => row.content)).toEqual([{ type: "text", text: "first" }]);
    now += 60_000;
    await scheduler.tick();
    expect(sent.map((row) => row.content)).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });

  it("does not skip on-time rows that wait for the send rate limit", async () => {
    let now = Date.parse("2026-10-20T12:00:00Z");
    const { scheduler, sent } = harness({
      now: () => now,
      missedPolicy: "skip",
      rateLimit: 2,
    });
    for (let index = 0; index < 8; index++) {
      scheduler.create({
        instanceId: INSTANCE_ID,
        to: `550000000000${index + 1}`,
        scheduledAt: "2026-10-21T09:00:00-03:00",
        content: { type: "text", text: `slot ${index}` },
      });
    }
    now = Date.parse("2026-10-21T12:00:00Z");
    for (let minute = 0; minute < 4; minute++) {
      await scheduler.tick();
      now += 60_000;
    }
    expect(sent).toHaveLength(8);
    expect(scheduler.list({ instanceId: INSTANCE_ID, status: "skipped" }).total).toBe(0);
    expect(scheduler.list({ instanceId: INSTANCE_ID, status: "completed" }).total).toBe(8);
  });

  it("skips an overdue backlog without waiting for send budget", async () => {
    let now = Date.parse("2026-10-20T12:00:00Z");
    const { scheduler, sent } = harness({
      now: () => now,
      missedPolicy: "skip",
      rateLimit: 1,
    });
    for (let index = 0; index < 4; index++) {
      scheduler.create({
        instanceId: INSTANCE_ID,
        to: `550000000000${index}`,
        scheduledAt: "2026-10-21T09:00:00-03:00",
        content: { type: "text", text: `late ${index}` },
      });
    }
    now = Date.parse("2026-10-21T15:00:00Z");
    const tick = await scheduler.tick();
    expect(tick).toEqual({ dispatched: 0, skipped: 4 });
    expect(sent).toEqual([]);
    expect(scheduler.list({ instanceId: INSTANCE_ID, status: "skipped" }).total).toBe(4);
  });

  it("applies the missed policy again immediately before enqueue", async () => {
    let now = Date.parse("2026-10-20T12:00:00Z");
    const { scheduler, sent, enqueue } = harness({
      now: () => now,
      missedPolicy: "skip",
      rateLimit: 10,
    });
    scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000001",
      scheduledAt: "2026-10-21T09:00:00-03:00",
      content: { type: "text", text: "on time" },
    });
    scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000002",
      scheduledAt: "2026-10-21T09:00:00-03:00",
      content: { type: "text", text: "becomes late" },
    });
    now = Date.parse("2026-10-21T12:00:30Z");
    enqueue.mockImplementation(async (_instanceId, to, content, channel) => {
      now = Date.parse("2026-10-21T12:10:00Z");
      sent.push({ to, content, channel });
      return { jobId: `job-${sent.length}` };
    });
    const tick = await scheduler.tick();
    expect(tick).toEqual({ dispatched: 1, skipped: 1 });
    expect(sent).toHaveLength(1);
    expect(scheduler.list({ instanceId: INSTANCE_ID, status: "skipped" }).total).toBe(1);
  });

  it("retries an error that only mentions not found, and fails a permanent code", async () => {
    let now = Date.parse("2026-10-20T12:00:00Z");
    const { scheduler, sent, enqueue } = harness({ now: () => now, missedPolicy: "skip" });
    const created = scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000001",
      scheduledAt: "2026-10-21T09:00:00-03:00",
      content: { type: "text", text: "retry me" },
    });
    now = Date.parse("2026-10-21T12:00:00Z");
    enqueue.mockRejectedValue(new Error("contact not found"));
    await scheduler.tick();
    expect(sent).toEqual([]);
    let listed = scheduler.list({ instanceId: INSTANCE_ID }).schedules[0];
    expect(listed?.status).toBe("active");
    expect(listed?.attempts).toBe(1);
    expect(listed?.lastError).toMatch(/contact not found/);

    now += 30_000;
    const permanent = new Error("recipient rejected");
    Object.assign(permanent, { code: SCHEDULE_PERMANENT_CODE });
    enqueue.mockRejectedValue(permanent);
    await scheduler.tick();
    listed = scheduler.list({ instanceId: INSTANCE_ID }).schedules[0];
    expect(listed?.id).toBe(created.id);
    expect(listed?.status).toBe("failed");
    expect(sent).toEqual([]);
  });

  it("waits for an in-flight tick before stop resolves", async () => {
    let now = Date.parse("2026-10-20T12:00:00Z");
    let release: (() => void) | undefined;
    const { scheduler, enqueue } = harness({ now: () => now });
    scheduler.create({
      instanceId: INSTANCE_ID,
      to: "5500000000001",
      scheduledAt: "2026-10-21T09:00:00-03:00",
      content: { type: "text", text: "hold" },
    });
    enqueue.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ jobId: "job-held" });
        }),
    );
    now = Date.parse("2026-10-21T12:00:00Z");
    const ticking = scheduler.tick();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalled());
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release?.();
    await stopping;
    await ticking;
    expect(stopped).toBe(true);
  });
});

function insertDue(sqlite: Database, id: string, nextRunAt: number, text: string): void {
  const now = nextRunAt;
  sqlite
    .prepare(
      `INSERT INTO scheduled_messages (
        id, instance_id, recipient, message_type, payload_json, timezone, recurrence,
        scheduled_at, next_run_at, occurrence_count, attempts, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'text', ?, 'America/Bahia', 'once', ?, ?, 0, 0, 'active', ?, ?)`,
    )
    .run(
      id,
      INSTANCE_ID,
      "5500000000009@s.whatsapp.net",
      JSON.stringify({ type: "text", text }),
      nextRunAt,
      nextRunAt,
      now,
      now,
    );
}

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

    const tools = new Map<
      string,
      (
        params: Record<string, unknown>,
      ) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>
    >();
    const server = {
      registerTool(
        name: string,
        _config: unknown,
        handler: (
          params: Record<string, unknown>,
        ) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>,
      ) {
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
