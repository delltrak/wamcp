// ============================================================
// WA MCP — Persisted auto-reply cooldown
// Plain positional placeholders so the current SQLite layer can run it.
// ============================================================

import { sqlite } from "./client.js";

export interface AutoReplyCooldownStore {
  load(instanceId: string, contactKey: string): number | undefined;
  save(instanceId: string, contactKey: string, lastReplyAt: number): void;
}

interface CooldownRow {
  lastReplyAt: number;
}

const readCooldown = sqlite.prepare(
  "SELECT last_reply_at AS lastReplyAt FROM auto_reply_cooldowns WHERE instance_id = ? AND contact_key = ?",
);

const writeCooldown = sqlite.prepare(
  `INSERT INTO auto_reply_cooldowns (instance_id, contact_key, last_reply_at)
   VALUES (?, ?, ?)
   ON CONFLICT(instance_id, contact_key) DO UPDATE SET last_reply_at = excluded.last_reply_at`,
);

export const sqliteAutoReplyCooldownStore: AutoReplyCooldownStore = {
  load(instanceId: string, contactKey: string): number | undefined {
    const row = readCooldown.get(instanceId, contactKey) as CooldownRow | undefined;
    return row?.lastReplyAt;
  },
  save(instanceId: string, contactKey: string, lastReplyAt: number): void {
    writeCooldown.run(instanceId, contactKey, lastReplyAt);
  },
};
