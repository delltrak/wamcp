import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { proto } from "@whiskeysockets/baileys";
import { sqlite } from "../src/db/client.js";

const mocks = vi.hoisted(() => ({
  makeWASocket: vi.fn(),
  makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
  useSqliteAuthState: vi.fn(async () => ({
    state: { creds: {}, keys: {} },
    saveCreds: vi.fn(async () => {}),
  })),
  getWaVersion: vi.fn(async () => ({ version: [2, 3000, 0] as [number, number, number] })),
}));

vi.mock("@whiskeysockets/baileys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@whiskeysockets/baileys")>();
  return {
    ...actual,
    default: mocks.makeWASocket,
    makeCacheableSignalKeyStore: mocks.makeCacheableSignalKeyStore,
  };
});

vi.mock("../src/channels/baileys/baileys.auth.js", () => ({
  useSqliteAuthState: mocks.useSqliteAuthState,
  clearAuthState: vi.fn(),
}));

vi.mock("../src/channels/baileys/baileys.version.js", () => ({
  getWaVersion: mocks.getWaVersion,
}));

import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";

describe("Baileys markOnlineOnConnect configuration", () => {
  let socket: {
    ev: { on: ReturnType<typeof vi.fn>; process: ReturnType<typeof vi.fn> };
    end: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    sendPresenceUpdate: ReturnType<typeof vi.fn>;
  };
  let activeInstanceId: string | undefined;
  let activeAdapter: BaileysAdapter | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    socket = {
      ev: { on: vi.fn(), process: vi.fn() },
      end: vi.fn(),
      sendMessage: vi.fn(),
      sendPresenceUpdate: vi.fn(async () => undefined),
    };
    mocks.makeWASocket.mockReturnValue(socket);
  });

  afterEach(async () => {
    if (activeAdapter) {
      await activeAdapter.disconnect();
      activeAdapter = undefined;
    }
    vi.useRealTimers();
    vi.unstubAllEnvs();
    if (activeInstanceId) {
      (await sqlite.prepare("DELETE FROM instances WHERE id = ?").run(activeInstanceId));
      activeInstanceId = undefined;
    }
  });

  it("defaults to on_activity and markOnlineOnConnect false when unset", async () => {
    vi.stubEnv("WA_PRESENCE_MODE", undefined);
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", undefined);
    const adapter = await connectOpenAdapter();

    expect(mocks.makeWASocket).toHaveBeenCalledWith(
      expect.objectContaining({ markOnlineOnConnect: false }),
    );
    expect(socket.sendPresenceUpdate).toHaveBeenCalledWith("unavailable");
    await adapter.disconnect();
  });

  it("passes true to makeWASocket when enabled", async () => {
    vi.stubEnv("WA_PRESENCE_MODE", "always");
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "true");
    const adapter = new BaileysAdapter("test_instance");

    await adapter.connect();

    expect(mocks.makeWASocket).toHaveBeenCalledWith(
      expect.objectContaining({ markOnlineOnConnect: true }),
    );
    await adapter.disconnect();
  });

  it("requests full history when the instance has no stored messages", async () => {
    const adapter = await connectOpenAdapter();
    const options = mocks.makeWASocket.mock.calls.at(-1)?.[0] as {
      syncFullHistory: boolean;
      shouldSyncHistoryMessage: (message: {
        syncType: proto.HistorySync.HistorySyncType;
      }) => boolean;
    };

    expect(options.syncFullHistory).toBe(true);
    expect(
      options.shouldSyncHistoryMessage({ syncType: proto.HistorySync.HistorySyncType.FULL }),
    ).toBe(true);
    expect(
      options.shouldSyncHistoryMessage({ syncType: proto.HistorySync.HistorySyncType.RECENT }),
    ).toBe(true);
    await adapter.disconnect();
  });

  it("does not request full history when the instance already has messages", async () => {
    const adapter = await connectOpenAdapter(true);
    const options = mocks.makeWASocket.mock.calls.at(-1)?.[0] as {
      syncFullHistory: boolean;
      shouldSyncHistoryMessage: (message: {
        syncType: proto.HistorySync.HistorySyncType;
      }) => boolean;
    };

    expect(options.syncFullHistory).toBe(false);
    expect(
      options.shouldSyncHistoryMessage({ syncType: proto.HistorySync.HistorySyncType.FULL }),
    ).toBe(false);
    expect(
      options.shouldSyncHistoryMessage({ syncType: proto.HistorySync.HistorySyncType.RECENT }),
    ).toBe(true);
    await adapter.disconnect();
  });

  it("forces markOnlineOnConnect off in on_activity mode even when the legacy flag is true", async () => {
    vi.stubEnv("WA_PRESENCE_MODE", "on_activity");
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "true");
    const adapter = new BaileysAdapter("test_instance");

    await adapter.connect();

    expect(mocks.makeWASocket).toHaveBeenCalledWith(
      expect.objectContaining({ markOnlineOnConnect: false }),
    );
    await adapter.disconnect();
  });

  it("starts unavailable on open, becomes available before a send, then returns to unavailable", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "on_activity");
    vi.stubEnv("WA_PRESENCE_IDLE_SECONDS", "2");
    const adapter = await connectOpenAdapter();

    expect(socket.sendPresenceUpdate).toHaveBeenCalledTimes(1);
    expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(1, "unavailable");
    expect(mocks.makeWASocket).toHaveBeenCalledWith(
      expect.objectContaining({ markOnlineOnConnect: false }),
    );

    setSuccessfulMessageSend();
    await adapter.sendMessage("5500000000001", { type: "text", text: "hello" });
    expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(2, "available");

    await vi.advanceTimersByTimeAsync(1999);
    expect(socket.sendPresenceUpdate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(3, "unavailable");
    await adapter.disconnect();
  });

  it("coalesces sends and resets one idle timer from the latest activity", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "on_activity");
    vi.stubEnv("WA_PRESENCE_IDLE_SECONDS", "2");
    const adapter = await connectOpenAdapter();
    setSuccessfulMessageSend();

    await adapter.sendMessage("5500000000001", { type: "text", text: "first" });
    await vi.advanceTimersByTimeAsync(1500);
    await adapter.sendMessage("5500000000001", { type: "text", text: "second" });

    expect(socket.sendPresenceUpdate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(socket.sendPresenceUpdate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(3, "unavailable");
    await adapter.disconnect();
  });

  it("tracks explicit unavailable globally so the next send marks the account available", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "on_activity");
    vi.stubEnv("WA_PRESENCE_IDLE_SECONDS", "2");
    const adapter = await connectOpenAdapter();
    setSuccessfulMessageSend();

    await adapter.sendMessage("5500000000001", { type: "text", text: "first" });
    await adapter.sendPresence("5500000000001", "unavailable");

    expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(3, "unavailable");
    await vi.advanceTimersByTimeAsync(2000);
    expect(socket.sendPresenceUpdate).toHaveBeenCalledTimes(3);

    await adapter.sendMessage("5500000000001", { type: "text", text: "second" });
    expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(4, "available");
    await adapter.disconnect();
  });

  it.each(["success", "failure"] as const)(
    "waits for an in-flight send before starting the idle timeout (%s)",
    async (outcome) => {
      vi.useFakeTimers();
      vi.stubEnv("WA_PRESENCE_MODE", "on_activity");
      vi.stubEnv("WA_PRESENCE_IDLE_SECONDS", "2");
      const adapter = await connectOpenAdapter();
      let resolveSend: ((value: unknown) => void) | undefined;
      let rejectSend: ((reason: Error) => void) | undefined;
      socket.sendMessage.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            resolveSend = resolve;
            rejectSend = reject;
          }),
      );

      const sending = adapter.sendMessage("5500000000001", {
        type: "text",
        text: "slow send",
      });
      for (let index = 0; index < 100 && !resolveSend; index += 1) {
        await Promise.resolve();
      }
      if (!resolveSend || !rejectSend) throw new Error("Message send did not start");

      await vi.advanceTimersByTimeAsync(2000);
      expect(socket.sendPresenceUpdate).toHaveBeenCalledTimes(2);

      if (outcome === "success") {
        resolveSend({
          key: {
            id: "slow-message",
            remoteJid: "5500000000001@s.whatsapp.net",
            fromMe: true,
          },
          message: { conversation: "slow send" },
          messageTimestamp: Math.floor(Date.now() / 1000),
        });
        await expect(sending).resolves.toMatchObject({ status: "sent" });
      } else {
        rejectSend(new Error("send failed"));
        await expect(sending).rejects.toThrow("send failed");
      }

      await vi.advanceTimersByTimeAsync(1999);
      expect(socket.sendPresenceUpdate).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(3, "unavailable");
      await adapter.disconnect();
    },
  );

  it("keeps one idle timer when sends overlap while availability is being set", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "on_activity");
    const adapter = await connectOpenAdapter();
    setSuccessfulMessageSend();
    let resolveAvailable: (() => void) | undefined;
    socket.sendPresenceUpdate.mockImplementation((status: string) => {
      if (status !== "available") return Promise.resolve();
      return new Promise<void>((resolve) => {
        resolveAvailable = resolve;
      });
    });

    const first = adapter.sendMessage("5500000000001", { type: "text", text: "first" });
    for (let index = 0; index < 10 && !resolveAvailable; index += 1) {
      await Promise.resolve();
    }
    const second = adapter.sendMessage("5500000000001", { type: "text", text: "second" });
    if (!resolveAvailable) throw new Error("Available update did not start");
    resolveAvailable();
    await Promise.all([first, second]);

    expect(socket.sendPresenceUpdate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(socket.sendPresenceUpdate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sendPresenceUpdate).toHaveBeenCalledTimes(3);
    expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(3, "unavailable");
    await adapter.disconnect();
  });

  it("uses the same available window for recording indicators", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "on_activity");
    vi.stubEnv("WA_PRESENCE_IDLE_SECONDS", "2");
    const adapter = await connectOpenAdapter();

    await adapter.sendPresence("5500000000001", "recording");

    expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(1, "unavailable");
    expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(2, "available");
    expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(
      3,
      "recording",
      "5500000000001@s.whatsapp.net",
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(4, "unavailable");
    await adapter.disconnect();
  });

  it.each([
    { status: "typing" as const, sentStatus: "composing" },
    { status: "recording" as const, sentStatus: "recording" },
  ])(
    "waits for an in-flight $status indicator before starting the idle timeout",
    async ({ status, sentStatus }) => {
      vi.useFakeTimers();
      vi.stubEnv("WA_PRESENCE_MODE", "on_activity");
      vi.stubEnv("WA_PRESENCE_IDLE_SECONDS", "2");
      const adapter = await connectOpenAdapter();
      let resolveIndicator: (() => void) | undefined;
      socket.sendPresenceUpdate.mockImplementation((updateStatus: string) => {
        if (updateStatus !== sentStatus) return Promise.resolve();
        return new Promise<void>((resolve) => {
          resolveIndicator = resolve;
        });
      });

      const updating = adapter.sendPresence("5500000000001", status);
      for (let index = 0; index < 100 && !resolveIndicator; index += 1) {
        await Promise.resolve();
      }
      if (!resolveIndicator) throw new Error("Per-chat presence update did not start");

      await vi.advanceTimersByTimeAsync(2000);
      expect(socket.sendPresenceUpdate).toHaveBeenCalledTimes(3);

      resolveIndicator();
      await updating;
      await vi.advanceTimersByTimeAsync(1999);
      expect(socket.sendPresenceUpdate).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(4, "unavailable");
      await adapter.disconnect();
    },
  );

  it("applies the idle timeout to an explicit available presence request", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "on_activity");
    vi.stubEnv("WA_PRESENCE_IDLE_SECONDS", "2");
    const adapter = await connectOpenAdapter();

    await adapter.sendPresence("5500000000001", "available");

    expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(1, "unavailable");
    expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(2, "available");
    expect(socket.sendPresenceUpdate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(3, "unavailable");
    await adapter.disconnect();
  });

  it("does not fail a message send when the global presence update fails", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "on_activity");
    const adapter = await connectOpenAdapter();
    socket.sendPresenceUpdate.mockRejectedValue(new Error("presence unavailable"));
    setSuccessfulMessageSend();

    await expect(
      adapter.sendMessage("5500000000001", { type: "text", text: "still sent" }),
    ).resolves.toMatchObject({ status: "sent" });
    expect(socket.sendMessage).toHaveBeenCalledOnce();
    await adapter.disconnect();
  });

  it("keeps legacy presence behavior in always mode and does not send unavailable automatically", async () => {
    vi.stubEnv("WA_PRESENCE_MODE", "always");
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "true");
    const adapter = await connectOpenAdapter();
    setSuccessfulMessageSend();

    await adapter.sendMessage("5500000000001", { type: "text", text: "hello" });

    expect(mocks.makeWASocket).toHaveBeenCalledWith(
      expect.objectContaining({ markOnlineOnConnect: true }),
    );
    expect(socket.sendPresenceUpdate).not.toHaveBeenCalled();
    await adapter.disconnect();
  });

  it("clears the idle timer on disconnect", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "on_activity");
    vi.stubEnv("WA_PRESENCE_IDLE_SECONDS", "2");
    const adapter = await connectOpenAdapter();
    setSuccessfulMessageSend();
    await adapter.sendMessage("5500000000001", { type: "text", text: "hello" });

    await adapter.disconnect();
    await vi.advanceTimersByTimeAsync(2000);

    expect(socket.sendPresenceUpdate).toHaveBeenCalledTimes(2);
  });

  it("clears the idle timer on close and reapplies unavailable when the socket reopens", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_PRESENCE_MODE", "on_activity");
    vi.stubEnv("WA_PRESENCE_IDLE_SECONDS", "2");
    vi.stubEnv("WA_AUTO_RECONNECT", "false");
    const adapter = await connectOpenAdapter();
    setSuccessfulMessageSend();
    await adapter.sendMessage("5500000000001", { type: "text", text: "hello" });
    const onConnectionUpdate = getConnectionUpdateHandler();

    await onConnectionUpdate({ connection: "close" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(socket.sendPresenceUpdate).toHaveBeenCalledTimes(2);

    await onConnectionUpdate({ connection: "open" });
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(3, "unavailable");
    await adapter.disconnect();
  });

  it("rejects invalid presence mode and idle timeout values", () => {
    vi.stubEnv("WA_PRESENCE_MODE", "sometimes");
    expect(() => new BaileysAdapter("test_instance")).toThrow(
      "Invalid WA_PRESENCE_MODE; expected on_activity or always",
    );

    vi.stubEnv("WA_PRESENCE_MODE", "on_activity");
    vi.stubEnv("WA_PRESENCE_IDLE_SECONDS", "0");
    expect(() => new BaileysAdapter("test_instance")).toThrow(
      "Invalid WA_PRESENCE_IDLE_SECONDS; expected a positive integer",
    );

    vi.stubEnv("WA_PRESENCE_IDLE_SECONDS", "2147483");
    expect(() => new BaileysAdapter("test_instance")).not.toThrow();

    vi.stubEnv("WA_PRESENCE_IDLE_SECONDS", "2147484");
    expect(() => new BaileysAdapter("test_instance")).toThrow(
      "Invalid WA_PRESENCE_IDLE_SECONDS; expected a positive integer no greater than 2147483",
    );
  });

  it("restores legacy stored message secrets for Baileys retries", async () => {
    const instanceId = `stored-message-${randomUUID()}`;
    activeInstanceId = instanceId;
    (await sqlite
      .prepare(
        "INSERT INTO instances (id, name, channel, status, created_at, updated_at) VALUES (?, ?, 'baileys', 'connected', 1, 1)",
      )
      .run(instanceId, "Stored message test"));

    const messageSecret = Buffer.alloc(32, 0x42);
    const outgoing = {
      key: { id: "sent-event", remoteJid: "5500000000001@s.whatsapp.net", fromMe: true },
      message: {
        eventMessage: { name: "Planning", startTime: 1_800_000_000 },
        messageContextInfo: { messageSecret },
      },
      messageTimestamp: 1_800_000_000,
    };
    socket.sendMessage.mockResolvedValue(outgoing);
    const adapter = new BaileysAdapter(instanceId);
    await adapter.connect();
    (adapter as unknown as { status: "connected" }).status = "connected";
    await adapter.sendEvent({
      to: "5500000000001@s.whatsapp.net",
      name: "Planning",
      start: "2027-01-15T08:00:00.000Z",
    });
    const legacyRawData = JSON.stringify({
      ...outgoing,
      message: {
        ...outgoing.message,
        messageContextInfo: { messageSecret: messageSecret.toString("base64") },
      },
    });
    (await sqlite
      .prepare("UPDATE messages SET raw_data = ? WHERE instance_id = ? AND id = ?")
      .run(legacyRawData, instanceId, "sent-event"));

    const options = mocks.makeWASocket.mock.calls.at(-1)?.[0] as {
      getMessage: (key: {
        id: string;
        remoteJid?: string;
      }) => Promise<
        | { messageContextInfo?: { messageSecret?: Uint8Array }; eventMessage?: { name?: string } }
        | undefined
      >;
    };
    const restored = await options.getMessage({
      id: "sent-event",
      remoteJid: "5500000000001@s.whatsapp.net",
    });

    expect(restored?.eventMessage?.name).toBe("Planning");
    expect(restored?.messageContextInfo?.messageSecret).toBeInstanceOf(Buffer);
    expect(restored?.messageContextInfo?.messageSecret).toEqual(messageSecret);
    await expect(
      options.getMessage({ id: "sent-event", remoteJid: "5500000000009@s.whatsapp.net" }),
    ).resolves.toBeUndefined();
    await expect(options.getMessage({ id: "missing-message" })).resolves.toBeUndefined();

    await adapter.disconnect();
  });

  it("rejects invalid boolean values", () => {
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "sometimes");

    expect(() => new BaileysAdapter("test_instance")).toThrow(
      "Invalid WA_MARK_ONLINE_ON_CONNECT; expected true or false",
    );
  });

  async function connectOpenAdapter(seedStoredMessage = false): Promise<BaileysAdapter> {
    const instanceId = `presence-${randomUUID()}`;
    activeInstanceId = instanceId;
    (await sqlite
      .prepare(
        "INSERT INTO instances (id, name, channel, status, created_at, updated_at) VALUES (?, ?, 'baileys', 'connected', 1, 1)",
      )
      .run(instanceId, "Presence test"));
    if (seedStoredMessage) {
      (await sqlite
        .prepare(
          `INSERT INTO messages
           (id, instance_id, chat_id, sender_id, type, timestamp)
           VALUES (?, ?, ?, ?, 'text', 1)`,
        )
        .run(
          "existing-history-message",
          instanceId,
          "5500000000001@s.whatsapp.net",
          "5500000000002@s.whatsapp.net",
        ));
    }
    const adapter = new BaileysAdapter(instanceId);
    activeAdapter = adapter;
    await adapter.connect();
    await getConnectionUpdateHandler()({ connection: "open" });
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    return adapter;
  }

  function getConnectionUpdateHandler(): (update: { connection: "open" | "close" }) => void {
    const handler = socket.ev.on.mock.calls.find(
      ([event]) => event === "connection.update",
    )?.[1] as ((update: { connection: "open" | "close" }) => void) | undefined;
    if (!handler) throw new Error("Connection update listener was not registered");
    return handler;
  }

  function setSuccessfulMessageSend(): void {
    let messageIndex = 0;
    socket.sendMessage.mockImplementation(async (jid: string) => ({
      key: { id: `presence-message-${++messageIndex}`, remoteJid: jid, fromMe: true },
      message: { conversation: "hello" },
      messageTimestamp: Math.floor(Date.now() / 1000),
    }));
  }
});
