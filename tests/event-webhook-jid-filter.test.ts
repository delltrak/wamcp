import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { BaileysEventMap, WAMessage, WASocket } from "@whiskeysockets/baileys";
import { eq } from "drizzle-orm";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { normalizeMessagesUpsert } from "../src/channels/baileys/baileys.events.js";
import { db } from "../src/db/client.js";
import { contacts, instances, messages } from "../src/db/schema.js";
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
  it.each([
    ["notify", "557712345678@s.whatsapp.net"],
    ["notify", "5577*@s.whatsapp.net"],
    ["append", "557712345678@s.whatsapp.net"],
    ["append", "5577*@s.whatsapp.net"],
  ] as const)(
    "filters %s group sender phone aliases with %s before contacts are stored",
    async (type, pattern) => {
      const instanceId = `unmapped_${randomUUID()}`;
      const events = normalizeMessagesUpsert(instanceId, {
        type,
        messages: ["557712345678:3@s.whatsapp.net", "5511888888888@s.whatsapp.net"].map(
          (phone, index) => ({
            key: {
              id: `alias-${index}`,
              remoteJid: "120363999000111@g.us",
              participant: `${111222333 + index}@lid`,
              participantAlt: phone,
              fromMe: false,
            },
            message: { conversation: "group message" },
            messageTimestamp: 1_700_000_000,
          }),
        ),
      });
      expect(events[0]?.message.sender).toBe("111222333@lid");
      expect(
        shouldSendEventWebhook(
          "message.received",
          events[0]!,
          destination({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "@s.whatsapp.net" }),
        ),
      ).toBe(true);

      let handler: Parameters<InstanceManager["onAnyEvent"]>[0] | undefined;
      const manager = {
        onAnyEvent: (next: Parameters<InstanceManager["onAnyEvent"]>[0]) => {
          handler = next;
          return () => undefined;
        },
      } as unknown as InstanceManager;
      const config = loadEventWebhookConfig({
        WA_EVENT_WEBHOOK_URL: URL,
        WA_EVENT_WEBHOOK_IGNORE_JIDS: pattern,
      });
      const enqueue = vi.fn((_: EventWebhookJob) => Promise.resolve());
      const unsubscribe = registerEventWebhookHandler(manager, config, enqueue);
      try {
        for (const event of events) handler?.("message.received", instanceId, event);
        await Promise.resolve();
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue.mock.calls[0]?.[0].payload).toMatchObject({ sender: "111222334@lid" });
        expect(JSON.stringify(enqueue.mock.calls[0]?.[0].payload)).not.toContain("senderPn");
      } finally {
        unsubscribe();
        await unsubscribe.flush();
      }
    },
  );

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

  it("keeps a phone chat when @lid only matches a LID alias, and still matches an exact LID", () => {
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
    ).toBe(true);
    expect(
      shouldSendEventWebhook(
        "message.received",
        message({ chatId: "111222333@lid" }),
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

  it("stores a bare *@domain star as a chat-only address wildcard", () => {
    expect(
      loadEventWebhookConfig({
        WA_EVENT_WEBHOOK_URL: URL,
        WA_EVENT_WEBHOOK_IGNORE_JIDS: "*@lid,*@s.whatsapp.net",
      }).destinations[0]?.ignoreJids,
    ).toEqual(["@lid", "@s.whatsapp.net"]);
    expect(
      loadEventWebhookConfig({
        WA_EVENT_WEBHOOKS: JSON.stringify([{ id: "owner", url: URL, ignoreJids: ["*@LID"] }]),
      }).destinations[0]?.ignoreJids,
    ).toEqual(["@lid"]);

    const lidGroup = message({
      chatId: "120363999000111@g.us",
      isGroup: true,
      message: { ...message().message, sender: "111222333@lid" },
    });
    expect(
      shouldSendEventWebhook(
        "message.received",
        lidGroup,
        destination({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "*@lid" }),
      ),
    ).toBe(true);
    expect(
      shouldSendEventWebhook(
        "message.received",
        message({
          chatId: "111222333@lid",
          message: { ...message().message, sender: "111222333@lid" },
        }),
        destination({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "*@lid" }),
      ),
    ).toBe(false);

    const phoneGroup = message({
      chatId: "120363999000111@g.us",
      isGroup: true,
      message: { ...message().message, sender: "5511999999999@s.whatsapp.net" },
    });
    expect(
      shouldSendEventWebhook(
        "message.received",
        phoneGroup,
        destination({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "*@s.whatsapp.net" }),
      ),
    ).toBe(true);
    expect(
      shouldSendEventWebhook(
        "message.received",
        message(),
        destination({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "*@s.whatsapp.net" }),
      ),
    ).toBe(false);
  });

  it("does not let @s.whatsapp.net hide a group message from a phone sender", () => {
    const target = destination({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "@s.whatsapp.net" });
    const group = message({
      chatId: "120363999000111@g.us",
      isGroup: true,
      message: { ...message().message, sender: "5511999999999@s.whatsapp.net" },
    });
    expect(shouldSendEventWebhook("message.received", group, target)).toBe(true);
    expect(shouldSendEventWebhook("message.received", message(), target)).toBe(false);
  });

  it("matches exact and starred entries after lowercasing and stripping a device suffix", () => {
    const payload = message({
      chatId: "120363999000111@g.us",
      isGroup: true,
      message: { ...message().message, sender: "628999:14@s.whatsapp.net" },
    });
    expect(
      shouldSendEventWebhook(
        "message.received",
        payload,
        destination({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "628999@S.WhatsApp.Net" }),
      ),
    ).toBe(false);
    expect(
      shouldSendEventWebhook(
        "message.received",
        message({
          chatId: "557712345678:3@s.whatsapp.net",
          message: { ...message().message, sender: "5511000000000@s.whatsapp.net" },
        }),
        destination({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "5577*@S.WHATSAPP.NET" }),
      ),
    ).toBe(false);
    expect(
      loadEventWebhookConfig({
        WA_EVENT_WEBHOOK_URL: URL,
        WA_EVENT_WEBHOOK_IGNORE_JIDS: "@G.US,",
      }).destinations[0]?.ignoreJids,
    ).toEqual(["@g.us"]);
    expect(
      loadEventWebhookConfig({
        WA_EVENT_WEBHOOK_URL: URL,
        WA_EVENT_WEBHOOK_IGNORE_JIDS: "@g.us,, @lid",
      }).destinations[0]?.ignoreJids,
    ).toEqual(["@g.us", "@lid"]);
  });

  it("matches a stored phone JID when the message only carries a LID", () => {
    const instanceId = "inst_lidmap01";
    const now = Date.now();
    db.insert(instances)
      .values({ id: instanceId, name: "lid map", createdAt: now, updatedAt: now })
      .run();
    db.insert(contacts)
      .values({
        instanceId,
        jid: "5511888888888@s.whatsapp.net",
        phone: "5511888888888",
        lid: "111222333@lid",
        updatedAt: now,
      })
      .run();
    const lidOnly = message({
      instanceId,
      chatId: "111222333@lid",
      message: { ...message().message, sender: "111222333@lid" },
    });
    try {
      expect(
        shouldSendEventWebhook(
          "message.received",
          lidOnly,
          destination({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "5511888888888@s.whatsapp.net" }),
        ),
      ).toBe(false);
      expect(
        shouldSendEventWebhook(
          "message.received",
          lidOnly,
          destination({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "@s.whatsapp.net" }),
        ),
      ).toBe(true);
      const unmapped = message({
        instanceId,
        chatId: "999888777@lid",
        message: { ...message().message, sender: "999888777@lid" },
      });
      expect(
        shouldSendEventWebhook(
          "message.received",
          unmapped,
          destination({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "5511888888888@s.whatsapp.net" }),
        ),
      ).toBe(true);
    } finally {
      db.delete(instances).where(eq(instances.id, instanceId)).run();
    }
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

  it("rejects invalid wildcards and exact JIDs while skipping blank comma slots", () => {
    expect(() => loadEventWebhookConfig({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "@foo" })).toThrow(
      /unsupported wildcard "@foo"/,
    );
    expect(() => loadEventWebhookConfig({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "not-a-jid" })).toThrow(
      /invalid JID "not-a-jid"/,
    );
    expect(() =>
      loadEventWebhookConfig({ WA_EVENT_WEBHOOK_IGNORE_JIDS: "@g.us,not-a-jid" }),
    ).toThrow(/invalid JID "not-a-jid"/);
    const skipped = loadEventWebhookConfig({
      WA_EVENT_WEBHOOK_URL: URL,
      WA_EVENT_WEBHOOK_IGNORE_JIDS: "@g.us,",
    });
    expect(skipped.destinations[0]?.ignoreJids).toEqual(["@g.us"]);
    const blanks = loadEventWebhookConfig({
      WA_EVENT_WEBHOOKS: JSON.stringify([
        { id: "owner", url: URL, ignoreJids: ["@g.us", "", " "] },
      ]),
    });
    expect(blanks.destinations[0]?.ignoreJids).toEqual(["@g.us"]);
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
