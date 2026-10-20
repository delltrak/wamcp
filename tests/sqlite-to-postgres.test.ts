import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { resolveDatabaseConfig } from "../src/db/config.js";
import { db } from "../src/db/client.js";
import { applySchemaSql } from "../src/db/schema-sql.js";
import { authKeys, instances, messages } from "../src/db/schema.js";
import { migrateSqliteToPostgres } from "../src/db/sqlite-to-postgres.js";

const config = resolveDatabaseConfig();
const postgresEnabled = config.driver === "postgres";

const sessionCreds = {
  registered: true,
  registrationId: 42,
  me: { id: "15550001111@s.whatsapp.net", name: "Migrate fixture" },
  account: { details: "fixture", accountSignatureKey: "key", deviceSignature: "device" },
  noiseKey: { public: "noise-public", private: "noise-private" },
  signedIdentityKey: { public: "identity-public", private: "identity-private" },
  advSecretKey: "adv-secret",
};

describe.skipIf(!postgresEnabled)("SQLite to Postgres migration", () => {
  it("copies a Baileys session so the instance does not need to pair again", async () => {
    const instanceId = `migrate-${randomUUID()}`;
    const directory = mkdtempSync(join(tmpdir(), "wamcp-migrate-src-"));
    const sqlitePath = join(directory, "whatsapp.db");
    const source = new Database(sqlitePath);
    applySchemaSql((sql) => {
      source.exec(sql);
    }, "sqlite");
    const now = Date.now();
    source
      .prepare(
        `INSERT INTO instances (id, name, channel, status, phone_number, created_at, updated_at)
         VALUES (?, 'Migrated', 'baileys', 'disconnected', '15550001111', ?, ?)`,
      )
      .run(instanceId, now, now);
    source
      .prepare(`INSERT INTO auth_keys (instance_id, key_id, key_data) VALUES (?, 'creds', ?)`)
      .run(instanceId, JSON.stringify(sessionCreds));
    source
      .prepare(`INSERT INTO auth_keys (instance_id, key_id, key_data) VALUES (?, 'pre-key-1', ?)`)
      .run(instanceId, JSON.stringify({ public: "pre", private: "key" }));
    source
      .prepare(
        `INSERT INTO messages (
           id, instance_id, chat_id, sender_id, type, content, is_from_me, is_forwarded, status, timestamp
         ) VALUES ('msg-1', ?, '15550001111@s.whatsapp.net', '15550001111@s.whatsapp.net', 'text', 'kept', 1, 0, 'sent', ?)`,
      )
      .run(instanceId, now);
    source.close();

    if (config.driver !== "postgres") return;
    const copied = await migrateSqliteToPostgres({
      sqlitePath,
      databaseUrl: config.url,
    });
    expect(copied.tables.auth_keys).toBe(2);
    expect(copied.tables.messages).toBe(1);

    const sourceAfter = new Database(sqlitePath, { readonly: true });
    const sourceCreds = sourceAfter
      .prepare(`SELECT key_data FROM auth_keys WHERE instance_id = ? AND key_id = 'creds'`)
      .get(instanceId) as { key_data: string };
    sourceAfter.close();
    expect(JSON.parse(sourceCreds.key_data)).toEqual(sessionCreds);

    const creds = db
      .select()
      .from(authKeys)
      .where(and(eq(authKeys.instanceId, instanceId), eq(authKeys.keyId, "creds")))
      .get();
    const preKey = db
      .select()
      .from(authKeys)
      .where(and(eq(authKeys.instanceId, instanceId), eq(authKeys.keyId, "pre-key-1")))
      .get();
    const instance = db.select().from(instances).where(eq(instances.id, instanceId)).get();
    const message = db
      .select()
      .from(messages)
      .where(and(eq(messages.instanceId, instanceId), eq(messages.id, "msg-1")))
      .get();

    expect(creds?.keyData).toBe(JSON.stringify(sessionCreds));
    expect(JSON.parse(creds?.keyData ?? "{}")).toMatchObject({ registered: true });
    expect(preKey?.keyData).toContain("pre");
    expect(instance?.phoneNumber).toBe("15550001111");
    expect(message?.content).toBe("kept");
    expect(message?.isFromMe).toBe(1);

    db.delete(instances).where(eq(instances.id, instanceId)).run();
  });
});
