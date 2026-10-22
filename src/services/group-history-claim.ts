import { db } from "../db/client.js";
import { groupHistorySends } from "../db/schema.js";

/** Record a stub message id. Returns false when that id was already claimed. */
export function claimGroupHistoryStub(instanceId: string, messageId: string): boolean {
  const result = db
    .insert(groupHistorySends)
    .values({
      instanceId,
      messageId,
      sentAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
  return result.changes > 0;
}
