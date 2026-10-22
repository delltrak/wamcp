// ============================================================
// WA MCP — Auto-reply cooldown SQL
// Plain DDL and positional placeholders so this can move into schema-sql.ts.
// ============================================================

/** Table created at startup. No named placeholders. */
export const AUTO_REPLY_COOLDOWNS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS auto_reply_cooldowns (
  instance_id    TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  contact_key    TEXT NOT NULL,
  last_reply_at  INTEGER NOT NULL,
  PRIMARY KEY (instance_id, contact_key)
)`;

export const AUTO_REPLY_COOLDOWN_SELECT_SQL =
  "SELECT last_reply_at FROM auto_reply_cooldowns WHERE instance_id = ? AND contact_key = ?";

export const AUTO_REPLY_COOLDOWN_UPSERT_SQL = `INSERT INTO auto_reply_cooldowns (instance_id, contact_key, last_reply_at)
   VALUES (?, ?, ?)
   ON CONFLICT(instance_id, contact_key) DO UPDATE SET last_reply_at = excluded.last_reply_at`;
