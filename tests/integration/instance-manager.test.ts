import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";

// We create an in-memory version of the schema and a minimal InstanceManager
// to test the CRUD logic without requiring Redis or WhatsApp connections.

const instances = sqliteTable("instances", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  channel: text("channel", { enum: ["baileys", "cloud"] })
    .notNull()
    .default("baileys"),
  phoneNumber: text("phone_number"),
  status: text("status", {
    enum: ["connected", "disconnected", "connecting", "qr_pending"],
  })
    .notNull()
    .default("disconnected"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  lastConnected: integer("last_connected"),
  lastDisconnected: integer("last_disconnected"),
});

const queueStats = sqliteTable("queue_stats", {
  instanceId: text("instance_id").primaryKey(),
  messagesSent: integer("messages_sent").notNull().default(0),
  messagesFailed: integer("messages_failed").notNull().default(0),
  lastSentAt: integer("last_sent_at"),
  rateLimitedUntil: integer("rate_limited_until"),
});

const INSTANCE_ID_PREFIX = "inst_";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE instances (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      channel         TEXT NOT NULL DEFAULT 'baileys',
      phone_number    TEXT,
      status          TEXT NOT NULL DEFAULT 'disconnected',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      last_connected  INTEGER,
      last_disconnected INTEGER
    );

    CREATE TABLE queue_stats (
      instance_id     TEXT NOT NULL PRIMARY KEY,
      messages_sent   INTEGER NOT NULL DEFAULT 0,
      messages_failed INTEGER NOT NULL DEFAULT 0,
      last_sent_at    INTEGER,
      rate_limited_until INTEGER
    );
  `);
  return { db: drizzle(sqlite, { schema: { instances, queueStats } }), sqlite };
}

// Minimal InstanceManager that works with injected DB
class TestInstanceManager {
  constructor(private db: ReturnType<typeof createTestDb>["db"]) {}

  createInstance(name: string, channel: "baileys" | "cloud" = "baileys") {
    const id = `${INSTANCE_ID_PREFIX}${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    this.db
      .insert(instances)
      .values({
        id,
        name,
        channel,
        status: "disconnected",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    this.db
      .insert(queueStats)
      .values({ instanceId: id, messagesSent: 0, messagesFailed: 0 })
      .onConflictDoNothing()
      .run();

    return this.getInstance(id);
  }

  getInstance(id: string) {
    const row = this.db.select().from(instances).where(eq(instances.id, id)).get();
    if (!row) throw new Error(`Instance ${id} not found`);
    return row;
  }

  getAllInstances() {
    return this.db.select().from(instances).all();
  }

  deleteInstance(id: string) {
    this.db.delete(queueStats).where(eq(queueStats.instanceId, id)).run();
    this.db.delete(instances).where(eq(instances.id, id)).run();
  }
}

describe("InstanceManager (integration skeleton)", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let manager: TestInstanceManager;

  beforeEach(() => {
    testDb = createTestDb();
    manager = new TestInstanceManager(testDb.db);
  });

  afterEach(() => {
    testDb.sqlite.close();
  });

  it("creates an instance and stores it in the DB", () => {
    const instance = manager.createInstance("test-bot");

    expect(instance.id).toMatch(new RegExp(`^${INSTANCE_ID_PREFIX}`));
    expect(instance.name).toBe("test-bot");
    expect(instance.channel).toBe("baileys");
    expect(instance.status).toBe("disconnected");
    expect(instance.createdAt).toBeGreaterThan(0);
  });

  it("creates a cloud instance", () => {
    const instance = manager.createInstance("cloud-bot", "cloud");

    expect(instance.channel).toBe("cloud");
    expect(instance.name).toBe("cloud-bot");
  });

  it("retrieves an instance by id", () => {
    const created = manager.createInstance("my-bot");
    const fetched = manager.getInstance(created.id);

    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe("my-bot");
  });

  it("throws when instance not found", () => {
    expect(() => manager.getInstance("nonexistent")).toThrow("Instance nonexistent not found");
  });

  it("lists all instances", () => {
    manager.createInstance("bot-1");
    manager.createInstance("bot-2");
    manager.createInstance("bot-3");

    const all = manager.getAllInstances();
    expect(all).toHaveLength(3);
  });

  it("deletes an instance", () => {
    const instance = manager.createInstance("to-delete");
    expect(manager.getAllInstances()).toHaveLength(1);

    manager.deleteInstance(instance.id);
    expect(manager.getAllInstances()).toHaveLength(0);
  });

  it("deleting also removes queue stats", () => {
    const instance = manager.createInstance("with-stats");

    // Verify queue stats exist
    const stats = testDb.db
      .select()
      .from(queueStats)
      .where(eq(queueStats.instanceId, instance.id))
      .get();
    expect(stats).toBeTruthy();

    manager.deleteInstance(instance.id);

    const statsAfter = testDb.db
      .select()
      .from(queueStats)
      .where(eq(queueStats.instanceId, instance.id))
      .get();
    expect(statsAfter).toBeUndefined();
  });

  it("creates instances with unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const instance = manager.createInstance(`bot-${i}`);
      ids.add(instance.id);
    }
    expect(ids.size).toBe(10);
  });

  it("instances default to disconnected status", () => {
    const instance = manager.createInstance("test-status");
    expect(instance.status).toBe("disconnected");
  });
});
