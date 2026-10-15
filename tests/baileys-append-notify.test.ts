import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BaileysEventMap, WAMessage, WASocket } from "@whiskeysockets/baileys";
import { eq } from "drizzle-orm";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { db } from "../src/db/client.js";
import { instances, processedMessages } from "../src/db/schema.js";
import { normalizeEventWebhookPayload } from "../src/services/event-webhook.js";
import type { NormalizedMessageEvent } from "../src/types/channel.types.js";

const CHAT_JID = "15555550123@s.whatsapp.net";

function fixtureMessage(
  id: string,
  options: { timestampMs?: number; fromMe?: boolean; chatId?: string } = {},
): WAMessage {
  return {
    key: {
      id,
      remoteJid: options.chatId ?? CHAT_JID,
      fromMe: options.fromMe ?? false,
    },
    message: { conversation: `fixture ${id}` },
    messageTimestamp: Math.floor((options.timestampMs ?? Date.now()) / 1000),
  } as WAMessage;
}

interface AdapterInternals {
  sock: WASocket | null;
  status: string;
  reconnectAttempt: number;
  saveCreds: (() => Promise<void>) | null;
  bindEvents: (sock: WASocket) => void;
}

function createFixture(options: { lastConnected?: number; lastDisconnected?: number } = {}): {
  instanceId: string;
  adapter: BaileysAdapter;
  dispatchBatch: (events: Partial<BaileysEventMap>) => Promise<void>;
  dispatch: (type: "append" | "notify", messages: WAMessage[]) => Promise<void>;
} {
  const instanceId = `append_notify_${randomUUID()}`;
  const now = Date.now();
  db.insert(instances)
    .values({
      id: instanceId,
      name: "Append notification fixture",
      createdAt: now,
      updatedAt: now,
      lastConnected: options.lastConnected,
      lastDisconnected: options.lastDisconnected,
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
    end: vi.fn(),
  } as unknown as WASocket;
  const adapter = new BaileysAdapter(instanceId);
  (adapter as unknown as AdapterInternals).bindEvents(socket);
  const dispatchBatch = async (events: Partial<BaileysEventMap>): Promise<void> => {
    if (!processEvents) throw new Error("Baileys event processor was not registered");
    await processEvents(events);
  };

  return {
    instanceId,
    adapter,
    dispatchBatch,
    dispatch: async (type, messages) => {
      await dispatchBatch({ "messages.upsert": { type, messages } } as Partial<BaileysEventMap>);
    },
  };
}

function deleteInstance(instanceId: string): void {
  db.delete(instances).where(eq(instances.id, instanceId)).run();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Baileys offline append notifications", () => {
  it("emits one received event and webhook payload across append and notify redelivery", async () => {
    const now = Date.now();
    const { instanceId, adapter, dispatch } = createFixture({
      lastConnected: now - 2 * 60_000,
      lastDisconnected: now - 5 * 60_000,
    });
    const received: NormalizedMessageEvent[] = [];
    const webhooks: unknown[] = [];
    adapter.on("message.received", (event) => {
      received.push(event);
      webhooks.push(normalizeEventWebhookPayload("message.received", instanceId, event));
    });
    const message = fixtureMessage("offline-message-once", { timestampMs: now - 2 * 60_000 });

    try {
      await dispatch("append", [message]);
      await dispatch("notify", [message]);
      await dispatch("append", [message]);
      const notifyFirst = fixtureMessage("notify-message-once", { timestampMs: now - 60_000 });
      await dispatch("notify", [notifyFirst]);
      await dispatch("append", [notifyFirst]);

      expect(received).toHaveLength(2);
      expect(received[0]).toMatchObject({
        instanceId,
        chatId: CHAT_JID,
        message: { id: "offline-message-once", content: "fixture offline-message-once" },
      });
      expect(webhooks).toHaveLength(2);
      expect(webhooks[0]).toMatchObject({
        event: "message.received",
        instanceId,
        text: "fixture offline-message-once",
      });
      expect(
        db
          .select()
          .from(processedMessages)
          .where(eq(processedMessages.messageId, "offline-message-once"))
          .get(),
      ).toBeDefined();
    } finally {
      deleteInstance(instanceId);
    }
  });

  it("skips append messages before the disconnect watermark, outside the fallback window, and from this account", async () => {
    const now = Date.now();
    const { instanceId, adapter, dispatch } = createFixture({
      lastDisconnected: now - 60 * 60_000,
    });
    const received = vi.fn();
    adapter.on("message.received", received);

    try {
      await dispatch("append", [
        fixtureMessage("before-disconnect", { timestampMs: now - 2 * 60 * 60_000 }),
        fixtureMessage("own-message", { timestampMs: now - 60_000, fromMe: true }),
      ]);
      expect(received).not.toHaveBeenCalled();
    } finally {
      deleteInstance(instanceId);
    }

    const fallback = createFixture();
    const fallbackReceived = vi.fn();
    fallback.adapter.on("message.received", fallbackReceived);
    try {
      await fallback.dispatch("append", [
        fixtureMessage("outside-fallback-window", { timestampMs: Date.now() - 25 * 60 * 60_000 }),
      ]);
      expect(fallbackReceived).not.toHaveBeenCalled();
    } finally {
      deleteInstance(fallback.instanceId);
    }
  });

  it("never emits messages included in a history sync", async () => {
    const { instanceId, adapter, dispatch, dispatchBatch } = createFixture();
    const received = vi.fn();
    adapter.on("message.received", received);
    const historyMessage = fixtureMessage("history-sync-message");

    try {
      await dispatchBatch({
        "messaging-history.set": {
          contacts: [],
          chats: [],
          messages: [historyMessage],
          syncType: 0,
        } as unknown as BaileysEventMap["messaging-history.set"],
      });
      await dispatch("append", [historyMessage]);
      expect(received).not.toHaveBeenCalled();
    } finally {
      deleteInstance(instanceId);
    }
  });

  it("caps emitted append events per batch", async () => {
    const originalCap = process.env.WA_BAILEYS_APPEND_NOTIFY_MAX_PER_BATCH;
    process.env.WA_BAILEYS_APPEND_NOTIFY_MAX_PER_BATCH = "2";
    const { instanceId, adapter, dispatch } = createFixture();
    const received = vi.fn();
    adapter.on("message.received", received);

    try {
      await dispatch(
        "append",
        Array.from({ length: 5 }, (_, index) => fixtureMessage(`capped-${index}`)),
      );
      expect(received).toHaveBeenCalledTimes(2);
    } finally {
      deleteInstance(instanceId);
      if (originalCap === undefined) delete process.env.WA_BAILEYS_APPEND_NOTIFY_MAX_PER_BATCH;
      else process.env.WA_BAILEYS_APPEND_NOTIFY_MAX_PER_BATCH = originalCap;
    }
  });

  it("ends an idle socket and enters normal reconnect scheduling without saving credentials", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
    const oldWatchdog = process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS;
    process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS = "1000";
    const { instanceId, adapter } = createFixture();

    const listeners = new Map<string, (value: unknown) => void>();
    let processEvents: ((events: Partial<BaileysEventMap>) => Promise<void> | void) | undefined;
    const socketEnd = vi.fn();
    const socket = {
      ev: {
        on: vi.fn((event: string, handler: (value: unknown) => void) => {
          listeners.set(event, handler);
        }),
        process: vi.fn((handler: (events: Partial<BaileysEventMap>) => Promise<void> | void) => {
          processEvents = handler;
        }),
      },
      end: socketEnd,
    } as unknown as WASocket;
    const internals = adapter as unknown as AdapterInternals;
    internals.sock = socket;
    internals.status = "connected";
    const saveCreds = vi.fn(async () => {});
    internals.saveCreds = saveCreds;
    internals.bindEvents(socket);
    const connectionChanged = vi.fn();
    adapter.on("connection.changed", connectionChanged);

    try {
      listeners.get("connection.update")?.({ connection: "open" });
      await vi.advanceTimersByTimeAsync(800);
      await processEvents?.({});
      await vi.advanceTimersByTimeAsync(999);
      expect(socketEnd).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(socketEnd).toHaveBeenCalledTimes(1);
      expect(socketEnd.mock.calls[0]?.[0]).toBeInstanceOf(Error);

      listeners.get("connection.update")?.({
        connection: "close",
        lastDisconnect: { error: new Error("watchdog reconnect fixture"), date: new Date() },
      });
      expect(internals.reconnectAttempt).toBe(1);
      expect(connectionChanged).toHaveBeenCalledWith(
        expect.objectContaining({ status: "close", instanceId }),
      );
      expect(saveCreds).not.toHaveBeenCalled();
    } finally {
      deleteInstance(instanceId);
      vi.clearAllTimers();
      if (oldWatchdog === undefined) delete process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS;
      else process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS = oldWatchdog;
    }
  });
});
