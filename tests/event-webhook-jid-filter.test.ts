import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { BaileysEventMap, WAMessage, WASocket } from "@whiskeysockets/baileys";
import { eq } from "drizzle-orm";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { normalizeMessagesUpsert } from "../src/channels/baileys/baileys.events.js";
import { db } from "../src/db/client.js";
import { instances, messages } from "../src/db/schema.js";
import { loadEventWebhookConfig } from "../src/services/event-webhook-config.js";
import {
  registerEventWebhookHandler,
  shouldSendEventWebhook,
  type EventWebhookJob,
} from "../src/services/event-webhook.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { ChannelEventPayload } from "../src/types/channel.types.js";

const URL = "https://hooks.example.test/receive";

function message(
  overrides: Partial<ChannelEventPayload["message.received"]> = {},
): ChannelEventPayload["message.received"] {
  return {
    instanceId: "inst_1234abcd",
    chatId: "5511888888888@s.whatsapp.net",
    message: {
      id: "wamid.1",
      sender: "5511888888888@s.whatsapp.net",
      timestamp: 1_700_000_000,
      type: "text",
      content: "hello",
      mediaUrl: null,
      quotedMessageId: null,
      isFromMe: false,
    },
    ...overrides,
  };
}

function destination(env: Record<string, string | undefined> = {}) {
  const config = loadEventWebhookConfig({ WA_EVENT_WEBHOOK_URL: URL, ...env });
  const target = config.destinations[0];
  if (!target) throw new Error("expected a destination");
  return target;
}

