import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, and, lt } from "drizzle-orm";
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

// We test the DedupService logic by reimplementing with an in-memory DB
// to avoid importing the real db client (which creates a file-based DB).

const processedMessages = sqliteTable(
  "processed_messages",
  {
    messageId: text("message_id").notNull(),
    instanceId: text("instance_id").notNull(),
    processedAt: integer("processed_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.instanceId, table.messageId] })],
);

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE processed_messages (
      message_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      processed_at INTEGER NOT NULL,
      PRIMARY KEY (instance_id, message_id)
    );
  `);
  return drizzle(sqlite, { schema: { processedMessages } });
}

// Reimplementation of DedupService using injected db
class TestDedupService {
  constructor(
    private db: ReturnType<typeof createTestDb>,
    private ttlHours = 24,
  ) {}

  isDuplicate(instanceId: string, messageId: string): boolean {
    const row = this.db
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

  markProcessed(instanceId: string, messageId: string): void {
    this.db
      .insert(processedMessages)
      .values({
        instanceId,
        messageId,
        processedAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
  }

  cleanup(): number {
    const cutoff = Date.now() - this.ttlHours * 60 * 60 * 1000;
    const result = this.db
      .delete(processedMessages)
      .where(lt(processedMessages.processedAt, cutoff))
      .run();
    return result.changes;
  }
}

describe("DedupService", () => {
  let db: ReturnType<typeof createTestDb>;
  let dedup: TestDedupService;

  beforeEach(() => {
    db = createTestDb();
    dedup = new TestDedupService(db);
  });

  it("isDuplicate returns false for new messages", () => {
    expect(dedup.isDuplicate("inst_1", "msg_001")).toBe(false);
  });

  it("isDuplicate returns true for seen messages", () => {
    dedup.markProcessed("inst_1", "msg_001");
    expect(dedup.isDuplicate("inst_1", "msg_001")).toBe(true);
  });

  it("markProcessed stores entries", () => {
    dedup.markProcessed("inst_1", "msg_001");
    dedup.markProcessed("inst_1", "msg_002");

    expect(dedup.isDuplicate("inst_1", "msg_001")).toBe(true);
    expect(dedup.isDuplicate("inst_1", "msg_002")).toBe(true);
    expect(dedup.isDuplicate("inst_1", "msg_003")).toBe(false);
  });

  it("messages are scoped per instance", () => {
    dedup.markProcessed("inst_1", "msg_001");

    expect(dedup.isDuplicate("inst_1", "msg_001")).toBe(true);
    expect(dedup.isDuplicate("inst_2", "msg_001")).toBe(false);
  });

  it("markProcessed is idempotent (onConflictDoNothing)", () => {
    dedup.markProcessed("inst_1", "msg_001");
    // Should not throw
    dedup.markProcessed("inst_1", "msg_001");
    expect(dedup.isDuplicate("inst_1", "msg_001")).toBe(true);
  });

  it("cleanup removes old entries", () => {
    // Insert a message with old timestamp
    const oldTimestamp = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
    db.insert(processedMessages)
      .values({
        instanceId: "inst_1",
        messageId: "old_msg",
        processedAt: oldTimestamp,
      })
      .run();

    // Insert a recent message
    dedup.markProcessed("inst_1", "new_msg");

    const removed = dedup.cleanup();
    expect(removed).toBe(1);
    expect(dedup.isDuplicate("inst_1", "old_msg")).toBe(false);
    expect(dedup.isDuplicate("inst_1", "new_msg")).toBe(true);
  });

  it("cleanup returns 0 when nothing to remove", () => {
    dedup.markProcessed("inst_1", "msg_001");
    const removed = dedup.cleanup();
    expect(removed).toBe(0);
  });

  it("cleanup removes multiple old entries", () => {
    const oldTimestamp = Date.now() - 25 * 60 * 60 * 1000;
    for (let i = 0; i < 5; i++) {
      db.insert(processedMessages)
        .values({
          instanceId: "inst_1",
          messageId: `old_${i}`,
          processedAt: oldTimestamp,
        })
        .run();
    }

    const removed = dedup.cleanup();
    expect(removed).toBe(5);
  });
});
