// ============================================================
// WA MCP — Message Deduplication Service
// ============================================================

import { eq, and, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { processedMessages } from "../db/schema.js";
import { DEDUP_TTL_HOURS } from "../constants.js";

export class DedupService {
  /** Returns true if the message was already processed */
  isDuplicate(instanceId: string, messageId: string): boolean {
    const row = db
      .select()
      .from(processedMessages)
      .where(
        and(
          eq(processedMessages.instanceId, instanceId),
          eq(processedMessages.messageId, messageId),
        ),
      )
      .get();
    return !!row;
  }

  /** Mark a message as processed */
  markProcessed(instanceId: string, messageId: string): void {
    db.insert(processedMessages)
      .values({
        instanceId,
        messageId,
        processedAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
  }

  /** Remove entries older than the configured TTL */
  cleanup(): number {
    const cutoff = Date.now() - DEDUP_TTL_HOURS * 60 * 60 * 1000;
    const result = db
      .delete(processedMessages)
      .where(lt(processedMessages.processedAt, cutoff))
      .run();
    return result.changes;
  }
}
