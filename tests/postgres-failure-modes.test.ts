import { randomUUID } from "node:crypto";
import { eq, getTableColumns, getTableName, isTable } from "drizzle-orm";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { clearAuthState, useSqliteAuthState } from "../src/channels/baileys/baileys.auth.js";
import { resolveDatabaseConfig } from "../src/db/config.js";
import { db, sqlite } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { ContactStore } from "../src/services/contact-store.js";

const postgresEnabled = resolveDatabaseConfig().driver === "postgres";

async function insertInstance(id: string): Promise<void> {
  const now = Date.now();
  await db
    .insert(schema.instances)
    .values({
      id,
      name: id,
      channel: "baileys",
      status: "disconnected",
      createdAt: now,
      updatedAt: now,
    })
    .run();
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
      await db.delete(schema.instances).where(eq(schema.instances.id, instanceId)).run();
    }
  });
});

describe("nested transactions", () => {
  it("rolls the outer transaction back when an inner savepoint throws", async () => {
    const outer = `outer-${randomUUID()}`;
    const inner = `inner-${randomUUID()}`;
    const now = Date.now();
    const insert = async (id: string) =>
      await sqlite
        .prepare(
          `INSERT INTO instances (id, name, channel, status, created_at, updated_at)
           VALUES (?, ?, 'baileys', 'disconnected', ?, ?)`,
        )
        .run(id, id, now, now);

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

describe("baileys auth keys", () => {
  it("upserts and deletes keys in one batch", async () => {
    const instanceId = `keys-${randomUUID()}`;
    await insertInstance(instanceId);
    try {
      const { state } = await useSqliteAuthState(instanceId);
      await state.keys.set({
        "pre-key": {
          "1": { public: "a" },
          "2": { public: "b" },
        },
        session: {
          abc: { id: "abc" },
          gone: null,
        },
      });
      const got = await state.keys.get("pre-key", ["1", "2", "3"]);
      expect(got["1"]).toEqual({ public: "a" });
      expect(got["2"]).toEqual({ public: "b" });
      expect(got["3"]).toBeUndefined();
      const session = await state.keys.get("session", ["abc", "gone"]);
      expect(session.abc).toEqual({ id: "abc" });
      expect(session.gone).toBeUndefined();

      await state.keys.set({ "pre-key": { "1": null } });
      const after = await state.keys.get("pre-key", ["1", "2"]);
      expect(after["1"]).toBeUndefined();
      expect(after["2"]).toEqual({ public: "b" });
    } finally {
      await clearAuthState(instanceId);
      await db.delete(schema.instances).where(eq(schema.instances.id, instanceId)).run();
    }
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

  it("creates every schema.ts table and column", async () => {
    const tables = Object.values(schema).filter(isTable);
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      const name = getTableName(table);
      const columns = Object.values(getTableColumns(table)).map((column) => column.name);
      const rows = (await sqlite
        .prepare(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = ?`,
        )
        .all(name)) as Array<{ column_name: string }>;
      const present = new Set(rows.map((row) => row.column_name));
      for (const column of columns) {
        expect(present.has(column), `${name}.${column}`).toBe(true);
      }
    }
  });

  it("discards a transaction connection that cannot roll back", async () => {
    const id = `discard-${randomUUID()}`;
    const now = Date.now();
    const admin = new Client({ connectionString: process.env.WA_DATABASE_URL });
    await admin.connect();
    try {
      await expect(
        sqlite.transaction(async () => {
          const row = (await sqlite.prepare("SELECT pg_backend_pid() AS pid").get()) as {
            pid: number | string;
          };
          await admin.query("SELECT pg_terminate_backend($1)", [Number(row.pid)]);
          throw new Error("transaction failed");
        })(),
      ).rejects.toThrow("transaction failed");

      await sqlite
        .prepare(
          `INSERT INTO instances (id, name, channel, status, created_at, updated_at)
           VALUES (?, 'discard', 'baileys', 'disconnected', ?, ?)`,
        )
        .run(id, now, now);
      const stored = (await sqlite.prepare("SELECT id FROM instances WHERE id = ?").get(id)) as {
        id: string;
      };
      expect(stored).toEqual({ id });
    } finally {
      await sqlite.prepare("DELETE FROM instances WHERE id = ?").run(id);
      await admin.end();
    }
  }, 20_000);

  it("returns integers above 2^53 as strings", async () => {
    const table = `big_${randomUUID().replaceAll("-", "")}`;
    await sqlite.exec(`CREATE TABLE ${table} (id BIGINT)`);
    await sqlite.prepare(`INSERT INTO ${table} (id) VALUES (9223372036854775807)`).run();
    const row = (await sqlite.prepare(`SELECT id FROM ${table}`).get()) as { id: unknown };
    expect(row.id).toBe("9223372036854775807");
  });
});
