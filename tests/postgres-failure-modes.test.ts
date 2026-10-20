import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { resolveDatabaseConfig } from "../src/db/config.js";
import { db, sqlite } from "../src/db/client.js";
import { instances } from "../src/db/schema.js";
import { ContactStore } from "../src/services/contact-store.js";

const postgresEnabled = resolveDatabaseConfig().driver === "postgres";

async function insertInstance(id: string): Promise<void> {
  const now = Date.now();
  await db.insert(instances).values({
    id,
    name: id,
    channel: "baileys",
    status: "disconnected",
    createdAt: now,
    updatedAt: now,
  }).run();
}

describe("contact search", () => {
  it("matches names regardless of case", async () => {
    const instanceId = `search-${randomUUID()}`;
    await insertInstance(instanceId);
    try {
      const store = new ContactStore(instanceId, db);
      await store.upsertContacts([
        { id: "15550002222@s.whatsapp.net", name: "Joao", phoneNumber: "15550002222" },
      ]);
      const found = await store.getContacts("joao");
      expect(found.map((contact) => contact.name)).toContain("Joao");
    } finally {
      await db.delete(instances).where(eq(instances.id, instanceId)).run();
    }
  });
});

describe("nested transactions", () => {
  it("rolls the outer transaction back when an inner savepoint throws", async () => {
    const outer = `outer-${randomUUID()}`;
    const inner = `inner-${randomUUID()}`;
    const now = Date.now();
    const insert = async (id: string) =>
      (await sqlite
        .prepare(
          `INSERT INTO instances (id, name, channel, status, created_at, updated_at)
           VALUES (?, ?, 'baileys', 'disconnected', ?, ?)`,
        )
        .run(id, id, now, now));

    await expect(
      sqlite.transaction(async () => {
        await insert(outer);
        await sqlite.transaction(async () => {
          await insert(inner);
          throw new Error("inner rollback");
        })();
      })(),
    ).rejects.toThrow("inner rollback");

    const left = await sqlite
      .prepare("SELECT id FROM instances WHERE id = ? OR id = ?")
      .all(outer, inner);
    expect(left).toEqual([]);
  });
});

describe.skipIf(!postgresEnabled)("postgres failure modes", () => {
  it("does not freeze the event loop while Postgres is busy", async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      await sqlite.prepare("SELECT pg_sleep(0.2) AS slept").get();
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });

  it("reconnects after the backend connection is killed", async () => {
    await sqlite.prepare("SELECT 1 AS ok").get();
    await sqlite
      .prepare(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE application_name = current_setting('application_name')
           AND pid <> pg_backend_pid()`,
      )
      .all();
    const started = Date.now();
    const row = (await sqlite.prepare("SELECT 1 AS ok").get()) as { ok: number };
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(Number(row.ok)).toBe(1);
  }, 20_000);

  it("widens INTEGER columns created through exec()", async () => {
    const table = `widen_${randomUUID().replaceAll("-", "")}`;
    await sqlite.exec(`CREATE TABLE ${table} (next_run_at INTEGER)`);
    const column = (await sqlite
      .prepare(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = ? AND column_name = 'next_run_at'`,
      )
      .get(table)) as { data_type: string };
    expect(column.data_type).toBe("bigint");
  });

  it("returns integers above 2^53 as strings", async () => {
    const table = `big_${randomUUID().replaceAll("-", "")}`;
    await sqlite.exec(`CREATE TABLE ${table} (id BIGINT)`);
    await sqlite.prepare(`INSERT INTO ${table} (id) VALUES (9223372036854775807)`).run();
    const row = (await sqlite.prepare(`SELECT id FROM ${table}`).get()) as { id: unknown };
    expect(row.id).toBe("9223372036854775807");
  });
});
