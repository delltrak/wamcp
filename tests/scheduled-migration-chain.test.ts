import { mkdtempSync, readFileSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { ScheduleStore } from "../src/services/schedule-store.js";

const folder = new URL("../drizzle/", import.meta.url).pathname;
const journal = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};

describe("scheduled migration after the integrated feature chain", () => {
  it("upgrades 0006 and creates fresh SQLite without losing webhooks, cooldowns or history", () => {
    const legacyFolder = mkdtempSync(join(tmpdir(), "wamcp-schedule-migrations-"));
    const sqlite = new Database(":memory:");
    const fresh = new Database(":memory:");
    try {
      sqlite.pragma("foreign_keys = ON");
      mkdirSync(join(legacyFolder, "meta"));
      const legacy = journal.entries.filter((entry) => entry.idx < 7);
      writeFileSync(
        join(legacyFolder, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries: legacy }),
      );
      for (const entry of legacy)
        copyFileSync(join(folder, `${entry.tag}.sql`), join(legacyFolder, `${entry.tag}.sql`));
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: legacyFolder });
      sqlite.exec(`INSERT INTO instances (id, name, created_at, updated_at) VALUES ('fixture', 'fixture', 1, 1);
        INSERT INTO instance_webhooks (instance_id, url, updated_at) VALUES ('fixture', 'https://example.invalid', 1);
        INSERT INTO auto_reply_cooldowns VALUES ('fixture', '111@s.whatsapp.net', 123);
        INSERT INTO group_history_sends VALUES ('fixture', 'stub', 456);`);
      migrate(db, { migrationsFolder: folder });
      migrate(db, { migrationsFolder: folder });
      expect(sqlite.prepare("SELECT last_reply_at FROM auto_reply_cooldowns").get()).toEqual({
        last_reply_at: 123,
      });
      expect(sqlite.prepare("SELECT url FROM instance_webhooks").get()).toEqual({
        url: "https://example.invalid",
      });
      expect(sqlite.prepare("SELECT count(*) AS n FROM group_history_sends").get()).toEqual({
        n: 1,
      });
      const store = new ScheduleStore(sqlite);
      const now = 1_800_000_000_000;
      store.insert({
        id: "schedule",
        instanceId: "fixture",
        recipient: "111@s.whatsapp.net",
        messageType: "text",
        payloadJson: JSON.stringify({ type: "text", text: "migration fixture" }),
        timezone: "UTC",
        recurrence: "once",
        scheduledAt: now,
        nextRunAt: now,
        weekdays: [],
        dayOfMonth: null,
        endAt: null,
        occurrenceLimit: 1,
        now,
      });
      expect(store.claimNext(now, now + 60_000, "lease")).toMatchObject({
        id: "schedule",
        status: "running",
        scheduledAt: now,
      });
      sqlite.exec("DELETE FROM instances WHERE id = 'fixture'");
      for (const table of [
        "scheduled_messages",
        "group_history_sends",
        "instance_webhooks",
        "auto_reply_cooldowns",
      ]) {
        expect(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
      migrate(drizzle(fresh), { migrationsFolder: folder });
      expect(
        fresh.prepare("SELECT name FROM sqlite_master WHERE name = 'scheduled_messages'").get(),
      ).toEqual({ name: "scheduled_messages" });
    } finally {
      sqlite.close();
      fresh.close();
      rmSync(legacyFolder, { recursive: true, force: true });
    }
  });

  it("appends a cumulative 0007 snapshot and strictly increasing journal after 0006", () => {
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index),
    );
    expect(journal.entries[7]?.tag).toBe("0007_scheduled_messages");
    for (let index = 1; index < journal.entries.length; index++) {
      expect(journal.entries[index]!.when).toBeGreaterThan(journal.entries[index - 1]!.when);
    }
    const previous = JSON.parse(readFileSync(join(folder, "meta/0006_snapshot.json"), "utf8"));
    const current = JSON.parse(readFileSync(join(folder, "meta/0007_snapshot.json"), "utf8"));
    expect(current.prevId).toBe(previous.id);
    expect(current.tables).toMatchObject(previous.tables);
    expect(current.tables).toHaveProperty("scheduled_messages");
  });
});
