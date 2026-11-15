import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { proto, type WAMessageKey } from "@whiskeysockets/baileys";
import { sqlite } from "../src/db/client.js";

const mocks = vi.hoisted(() => ({
  makeWASocket: vi.fn(),
  makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
  useSqliteAuthState: vi.fn(async () => ({
    state: { creds: { me: { id: "5500000000001:1@s.whatsapp.net" } }, keys: {} },
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

const GROUP_JID = "120363000000000000@g.us";

describe("group status getMessage roundtrip", () => {
  let instanceId = "";
  let adapter: BaileysAdapter | undefined;

  afterEach(async () => {
    if (adapter) {
      await adapter.disconnect();
      adapter = undefined;
    }
    vi.unstubAllEnvs();
    if (instanceId) {
      await sqlite.prepare("DELETE FROM instances WHERE id = ?").run(instanceId);
      instanceId = "";
    }
  });

  it("returns the envelope with the same protobuf bytes, including font", async () => {
    vi.stubEnv("WA_GROUP_STATUS_ENABLED", "true");
    vi.stubEnv("WA_GROUP_STATUS_MIN_INTERVAL_MS", "0");
    vi.stubEnv("WA_PRESENCE_MODE", "always");
    instanceId = `group-status-get-${randomUUID()}`;
    await sqlite
      .prepare(
        "INSERT INTO instances (id, name, channel, status, created_at, updated_at) VALUES (?, ?, 'baileys', 'connected', 1, 1)",
      )
      .run(instanceId, "group status getMessage");

    const socket = {
      ev: { on: vi.fn(), process: vi.fn(), off: vi.fn() },
      end: vi.fn(),
      ws: { isOpen: true },
      user: { id: "5500000000001:1@s.whatsapp.net" },
      relayMessage: vi.fn(async () => undefined),
      sendPresenceUpdate: vi.fn(async () => undefined),
      waUploadToServer: vi.fn(),
      messageRetryManager: { addRecentMessage: vi.fn() },
    };
    mocks.makeWASocket.mockReturnValue(socket);
    adapter = new BaileysAdapter(instanceId);
    await adapter.connect();
    const onConnection = socket.ev.on.mock.calls.find(([event]) => event === "connection.update")?.[1] as
      | ((update: { connection: "open" }) => void)
      | undefined;
    if (!onConnection) throw new Error("connection.update was not registered");
    await onConnection({ connection: "open" });

    const result = await adapter.sendGroupStatus({
      groupId: GROUP_JID,
      type: "text",
      text: "Roundtrip",
      font: 6,
    });
    const getMessage = mocks.makeWASocket.mock.calls.at(-1)?.[0].getMessage as (
      key: WAMessageKey,
    ) => Promise<proto.IMessage | undefined>;
    const cached = socket.messageRetryManager.addRecentMessage.mock.calls[0]?.[2] as proto.IMessage;
    const loaded = await getMessage({ remoteJid: GROUP_JID, id: result.messageId, fromMe: true });
    expect(loaded?.groupStatusMessageV2).toBeTruthy();
    expect(Buffer.from(proto.Message.encode(loaded!).finish())).toEqual(
      Buffer.from(proto.Message.encode(cached).finish()),
    );
    expect(loaded?.groupStatusMessageV2?.message?.extendedTextMessage?.font).toBe(6);

    const row = (await sqlite
      .prepare("SELECT raw_data FROM messages WHERE instance_id = ? AND id = ?")
      .get(instanceId, result.messageId)) as { raw_data: string };
    await sqlite
      .prepare("UPDATE messages SET raw_data = ? WHERE instance_id = ? AND id = ?")
      .run(row.raw_data.replace('"font":6', '"font":"SYSTEM_BOLD"'), instanceId, result.messageId);
    const repaired = await getMessage({ remoteJid: GROUP_JID, id: result.messageId, fromMe: true });
    expect(repaired?.groupStatusMessageV2?.message?.extendedTextMessage?.font).toBe(6);
    expect(Buffer.from(proto.Message.encode(repaired!).finish())).toEqual(
      Buffer.from(proto.Message.encode(cached).finish()),
    );
  });
});
