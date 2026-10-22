import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WASocket } from "@whiskeysockets/baileys";
import { and, eq } from "drizzle-orm";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { db } from "../src/db/client.js";
import { instances, messages, statusAudiences } from "../src/db/schema.js";
import type { ContactStore } from "../src/services/contact-store.js";
import type { NormalizedMessageEvent } from "../src/types/channel.types.js";

const OWN_JID = "5500000000001@s.whatsapp.net";
const SAVED_JID = "5500000000002@s.whatsapp.net";
const EXPLICIT_JID = "5500000000003@s.whatsapp.net";
const CONTACT_JID = "5500000000004@s.whatsapp.net";
const STATUS_MESSAGE_ID = "synthetic-status-delete-message";

describe("Baileys status deletion", () => {
  let instanceId: string;

  beforeEach(async () => {
    instanceId = `status_delete_${randomUUID()}`;
    const now = Date.now();
    (await db.insert(instances)
      .values({ id: instanceId, name: "test", createdAt: now, updatedAt: now })
      .run());
  });

  afterEach(async () => {
    (await db.delete(instances).where(eq(instances.id, instanceId)).run());
    vi.unstubAllEnvs();
  });

  function createAdapter(contacts: string[] = [], maxRecipients?: number) {
    if (maxRecipients !== undefined) {
      vi.stubEnv("WA_STATUS_MAX_RECIPIENTS", String(maxRecipients));
    }
    const contactStore = {
      getContacts: vi.fn(() => contacts.map((jid) => ({ jid }))),
    } as unknown as ContactStore;
    const sendMessage = vi.fn(async () => ({ key: { id: STATUS_MESSAGE_ID } }));
    const sock = {
      user: { id: OWN_JID },
      sendMessage,
    } as unknown as WASocket;
    const adapter = new BaileysAdapter(instanceId, contactStore);
    Object.assign(adapter, { sock, status: "connected" });
    return { adapter, sendMessage, contactStore };
  }

  async function insertSentMessage(chatId: string, messageId = STATUS_MESSAGE_ID, isFromMe = 1): Promise<void> {
    (await db.insert(messages)
      .values({
        id: messageId,
        instanceId,
        chatId,
        senderId: "me",
        type: "text",
        isFromMe,
        status: isFromMe === 1 ? "sent" : "received",
        timestamp: Date.now(),
      })
      .run());
  }

  it("reuses the stored audience, includes own JID, and marks a status revoked", async () => {
    const { adapter, sendMessage } = createAdapter([CONTACT_JID]);
    await adapter.sendStatus({
      type: "text",
      text: "A saved status",
      statusJidList: [SAVED_JID],
    });
    (await insertSentMessage("status@broadcast"));

    await adapter.deleteMessage("status@broadcast", STATUS_MESSAGE_ID);

    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      "status@broadcast",
      { delete: { remoteJid: "status@broadcast", id: STATUS_MESSAGE_ID, fromMe: true } },
      { statusJidList: [OWN_JID, SAVED_JID] },
    );
    const row = (await db
      .select({ status: messages.status })
      .from(messages)
      .where(and(eq(messages.instanceId, instanceId), eq(messages.id, STATUS_MESSAGE_ID)))
      .get());
    expect(row?.status).toBe("revoked");
  });

  it("reuses every saved status recipient without applying the current cap", async () => {
    const { adapter, sendMessage, contactStore } = createAdapter([CONTACT_JID], 1);
    const storedJids = [SAVED_JID, CONTACT_JID, SAVED_JID, OWN_JID];
    (await db.insert(statusAudiences)
      .values({
        instanceId,
        messageId: STATUS_MESSAGE_ID,
        recipientJids: JSON.stringify(storedJids),
        createdAt: Date.now(),
      })
      .run());
    (await insertSentMessage("status@broadcast"));

    await adapter.deleteMessage("status@broadcast", STATUS_MESSAGE_ID);

    expect(sendMessage).toHaveBeenCalledWith(
      "status@broadcast",
      { delete: { remoteJid: "status@broadcast", id: STATUS_MESSAGE_ID, fromMe: true } },
      { statusJidList: [OWN_JID, SAVED_JID, CONTACT_JID] },
    );
    expect(contactStore.getContacts).not.toHaveBeenCalled();
  });

  it("uses an explicit deletion audience instead of the stored audience", async () => {
    const { adapter, sendMessage, contactStore } = createAdapter([CONTACT_JID]);
    await adapter.sendStatus({ type: "text", text: "A saved status", statusJidList: [SAVED_JID] });

    await adapter.deleteMessage("status@broadcast", STATUS_MESSAGE_ID, [EXPLICIT_JID]);

    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      "status@broadcast",
      { delete: { remoteJid: "status@broadcast", id: STATUS_MESSAGE_ID, fromMe: true } },
      { statusJidList: [OWN_JID, EXPLICIT_JID] },
    );
    expect(contactStore.getContacts).not.toHaveBeenCalled();
  });

  it("validates and caps an explicit deletion audience", async () => {
    const { adapter, sendMessage } = createAdapter([], 2);

    await adapter.deleteMessage("status@broadcast", STATUS_MESSAGE_ID, [SAVED_JID, CONTACT_JID]);

    expect(sendMessage).toHaveBeenCalledWith(
      "status@broadcast",
      { delete: { remoteJid: "status@broadcast", id: STATUS_MESSAGE_ID, fromMe: true } },
      { statusJidList: [OWN_JID, SAVED_JID] },
    );
  });

  it("falls back to known contacts and own JID when no audience was stored", async () => {
    const { adapter, sendMessage, contactStore } = createAdapter([CONTACT_JID]);

    await adapter.deleteMessage("status@broadcast", "older-status-message");

    expect(sendMessage).toHaveBeenCalledWith(
      "status@broadcast",
      { delete: { remoteJid: "status@broadcast", id: "older-status-message", fromMe: true } },
      { statusJidList: [OWN_JID, CONTACT_JID] },
    );
    expect(contactStore.getContacts).toHaveBeenCalledOnce();
    expect(
      (await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.instanceId, instanceId), eq(messages.id, "older-status-message")))
        .get()),
    ).toBeUndefined();
  });

  it("keeps regular deletes unchanged and marks the local message revoked", async () => {
    const chatId = "5500000000005@s.whatsapp.net";
    const messageId = "regular-delete-message";
    const { adapter, sendMessage } = createAdapter();
    (await insertSentMessage(chatId, messageId));

    await adapter.deleteMessage(chatId, messageId);

    expect(sendMessage.mock.calls).toEqual([
      [chatId, { delete: { remoteJid: chatId, id: messageId, fromMe: true } }],
    ]);
    const row = (await db
      .select({ status: messages.status })
      .from(messages)
      .where(and(eq(messages.instanceId, instanceId), eq(messages.id, messageId)))
      .get());
    expect(row?.status).toBe("revoked");
  });

  it.each([
    {
      description: "an incoming message",
      chatId: "5500000000006@s.whatsapp.net",
      storedIsFromMe: 0,
    },
    {
      description: "a message from another chat",
      chatId: "5500000000007@s.whatsapp.net",
      storedIsFromMe: 1,
    },
  ])("does not send a revoke for $description", async ({ chatId, storedIsFromMe }) => {
    const messageId = `invalid-revoke-${randomUUID()}`;
    const requestedChatId = "5500000000008@s.whatsapp.net";
    const { adapter, sendMessage } = createAdapter();
    (await insertSentMessage(chatId, messageId, storedIsFromMe));

    await expect(adapter.deleteMessage(requestedChatId, messageId)).rejects.toThrow(
      "the stored message is not an outgoing message",
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      (await db
        .select({ status: messages.status })
        .from(messages)
        .where(and(eq(messages.instanceId, instanceId), eq(messages.id, messageId)))
        .get())?.status,
    ).toBe(storedIsFromMe === 1 ? "sent" : "received");
  });

  it("keeps revoked terminal across delivery updates and message upserts", async () => {
    const chatId = "5500000000009@s.whatsapp.net";
    const messageId = "terminal-revoked-message";
    const { adapter } = createAdapter();
    (await insertSentMessage(chatId, messageId));
    (await db.update(messages)
      .set({ status: "revoked" })
      .where(and(eq(messages.instanceId, instanceId), eq(messages.id, messageId)))
      .run());

    await (
      adapter as unknown as {
        updateMessageStatus: (id: string, status: "delivered") => Promise<void>;
      }
    ).updateMessageStatus(messageId, "delivered");
    await (
      adapter as unknown as {
        persistMessage: (event: NormalizedMessageEvent) => Promise<void>;
      }
    ).persistMessage({
      instanceId,
      chatId,
      message: {
        id: messageId,
        sender: "me",
        timestamp: Math.floor(Date.now() / 1000),
        type: "text",
        content: "updated body",
        mediaUrl: null,
        quotedMessageId: null,
        isFromMe: true,
      },
    });

    const row = (await db
      .select({ status: messages.status })
      .from(messages)
      .where(and(eq(messages.instanceId, instanceId), eq(messages.id, messageId)))
      .get());
    expect(row?.status).toBe("revoked");
  });
});
