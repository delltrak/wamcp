import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { instanceWebhooks } from "../db/schema.js";
import { CHANNEL_EVENTS, type ChannelEvent } from "../types/channel.types.js";

export interface InstanceWebhookRow {
  instanceId: string;
  url: string;
  authHeader: string | null;
  authValue: string | null;
  events: ChannelEvent[] | null;
  updatedAt: number;
}

function parseStoredEvents(value: string | null): ChannelEvent[] | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid stored instance webhook events");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((event) => typeof event === "string") ||
    parsed.some((event) => !CHANNEL_EVENTS.includes(event as ChannelEvent))
  ) {
    throw new Error("Invalid stored instance webhook events");
  }
  return parsed as ChannelEvent[];
}

function toRow(record: typeof instanceWebhooks.$inferSelect): InstanceWebhookRow {
  return {
    instanceId: record.instanceId,
    url: record.url,
    authHeader: record.authHeader,
    authValue: record.authValue,
    events: parseStoredEvents(record.events),
    updatedAt: record.updatedAt,
  };
}

export function listInstanceWebhooks(): InstanceWebhookRow[] {
  return db.select().from(instanceWebhooks).all().map(toRow);
}

export function getInstanceWebhook(instanceId: string): InstanceWebhookRow | undefined {
  const record = db
    .select()
    .from(instanceWebhooks)
    .where(eq(instanceWebhooks.instanceId, instanceId))
    .get();
  return record ? toRow(record) : undefined;
}

export function upsertInstanceWebhook(row: InstanceWebhookRow): void {
  const events = row.events === null ? null : JSON.stringify(row.events);
  db.insert(instanceWebhooks)
    .values({
      instanceId: row.instanceId,
      url: row.url,
      authHeader: row.authHeader,
      authValue: row.authValue,
      events,
      updatedAt: row.updatedAt,
    })
    .onConflictDoUpdate({
      target: instanceWebhooks.instanceId,
      set: {
        url: row.url,
        authHeader: row.authHeader,
        authValue: row.authValue,
        events,
        updatedAt: row.updatedAt,
      },
    })
    .run();
}

export function deleteInstanceWebhook(instanceId: string): boolean {
  const result = db
    .delete(instanceWebhooks)
    .where(eq(instanceWebhooks.instanceId, instanceId))
    .run();
  return result.changes > 0;
}
