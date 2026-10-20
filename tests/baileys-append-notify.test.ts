import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BaileysEventMap, WAMessage, WASocket } from "@whiskeysockets/baileys";
import { and, eq, lt } from "drizzle-orm";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { db } from "../src/db/client.js";
import { instances, messages, processedMessages } from "../src/db/schema.js";
import { InstanceManager } from "../src/services/instance-manager.js";
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
  watchdogTimer: ReturnType<typeof setTimeout> | null;
  saveCreds: (() => Promise<void>) | null;
  bindEvents: (sock: WASocket) => void;
  getAppendNotifyWatermark: (now: number) => Promise<number>;
}

interface InstanceManagerInternals {
  bindAdapterEvents: (instanceId: string, adapter: BaileysAdapter) => void;
}

function createTestEventBuffer() {
  return {
    isBuffering: vi.fn(() => false),
    flush: vi.fn(() => false),
  };
}

type TestEventBuffer = ReturnType<typeof createTestEventBuffer>;

async function createFixture(
  options: { lastConnected?: number; lastDisconnected?: number } = {},
): Promise<{
  instanceId: string;
  adapter: BaileysAdapter;
  socket: WASocket;
  eventBuffer: TestEventBuffer;
  dispatchBatch: (events: Partial<BaileysEventMap>) => Promise<void>;
  dispatch: (type: "append" | "notify", messages: WAMessage[]) => Promise<void>;
  dispatchConnectionUpdate: (update: BaileysEventMap["connection.update"]) => Promise<void>;
  dispatchCredsUpdate: () => Promise<void>;
}> {
  const instanceId = `append_notify_${randomUUID()}`;
  const now = Date.now();
  const eventBuffer = createTestEventBuffer();
  await db
    .insert(instances)
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
  let connectionUpdate:
    ((update: BaileysEventMap["connection.update"]) => void | Promise<void>) | undefined;
  let credsUpdate: (() => void | Promise<void>) | undefined;
  const socket = {
    ev: {
      on: vi.fn((event: string, handler: (...args: never[]) => void | Promise<void>) => {
        if (event === "connection.update") {
          connectionUpdate = handler as (
            update: BaileysEventMap["connection.update"],
          ) => void | Promise<void>;
        }
        if (event === "creds.update") credsUpdate = handler as () => void | Promise<void>;
      }),
      process: vi.fn((handler: (events: Partial<BaileysEventMap>) => Promise<void> | void) => {
        processEvents = handler;
      }),
      ...eventBuffer,
    },
    end: vi.fn(),
  } as unknown as WASocket;
  const adapter = new BaileysAdapter(instanceId);
  (adapter as unknown as AdapterInternals).bindEvents(socket);
  (new InstanceManager() as unknown as InstanceManagerInternals).bindAdapterEvents(
    instanceId,
    adapter,
  );
  const dispatchBatch = async (events: Partial<BaileysEventMap>): Promise<void> => {
    if (!processEvents) throw new Error("Baileys event processor was not registered");
    await processEvents(events);
  };

  return {
    instanceId,
    adapter,
    socket,
    eventBuffer,
    dispatchBatch,
    dispatch: async (type, messages) => {
      await dispatchBatch({ "messages.upsert": { type, messages } } as Partial<BaileysEventMap>);
    },
    dispatchConnectionUpdate: async (update) => {
      if (!connectionUpdate)
        throw new Error("Baileys connection update handler was not registered");
      await connectionUpdate(update);
    },
    dispatchCredsUpdate: async () => {
      if (!credsUpdate) throw new Error("Baileys creds update handler was not registered");
      await credsUpdate();
    },
  };
}

async function deleteInstance(instanceId: string): Promise<void> {
  await db.delete(instances).where(eq(instances.id, instanceId)).run();
}

