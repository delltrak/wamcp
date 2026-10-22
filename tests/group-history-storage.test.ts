import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WAMessageStubType, type BaileysEventMap, type WASocket } from "@whiskeysockets/baileys";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { db, sqlite } from "../src/db/client.js";
import { messages } from "../src/db/schema.js";

vi.mock("../src/db/client.js", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const schema = await import("../src/db/schema.js");
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE messages (
    instance_id TEXT NOT NULL, id TEXT NOT NULL, chat_id TEXT NOT NULL,
    sender_id TEXT NOT NULL, type TEXT NOT NULL, content TEXT, media_url TEXT,
    media_local TEXT, media_mimetype TEXT, quoted_id TEXT, is_from_me INTEGER DEFAULT 0,
    is_forwarded INTEGER DEFAULT 0, status TEXT DEFAULT 'received', timestamp INTEGER NOT NULL,
    push_name TEXT, raw_data TEXT, starred INTEGER DEFAULT 0,
    PRIMARY KEY (instance_id, id)
  )`);
  return { sqlite, db: drizzle(sqlite, { schema }) };
});

const group = "123456789@g.us";
function insert(id: string, raw: unknown, instanceId = "fixture") {
  db.insert(messages)
    .values({
      instanceId,
      id,
      chatId: group,
      senderId: "111@s.whatsapp.net",
      type: "text",
      content: "secret",
      timestamp: 1000,
      rawData: typeof raw === "string" ? raw : raw === null ? null : JSON.stringify(raw),
    })
    .run();
}
function fixture() {
  let process: (events: Partial<BaileysEventMap>) => Promise<void> = async () => {};
  const socket = {
    ev: {
      on: vi.fn(),
      process: vi.fn((handler) => {
        process = handler;
        return vi.fn();
      }),
    },
  } as unknown as WASocket;
  const adapter = new BaileysAdapter("fixture");
  const internals = adapter as unknown as {
    bindEvents: (sock: WASocket) => void;
    getLabelsFor: () => [];
  };
  internals.getLabelsFor = () => [];
  internals.bindEvents(socket);
  return { adapter, process: (events: Partial<BaileysEventMap>) => process(events) };
}
beforeEach(() => {
  sqlite.exec("DELETE FROM messages");
});
afterAll(() => {
  sqlite.close();
});

describe("persisted history privacy", () => {
  it("preserves raw ephemeral/view-once flags and fails closed for absent or corrupt raw payloads", async () => {
    insert("ephemeral", {
      message: { extendedTextMessage: { text: "secret", contextInfo: { expiration: 86400 } } },
    });
    insert("once", { message: { viewOnceMessageV2: { message: { imageMessage: {} } } } });
    insert("missing", null);
    insert("corrupt", "{");
    insert("normal", { message: { conversation: "normal" } });
    const rows = new Map(
      (await fixture().adapter.getMessages(group)).map((message) => [message.id, message]),
    );
    expect(rows.get("ephemeral")).toMatchObject({ ephemeral: true });
    expect(rows.get("once")).toMatchObject({ viewOnce: true });
    expect(rows.get("missing")).toMatchObject({ historySharingBlocked: true });
    expect(rows.get("corrupt")).toMatchObject({ historySharingBlocked: true });
    expect(rows.get("normal")?.historySharingBlocked).not.toBe(true);
  });
  it("persists received revocations and does not restore shareability after late receipts", async () => {
    insert("deleted", { message: { conversation: "secret" } });
    const f = fixture();
    await f.process({
      "messages.update": [
        {
          key: { remoteJid: group, id: "deleted" },
          update: { message: null, messageStubType: WAMessageStubType.REVOKE },
        },
      ],
    });
    await f.process({
      "messages.update": [{ key: { remoteJid: group, id: "deleted" }, update: { status: 2 } }],
    });
    expect((await f.adapter.getMessages(group))[0]?.status).toBe("revoked");
  });
  it.each(["ephemeralMessage", "viewOnceMessageV2"])(
    "persists received edits while preserving %s",
    async (wrapper) => {
      insert("edited", {
        key: { remoteJid: group, id: "edited" },
        message: { [wrapper]: { message: { conversation: "secret" } } },
      });
      const f = fixture();
      await f.process({
        "messages.update": [
          {
            key: { remoteJid: group, id: "edited" },
            update: {
              message: { editedMessage: { message: { conversation: "replacement" } } },
            },
          },
        ],
      });
      expect((await f.adapter.getMessages(group))[0]).toMatchObject({
        content: "replacement",
        ...(wrapper === "ephemeralMessage" ? { ephemeral: true } : { viewOnce: true }),
      });
    },
  );

  it("marks explicit and whole-chat deletion events without affecting another instance", async () => {
    insert("first", { message: { conversation: "secret" } });
    insert("second", { message: { conversation: "secret" } });
    insert("other", { message: { conversation: "secret" } }, "other-instance");
    const f = fixture();
    await f.process({ "messages.delete": { keys: [{ remoteJid: group, id: "first" }] } });
    expect((await f.adapter.getMessages(group)).find((m) => m.id === "first")?.status).toBe(
      "revoked",
    );
    await f.process({ "messages.delete": { jid: group, all: true } });
    expect((await f.adapter.getMessages(group)).every((m) => m.status === "revoked")).toBe(true);
    expect(
      db
        .select()
        .from(messages)
        .all()
        .find((m) => m.id === "other")?.status,
    ).toBe("received");
  });
});
