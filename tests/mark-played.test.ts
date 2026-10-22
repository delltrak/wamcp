import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { BinaryNode, WAMessageKey } from "@whiskeysockets/baileys";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import { db } from "../src/db/client.js";
import { instances, messages } from "../src/db/schema.js";
import { MarkPlayedSchema } from "../src/schemas/messaging.schema.js";

const PN_JID = "5511999999999@s.whatsapp.net";
const LID_JID = "1999991111@lid";
const GROUP_JID = "120363000000000000@g.us";
const SENDER_JID = "5511888888888@s.whatsapp.net";

describe("MarkPlayedSchema", () => {
  it("accepts chatJid and rejects the old chatId field", () => {
    expect(
      MarkPlayedSchema.parse({
        instanceId: "inst_test",
        chatJid: PN_JID,
        messageIds: ["voice-1"],
        participant: SENDER_JID,
      }),
    ).toMatchObject({ chatJid: PN_JID, messageIds: ["voice-1"], participant: SENDER_JID });

    expect(() =>
      MarkPlayedSchema.parse({
        instanceId: "inst_test",
        chatId: PN_JID,
        messageIds: ["voice-1"],
      }),
    ).toThrow();
  });
});

describe("CloudApiAdapter.markPlayed", () => {
  it("reports that played receipts are unsupported", async () => {
    await expect(new CloudApiAdapter("cloud_test").markPlayed(PN_JID, ["voice-1"])).rejects.toThrow(
      "Marking audio or video messages as played is not supported on Cloud API",
    );
    await expect(new CloudApiAdapter("cloud_test").markPlayedMessage("voice-1")).rejects.toThrow(
      "Marking audio or video messages as played is not supported on Cloud API",
    );
  });
});

