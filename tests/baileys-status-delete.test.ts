import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WASocket } from "@whiskeysockets/baileys";
import { and, eq } from "drizzle-orm";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { db } from "../src/db/client.js";
import { instances, messages } from "../src/db/schema.js";
import type { ContactStore } from "../src/services/contact-store.js";

const OWN_JID = "5500000000001@s.whatsapp.net";
const SAVED_JID = "5500000000002@s.whatsapp.net";
const EXPLICIT_JID = "5500000000003@s.whatsapp.net";
const CONTACT_JID = "5500000000004@s.whatsapp.net";
const STATUS_MESSAGE_ID = "synthetic-status-delete-message";

describe("Baileys status deletion", () => {
  let instanceId: string;

  beforeEach(() => {
    instanceId = `status_delete_${randomUUID()}`;
    const now = Date.now();
    db.insert(instances)
      .values({ id: instanceId, name: "test", createdAt: now, updatedAt: now })
      .run();
  });

  afterEach(() => {
    db.delete(instances).where(eq(instances.id, instanceId)).run();
    vi.unstubAllEnvs();
  });

  function createAdapter(contacts: string[] = []) {
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

  function insertSentMessage(chatId: string, messageId = STATUS_MESSAGE_ID): void {
    db.insert(messages)
      .values({
        id: messageId,
        instanceId,
        chatId,
        senderId: "me",
        type: "text",
        isFromMe: 1,
        status: "sent",
        timestamp: Date.now(),
      })
      .run();
  }

  it("reuses the stored audience, includes own JID, and marks a status revoked", async () => {
    const { adapter, sendMessage } = createAdapter([CONTACT_JID]);
    await adapter.sendStatus({
      type: "text",
      text: "A saved status",
      statusJidList: [SAVED_JID],
    });
    insertSentMessage("status@broadcast");

    await adapter.deleteMessage("status@broadcast", STATUS_MESSAGE_ID);

    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      "status@broadcast",
      { delete: { remoteJid: "status@broadcast", id: STATUS_MESSAGE_ID, fromMe: true } },
      { statusJidList: [OWN_JID, SAVED_JID] },
    );
    const row = db
      .select({ status: messages.status })
      .from(messages)
      .where(and(eq(messages.instanceId, instanceId), eq(messages.id, STATUS_MESSAGE_ID)))
      .get();
    expect(row?.status).toBe("revoked");
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

  it("falls back to known contacts and own JID when no audience was stored", async () => {
    const { adapter, sendMessage, contactStore } = createAdapter([CONTACT_JID]);

    await adapter.deleteMessage("status@broadcast", "older-status-message");

    expect(sendMessage).toHaveBeenCalledWith(
      "status@broadcast",
      { delete: { remoteJid: "status@broadcast", id: "older-status-message", fromMe: true } },
      { statusJidList: [OWN_JID, CONTACT_JID] },
    );
    expect(contactStore.getContacts).toHaveBeenCalledOnce();
  });

  it("keeps regular deletes unchanged and marks the local message revoked", async () => {
    const chatId = "5500000000005@s.whatsapp.net";
    const messageId = "regular-delete-message";
    const { adapter, sendMessage } = createAdapter();
    insertSentMessage(chatId, messageId);

    await adapter.deleteMessage(chatId, messageId);

    expect(sendMessage.mock.calls).toEqual([
      [chatId, { delete: { remoteJid: chatId, id: messageId, fromMe: true } }],
    ]);
    const row = db
      .select({ status: messages.status })
      .from(messages)
      .where(and(eq(messages.instanceId, instanceId), eq(messages.id, messageId)))
      .get();
    expect(row?.status).toBe("revoked");
  });
});