describe("WA_EVENT_WEBHOOK_IGNORE_JIDS", () => {
  it("stays unset by default and still forwards group traffic", () => {
    const config = loadEventWebhookConfig({ WA_EVENT_WEBHOOK_URL: URL });
    expect(config.destinations[0]).not.toHaveProperty("ignoreJids");
    const group = message({
      chatId: "120363999000111@g.us",
      isGroup: true,
      message: { ...message().message, sender: "5511999999999@s.whatsapp.net" },
    });
    expect(shouldSendEventWebhook("message.received", group, config.destinations[0]!)).toBe(true);
    expect(loadEventWebhookConfig({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "   " }).destinations).toEqual(
      [],
    );
  });

  it("drops newsletter chats for @newsletter and keeps direct chats", () => {
    const target = destination({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "@newsletter" });
    const channel = message({ chatId: "120363000000000119@newsletter" });
    expect(shouldSendEventWebhook("message.received", channel, target)).toBe(false);
    expect(shouldSendEventWebhook("message.received", message(), target)).toBe(true);
  });

  it("drops a prefix wildcard on the chat or the sender", () => {
    const target = destination({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "5577*@s.whatsapp.net" });
    const byChat = message({
      chatId: "557712345678@s.whatsapp.net",
      message: { ...message().message, sender: "5511888888888@s.whatsapp.net" },
    });
    const bySender = message({
      chatId: "5511888888888@s.whatsapp.net",
      message: { ...message().message, sender: "557700000000@s.whatsapp.net" },
    });
    const other = message({
      chatId: "1557712345678@s.whatsapp.net",
      message: { ...message().message, sender: "1557712345678@s.whatsapp.net" },
    });
    expect(shouldSendEventWebhook("message.received", byChat, target)).toBe(false);
    expect(shouldSendEventWebhook("message.received", bySender, target)).toBe(false);
    expect(shouldSendEventWebhook("message.received", other, target)).toBe(true);
    expect(() =>
      loadEventWebhookConfig({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "5577*@evil.com" }),
    ).toThrow(/invalid JID wildcard/);
    expect(() =>
      loadEventWebhookConfig({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "5577**@s.whatsapp.net" }),
    ).toThrow(/invalid JID wildcard/);
  });

  it("drops group chats for @g.us and keeps direct chats", () => {
    const target = destination({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "@g.us" });
    const group = message({ chatId: "120363999000111@g.us", isGroup: true });
    expect(shouldSendEventWebhook("message.received", group, target)).toBe(false);
    expect(shouldSendEventWebhook("message.received", message(), target)).toBe(true);
  });

  it("drops an event when the exact sender or chat JID matches", () => {
    const bySender = destination({
      WA_EVENT_WEBHOOK_IGNORE_JIDS: "628999@s.whatsapp.net",
    });
    const payload = message({
      chatId: "628111@s.whatsapp.net",
      message: { ...message().message, sender: "628999@s.whatsapp.net" },
    });
    expect(shouldSendEventWebhook("message.received", payload, bySender)).toBe(false);

    const byChat = destination({
      WA_EVENT_WEBHOOK_IGNORE_JIDS: "628111@s.whatsapp.net",
    });
    expect(shouldSendEventWebhook("message.received", payload, byChat)).toBe(false);
    expect(
      shouldSendEventWebhook(
        "message.received",
        message({
          chatId: "628222@s.whatsapp.net",
          message: { ...message().message, sender: "628222@s.whatsapp.net" },
        }),
        byChat,
      ),
    ).toBe(true);
  });

  it("matches @lid and an exact LID against chatLid when the phone JID is primary", () => {
    const payload = message({
      chatId: "628111@s.whatsapp.net",
      chatLid: "111222333@lid",
      message: {
        ...message().message,
        sender: "628111@s.whatsapp.net",
        senderLid: "111222333@lid",
      },
    });
    expect(
      shouldSendEventWebhook(
        "message.received",
        payload,
        destination({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "@lid" }),
      ),
    ).toBe(false);
    expect(
      shouldSendEventWebhook(
        "message.received",
        payload,
        destination({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "111222333@lid" }),
      ),
    ).toBe(false);
    expect(
      shouldSendEventWebhook(
        "message.received",
        payload,
        destination({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "999@lid" }),
      ),
    ).toBe(true);
  });

  it("forwards lifecycle events and events that carry no chat or sender JID", () => {
    const target = destination({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "@g.us,@s.whatsapp.net,@lid" });
    const connected: ChannelEventPayload["instance.connected"] = {
      instanceId: "inst_1234abcd",
      phone: "5511888888888@s.whatsapp.net",
      lid: "111222333@lid",
      pushName: "Ada",
      connectedAt: 1,
      wasPairing: false,
    };
    const config = loadEventWebhookConfig({
      WA_EVENT_WEBHOOK_URL: URL,
      WA_EVENT_WEBHOOK_EVENTS: "message.received,instance.connected",
      WA_EVENT_WEBHOOK_IGNORE_JIDS: "@g.us,@s.whatsapp.net,@lid",
    });
    expect(shouldSendEventWebhook("instance.connected", connected, config.destinations[0]!)).toBe(
      true,
    );
    const label: ChannelEventPayload["label.updated"] = {
      instanceId: "inst_1234abcd",
      action: "edited",
      label: { id: "1", name: "Later", color: 1, deleted: false },
    };
    expect(
      shouldSendEventWebhook("label.updated", label, {
        ...target,
        events: ["label.updated"],
      }),
    ).toBe(true);
  });

  it("composes with the event allowlist and does not scan participant arrays", () => {
    const target = destination({
      WA_EVENT_WEBHOOK_EVENTS: "message.received,group.participants_changed",
      WA_EVENT_WEBHOOK_IGNORE_JIDS: "@s.whatsapp.net",
    });
    const participants: ChannelEventPayload["group.participants_changed"] = {
      instanceId: "inst_1234abcd",
      groupId: "120363999000111@g.us",
      action: "add",
      participants: ["5511888888888@s.whatsapp.net"],
    };
    expect(shouldSendEventWebhook("group.participants_changed", participants, target)).toBe(true);
    const direct = message();
    expect(shouldSendEventWebhook("message.received", direct, target)).toBe(false);
    expect(
      shouldSendEventWebhook(
        "message.edited",
        {
          instanceId: "inst_1234abcd",
          chatId: "120363999000111@g.us",
          messageId: "m1",
          newContent: "edited",
          editedAt: 1,
        },
        target,
      ),
    ).toBe(false);
  });

  it("unions a destination ignoreJids array with the global list", () => {
    const config = loadEventWebhookConfig({
      WA_EVENT_WEBHOOK_IGNORE_JIDS: "@g.us",
      WA_EVENT_WEBHOOKS: JSON.stringify([
        {
          id: "owner",
          url: URL,
          ignoreJids: ["5511777777777@s.whatsapp.net"],
        },
      ]),
    });
    expect(config.destinations[0]?.ignoreJids).toEqual(["@g.us", "5511777777777@s.whatsapp.net"]);
    const direct = message({
      chatId: "5511777777777@s.whatsapp.net",
      message: { ...message().message, sender: "5511777777777@s.whatsapp.net" },
    });
    expect(shouldSendEventWebhook("message.received", direct, config.destinations[0]!)).toBe(false);
  });

  it("rejects invalid wildcards, exact JIDs, and empty entries", () => {
    expect(() => loadEventWebhookConfig({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "@foo" })).toThrow(
      /unsupported wildcard "@foo"/,
    );
    expect(() => loadEventWebhookConfig({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "not-a-jid" })).toThrow(
      /invalid JID "not-a-jid"/,
    );
    expect(() => loadEventWebhookConfig({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "@g.us," })).toThrow(
      /empty entry/,
    );
    expect(() =>
      loadEventWebhookConfig({
        WA_EVENT_WEBHOOKS: JSON.stringify([{ id: "owner", url: URL, ignoreJids: [1] }]),
      }),
    ).toThrow(/ignoreJids must be an array/);
  });

  it("does not enqueue an ignored group message and still enqueues a direct chat", async () => {
    let handler: Parameters<InstanceManager["onAnyEvent"]>[0] | undefined;
    const instanceManager = {
      onAnyEvent: (next: Parameters<InstanceManager["onAnyEvent"]>[0]) => {
        handler = next;
        return () => undefined;
      },
    } as unknown as InstanceManager;
    const config = loadEventWebhookConfig({
      WA_EVENT_WEBHOOK_URL: URL,
      WA_EVENT_WEBHOOK_IGNORE_JIDS: "@g.us",
    });
    const enqueue = vi.fn((_: EventWebhookJob) => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(instanceManager, config, enqueue);
    handler?.(
      "message.received",
      "inst_1234abcd",
      message({ chatId: "120363999000111@g.us", isGroup: true }),
    );
    handler?.("message.received", "inst_1234abcd", message());
    await Promise.resolve();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0].payload).toMatchObject({
      chat: "5511888888888@s.whatsapp.net",
    });
    unsubscribe();
    await unsubscribe.flush();
  });

  it("stores an ignored group message and still stores and forwards a direct chat", async () => {
    const instanceId = `ignore_jid_${randomUUID()}`;
    const now = Date.now();
    db.insert(instances)
      .values({
        id: instanceId,
        name: "Ignore JID fixture",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    let processEvents: ((events: Partial<BaileysEventMap>) => Promise<void> | void) | undefined;
    const socket = {
      ev: {
        on: vi.fn(),
        process: vi.fn((handler: (events: Partial<BaileysEventMap>) => Promise<void> | void) => {
          processEvents = handler;
        }),
      },
    } as unknown as WASocket;
    const adapter = new BaileysAdapter(instanceId);
    (adapter as unknown as { bindEvents: (sock: WASocket) => void }).bindEvents(socket);
    const received: ChannelEventPayload["message.received"][] = [];
    adapter.on("message.received", (event) => {
      received.push(event);
    });
    const groupMessage = {
      key: {
        id: "group-stored",
        remoteJid: "120363999000111@g.us",
        participant: "5511999999999@s.whatsapp.net",
        fromMe: false,
      },
      message: { conversation: "group hello" },
      messageTimestamp: Math.floor(now / 1000),
    } as WAMessage;
    const directMessage = {
      key: {
        id: "direct-stored",
        remoteJid: "5511888888888@s.whatsapp.net",
        fromMe: false,
      },
      message: { conversation: "direct hello" },
      messageTimestamp: Math.floor(now / 1000),
    } as WAMessage;

    try {
      if (!processEvents) throw new Error("Baileys event processor was not registered");
      await processEvents({
        "messages.upsert": { type: "notify", messages: [groupMessage, directMessage] },
      });
      const stored = db
        .select({ id: messages.id, content: messages.content })
        .from(messages)
        .where(eq(messages.instanceId, instanceId))
        .all();
      expect(stored).toEqual(
        expect.arrayContaining([
          { id: "group-stored", content: "group hello" },
          { id: "direct-stored", content: "direct hello" },
        ]),
      );

      let handler: Parameters<InstanceManager["onAnyEvent"]>[0] | undefined;
      const instanceManager = {
        onAnyEvent: (next: Parameters<InstanceManager["onAnyEvent"]>[0]) => {
          handler = next;
          return () => undefined;
        },
      } as unknown as InstanceManager;
      const config = loadEventWebhookConfig({
        WA_EVENT_WEBHOOK_URL: URL,
        WA_EVENT_WEBHOOK_IGNORE_JIDS: "@g.us",
      });
      const enqueue = vi.fn((_: EventWebhookJob) => Promise.resolve());
      const unsubscribe = registerEventWebhookHandler(instanceManager, config, enqueue);
      for (const event of received) handler?.("message.received", instanceId, event);
      await Promise.resolve();
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue.mock.calls[0]?.[0].payload).toMatchObject({
        chat: "5511888888888@s.whatsapp.net",
      });
      unsubscribe();
      await unsubscribe.flush();
    } finally {
      db.delete(instances).where(eq(instances.id, instanceId)).run();
    }
  });

  it("keeps the LID on a normalized message after the phone JID becomes primary", () => {
    const [event] = normalizeMessagesUpsert("inst_1234abcd", {
      type: "notify",
      messages: [
        {
          key: {
            remoteJid: "111222333@lid",
            remoteJidAlt: "5511888888888@s.whatsapp.net",
            fromMe: false,
            id: "wamid.lid",
          },
          message: { conversation: "hi" },
          messageTimestamp: 10,
        },
      ],
    });
    expect(event).toMatchObject({
      chatId: "5511888888888@s.whatsapp.net",
      chatLid: "111222333@lid",
      message: { sender: "5511888888888@s.whatsapp.net", senderLid: "111222333@lid" },
    });
  });
});
