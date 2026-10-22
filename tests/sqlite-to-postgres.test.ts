import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { resolveDatabaseConfig } from "../src/db/config.js";
import { applySchemaSql } from "../src/db/schema-sql.js";
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

async function freshSchema(): Promise<{ url: string; schema: string; drop: () => Promise<void> }> {
  if (config.driver !== "postgres") throw new Error("Postgres URL is not configured");
  const schema = `wamcp_copy_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: config.url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const url = new URL(config.url);
  url.searchParams.set("options", `-c search_path=${schema} -c application_name=${schema}`);
  return {
    url: url.toString(),
    schema,
    drop: async () => {
      const closer = new Client({ connectionString: config.url });
      await closer.connect();
      try {
        await closer.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()",
          [schema],
        );
        await closer.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await closer.end();
      }
    },
  };
}

async function buildSqlite(options?: {
  content?: string;
  creds?: unknown;
  unknownTables?: boolean;
  extraColumn?: boolean;
}): Promise<{ path: string; instanceId: string }> {
  const instanceId = `migrate-${randomUUID()}`;
  const directory = mkdtempSync(join(tmpdir(), "wamcp-migrate-src-"));
  const sqlitePath = join(directory, "whatsapp.db");
  const source = new Database(sqlitePath);
  await applySchemaSql((sql) => {
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
    .run(instanceId, JSON.stringify(options?.creds ?? sessionCreds));
  source
    .prepare(`INSERT INTO auth_keys (instance_id, key_id, key_data) VALUES (?, 'pre-key-1', ?)`)
    .run(instanceId, JSON.stringify({ public: "pre", private: "key" }));
  source
    .prepare(
      `INSERT INTO messages (
         id, instance_id, chat_id, sender_id, type, content, is_from_me, is_forwarded, status, timestamp
       ) VALUES ('msg-1', ?, '15550001111@s.whatsapp.net', '15550001111@s.whatsapp.net', 'text', ?, 1, 0, 'sent', ?)`,
    )
    .run(instanceId, options?.content ?? "kept", now);
  source.prepare("INSERT INTO instance_webhooks (instance_id, url, updated_at) VALUES (?, 'https://example.test/hook', ?)").run(instanceId, now);
  source.prepare("INSERT INTO auto_reply_cooldowns (instance_id, contact_key, last_reply_at) VALUES (?, 'contact', ?)").run(instanceId, now);
  source.prepare("INSERT INTO group_history_sends (instance_id, message_id, sent_at) VALUES (?, 'history', ?)").run(instanceId, now);
  source.prepare("INSERT INTO scheduled_messages (id, instance_id, recipient, message_type, payload_json, timezone, recurrence, scheduled_at, next_run_at, status, created_at, updated_at) VALUES ('schedule', ?, 'contact', 'text', '{}', 'UTC', 'once', ?, ?, 'active', ?, ?)").run(instanceId, now, now, now, now);
  if (options?.extraColumn) {
    source.exec("ALTER TABLE messages ADD COLUMN extra_future TEXT");
    source
      .prepare("UPDATE messages SET extra_future = 'later' WHERE instance_id = ?")
      .run(instanceId);
  }
  if (options?.unknownTables) {
    source.exec(
      "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at NUMERIC)",
    );
    source.exec("CREATE TABLE future_feature_rows (id TEXT)");
    source.exec("INSERT INTO future_feature_rows (id) VALUES ('later')");
  }
  source.close();
  return { path: sqlitePath, instanceId };
}

async function credsJson(url: string, instanceId: string): Promise<string> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{ key_data: string }>(
      "SELECT key_data FROM auth_keys WHERE instance_id = $1 AND key_id = 'creds'",
      [instanceId],
    );
    return result.rows[0]?.key_data ?? "";
  } finally {
    await client.end();
  }
}

describe.skipIf(!postgresEnabled)("SQLite to Postgres migration", () => {
  it("copies a Baileys session so the instance does not need to pair again", async () => {
    const target = await freshSchema();
    try {
      const source = await buildSqlite();
      const copied = await migrateSqliteToPostgres({
        sqlitePath: source.path,
        databaseUrl: target.url,
      });
      expect(copied.tables.auth_keys).toBe(2);
      expect(copied.tables.messages).toBe(1);
      for (const table of ["instance_webhooks", "auto_reply_cooldowns", "group_history_sends", "scheduled_messages"]) expect(copied.tables[table]).toBe(1);
      expect(copied.skipped).toEqual([]);

      const sourceAfter = new Database(source.path, { readonly: true });
      const sourceCreds = sourceAfter
        .prepare(`SELECT key_data FROM auth_keys WHERE instance_id = ? AND key_id = 'creds'`)
        .get(source.instanceId) as { key_data: string };
      sourceAfter.close();
      expect(JSON.parse(sourceCreds.key_data)).toEqual(sessionCreds);
      expect(JSON.parse(await credsJson(target.url, source.instanceId))).toEqual(sessionCreds);
    } finally {
      await target.drop();
    }
  });

  it("refuses a second copy unless --force is passed", async () => {
    const target = await freshSchema();
    try {
      const source = await buildSqlite();
      await migrateSqliteToPostgres({ sqlitePath: source.path, databaseUrl: target.url });
      const replacement = { ...sessionCreds, advSecretKey: "replaced" };
      const again = await buildSqlite({ creds: replacement });
      await expect(
        migrateSqliteToPostgres({ sqlitePath: again.path, databaseUrl: target.url }),
      ).rejects.toThrow(/Refusing to copy/);
      expect(JSON.parse(await credsJson(target.url, source.instanceId)).advSecretKey).toBe(
        "adv-secret",
      );

      await migrateSqliteToPostgres({
        sqlitePath: again.path,
        databaseUrl: target.url,
        force: true,
      });
      expect(JSON.parse(await credsJson(target.url, again.instanceId)).advSecretKey).toBe(
        "replaced",
      );
      expect(await credsJson(target.url, source.instanceId)).toBe("");
    } finally {
      await target.drop();
    }
  });

  it("skips unknown SQLite tables and strips NUL bytes", async () => {
    const target = await freshSchema();
    try {
      const source = await buildSqlite({ content: "a\u0000b", unknownTables: true });
      const copied = await migrateSqliteToPostgres({
        sqlitePath: source.path,
        databaseUrl: target.url,
      });
      expect(copied.skipped).toEqual(["__drizzle_migrations", "future_feature_rows"]);
      expect(copied.tables.messages).toBe(1);
      const client = new Client({ connectionString: target.url });
      await client.connect();
      try {
        const message = await client.query<{ content: string }>(
          "SELECT content FROM messages WHERE instance_id = $1",
          [source.instanceId],
        );
        expect(message.rows[0]?.content).toBe("ab");
        const unknown = await client.query("SELECT to_regclass('future_feature_rows') AS present");
        expect(unknown.rows[0]?.present).toBeNull();
      } finally {
        await client.end();
      }
    } finally {
      await target.drop();
    }
  });

  it("skips SQLite columns that are not in Postgres", async () => {
    const target = await freshSchema();
    try {
      const source = await buildSqlite({ extraColumn: true });
      const copied = await migrateSqliteToPostgres({
        sqlitePath: source.path,
        databaseUrl: target.url,
      });
      expect(copied.tables.messages).toBe(1);
      const client = new Client({ connectionString: target.url });
      await client.connect();
      try {
        const message = await client.query<{ content: string }>(
          "SELECT content FROM messages WHERE instance_id = $1",
          [source.instanceId],
        );
        expect(message.rows[0]?.content).toBe("kept");
      } finally {
        await client.end();
      }
    } finally {
      await target.drop();
    }
  });

  it("runs the copy CLI against an empty schema", async () => {
    const target = await freshSchema();
    try {
      const source = await buildSqlite();
      const result = spawnSync(
        process.execPath,
        ["./node_modules/tsx/dist/cli.mjs", "src/db/migrate-to-postgres-cli.ts", source.path],
        {
          env: { ...process.env, WA_DATABASE_URL: target.url },
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Copied");
      expect(JSON.parse(await credsJson(target.url, source.instanceId)).registered).toBe(true);

      const refused = spawnSync(
        process.execPath,
        ["./node_modules/tsx/dist/cli.mjs", "src/db/migrate-to-postgres-cli.ts", source.path],
        {
          env: { ...process.env, WA_DATABASE_URL: target.url },
          encoding: "utf8",
        },
      );
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("Refusing to copy");
      expect(refused.stderr).not.toMatch(/\n\s+at /);
      expect(refused.stdout).not.toContain("Copied");

      const migrate = spawnSync(
        process.execPath,
        ["./node_modules/tsx/dist/cli.mjs", "src/db/migrate-cli.ts"],
        {
          env: { ...process.env, WA_DATABASE_URL: target.url },
          encoding: "utf8",
        },
      );
      expect(migrate.status).toBe(0);
      expect(migrate.stdout).toContain("Postgres schema is up to date.");
    } finally {
      await target.drop();
    }
  });
});
