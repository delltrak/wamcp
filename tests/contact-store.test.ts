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

  it("keeps history-sync contacts available after reopening the database", () => {
    directory = mkdtempSync(join(tmpdir(), "wa-mcp-contact-store-"));
    const databasePath = join(directory, "contacts.db");
    const instanceId = "inst_fake_sync";

    const firstSqlite = new Database(databasePath);
    firstSqlite.pragma("foreign_keys = ON");
    firstSqlite.exec(`
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
        notify_name TEXT,
        phone TEXT,
        lid TEXT,
        profile_pic_url TEXT,
        is_business INTEGER NOT NULL DEFAULT 0,
        is_blocked INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (instance_id, jid)
      );
    `);
    firstSqlite
      .prepare(
        "INSERT INTO instances (id, name, channel, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(instanceId, "Fake sync instance", "baileys", "disconnected", 1, 1);

    const firstStore = new ContactStore(instanceId, drizzle(firstSqlite, { schema }));
    firstStore.handleHistorySync({
      contacts: [
        {
          id: "15555550123@s.whatsapp.net",
          name: "Example Contact",
          notify: "Example Device",
          phoneNumber: "15555550123@s.whatsapp.net",
        },
        { id: "15555550124@s.whatsapp.net" },
      ],
      chats: [{ id: "15555550125@s.whatsapp.net", name: "Example Chat Contact" }],
    });

    expect(
      firstSqlite.prepare("SELECT COUNT(*) AS count FROM contacts WHERE instance_id = ?").get(instanceId),
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
});