describe("BaileysAdapter.markPlayed", () => {
  let instanceId: string;

  beforeEach(async () => {
    instanceId = `test_${randomUUID()}`;
    const now = Date.now();
    (await db.insert(instances)
      .values({ id: instanceId, name: "played test", createdAt: now, updatedAt: now })
      .run());
  });

  afterEach(async () => {
    (await db.delete(instances).where(eq(instances.id, instanceId)).run());
  });

  function connectedAdapter(): {
    adapter: BaileysAdapter;
    sendNode: ReturnType<typeof vi.fn>;
    sendReceipt: ReturnType<typeof vi.fn>;
  } {
    const adapter = new BaileysAdapter(instanceId);
    const sendNode = vi.fn().mockResolvedValue(undefined);
    const sendReceipt = vi.fn().mockResolvedValue(undefined);
    Object.assign(adapter, { status: "connected", sock: { sendNode, sendReceipt } });
    return { adapter, sendNode, sendReceipt };
  }

  async function insertAudio(options: {
    id: string;
    chatId?: string;
    senderId?: string;
    isFromMe?: number;
    type?: "audio" | "text" | "image" | "video";
    rawData?: string | null;
  }): Promise<void> {
    (await db.insert(messages)
      .values({
        id: options.id,
        instanceId,
        chatId: options.chatId ?? PN_JID,
        senderId: options.senderId ?? SENDER_JID,
        type: options.type ?? "audio",
        isFromMe: options.isFromMe ?? 0,
        status: "received",
        timestamp: 1_700_000_000,
        rawData: options.rawData === undefined ? null : options.rawData,
      })
      .run());
  }

  function rawAudio(key: WAMessageKey, ptt = true): string {
    return JSON.stringify({
      key,
      message: { audioMessage: { ptt, mimetype: "audio/ogg; codecs=opus", seconds: 3 } },
      messageTimestamp: 1_700_000_000,
    });
  }

  it("sends one played receipt with a timestamp for a direct voice note", async () => {
    (await insertAudio({ id: "voice-1" }));
    const { adapter, sendNode, sendReceipt } = connectedAdapter();
    const before = Math.floor(Date.now() / 1000);

    await adapter.markPlayed(PN_JID, ["voice-1", "voice-1"]);

    expect(sendReceipt).not.toHaveBeenCalled();
    expect(sendNode).toHaveBeenCalledOnce();
    const node = sendNode.mock.calls[0]?.[0] as BinaryNode;
    expect(node.tag).toBe("receipt");
    expect(node.attrs.type).toBe("played");
    expect(node.attrs.to).toBe(PN_JID);
    expect(node.attrs.id).toBe("voice-1");
    expect(node.attrs.participant).toBeUndefined();
    expect(Number(node.attrs.t)).toBeGreaterThanOrEqual(before);
    expect(node.content).toBeUndefined();
  });

  it("uses the stored raw chat address and batches ids from the same group sender", async () => {
    const firstKey: WAMessageKey = {
      remoteJid: GROUP_JID,
      id: "group-voice-1",
      fromMe: false,
      participant: SENDER_JID,
    };
    const secondKey: WAMessageKey = {
      remoteJid: GROUP_JID,
      id: "group-voice-2",
      fromMe: false,
      participant: SENDER_JID,
    };
    (await insertAudio({ id: firstKey.id!, chatId: GROUP_JID, rawData: rawAudio(firstKey) }));
    (await insertAudio({ id: secondKey.id!, chatId: GROUP_JID, rawData: rawAudio(secondKey, false) }));
    const { adapter, sendNode } = connectedAdapter();

    await adapter.markPlayed(GROUP_JID, [firstKey.id!, secondKey.id!]);

    const node = sendNode.mock.calls[0]?.[0] as BinaryNode;
    expect(node.attrs).toMatchObject({
      id: "group-voice-1",
      to: GROUP_JID,
      type: "played",
      participant: SENDER_JID,
    });
    expect(node.content).toEqual([
      {
        tag: "list",
        attrs: {},
        content: [{ tag: "item", attrs: { id: "group-voice-2" } }],
      },
    ]);
  });

  it("prefers the stored raw remote jid and falls back to the supplied group participant", async () => {
    const key: WAMessageKey = {
      remoteJid: LID_JID,
      remoteJidAlt: PN_JID,
      id: "lid-voice",
      fromMe: false,
    };
    (await insertAudio({ id: key.id!, rawData: rawAudio(key) }));
    const groupId = "group-voice-fallback";
    (await insertAudio({ id: groupId, chatId: GROUP_JID, senderId: "me" }));
    const { adapter, sendNode } = connectedAdapter();

    await adapter.markPlayed(PN_JID, [key.id!]);
    await adapter.markPlayed(GROUP_JID, [groupId], "5511777777777@s.whatsapp.net");

    expect(sendNode.mock.calls[0]?.[0]).toMatchObject({
      attrs: { to: LID_JID, id: "lid-voice", type: "played" },
    });
    expect(sendNode.mock.calls[1]?.[0]).toMatchObject({
      attrs: {
        to: GROUP_JID,
        id: groupId,
        type: "played",
        participant: "5511777777777@s.whatsapp.net",
      },
    });
  });

  it("falls back to sendReceipt when the socket has no sendNode", async () => {
    (await insertAudio({ id: "voice-fallback" }));
    const adapter = new BaileysAdapter(instanceId);
    const sendReceipt = vi.fn().mockResolvedValue(undefined);
    Object.assign(adapter, { status: "connected", sock: { sendReceipt } });

    await adapter.markPlayed(PN_JID, ["voice-fallback"]);

    expect(sendReceipt).toHaveBeenCalledWith(PN_JID, undefined, ["voice-fallback"], "played");
  });

  it("refuses missing, outgoing, non-audio, and group messages without a sender", async () => {
    (await insertAudio({ id: "outgoing-audio", isFromMe: 1 }));
    (await insertAudio({ id: "text-message", type: "text" }));
    (await insertAudio({ id: "group-without-sender", chatId: GROUP_JID, senderId: "me" }));
    const { adapter, sendNode, sendReceipt } = connectedAdapter();

    await expect(adapter.markPlayed(PN_JID, ["missing-audio"])).rejects.toThrow(
      "Message missing-audio is not stored in this chat",
    );
    await expect(adapter.markPlayed(PN_JID, ["outgoing-audio"])).rejects.toThrow(
      "Message outgoing-audio is not an incoming audio, voice, or video message",
    );
    await expect(adapter.markPlayed(PN_JID, ["text-message"])).rejects.toThrow(
      "Message text-message is not an incoming audio, voice, or video message",
    );
    await expect(adapter.markPlayed(GROUP_JID, ["group-without-sender"])).rejects.toThrow(
      "Sender is missing for group audio or video message group-without-sender",
    );
    expect(sendNode).not.toHaveBeenCalled();
    expect(sendReceipt).not.toHaveBeenCalled();
  });

  it("sends a played receipt for video and for a video note stored as ptv", async () => {
    (await insertAudio({ id: "video-1", type: "video" }));
    const ptvKey: WAMessageKey = { remoteJid: PN_JID, id: "ptv-1", fromMe: false };
    (await insertAudio({
      id: "ptv-1",
      type: "text",
      rawData: JSON.stringify({
        key: ptvKey,
        message: { ptvMessage: { mimetype: "video/mp4", seconds: 4 } },
        messageTimestamp: 1_700_000_000,
      }),
    }));
    const { adapter, sendNode } = connectedAdapter();

    await adapter.markPlayed(PN_JID, ["video-1", "ptv-1"]);

    const node = sendNode.mock.calls[0]?.[0] as BinaryNode;
    expect(node.attrs).toMatchObject({ id: "video-1", to: PN_JID, type: "played" });
    expect(node.content).toEqual([
      {
        tag: "list",
        attrs: {},
        content: [{ tag: "item", attrs: { id: "ptv-1" } }],
      },
    ]);
  });

  it("rejects status broadcasts and newsletters without sending a receipt", async () => {
    const statusKey: WAMessageKey = {
      remoteJid: "status@broadcast",
      id: "status-voice",
      fromMe: false,
    };
    (await insertAudio({
      id: "status-voice",
      chatId: "status@broadcast",
      rawData: JSON.stringify({
        key: statusKey,
        message: { audioMessage: { ptt: true, mimetype: "audio/ogg" } },
        messageTimestamp: 1_700_000_000,
      }),
    }));
    (await insertAudio({ id: "newsletter-voice", chatId: "12345@newsletter" }));
    (await insertAudio({ id: "list-voice", chatId: "12345@broadcast" }));
    const { adapter, sendNode, sendReceipt } = connectedAdapter();

    await expect(adapter.markPlayed("status@broadcast", ["status-voice"])).rejects.toThrow(
      "Played receipts are not sent to status broadcasts or newsletters (status@broadcast)",
    );
    await expect(adapter.markPlayed("12345@newsletter", ["newsletter-voice"])).rejects.toThrow(
      "Played receipts are not sent to status broadcasts or newsletters (12345@newsletter)",
    );
    await expect(adapter.markPlayed("12345@broadcast", ["list-voice"])).rejects.toThrow(
      /status broadcasts or newsletters/,
    );
    await expect(adapter.markPlayedMessage("status-voice", "status@broadcast")).rejects.toThrow(
      /status broadcasts or newsletters/,
    );
    expect(sendNode).not.toHaveBeenCalled();
    expect(sendReceipt).not.toHaveBeenCalled();
  });

  it("rejects a playable message whose stored address is a status broadcast", async () => {
    const statusKey: WAMessageKey = {
      remoteJid: "status@broadcast",
      id: "wrapped-status",
      fromMe: false,
    };
    (await insertAudio({
      id: "wrapped-status",
      chatId: PN_JID,
      rawData: JSON.stringify({
        key: statusKey,
        message: { audioMessage: { ptt: true } },
        messageTimestamp: 1_700_000_000,
      }),
    }));
    const { adapter, sendNode } = connectedAdapter();

    await expect(adapter.markPlayed(PN_JID, ["wrapped-status"])).rejects.toThrow(
      "Played receipts are not sent to status broadcasts or newsletters (status@broadcast)",
    );
    expect(sendNode).not.toHaveBeenCalled();
  });

  it("sends a played receipt to an optional hosted chat", async () => {
    const hosted = "123456789@hosted.lid";
    (await insertAudio({ id: "hosted-voice", chatId: hosted }));
    const { adapter, sendNode } = connectedAdapter();

    await adapter.markPlayed(hosted, ["hosted-voice"]);

    expect(sendNode.mock.calls[0]?.[0]).toMatchObject({
      attrs: { id: "hosted-voice", to: hosted, type: "played" },
    });
  });

  it("marks a stored incoming message only when the chat matches", async () => {
    (await insertAudio({ id: "voice-stored", chatId: PN_JID }));
    (await insertAudio({ id: "outgoing-only", chatId: PN_JID, isFromMe: 1 }));
    const { adapter, sendNode } = connectedAdapter();

    await expect(adapter.markPlayedMessage("voice-stored", LID_JID)).rejects.toThrow(
      "Message voice-stored is not stored in this chat",
    );
    await expect(adapter.markPlayedMessage("outgoing-only", PN_JID)).rejects.toThrow(
      "Message outgoing-only is not stored in this chat",
    );
    expect(sendNode).not.toHaveBeenCalled();

    await adapter.markPlayedMessage("voice-stored", PN_JID);
    expect(sendNode.mock.calls[0]?.[0]).toMatchObject({
      attrs: { id: "voice-stored", to: PN_JID, type: "played" },
    });
  });

  it("marks a stored message from its saved chat without a separate chat argument", async () => {
    (await insertAudio({ id: "voice-stored", chatId: PN_JID }));
    const { adapter, sendNode } = connectedAdapter();

    await adapter.markPlayedMessage("voice-stored");

    expect(sendNode.mock.calls[0]?.[0]).toMatchObject({
      attrs: { id: "voice-stored", to: PN_JID, type: "played" },
    });
  });

  it("rejects more than 100 message ids before sending", async () => {
    const { adapter, sendNode } = connectedAdapter();
    const ids = Array.from({ length: 101 }, (_, index) => `voice-${index}`);

    await expect(adapter.markPlayed(PN_JID, ids)).rejects.toThrow(
      "A mark-played request can contain at most 100 message IDs",
    );
    expect(sendNode).not.toHaveBeenCalled();
  });
});
