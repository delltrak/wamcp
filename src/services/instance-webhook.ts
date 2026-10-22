import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { instances } from "../db/schema.js";
import type { ChannelEvent } from "../types/channel.types.js";
import { logger } from "../utils/logger.js";
import { isValidInstanceId } from "../utils/validation.js";
import {
  assertInstanceWebhookHostAllowed,
  eventWebhookAllowsHttp,
  instanceWebhookHeaders,
  loadEventWebhookConfig,
  normalizeInstanceWebhookEvents,
  normalizeInstanceWebhookUrl,
  validateStoredInstanceWebhook,
} from "./event-webhook-config.js";
import {
  deleteInstanceWebhook,
  getInstanceWebhook,
  InvalidStoredInstanceWebhookError,
  upsertInstanceWebhook,
} from "./instance-webhook-store.js";

export interface InstanceWebhookConfigured {
  configured: true;
  /** Origin only. The full URL stays in the database. */
  endpoint: string;
  authHeader: string | null;
  authConfigured: boolean;
  /** Null inherits WA_EVENT_WEBHOOK_EVENTS. */
  events: ChannelEvent[] | null;
  updatedAt: number;
}

export type InstanceWebhookState =
  InstanceWebhookConfigured | { configured: false; invalid?: true };

export interface InstanceWebhookInput {
  instanceId: string;
  url: string;
  authHeader?: string;
  authValue?: string;
  events?: readonly string[];
}

async function requireInstance(instanceId: string): Promise<void> {
  if (!isValidInstanceId(instanceId)) throw new Error("Invalid instance ID");
  const row = await db
    .select({ id: instances.id })
    .from(instances)
    .where(eq(instances.id, instanceId))
    .get();
  if (!row) throw new Error("Instance not found");
}

function redactedWebhookEndpoint(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "[invalid URL]";
  }
}

function viewFromStored(
  url: string,
  authHeader: string | null,
  authValue: string | null,
  events: ChannelEvent[] | null,
  updatedAt: number,
): InstanceWebhookConfigured {
  return {
    configured: true,
    endpoint: redactedWebhookEndpoint(url),
    authHeader,
    authConfigured: authHeader !== null && authValue !== null && authValue !== "",
    events,
    updatedAt,
  };
}

/** Replace the stored webhook for one instance. The auth value is not returned. */
export async function setInstanceWebhook(
  input: InstanceWebhookInput,
): Promise<InstanceWebhookConfigured> {
  await requireInstance(input.instanceId);
  const url = normalizeInstanceWebhookUrl(input.url.trim(), eventWebhookAllowsHttp());
  assertInstanceWebhookHostAllowed(url);
  instanceWebhookHeaders(input.authHeader, input.authValue);
  const events = normalizeInstanceWebhookEvents(input.events);
  const active = loadEventWebhookConfig();
  if (!active.instanceMergeGlobal && active.destinations.length > 0) {
    logger.warn(
      { service: "instance-webhook", instanceId: input.instanceId },
      "Instance webhook replaces the global event webhook for this instance",
    );
  }
  const updatedAt = Date.now();
  const authHeader = input.authHeader ?? null;
  const authValue = input.authValue ?? null;
  await upsertInstanceWebhook({
    instanceId: input.instanceId,
    url,
    authHeader,
    authValue,
    events,
    updatedAt,
  });
  return viewFromStored(url, authHeader, authValue, events, updatedAt);
}

/** Read the stored webhook. The auth value is never included. */
export async function readInstanceWebhook(instanceId: string): Promise<InstanceWebhookState> {
  await requireInstance(instanceId);
  try {
    const row = await getInstanceWebhook(instanceId);
    if (!row) return { configured: false };
    const allowHttp = eventWebhookAllowsHttp();
    try {
      validateStoredInstanceWebhook(row, allowHttp);
    } catch {
      return { configured: false, invalid: true };
    }
    return viewFromStored(row.url, row.authHeader, row.authValue, row.events, row.updatedAt);
  } catch (err) {
    if (err instanceof InvalidStoredInstanceWebhookError) {
      return { configured: false, invalid: true };
    }
    throw err;
  }
}

/** Remove the stored webhook. The instance then uses the global destinations. */
export async function removeInstanceWebhook(instanceId: string): Promise<{ deleted: boolean }> {
  await requireInstance(instanceId);
  return { deleted: await deleteInstanceWebhook(instanceId) };
}
