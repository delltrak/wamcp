// ============================================================
// WA MCP — Persisted auto-reply cooldown
// Plain positional placeholders so the current SQLite layer can run it.
// ============================================================

import { sqlite } from "./client.js";
import {
  AUTO_REPLY_COOLDOWN_SELECT_SQL,
  AUTO_REPLY_COOLDOWN_UPSERT_SQL,
} from "./auto-reply-cooldown-sql.js";

export interface AutoReplyCooldownStore {
  load(instanceId: string, contactKey: string): number | undefined;
  save(instanceId: string, contactKey: string, lastReplyAt: number): void;
}

/** Read the snake_case column. Unquoted aliases are not stable across SQLite and Postgres. */
export function cooldownTimestamp(row: Record<string, unknown> | undefined): number | undefined {
  const value = row?.last_reply_at;
  return typeof value === "number" ? value : undefined;
}

const readCooldown = sqlite.prepare(AUTO_REPLY_COOLDOWN_SELECT_SQL);

const writeCooldown = sqlite.prepare(AUTO_REPLY_COOLDOWN_UPSERT_SQL);

export const sqliteAutoReplyCooldownStore: AutoReplyCooldownStore = {
  load(instanceId: string, contactKey: string): number | undefined {
    const row = readCooldown.get(instanceId, contactKey) as Record<string, unknown> | undefined;
    return cooldownTimestamp(row);
  },
  save(instanceId: string, contactKey: string, lastReplyAt: number): void {
    writeCooldown.run(instanceId, contactKey, lastReplyAt);
  },
};
