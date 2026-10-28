import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/db/client.js";
import { instances, messageReceipts, messages } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import { getDeliverySummary } from "../src/services/delivery-status.js";

let instanceId: string;
const chat = "5500000000001@s.whatsapp.net";
beforeEach(async () => {
  instanceId = randomUUID();
  await db
    .insert(instances)
    .values({
      id: instanceId,
      name: "receipt fixture",
      channel: "cloud",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
});
describe("delivery metadata with either storage driver", () => {
  it("interprets existing Baileys receipt milliseconds without multiplying them again", async () => {
    const baileysId = randomUUID();
    await db
      .insert(instances)
      .values({
        id: baileysId,
        name: "baileys fixture",
        channel: "baileys",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    await db
      .insert(messageReceipts)
      .values({
        instanceId: baileysId,
        chatId: chat,
        messageId: "baileys-message",
        participant: chat,
        status: "read",
        timestamp: 1700000002000,
      })
      .run();
    expect(await getDeliverySummary(baileysId, chat, "baileys-message")).toMatchObject({
      latestObservedAt: "2023-11-14T22:13:22.000Z",
      counts: { read: 1 },
    });
  });
  it("persists cloud receipts without storing message/OTP content and does not regress on out-of-order webhooks", async () => {
    const adapter = new CloudApiAdapter(instanceId);
    const base = { instanceId, chatId: chat, messageId: "wamid.fixture" };
    await adapter.emit("message.updated", { ...base, status: "read", timestamp: 1700000002 });
    await adapter.emit("message.updated", { ...base, status: "delivered", timestamp: 1700000003 });
    await adapter.emit("message.updated", { ...base, status: "read", timestamp: 1700000001 });
    expect(await getDeliverySummary(instanceId, chat, base.messageId)).toEqual({
      counts: { delivered: 0, read: 1, played: 0 },
      latestObservedAt: "2023-11-14T22:13:22.000Z",
      scope: "observed_participants_only",
    });
    expect(
      await db.select().from(messages).where(eq(messages.instanceId, instanceId)).all(),
    ).toEqual([]);
    expect(await getDeliverySummary(instanceId, chat, "missing")).toMatchObject({
      counts: { delivered: 0, read: 0, played: 0 },
      latestObservedAt: null,
    });
    expect(await getDeliverySummary("other", chat, base.messageId)).toMatchObject({
      latestObservedAt: null,
    });
    expect(await getDeliverySummary(instanceId, "other@g.us", base.messageId)).toMatchObject({
      latestObservedAt: null,
    });
  });
  it("aggregates only observed group participants rather than claiming everyone read", async () => {
    for (const [participant, status] of [
      ["a", "delivered"],
      ["b", "read"],
      ["c", "played"],
    ] as const)
      await db
        .insert(messageReceipts)
        .values({
          instanceId,
          chatId: "fixture@g.us",
          messageId: "group-message",
          participant,
          status,
          timestamp: 1700000001000,
        })
        .run();
    const result = await getDeliverySummary(instanceId, "fixture@g.us", "group-message");
    expect(result).toMatchObject({
      counts: { delivered: 1, read: 1, played: 1 },
      scope: "observed_participants_only",
    });
    expect(Object.keys(result).sort()).toEqual(["counts", "latestObservedAt", "scope"]);
  });
});
