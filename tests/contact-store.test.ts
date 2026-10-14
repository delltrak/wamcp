import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "../src/db/schema.js";
import { ContactStore } from "../src/services/contact-store.js";

describe("ContactStore", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  const createStore = (instanceId = "inst_fake_sync") => {
    directory = mkdtempSync(join(tmpdir(), "wa-mcp-contact-store-"));
    const databasePath = join(directory, "contacts.db");

    const sqlite = new Database(databasePath);
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      CREATE TABLE instances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'baileys',
        status TEXT NOT NULL DEFAULT 'disconnected',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE contacts (
        instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        jid TEXT NOT NULL,
        name TEXT,
        name_source TEXT,
        notify_name TEXT,
        phone TEXT,
        lid TEXT,
        profile_pic_url TEXT,
        is_business INTEGER NOT NULL DEFAULT 0,
        is_blocked INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (instance_id, jid)
      );
      CREATE TABLE chats (
        instance_id TEXT NOT NULL,
        jid TEXT NOT NULL,
        name TEXT
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        is_from_me INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL,
        push_name TEXT
      );
    `);
    sqlite
      .prepare(
        "INSERT INTO instances (id, name, channel, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(instanceId, "Fake sync instance", "baileys", "disconnected", 1, 1);

    return { sqlite, store: new ContactStore(instanceId, drizzle(sqlite, { schema })) };
  };

  it("keeps history-sync contacts available after reopening the database", async () => {
    const instanceId = "inst_fake_sync";
    const { sqlite: firstSqlite, store: firstStore } = createStore();
    const databasePath = join(directory!, "contacts.db");

    await firstStore.handleHistorySync({
      contacts: [
        {
          id: "15555550123@s.whatsapp.net",
          name: "Example Contact",
          notify: "Example Device",
          phoneNumber: "15555550123@s.whatsapp.net",
        },
        { id: "15555550124@s.whatsapp.net" },
      ],
      chats: [
        { id: "15555550125@s.whatsapp.net", name: "Example Chat Contact" },
        { id: "120363000000000000@g.us", name: "Group title" },
        { id: "12345@broadcast", name: "Broadcast list" },
        { id: "12345@newsletter", name: "Channel" },
        { id: "status@broadcast", name: "Status" },
      ],
    });

    expect(
      firstSqlite
        .prepare("SELECT COUNT(*) AS count FROM contacts WHERE instance_id = ?")
        .get(instanceId),
    ).toEqual({ count: 3 });
    firstSqlite.close();

    const restartedSqlite = new Database(databasePath);
    restartedSqlite.pragma("foreign_keys = ON");
    const restartedStore = new ContactStore(instanceId, drizzle(restartedSqlite, { schema }));

    expect(restartedStore.getContacts("15555550123")).toEqual([
      {
        jid: "15555550123@s.whatsapp.net",
        name: "Example Contact",
        notifyName: "Example Device",
        phone: "15555550123",
        profilePicUrl: null,
        isBusiness: false,
        isBlocked: false,
      },
    ]);
    expect(restartedStore.getContacts()).toHaveLength(3);

    restartedSqlite.close();
  });

  it("updates an LID-only contact when its phone mapping arrives", async () => {
    const { sqlite, store } = createStore();
    const lid = "123456789012345@lid";
    const pn = "15555550123@s.whatsapp.net";

    await store.upsertContacts([{ id: lid, name: "LID Contact" }]);
    expect(store.getContacts("15555550123")).toEqual([]);

    store.updateLidMapping(lid, pn);

    expect(store.getContacts("15555550123")).toEqual([
      {
        jid: lid,
        name: "LID Contact",
        notifyName: null,
        phone: "15555550123",
        profilePicUrl: null,
        isBusiness: false,
        isBlocked: false,
      },
    ]);

    sqlite.close();
  });

  it("resolves a LID to its phone number before persisting", async () => {
    const { sqlite, store } = createStore();
    const lid = "123456789012345@lid";
    const pn = "15555550123@s.whatsapp.net";
    const resolvePn = async (value: string) => (value === lid ? pn : null);

    await store.upsertContacts([{ id: lid, name: "Resolved Contact" }], resolvePn);

    expect(
      sqlite
        .prepare("SELECT jid, phone, lid FROM contacts WHERE instance_id = ?")
        .get("inst_fake_sync"),
    ).toEqual({ jid: pn, phone: "15555550123", lid });
    expect(store.getContacts("15555550123")).toHaveLength(1);

    sqlite.close();
  });

  it("keeps saved names above later notify and push names", async () => {
    const { sqlite, store } = createStore();
    const jid = "15555550126@s.whatsapp.net";

    await store.upsertContacts([{ id: jid, notify: "Initial profile" }]);
    await store.upsertContacts([{ id: jid, name: "Initial profile" }]);
    await store.upsertContacts([{ id: jid, notify: "Updated profile" }]);

    expect(store.getContacts()).toEqual([
      {
        jid,
        name: "Initial profile",
        notifyName: "Updated profile",
        phone: "15555550126",
        profilePicUrl: null,
        isBusiness: false,
        isBlocked: false,
      },
    ]);

    sqlite.close();
  });

  it("recovers individual contacts and names from locally stored chats and messages", async () => {
    const { sqlite, store } = createStore();
    const directJid = "15555550127@s.whatsapp.net";
    const groupJid = "120363000000000000@g.us";
    const groupSender = "15555550128@s.whatsapp.net";
    const outgoingJid = "15555550129@s.whatsapp.net";
    const lid = "123456789012345@lid";
    const resolvedJid = "15555550130@s.whatsapp.net";

    const insertChat = sqlite.prepare(
      "INSERT INTO chats (instance_id, jid, name) VALUES (?, ?, ?)",
    );
    insertChat.run("inst_fake_sync", directJid, "Saved chat name");
    insertChat.run("inst_fake_sync", groupJid, "Group title");
    insertChat.run("inst_fake_sync", "status@broadcast", "Status");
    insertChat.run("inst_fake_sync", "12345@newsletter", "Channel");

    const insertMessage = sqlite.prepare(
      "INSERT INTO messages (id, instance_id, chat_id, sender_id, is_from_me, timestamp, push_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertMessage.run("m1", "inst_fake_sync", directJid, directJid, 0, 40, "Profile name");
    insertMessage.run("m2", "inst_fake_sync", groupJid, groupSender, 0, 30, "Group sender");
    insertMessage.run("m3", "inst_fake_sync", outgoingJid, "me", 1, 20, null);
    insertMessage.run("m4", "inst_fake_sync", lid, lid, 0, 10, "LID profile");
    insertMessage.run(
      "m5",
      "inst_fake_sync",
      "status@broadcast",
      "status@broadcast",
      0,
      5,
      "Status",
    );
    insertMessage.run(
      "m6",
      "inst_fake_sync",
      "12345@newsletter",
      "12345@newsletter",
      0,
      4,
      "Channel",
    );

    const recovery = await store.recoverFromLocalData(async (value) =>
      value === lid ? resolvedJid : null,
    );

    expect(recovery).toEqual({
      chats: { candidates: 1, contactsAdded: 1 },
      messages: { candidates: 4, contactsAdded: 3 },
    });
    expect(store.getContactCount()).toBe(4);
    expect(store.getContacts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jid: directJid,
          name: "Saved chat name",
          notifyName: "Profile name",
        }),
        expect.objectContaining({ jid: groupSender, name: "Group sender" }),
        expect.objectContaining({ jid: outgoingJid, name: null }),
        expect.objectContaining({
          jid: resolvedJid,
          name: "LID profile",
          phone: "15555550130",
        }),
      ]),
    );
    expect(store.getContacts().map((contact) => contact.jid)).not.toEqual(
      expect.arrayContaining([groupJid, "status@broadcast", "12345@newsletter"]),
    );

    sqlite.close();
  });

  it("deduplicates recovered message contacts and keeps the latest non-empty push name", async () => {
    const { sqlite, store } = createStore();
    const jid = "15555550131@s.whatsapp.net";
    const insertMessage = sqlite.prepare(
      "INSERT INTO messages (id, instance_id, chat_id, sender_id, is_from_me, timestamp, push_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertMessage.run("latest-old", "inst_fake_sync", jid, jid, 0, 10, "Old name");
    insertMessage.run("latest-name", "inst_fake_sync", jid, jid, 0, 20, "Latest name");
    insertMessage.run("latest-empty", "inst_fake_sync", jid, jid, 0, 30, "   ");

    const recovery = await store.recoverFromLocalData();

    expect(recovery.messages).toEqual({ candidates: 1, contactsAdded: 1 });
    expect(store.getContacts()).toEqual([
      {
        jid,
        name: "Latest name",
        notifyName: "Latest name",
        phone: "15555550131",
        profilePicUrl: null,
        isBusiness: false,
        isBlocked: false,
      },
    ]);

    sqlite.close();
  });
});
