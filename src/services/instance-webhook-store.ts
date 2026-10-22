import { sqlite } from "../db/client.js";
import { CHANNEL_EVENTS, type ChannelEvent } from "../types/channel.types.js";
import { createChildLogger } from "../utils/logger.js";

const logger = createChildLogger({ service: "instance-webhook-store" });

/** #142: `?` placeholders only. No named parameters. */
export const INSTANCE_WEBHOOK_SQL = {
  list: "SELECT instance_id, url, auth_header, auth_value, events, updated_at FROM instance_webhooks",
  get: "SELECT instance_id, url, auth_header, auth_value, events, updated_at FROM instance_webhooks WHERE instance_id = ?",
  upsert: `INSERT INTO instance_webhooks (
      instance_id, url, auth_header, auth_value, events, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(instance_id) DO UPDATE SET
      url = excluded.url,
      auth_header = excluded.auth_header,
      auth_value = excluded.auth_value,
      events = excluded.events,
      updated_at = excluded.updated_at`,
  delete: "DELETE FROM instance_webhooks WHERE instance_id = ?",
} as const;

export interface InstanceWebhookRow {
  instanceId: string;
  url: string;
  authHeader: string | null;
  authValue: string | null;
  events: ChannelEvent[] | null;
  updatedAt: number;
}

interface RawInstanceWebhook extends Record<string, unknown> {
  instance_id: string;
  url: string;
  auth_header: string | null;
  auth_value: string | null;
  events: string | null;
  updated_at: number;
}

let storageGeneration = 0;

/** Bumped when stored instance webhooks change, including an instance delete. */
export function instanceWebhookStorageGeneration(): number {
  return storageGeneration;
}

export function touchInstanceWebhookStorage(): void {
  storageGeneration += 1;
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

function toRow(record: RawInstanceWebhook): InstanceWebhookRow {
  return {
    instanceId: record.instance_id,
    url: record.url,
    authHeader: record.auth_header,
    authValue: record.auth_value,
    events: parseStoredEvents(record.events),
    updatedAt: record.updated_at,
  };
}

export async function listInstanceWebhooks(): Promise<InstanceWebhookRow[]> {
  const records = (await sqlite.prepare(INSTANCE_WEBHOOK_SQL.list).all()) as RawInstanceWebhook[];
  const rows: InstanceWebhookRow[] = [];
  for (const record of records) {
    try {
      rows.push(toRow(record));
    } catch {
      logger.warn({ instanceId: record.instance_id }, "Skipping invalid stored instance webhook");
    }
  }
  return rows;
}

export class InvalidStoredInstanceWebhookError extends Error {
  constructor() {
    super("Invalid stored instance webhook");
    this.name = "InvalidStoredInstanceWebhookError";
  }
}

export async function getInstanceWebhook(
  instanceId: string,
): Promise<InstanceWebhookRow | undefined> {
  const record = (await sqlite.prepare(INSTANCE_WEBHOOK_SQL.get).get(instanceId)) as
    RawInstanceWebhook | undefined;
  if (!record) return undefined;
  try {
    return toRow(record);
  } catch {
    logger.warn({ instanceId }, "Skipping invalid stored instance webhook");
    throw new InvalidStoredInstanceWebhookError();
  }
}

export async function upsertInstanceWebhook(row: InstanceWebhookRow): Promise<void> {
  const events = row.events === null ? null : JSON.stringify(row.events);
  await sqlite
    .prepare(INSTANCE_WEBHOOK_SQL.upsert)
    .run(row.instanceId, row.url, row.authHeader, row.authValue, events, row.updatedAt);
  touchInstanceWebhookStorage();
}

export async function deleteInstanceWebhook(instanceId: string): Promise<boolean> {
  const result = await sqlite.prepare(INSTANCE_WEBHOOK_SQL.delete).run(instanceId);
  touchInstanceWebhookStorage();
  return result.changes > 0;
}