async function seedStoredMessage(
  instanceId: string,
  messageId: string,
  timestamp: number,
): Promise<void> {
  await db
    .insert(messages)
    .values({
      id: messageId,
      instanceId,
      chatId: CHAT_JID,
      senderId: CHAT_JID,
      type: "text",
      content: `fixture ${messageId}`,
      status: "received",
      timestamp,
    })
    .run();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Baileys offline append notifications", () => {
  it("auto-reads an eligible append once when on_receive is enabled", async () => {
    vi.stubEnv("WA_AUTO_READ", "on_receive");
    const { instanceId, adapter, dispatch } = await createFixture();
    const markRead = vi.spyOn(adapter, "markRead").mockResolvedValue(undefined);
    const message = fixtureMessage("auto-read-offline-append");

    try {
      await dispatch("append", [message]);
      await dispatch("append", [message]);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(markRead).toHaveBeenCalledTimes(1);
      expect(markRead).toHaveBeenCalledWith(CHAT_JID, ["auto-read-offline-append"], undefined);
    } finally {
      await deleteInstance(instanceId);
    }
  });

  it("does not auto-read capped, old, from-me, or duplicate append messages", async () => {
    vi.stubEnv("WA_AUTO_READ", "on_receive");
    vi.stubEnv("WA_BAILEYS_APPEND_NOTIFY_MAX_PER_BATCH", "1");
    const now = Date.now();
    const { instanceId, adapter, dispatch } = await createFixture();
    const markRead = vi.spyOn(adapter, "markRead").mockResolvedValue(undefined);

    try {
      await dispatch("append", [
        fixtureMessage("append-winner", { timestampMs: now - 60_000 }),
        fixtureMessage("append-winner", { timestampMs: now - 60_000 }),
        fixtureMessage("append-capped", { timestampMs: now - 60_000 }),
        fixtureMessage("append-old", { timestampMs: now - 25 * 60 * 60_000 }),
        fixtureMessage("append-from-me", { timestampMs: now - 60_000, fromMe: true }),
      ]);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(markRead).toHaveBeenCalledTimes(1);
      expect(markRead).toHaveBeenCalledWith(CHAT_JID, ["append-winner"], undefined);
    } finally {
      await deleteInstance(instanceId);
    }
  });

  it("leaves append messages unread in modes other than on_receive", async () => {
    vi.stubEnv("WA_AUTO_READ", "on_fetch");
    const { instanceId, adapter, dispatch } = await createFixture();
    const markRead = vi.spyOn(adapter, "markRead").mockResolvedValue(undefined);

    try {
      await dispatch("append", [fixtureMessage("append-on-fetch")]);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(markRead).not.toHaveBeenCalled();
    } finally {
      await deleteInstance(instanceId);
    }
  });

  it("normalizes millisecond-stored message timestamps and still emits newer appends", async () => {
    const now = Date.now();
    const storedTimestampMs = now - 2 * 60_000;
    const { instanceId, adapter, dispatch } = await createFixture({
      lastConnected: now - 10 * 60_000,
      lastDisconnected: now - 15 * 60_000,
    });
    await seedStoredMessage(instanceId, "stored-millisecond-message", storedTimestampMs);
    const received = vi.fn();
    adapter.on("message.received", received);

    try {
      expect(await (adapter as unknown as AdapterInternals).getAppendNotifyWatermark(now)).toBe(
        storedTimestampMs,
      );

      await dispatch("append", [
        fixtureMessage("newer-offline-append", { timestampMs: now - 60_000 }),
      ]);
      expect(received).toHaveBeenCalledTimes(1);
    } finally {
      await deleteInstance(instanceId);
    }
  });

  it("picks the newest stored message when timestamps use seconds and milliseconds", async () => {
    const now = Date.now();
    const olderTimestampMs = now - 10 * 60_000;
    const newerTimestampSeconds = Math.floor((now - 60_000) / 1000);
    const { instanceId, adapter } = await createFixture();
    await seedStoredMessage(instanceId, "older-millisecond-message", olderTimestampMs);
    await seedStoredMessage(instanceId, "newer-second-message", newerTimestampSeconds);

    try {
      expect(await (adapter as unknown as AdapterInternals).getAppendNotifyWatermark(now)).toBe(
        newerTimestampSeconds * 1000,
      );
    } finally {
      await deleteInstance(instanceId);
    }
  });

  it("skips a redelivered append after its processed-message record was pruned", async () => {
    const now = Date.now();
    const { instanceId, adapter, dispatch } = await createFixture();
    const messageId = "pruned-processed-append";
    await seedStoredMessage(instanceId, messageId, Math.floor((now - 6 * 60_000) / 1000));
    await db
      .insert(processedMessages)
      .values({ messageId, instanceId, processedAt: now - 25 * 60 * 60_000 })
      .run();
    await db
      .delete(processedMessages)
      .where(
        and(
          eq(processedMessages.instanceId, instanceId),
          lt(processedMessages.processedAt, now - 24 * 60 * 60_000),
        ),
      )
      .run();
    const received = vi.fn();
    adapter.on("message.received", received);

    try {
      await dispatch("append", [fixtureMessage(messageId, { timestampMs: now - 2 * 60_000 })]);
      expect(received).not.toHaveBeenCalled();
      expect(
        await db
          .select()
          .from(processedMessages)
          .where(eq(processedMessages.messageId, messageId))
          .get(),
      ).toBeUndefined();
    } finally {
      await deleteInstance(instanceId);
    }
  });

  it("notifies a brand-new offline append once", async () => {
    const now = Date.now();
    const { instanceId, adapter, dispatch } = await createFixture({
      lastConnected: now - 15 * 60_000,
      lastDisconnected: now - 10 * 60_000,
    });
    const received = vi.fn();
    adapter.on("message.received", received);
    const message = fixtureMessage("new-offline-append-once", { timestampMs: now - 8 * 60_000 });

    try {
      await dispatch("append", [message]);
      await dispatch("append", [message]);
      expect(received).toHaveBeenCalledTimes(1);
    } finally {
      await deleteInstance(instanceId);
    }
  });

  it("emits one received event and webhook payload across append and notify redelivery", async () => {
    const now = Date.now();
    const { instanceId, adapter, dispatch } = await createFixture({
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
        await db
          .select()
          .from(processedMessages)
          .where(eq(processedMessages.messageId, "offline-message-once"))
          .get(),
      ).toBeDefined();
    } finally {
      await deleteInstance(instanceId);
    }
  });

  it("skips append messages before the disconnect watermark, outside the fallback window, and from this account", async () => {
    const now = Date.now();
    const { instanceId, adapter, dispatch } = await createFixture({
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
      await deleteInstance(instanceId);
    }

    const fallback = await createFixture();
    const fallbackReceived = vi.fn();
    fallback.adapter.on("message.received", fallbackReceived);
    try {
      await fallback.dispatch("append", [
        fixtureMessage("outside-fallback-window", { timestampMs: Date.now() - 25 * 60 * 60_000 }),
      ]);
      expect(fallbackReceived).not.toHaveBeenCalled();
    } finally {
      await deleteInstance(fallback.instanceId);
    }
  });

  it("uses the newest persisted connection timestamp when the disconnect timestamp is stale", async () => {
    const now = Date.now();
    const { instanceId, adapter, dispatch } = await createFixture({
      lastDisconnected: now - 2 * 60 * 60_000,
      lastConnected: now - 30 * 60_000,
    });
    const received = vi.fn();
    adapter.on("message.received", received);

    try {
      await dispatch("append", [
        fixtureMessage("before-latest-connect", { timestampMs: now - 60 * 60_000 }),
      ]);
      expect(received).not.toHaveBeenCalled();
    } finally {
      await deleteInstance(instanceId);
    }
  });

  it("keeps the pre-connect watermark for offline messages delivered after open", async () => {
    const now = Date.now();
    const { instanceId, adapter, dispatch, dispatchConnectionUpdate } = await createFixture({
      lastDisconnected: now - 30 * 60_000,
      lastConnected: now - 40 * 60_000,
    });
    const received = vi.fn();
    adapter.on("message.received", received);
    const offlineMessageTimestampMs = now - 10 * 60_000;
    const offlineMessage = fixtureMessage("offline-after-open", {
      timestampMs: offlineMessageTimestampMs,
    });

    try {
      await dispatchConnectionUpdate({ connection: "open" });
      expect(
        (
          await db
            .select({ lastConnected: instances.lastConnected })
            .from(instances)
            .where(eq(instances.id, instanceId))
            .get()
        )?.lastConnected,
      ).toBeGreaterThan(offlineMessageTimestampMs);

      await dispatch("append", [offlineMessage]);
      expect(received).toHaveBeenCalledTimes(1);
      expect(received).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.objectContaining({ id: "offline-after-open" }) }),
      );
    } finally {
      await deleteInstance(instanceId);
    }
  });

  it("keeps the first disconnect watermark across failed reconnects until open", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-10-15T12:00:00.000Z").getTime();
    vi.setSystemTime(start);
    const { instanceId, adapter, dispatch, dispatchConnectionUpdate } = await createFixture({
      lastConnected: start - 10 * 60_000,
    });
    const received = vi.fn();
    adapter.on("message.received", received);
    const outageMessage = fixtureMessage("message-after-original-disconnect", {
      timestampMs: start + 1_000,
    });

    try {
      await dispatchConnectionUpdate({ connection: "close" });
      const originalDisconnect = (
        await db
          .select({ lastDisconnected: instances.lastDisconnected })
          .from(instances)
          .where(eq(instances.id, instanceId))
          .get()
      )?.lastDisconnected;
      expect(originalDisconnect).toBe(start);

      for (const elapsedMs of [2, 4, 6].map((minutes) => minutes * 60_000)) {
        vi.setSystemTime(start + elapsedMs);
        await dispatchConnectionUpdate({ connection: "close" });
        expect(
          (
            await db
              .select({ lastDisconnected: instances.lastDisconnected })
              .from(instances)
              .where(eq(instances.id, instanceId))
              .get()
          )?.lastDisconnected,
        ).toBe(originalDisconnect);
      }

      vi.setSystemTime(start + 8 * 60_000);
      await dispatchConnectionUpdate({ connection: "open" });
      await dispatch("append", [outageMessage]);
      await dispatch("append", [outageMessage]);

      expect(received).toHaveBeenCalledTimes(1);
      expect(received).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({ id: "message-after-original-disconnect" }),
        }),
      );
    } finally {
      await deleteInstance(instanceId);
    }
  });

  it("notifies a new append sharing the latest stored second but skips stored IDs", async () => {
    const now = Date.now();
    const timestampSeconds = Math.floor((now - 60_000) / 1000);
    const { instanceId, adapter, dispatch } = await createFixture({
      lastConnected: now - 5 * 60_000,
      lastDisconnected: now - 4 * 60_000,
    });
    await seedStoredMessage(instanceId, "latest-stored-append", timestampSeconds);
    const received = vi.fn();
    adapter.on("message.received", received);

    try {
      await dispatch("append", [
        fixtureMessage("new-id-same-second", { timestampMs: timestampSeconds * 1000 }),
        fixtureMessage("latest-stored-append", { timestampMs: timestampSeconds * 1000 }),
      ]);
      await dispatch("append", [
        fixtureMessage("new-id-same-second", { timestampMs: timestampSeconds * 1000 }),
      ]);

      expect(received).toHaveBeenCalledTimes(1);
      expect(received).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({ id: "new-id-same-second" }),
        }),
      );
    } finally {
      await deleteInstance(instanceId);
    }
  });

  it("never emits messages included in a history sync", async () => {
    const { instanceId, adapter, dispatch, dispatchBatch } = await createFixture();
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
      await deleteInstance(instanceId);
    }
  });

  it("caps emitted append events per batch", async () => {
    const originalCap = process.env.WA_BAILEYS_APPEND_NOTIFY_MAX_PER_BATCH;
    process.env.WA_BAILEYS_APPEND_NOTIFY_MAX_PER_BATCH = "2";
    const { instanceId, adapter, dispatch } = await createFixture();
    const received = vi.fn();
    adapter.on("message.received", received);

    try {
      await dispatch(
        "append",
        Array.from({ length: 5 }, (_, index) => fixtureMessage(`capped-${index}`)),
      );
      expect(received).toHaveBeenCalledTimes(2);
    } finally {
      await deleteInstance(instanceId);
      if (originalCap === undefined) delete process.env.WA_BAILEYS_APPEND_NOTIFY_MAX_PER_BATCH;
      else process.env.WA_BAILEYS_APPEND_NOTIFY_MAX_PER_BATCH = originalCap;
    }
  });

  it("ignores websocket keepalive frames and reconnects after consecutive failed USync probes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
    const oldWatchdog = process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS;
    process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS = "1000";
    const { instanceId, adapter } = await createFixture();

    const listeners = new Map<string, (value: unknown) => void>();
    const websocketListeners = new Map<string, Array<(...args: unknown[]) => void>>();
    let processEvents: ((events: Partial<BaileysEventMap>) => Promise<void> | void) | undefined;
    let probeCount = 0;
    const fetchStatus = vi.fn(async () => {
      probeCount += 1;
      if (probeCount === 1) return await new Promise<never>(() => {});
      throw new Error("simulated USync timeout");
    });
    const query = vi.fn(async () => ({ tag: "iq", attrs: { type: "result" } }));
    const socketEnd = vi.fn(async () => {});
    const socket = {
      user: { id: CHAT_JID },
      ev: {
        on: vi.fn((event: string, handler: (value: unknown) => void) => {
          listeners.set(event, handler);
        }),
        process: vi.fn((handler: (events: Partial<BaileysEventMap>) => Promise<void> | void) => {
          processEvents = handler;
        }),
        isBuffering: vi.fn(() => false),
        flush: vi.fn(() => false),
      },
      ws: {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          websocketListeners.set(event, [...(websocketListeners.get(event) ?? []), handler]);
        }),
      },
      fetchStatus,
      query,
      end: socketEnd,
      get authState() {
        throw new Error("health monitoring must not access auth state");
      },
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
      await listeners.get("connection.update")?.({ connection: "open" });
      for (let elapsed = 0; elapsed < 1000; elapsed += 100) {
        for (const event of ["message", "ping", "pong"]) {
          for (const handler of websocketListeners.get(event) ?? []) handler();
        }
        await vi.advanceTimersByTimeAsync(100);
      }

      expect(fetchStatus).toHaveBeenCalledTimes(1);
      expect(fetchStatus).toHaveBeenCalledWith(CHAT_JID);
      expect(query).not.toHaveBeenCalled();
      expect(socketEnd).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(20_000);
      expect(socketEnd).not.toHaveBeenCalled();

      await processEvents?.({
        "presence.update": { id: CHAT_JID, presences: {} },
      } as Partial<BaileysEventMap>);
      for (let elapsed = 0; elapsed < 1000; elapsed += 100) {
        for (const event of ["message", "ping", "pong"]) {
          for (const handler of websocketListeners.get(event) ?? []) handler();
        }
        await vi.advanceTimersByTimeAsync(100);
      }

      expect(fetchStatus).toHaveBeenCalledTimes(2);
      expect(socketEnd).not.toHaveBeenCalled();

      for (let elapsed = 0; elapsed < 1000; elapsed += 100) {
        for (const event of ["message", "ping", "pong"]) {
          for (const handler of websocketListeners.get(event) ?? []) handler();
        }
        await vi.advanceTimersByTimeAsync(100);
      }

      expect(fetchStatus).toHaveBeenCalledTimes(3);
      expect(query).not.toHaveBeenCalled();
      expect(socketEnd).toHaveBeenCalledTimes(1);
      expect(socketEnd.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect(socketEnd.mock.calls[0]?.[0]?.message).toContain("simulated USync timeout");

      await listeners.get("connection.update")?.({
        connection: "close",
        lastDisconnect: { error: new Error("watchdog reconnect fixture"), date: new Date() },
      });
      expect(internals.reconnectAttempt).toBe(1);
      expect(connectionChanged).toHaveBeenCalledWith(
        expect.objectContaining({ status: "close", instanceId }),
      );
      expect(saveCreds).not.toHaveBeenCalled();
    } finally {
      await deleteInstance(instanceId);
      vi.clearAllTimers();
      if (oldWatchdog === undefined) delete process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS;
      else process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS = oldWatchdog;
    }
  });

  it("keeps a quiet socket connected when application probes succeed", async () => {
    vi.useFakeTimers();
    const oldWatchdog = process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS;
    process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS = "1000";
    const { instanceId, adapter } = await createFixture();

    const listeners = new Map<string, (value: unknown) => void>();
    let processEvents: ((events: Partial<BaileysEventMap>) => Promise<void> | void) | undefined;
    const fetchStatus = vi.fn(async () => []);
    const query = vi.fn(async () => ({ tag: "iq", attrs: { type: "result" } }));
    const socketEnd = vi.fn(async () => {});
    const socket = {
      user: { id: CHAT_JID },
      ev: {
        on: vi.fn((event: string, handler: (value: unknown) => void) => {
          listeners.set(event, handler);
        }),
        process: vi.fn((handler: (events: Partial<BaileysEventMap>) => Promise<void> | void) => {
          processEvents = handler;
        }),
        isBuffering: vi.fn(() => false),
        flush: vi.fn(() => false),
      },
      fetchStatus,
      query,
      end: socketEnd,
      get authState() {
        throw new Error("health monitoring must not access auth state");
      },
    } as unknown as WASocket;
    const internals = adapter as unknown as AdapterInternals;
    internals.sock = socket;
    internals.status = "connected";
    const saveCreds = vi.fn(async () => {});
    internals.saveCreds = saveCreds;
    internals.bindEvents(socket);

    try {
      await listeners.get("connection.update")?.({ connection: "open" });
      await vi.advanceTimersByTimeAsync(3000);

      expect(fetchStatus).toHaveBeenCalledTimes(3);
      expect(fetchStatus).toHaveBeenCalledWith(CHAT_JID);
      expect(query).not.toHaveBeenCalled();
      expect(socketEnd).not.toHaveBeenCalled();
      expect(saveCreds).not.toHaveBeenCalled();
      expect(processEvents).toBeDefined();
    } finally {
      await deleteInstance(instanceId);
      vi.clearAllTimers();
      if (oldWatchdog === undefined) delete process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS;
      else process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS = oldWatchdog;
    }
  });

  it("flushes a stalled event buffer and delivers its held append notification", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
    const oldWatchdog = process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS;
    const oldBufferStall = process.env.WA_BAILEYS_EVENT_BUFFER_STALL_MS;
    process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS = "10000";
    process.env.WA_BAILEYS_EVENT_BUFFER_STALL_MS = "1000";
    const { instanceId, adapter, socket, eventBuffer, dispatch, dispatchConnectionUpdate } =
      await createFixture({ lastConnected: Date.now() - 10_000 });
    const internals = adapter as unknown as AdapterInternals;
    internals.sock = socket;
    eventBuffer.isBuffering.mockReturnValue(true);
    const message = fixtureMessage("stalled-buffer-append", {
      timestampMs: Date.now() - 5_000,
    });
    let heldEventProcessing: Promise<void> | undefined;
    eventBuffer.flush.mockImplementation(() => {
      eventBuffer.isBuffering.mockReturnValue(false);
      heldEventProcessing = dispatch("append", [message]);
      return true;
    });
    const received = vi.fn();
    adapter.on("message.received", received);

    try {
      await dispatchConnectionUpdate({ connection: "open" });
      await vi.advanceTimersByTimeAsync(999);
      expect(eventBuffer.flush).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await heldEventProcessing;

      expect(eventBuffer.flush).toHaveBeenCalledTimes(1);
      expect(received).toHaveBeenCalledTimes(1);
      expect(received).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({ id: "stalled-buffer-append" }),
        }),
      );
      expect(socket.end).not.toHaveBeenCalled();
    } finally {
      await deleteInstance(instanceId);
      vi.clearAllTimers();
      if (oldWatchdog === undefined) delete process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS;
      else process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS = oldWatchdog;
      if (oldBufferStall === undefined) delete process.env.WA_BAILEYS_EVENT_BUFFER_STALL_MS;
      else process.env.WA_BAILEYS_EVENT_BUFFER_STALL_MS = oldBufferStall;
    }
  });

  it("ends a socket when its event buffer remains stalled after flushing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
    const oldWatchdog = process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS;
    const oldBufferStall = process.env.WA_BAILEYS_EVENT_BUFFER_STALL_MS;
    process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS = "10000";
    process.env.WA_BAILEYS_EVENT_BUFFER_STALL_MS = "1000";
    const { instanceId, adapter, socket, eventBuffer, dispatchConnectionUpdate } =
      await createFixture();
    const internals = adapter as unknown as AdapterInternals;
    internals.sock = socket;
    eventBuffer.isBuffering.mockReturnValue(true);

    try {
      await dispatchConnectionUpdate({ connection: "open" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(eventBuffer.flush).toHaveBeenCalledTimes(1);
      expect(socket.end).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);

      expect(socket.end).toHaveBeenCalledTimes(1);
      expect(socket.end).toHaveBeenCalledWith(expect.any(Error));
      expect(
        (socket.end as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.message,
      ).toContain("event buffer remained stalled");

      await dispatchConnectionUpdate({
        connection: "close",
        lastDisconnect: { error: new Error("stalled buffer fixture"), date: new Date() },
      });
      expect(internals.reconnectAttempt).toBe(1);
    } finally {
      await deleteInstance(instanceId);
      vi.clearAllTimers();
      if (oldWatchdog === undefined) delete process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS;
      else process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS = oldWatchdog;
      if (oldBufferStall === undefined) delete process.env.WA_BAILEYS_EVENT_BUFFER_STALL_MS;
      else process.env.WA_BAILEYS_EVENT_BUFFER_STALL_MS = oldBufferStall;
    }
  });

  it("does nothing when the event buffer ends before the stall limit", async () => {
    vi.useFakeTimers();
    const oldWatchdog = process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS;
    const oldBufferStall = process.env.WA_BAILEYS_EVENT_BUFFER_STALL_MS;
    process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS = "10000";
    process.env.WA_BAILEYS_EVENT_BUFFER_STALL_MS = "1000";
    const { instanceId, adapter, socket, eventBuffer, dispatchConnectionUpdate } =
      await createFixture();
    const internals = adapter as unknown as AdapterInternals;
    internals.sock = socket;
    eventBuffer.isBuffering.mockReturnValue(true);

    try {
      await dispatchConnectionUpdate({ connection: "open" });
      await vi.advanceTimersByTimeAsync(500);
      eventBuffer.isBuffering.mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(1000);

      expect(eventBuffer.flush).not.toHaveBeenCalled();
      expect(socket.end).not.toHaveBeenCalled();
    } finally {
      await deleteInstance(instanceId);
      vi.clearAllTimers();
      if (oldWatchdog === undefined) delete process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS;
      else process.env.WA_BAILEYS_HEALTH_WATCHDOG_MS = oldWatchdog;
      if (oldBufferStall === undefined) delete process.env.WA_BAILEYS_EVENT_BUFFER_STALL_MS;
      else process.env.WA_BAILEYS_EVENT_BUFFER_STALL_MS = oldBufferStall;
    }
  });

  it("reaches connected when the append watermark read fails", async () => {
    const { instanceId, adapter, socket, dispatchConnectionUpdate } = await createFixture();
    const internals = adapter as unknown as AdapterInternals;
    internals.sock = socket;
    internals.status = "connecting";
    internals.getAppendNotifyWatermark = async () => {
      throw new Error("watermark down");
    };
    const connected: unknown[] = [];
    adapter.on("instance.connected", (payload) => {
      connected.push(payload);
    });

    try {
      await dispatchConnectionUpdate({ connection: "open" });
      expect(internals.status).toBe("connected");
      expect(connected).toHaveLength(1);
      expect(internals.watchdogTimer).not.toBeNull();
    } finally {
      await adapter.disconnect();
      await deleteInstance(instanceId);
    }
  });

  it("retries a failed credential save and keeps the in-memory creds", async () => {
    const { instanceId, adapter, dispatchCredsUpdate } = await createFixture();
    vi.useFakeTimers();
    const creds = { registrationId: 7 };
    const seen: number[] = [];
    let attempts = 0;
    const internals = adapter as unknown as AdapterInternals;
    internals.saveCreds = async () => {
      seen.push(creds.registrationId);
      attempts += 1;
      if (attempts === 1) throw new Error("db down");
    };

    try {
      await dispatchCredsUpdate();
      expect(attempts).toBe(1);
      creds.registrationId = 8;
      await vi.advanceTimersByTimeAsync(1000);
      expect(attempts).toBe(2);
      expect(seen).toEqual([7, 8]);
    } finally {
      await adapter.disconnect();
      await deleteInstance(instanceId);
      vi.clearAllTimers();
    }
  });
});
