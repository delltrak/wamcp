import { mkdtempSync, readFileSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";

const folder = new URL("../drizzle/", import.meta.url).pathname;
const journal = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};

describe("group history migration after webhooks and auto-reply", () => {
  it("upgrades SQLite 0005 to 0006 without losing either feature's rows and supports fresh installs", () => {
    const legacyFolder = mkdtempSync(join(tmpdir(), "wamcp-legacy-migrations-"));
    const sqlite = new Database(":memory:");
    const fresh = new Database(":memory:");
    try {
      sqlite.pragma("foreign_keys = ON");
      mkdirSync(join(legacyFolder, "meta"));
      const legacy = journal.entries.filter((entry) => entry.idx < 6);
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
        INSERT INTO auto_reply_cooldowns VALUES ('fixture', '111@s.whatsapp.net', 123);`);
      migrate(db, { migrationsFolder: folder });
      migrate(db, { migrationsFolder: folder });
      expect(sqlite.prepare("SELECT last_reply_at FROM auto_reply_cooldowns").get()).toEqual({
        last_reply_at: 123,
      });
      expect(sqlite.prepare("SELECT url FROM instance_webhooks").get()).toEqual({
        url: "https://example.invalid",
      });
      sqlite.exec("INSERT INTO group_history_sends VALUES ('fixture', 'stub', 456)");
      expect(() =>
        sqlite.exec("INSERT INTO group_history_sends VALUES ('fixture', 'stub', 789)"),
      ).toThrow();
      sqlite.exec("DELETE FROM instances WHERE id = 'fixture'");
      for (const table of ["group_history_sends", "instance_webhooks", "auto_reply_cooldowns"]) {
        expect(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
      migrate(drizzle(fresh), { migrationsFolder: folder });
      expect(
        fresh.prepare("SELECT name FROM sqlite_master WHERE name = 'group_history_sends'").get(),
      ).toEqual({ name: "group_history_sends" });
    } finally {
      sqlite.close();
      fresh.close();
      rmSync(legacyFolder, { recursive: true, force: true });
    }
  });

  it("keeps migration indexes, timestamps, and cumulative snapshots in sequence", () => {
    expect(journal.entries.map((entry) => entry.idx)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(journal.entries.at(-1)?.tag).toBe("0006_group_history_sends");
    for (let index = 1; index < journal.entries.length; index++) {
      expect(journal.entries[index]!.when).toBeGreaterThan(journal.entries[index - 1]!.when);
    }
    const previous = JSON.parse(readFileSync(join(folder, "meta/0005_snapshot.json"), "utf8"));
    const current = JSON.parse(readFileSync(join(folder, "meta/0006_snapshot.json"), "utf8"));
    expect(current.prevId).toBe(previous.id);
    expect(current.tables).toMatchObject(previous.tables);
    expect(current.tables).toHaveProperty("group_history_sends");
  });
});
