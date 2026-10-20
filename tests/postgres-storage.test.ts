import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { resolveDatabaseConfig } from "../src/db/config.js";
import { db, sqlite } from "../src/db/client.js";
import { instances, messageReceipts, processedMessages } from "../src/db/schema.js";
import { POSTGRES_BASELINE_MIGRATION_ID } from "../src/db/schema-sql.js";
import { searchStoredMessages } from "../src/services/message-search.js";

const postgresEnabled = resolveDatabaseConfig().driver === "postgres";

describe.skipIf(!postgresEnabled)("postgres storage", () => {
  it("does not create the default SQLite file", () => {
    expect(existsSync(resolveDatabaseConfig().path)).toBe(false);
  });

  it("records the baseline migration and stores timestamps as bigint", () => {
    const migration = sqlite
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get(POSTGRES_BASELINE_MIGRATION_ID) as { id: string } | undefined;
    expect(migration?.id).toBe(POSTGRES_BASELINE_MIGRATION_ID);
    const column = sqlite
      .prepare(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'timestamp'`,
      )
      .get() as { data_type: string };
    expect(column.data_type).toBe("bigint");
  });

  it("keeps aggregate MAX, rewrites scalar MAX, and reports insert conflicts", () => {
    const instanceId = `pg-storage-${randomUUID()}`;
    const now = Date.now();
    try {
      db.insert(instances)
        .values({
          id: instanceId,
          name: "Postgres storage",
          channel: "baileys",
          status: "disconnected",
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const inserted = db
        .insert(processedMessages)
        .values({ instanceId, messageId: "m1", processedAt: now })
        .onConflictDoNothing()
        .run();
      const duplicate = db
        .insert(processedMessages)
        .values({ instanceId, messageId: "m1", processedAt: now })
        .onConflictDoNothing()
        .run();
      expect(inserted.changes).toBe(1);
      expect(duplicate.changes).toBe(0);

      db.insert(messageReceipts)
        .values({
          instanceId,
          chatId: "15550001111@s.whatsapp.net",
          messageId: "m1",
          participant: "15550001111@s.whatsapp.net",
          status: "delivered",
          timestamp: 10,
        })
        .run();
      db.insert(messageReceipts)
        .values({
          instanceId,
          chatId: "15550001111@s.whatsapp.net",
          messageId: "m1",
          participant: "15550001111@s.whatsapp.net",
          status: "read",
          timestamp: 4,
        })
        .onConflictDoUpdate({
          target: [
            messageReceipts.instanceId,
            messageReceipts.chatId,
            messageReceipts.messageId,
            messageReceipts.participant,
          ],
          set: {
            status: sql`CASE
              WHEN ${messageReceipts.status} = 'played' OR excluded.status = 'played' THEN 'played'
              WHEN ${messageReceipts.status} = 'read' OR excluded.status = 'read' THEN 'read'
              ELSE 'delivered'
            END`,
            timestamp: sql`MAX(${messageReceipts.timestamp}, excluded.timestamp)`,
          },
        })
        .run();
      const receipt = db
        .select()
        .from(messageReceipts)
        .where(eq(messageReceipts.instanceId, instanceId))
        .get();
      expect(receipt?.status).toBe("read");
      expect(receipt?.timestamp).toBe(10);

      const aggregate = sqlite
        .prepare(
          `WITH rows AS (
             SELECT 'a' AS jid, 2 AS candidate_at
             UNION ALL
             SELECT 'a', 1
           )
           SELECT jid, MAX(candidate_at) AS latest_at FROM rows GROUP BY jid`,
        )
        .get() as { jid: string; latest_at: number };
      expect(aggregate).toEqual({ jid: "a", latest_at: 2 });

      sqlite
        .prepare(
          `INSERT INTO messages (
             id, instance_id, chat_id, sender_id, type, content, is_from_me, is_forwarded, status, timestamp
           ) VALUES (?, ?, ?, ?, 'text', ?, 0, 0, 'received', ?)`,
        )
        .run("m-search", instanceId, "15550001111@s.whatsapp.net", "15550001111@s.whatsapp.net", "Hello Postgres", now);
      const found = searchStoredMessages(sqlite, instanceId, {
        query: "postgres",
        limit: 10,
        offset: 0,
      });
      expect(found.messages.map((message) => message.id)).toEqual(["m-search"]);

      const rolledBack = `pg-rollback-${randomUUID()}`;
      expect(() => {
        sqlite
          .transaction(() => {
            sqlite
              .prepare(
                `INSERT INTO instances (id, name, channel, status, created_at, updated_at)
                 VALUES (?, 'rollback', 'baileys', 'disconnected', ?, ?)`,
              )
              .run(rolledBack, now, now);
            throw new Error("rollback");
          })
          .deferred();
      }).toThrow(/rollback/);
      expect(sqlite.prepare("SELECT id FROM instances WHERE id = ?").get(rolledBack)).toBeUndefined();
    } finally {
      sqlite.prepare("DELETE FROM instances WHERE id = ?").run(instanceId);
    }
  });
});
