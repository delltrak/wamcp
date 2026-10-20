import { describe, expect, it, vi } from "vitest";
import { normalizeMessagesUpsert } from "../src/channels/baileys/baileys.events.js";
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
