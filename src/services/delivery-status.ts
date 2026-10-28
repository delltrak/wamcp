import { and, count, eq, max, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { messageReceipts } from "../db/schema.js";

export async function recordCloudReceipt(
  instanceId: string,
  chatId: string,
  messageId: string,
  status: "delivered" | "read",
  timestamp: number,
): Promise<void> {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > 253402300799) {
    timestamp = Math.floor(Date.now() / 1000);
  }
  await db
    .insert(messageReceipts)
    .values({
      instanceId,
      chatId,
      messageId,
      participant: chatId,
      status,
      timestamp,
    })
    .onConflictDoUpdate({
      target: [
        messageReceipts.instanceId,
        messageReceipts.chatId,
        messageReceipts.messageId,
        messageReceipts.participant,
      ],
      set: {
        status,
        timestamp: sql`CASE WHEN excluded.timestamp > ${messageReceipts.timestamp} THEN excluded.timestamp ELSE ${messageReceipts.timestamp} END`,
      },
      setWhere: status === "read" ? undefined : eq(messageReceipts.status, "delivered"),
    })
    .run();
}

/** Counts describe observed participants, never all group members. No message content is read. */
export async function getDeliverySummary(instanceId: string, chatId: string, messageId: string) {
  const rows = await db
    .select({
      status: messageReceipts.status,
      count: count(),
      timestamp: max(messageReceipts.timestamp),
    })
    .from(messageReceipts)
    .where(
      and(
        eq(messageReceipts.instanceId, instanceId),
        eq(messageReceipts.chatId, chatId),
        eq(messageReceipts.messageId, messageId),
      ),
    )
    .groupBy(messageReceipts.status)
    .all();
  const counts = { delivered: 0, read: 0, played: 0 };
  let latest = 0;
  for (const row of rows) {
    counts[row.status] = Number(row.count);
    latest = Math.max(latest, row.timestamp ?? 0);
  }
  return {
    counts,
    latestObservedAt: latest ? new Date(latest * 1000).toISOString() : null,
    scope: "observed_participants_only" as const,
  };
}
