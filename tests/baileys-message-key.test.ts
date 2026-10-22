import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { type WAMessage, type WASocket } from "@whiskeysockets/baileys";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { db } from "../src/db/client.js";
import { instances, messages } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

const GROUP_JID = "123456789@g.us";
const AUTHOR_JID = "111111111@s.whatsapp.net";
const OWN_JID = "222222222@s.whatsapp.net";
const DIRECT_JID = "333333333@s.whatsapp.net";

describe("Baileys message operation keys", () => {
  let instanceId: string;

  beforeEach(async () => {
    instanceId = `message_key_${randomUUID()}`;
    const now = Date.now();
    (await db.insert(instances)
      .values({ id: instanceId, name: "message key test", createdAt: now, updatedAt: now })
      .run());
  });

  afterEach(async () => {
    (await db.delete(instances).where(eq(instances.id, instanceId)).run());
  });

  async function insertMessage({
    id,
    chatId,
    senderId,
    isFromMe,
    rawKey,
  }: {
    id: string;
    chatId: string;
    senderId: string;
    isFromMe: boolean;
    rawKey?: WAMessage["key"];
  }): Promise<void> {
    (await db.insert(messages)
      .values({
        id,
        instanceId,
        chatId,
        senderId,
        type: "text",
        content: "stored message",
        isFromMe: isFromMe ? 1 : 0,
        status: isFromMe ? "sent" : "received",
        timestamp: Date.now(),
        rawData: rawKey
          ? JSON.stringify({ key: rawKey, message: { conversation: "stored" } })
          : null,
      })
      .run());
  }

  function createAdapter() {
    const sendMessage = vi.fn(async (..._args: unknown[]) => undefined);
    const socket = {
      user: { id: OWN_JID },
      sendMessage,
    } as unknown as WASocket;
    const adapter = new BaileysAdapter(instanceId);
    Object.assign(adapter, { sock: socket, status: "connected", presenceMode: "always" });
    return { adapter, sendMessage };
  }

  function lastPayload(sendMessage: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const args = sendMessage.mock.calls.at(-1) as unknown[] | undefined;
    return args?.[1] as Record<string, unknown>;
  }

  it("reacts to another group member's message with the stored author key", async () => {
    const messageId = "group-incoming-reaction";
    (await insertMessage({
      id: messageId,
      chatId: GROUP_JID,
      senderId: AUTHOR_JID,
      isFromMe: false,
      rawKey: { remoteJid: GROUP_JID, id: messageId, fromMe: false, participant: AUTHOR_JID },
    }));
    const { adapter, sendMessage } = createAdapter();

    await adapter.sendReaction(GROUP_JID, messageId, "🔥");

    expect(lastPayload(sendMessage).react).toMatchObject({
      text: "🔥",
      key: {
        remoteJid: GROUP_JID,
        id: messageId,
        fromMe: false,
        participant: AUTHOR_JID,
      },
    });

    await adapter.sendReaction(GROUP_JID, messageId, "");
    expect(lastPayload(sendMessage).react).toMatchObject({
      text: "",
      key: {
        remoteJid: GROUP_JID,
        id: messageId,
        fromMe: false,
        participant: AUTHOR_JID,
      },
    });
  });

  it("keeps group reactions to this account's own message marked fromMe", async () => {
    const messageId = "group-own-reaction";
    (await insertMessage({
      id: messageId,
      chatId: GROUP_JID,
      senderId: "me",
      isFromMe: true,
      rawKey: { remoteJid: GROUP_JID, id: messageId, fromMe: false, participant: OWN_JID },
    }));
    const { adapter, sendMessage } = createAdapter();

    await adapter.sendReaction(GROUP_JID, messageId, "👍");

    expect(lastPayload(sendMessage).react).toMatchObject({
      text: "👍",
      key: { remoteJid: GROUP_JID, id: messageId, fromMe: true, participant: OWN_JID },
    });
  });

  it("uses stored ownership for one-to-one reactions and omits participants", async () => {
    const incomingId = "direct-incoming-reaction";
    const outgoingId = "direct-outgoing-reaction";
    (await insertMessage({
      id: incomingId,
      chatId: DIRECT_JID,
      senderId: DIRECT_JID,
      isFromMe: false,
      rawKey: {
        remoteJid: DIRECT_JID,
        id: incomingId,
        fromMe: false,
        participant: AUTHOR_JID,
      },
    }));
    (await insertMessage({
      id: outgoingId,
      chatId: DIRECT_JID,
      senderId: "me",
      isFromMe: true,
      rawKey: { remoteJid: DIRECT_JID, id: outgoingId, fromMe: true },
    }));
    const { adapter, sendMessage } = createAdapter();

    await adapter.sendReaction(DIRECT_JID, incomingId, "❤️");
    const incomingKey = (lastPayload(sendMessage).react as { key: Record<string, unknown> }).key;
    expect(incomingKey).toEqual({ remoteJid: DIRECT_JID, id: incomingId, fromMe: false });

    await adapter.sendReaction(DIRECT_JID, outgoingId, "❤️");
    const outgoingKey = (lastPayload(sendMessage).react as { key: Record<string, unknown> }).key;
    expect(outgoingKey).toEqual({ remoteJid: DIRECT_JID, id: outgoingId, fromMe: true });
  });

  it("falls back safely when the target message is missing from the database", async () => {
    const { adapter, sendMessage } = createAdapter();

    await adapter.sendReaction(DIRECT_JID, "missing-direct-message", "✅");
    expect((lastPayload(sendMessage).react as { key: Record<string, unknown> }).key).toEqual({
      remoteJid: DIRECT_JID,
      id: "missing-direct-message",
      fromMe: false,
    });

    await adapter.sendReaction(GROUP_JID, "missing-group-message", "");
    expect((lastPayload(sendMessage).react as { key: Record<string, unknown> }).key).toEqual({
      remoteJid: GROUP_JID,
      id: "missing-group-message",
      fromMe: false,
    });
  });

  it("pins a stored group message with its author and ownership key", async () => {
    const messageId = "group-pin-target";
    (await insertMessage({
      id: messageId,
      chatId: GROUP_JID,
      senderId: AUTHOR_JID,
      isFromMe: false,
      rawKey: { remoteJid: GROUP_JID, id: messageId, fromMe: false },
    }));
    const { adapter, sendMessage } = createAdapter();

    await adapter.pinMessage(GROUP_JID, messageId, true);

    expect(lastPayload(sendMessage).pin).toMatchObject({
      remoteJid: GROUP_JID,
      id: messageId,
      fromMe: false,
      participant: AUTHOR_JID,
    });
  });

  it("keeps edits of own group messages marked fromMe", async () => {
    const messageId = "group-edit-target";
    (await insertMessage({
      id: messageId,
      chatId: GROUP_JID,
      senderId: "me",
      isFromMe: true,
      rawKey: { remoteJid: GROUP_JID, id: messageId, fromMe: false },
    }));
    const { adapter, sendMessage } = createAdapter();

    await adapter.editMessage(GROUP_JID, messageId, "Updated text");

    expect(lastPayload(sendMessage).edit).toEqual({
      remoteJid: GROUP_JID,
      id: messageId,
      fromMe: true,
    });
  });
});
