import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sqlite, databaseDriver } from "../src/db/client.js";
import { MessageScheduler } from "../src/services/scheduler.js";
import { ScheduleStore } from "../src/services/schedule-store.js";

it("enforces a shared schedule quota and claims once through the active storage driver", async () => {
  const instanceId = `schedule-storage-${randomUUID()}`;
  const now = 1_800_000_000_000;
  await sqlite.prepare("INSERT INTO instances (id, name, created_at, updated_at) VALUES (?, 'schedule', ?, ?)").run(instanceId, now, now);
  const scheduler = () => new MessageScheduler({
    sqlite, driver: databaseDriver, now: () => now,
    config: { enabled: true, missedPolicy: "send", maxActive: 1 },
    enqueue: async () => ({ jobId: "unused" }),
    getJobState: async () => ({ state: "missing" }),
    resolveChannel: async () => "baileys",
  });
  try {
    const input = { instanceId, to: "5511999999999", scheduledAt: new Date(now + 60_000).toISOString(), timezone: "UTC", recurrence: "once" as const, content: { type: "text" as const, text: "test" } };
    const results = await Promise.allSettled([scheduler().create(input), scheduler().create(input)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const store = new ScheduleStore(sqlite, databaseDriver);
    const claims = await Promise.all([store.claimNext(now + 60_000, now + 120_000, "lease-a"), store.claimNext(now + 60_000, now + 120_000, "lease-b")]);
    const claimed = claims.find((row) => row !== null)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claimed.nextRunAt).toBe(now + 60_000);
    expect(await store.setJobId(claimed.id, "stale-lease", "wrong")).toBe(false);
    expect(await store.setJobId(claimed.id, claimed.leaseToken, "queued")).toBe(true);
    expect((await store.listRunning())[0]?.lastJobId).toBe("queued");
  } finally {
    await sqlite.prepare("DELETE FROM instances WHERE id = ?").run(instanceId);
  }
});
