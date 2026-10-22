import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaileysEventMap, WASocket } from "@whiskeysockets/baileys";
import { eq } from "drizzle-orm";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { db } from "../src/db/client.js";
import { instances, chats } from "../src/db/schema.js";
import type { ContactStore } from "../src/services/contact-store.js";

describe("Baileys chat contact names", () => {
  let instanceId: string;

  beforeEach(async () => {
    instanceId = `chat_contact_names_${randomUUID()}`;
    const now = Date.now();
    await db
      .insert(instances)
      .values({ id: instanceId, name: "test", createdAt: now, updatedAt: now })
      .run();
  });

  afterEach(async () => {
    await db.delete(instances).where(eq(instances.id, instanceId)).run();
  });

  it("lists chats with known recent messages before chats without timestamps", async () => {
    await db
      .insert(chats)
      .values([
        { instanceId, jid: "unknown@s.whatsapp.net", lastMessageAt: null, updatedAt: 300 },
        { instanceId, jid: "older@s.whatsapp.net", lastMessageAt: 100, updatedAt: 100 },
        { instanceId, jid: "recent@s.whatsapp.net", lastMessageAt: 200, updatedAt: 200 },
      ])
      .run();
    const adapter = new BaileysAdapter(instanceId);
    expect((await adapter.getChats()).map((chat) => chat.jid)).toEqual([
      "recent@s.whatsapp.net",
      "older@s.whatsapp.net",
      "unknown@s.whatsapp.net",
    ]);
  });

  it("skips group, broadcast, newsletter, and status names from chats.update", async () => {
    const upsertContacts = vi.fn(async () => {});
    const contactStore = { upsertContacts } as unknown as ContactStore;
    let processEvents: ((events: Partial<BaileysEventMap>) => Promise<void>) | undefined;
    const socket = {
      ev: {
        on: vi.fn(),
        process: vi.fn((handler: (events: Partial<BaileysEventMap>) => Promise<void>) => {
          processEvents = handler;
        }),
      },
      signalRepository: { lidMapping: { getPNForLID: vi.fn(async () => null) } },
    } as unknown as WASocket;
    const adapter = new BaileysAdapter(instanceId, contactStore);
    (adapter as unknown as { bindEvents: (sock: WASocket) => void }).bindEvents(socket);

    await processEvents?.({
      "chats.update": [
        { id: "15555550141@s.whatsapp.net", name: "Individual contact" },
        { id: "120363000000000000@g.us", name: "Group title" },
        { id: "12345@broadcast", name: "Broadcast list" },
        { id: "12345@newsletter", name: "Channel" },
        { id: "status@broadcast", name: "Status" },
      ],
    });

    expect(upsertContacts).toHaveBeenCalledTimes(1);
    expect(upsertContacts.mock.calls[0]?.[0]).toEqual([
      { id: "15555550141@s.whatsapp.net", name: "Individual contact" },
    ]);
  });
});
