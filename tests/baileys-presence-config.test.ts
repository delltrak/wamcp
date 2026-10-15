import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
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
  };
  let activeInstanceId: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    socket = {
      ev: { on: vi.fn(), process: vi.fn() },
      end: vi.fn(),
      sendMessage: vi.fn(),
    };
    mocks.makeWASocket.mockReturnValue(socket);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (activeInstanceId) {
      sqlite.prepare("DELETE FROM instances WHERE id = ?").run(activeInstanceId);
      activeInstanceId = undefined;
    }
  });

  it("defaults to false when unset", async () => {
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", undefined);
    const adapter = new BaileysAdapter("test_instance");

    await adapter.connect();

    expect(mocks.makeWASocket).toHaveBeenCalledWith(
      expect.objectContaining({ markOnlineOnConnect: false }),
    );
    await adapter.disconnect();
  });

  it("passes true to makeWASocket when enabled", async () => {
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "true");
    const adapter = new BaileysAdapter("test_instance");

    await adapter.connect();

    expect(mocks.makeWASocket).toHaveBeenCalledWith(
      expect.objectContaining({ markOnlineOnConnect: true }),
    );
    await adapter.disconnect();
  });

  it("restores legacy stored message secrets for Baileys retries", async () => {
    const instanceId = `stored-message-${randomUUID()}`;
    activeInstanceId = instanceId;
    sqlite
      .prepare(
        "INSERT INTO instances (id, name, channel, status, created_at, updated_at) VALUES (?, ?, 'baileys', 'connected', 1, 1)",
      )
      .run(instanceId, "Stored message test");

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
    sqlite
      .prepare("UPDATE messages SET raw_data = ? WHERE instance_id = ? AND id = ?")
      .run(legacyRawData, instanceId, "sent-event");

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
});
