import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { instances, messages, statusAudiences } from "../src/db/schema.js";
import { MaintenanceService } from "../src/services/maintenance.js";
import type { InstanceManager } from "../src/services/instance-manager.js";

describe("maintenance message retention", () => {
  const instanceId = `maintenance_${randomUUID()}`;

  beforeEach(async () => {
    vi.stubEnv("WA_MESSAGE_RETENTION_DAYS", "30");
    const now = Date.now();
    (await db.insert(instances)
      .values({ id: instanceId, name: "test", createdAt: now, updatedAt: now })
      .run());
  });

  afterEach(async () => {
    (await db.delete(instances).where(eq(instances.id, instanceId)).run());
    vi.unstubAllEnvs();
  });

  it("prunes old second and millisecond messages while keeping recent ones and pruning audiences in milliseconds", async () => {
    const now = Date.now();
    const retentionMs = 30 * 24 * 60 * 60 * 1000;
    const rows = [
      { id: "recent-seconds", timestamp: Math.floor(now / 1000) - 60 },
      { id: "old-seconds", timestamp: Math.floor((now - retentionMs - 60_000) / 1000) },
      { id: "recent-milliseconds", timestamp: now - 60_000 },
      { id: "old-milliseconds", timestamp: now - retentionMs - 60_000 },
    ];
    (await db.insert(messages)
      .values(
        rows.map((row) => ({
          ...row,
          instanceId,
          chatId: "15555550123@s.whatsapp.net",
          senderId: "15555550123@s.whatsapp.net",
          type: "text" as const,
        })),
      )
      .run());

    (await db.insert(statusAudiences)
      .values([
        { instanceId, messageId: "recent-audience", recipientJids: "[]", createdAt: now - 60_000 },
        {
          instanceId,
          messageId: "old-audience",
          recipientJids: "[]",
          createdAt: now - retentionMs - 60_000,
        },
      ])
      .run());

    const service = new MaintenanceService({} as InstanceManager);
    await (service as unknown as { pruneMessages: () => Promise<void> }).pruneMessages();

    const remainingMessages = (await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.instanceId, instanceId))
      .all())
      .map((row) => row.id)
      .sort();
    expect(remainingMessages).toEqual(["recent-milliseconds", "recent-seconds"]);

    const remainingAudiences = (await db
      .select({ messageId: statusAudiences.messageId })
      .from(statusAudiences)
      .where(eq(statusAudiences.instanceId, instanceId))
      .all())
      .map((row) => row.messageId)
      .sort();
    expect(remainingAudiences).toEqual(["recent-audience"]);
  });
});
