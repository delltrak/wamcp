// ============================================================
// WA MCP — Database Client
// ============================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const DB_PATH = "data/whatsapp.db";

// Ensure the data directory exists
const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

const sqlite: DatabaseType = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

// Run table creation on init (push-based, no migration files needed)
function initializeDatabase(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      channel         TEXT NOT NULL DEFAULT 'baileys',
      phone_number    TEXT,
      status          TEXT NOT NULL DEFAULT 'disconnected',
      wa_version      TEXT,
      cloud_access_token    TEXT,
      cloud_phone_number_id TEXT,
      cloud_business_id     TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      last_connected  INTEGER,
      last_disconnected INTEGER
    );

    CREATE TABLE IF NOT EXISTS auth_keys (
      instance_id     TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      key_id          TEXT NOT NULL,
      key_data        TEXT NOT NULL,
      PRIMARY KEY (instance_id, key_id)
    );
    CREATE INDEX IF NOT EXISTS idx_auth_keys_instance ON auth_keys(instance_id);

    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT NOT NULL,
      instance_id     TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      chat_id         TEXT NOT NULL,
      sender_id       TEXT NOT NULL,
      type            TEXT NOT NULL,
      content         TEXT,
      media_url       TEXT,
      media_local     TEXT,
      media_mimetype  TEXT,
      quoted_id       TEXT,
      is_from_me      INTEGER NOT NULL DEFAULT 0,
      is_forwarded    INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'received',
      timestamp       INTEGER NOT NULL,
      raw_data        TEXT,
      PRIMARY KEY (instance_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(instance_id, chat_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(instance_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id      TEXT NOT NULL,
      instance_id     TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      processed_at    INTEGER NOT NULL,
      PRIMARY KEY (instance_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS contacts (
      instance_id     TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      jid             TEXT NOT NULL,
      name            TEXT,
      notify_name     TEXT,
      phone           TEXT,
      profile_pic_url TEXT,
      is_business     INTEGER NOT NULL DEFAULT 0,
      is_blocked      INTEGER NOT NULL DEFAULT 0,
      updated_at      INTEGER NOT NULL,
      PRIMARY KEY (instance_id, jid)
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(instance_id, phone);

    CREATE TABLE IF NOT EXISTS groups_cache (
      instance_id     TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      jid             TEXT NOT NULL,
      subject         TEXT,
      description     TEXT,
      owner_jid       TEXT,
      participants    TEXT NOT NULL DEFAULT '[]',
      participant_count INTEGER NOT NULL DEFAULT 0,
      is_announce      INTEGER NOT NULL DEFAULT 0,
      is_locked        INTEGER NOT NULL DEFAULT 0,
      ephemeral_duration INTEGER,
      invite_code     TEXT,
      created_at      INTEGER,
      updated_at      INTEGER NOT NULL,
      PRIMARY KEY (instance_id, jid)
    );

    CREATE TABLE IF NOT EXISTS chats (
      instance_id     TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      jid             TEXT NOT NULL,
      name            TEXT,
      is_group        INTEGER NOT NULL DEFAULT 0,
      unread_count    INTEGER NOT NULL DEFAULT 0,
      is_pinned       INTEGER NOT NULL DEFAULT 0,
      is_muted        INTEGER NOT NULL DEFAULT 0,
      mute_until      INTEGER,
      is_archived     INTEGER NOT NULL DEFAULT 0,
      last_message_id TEXT,
      last_message_at INTEGER,
      updated_at      INTEGER NOT NULL,
      PRIMARY KEY (instance_id, jid)
    );
    CREATE INDEX IF NOT EXISTS idx_chats_recent ON chats(instance_id, last_message_at DESC);

    CREATE TABLE IF NOT EXISTS wa_version_cache (
      id              INTEGER PRIMARY KEY DEFAULT 1,
      version_json    TEXT NOT NULL,
      fetched_at      INTEGER NOT NULL,
      is_latest       INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS queue_stats (
      instance_id     TEXT NOT NULL PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
      messages_sent   INTEGER NOT NULL DEFAULT 0,
      messages_failed INTEGER NOT NULL DEFAULT 0,
      last_sent_at    INTEGER,
      rate_limited_until INTEGER
    );
  `);
}

initializeDatabase();

export { sqlite };
