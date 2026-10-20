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
} from "./event-webhook-config.js";
import {
  deleteInstanceWebhook,
  getInstanceWebhook,
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

export type InstanceWebhookState = InstanceWebhookConfigured | { configured: false };

export interface InstanceWebhookInput {
  instanceId: string;
  url: string;
  authHeader?: string;
  authValue?: string;
  events?: readonly string[];
}

function requireInstance(instanceId: string): void {
  if (!isValidInstanceId(instanceId)) throw new Error("Invalid instance ID");
  const row = db
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
export function setInstanceWebhook(input: InstanceWebhookInput): InstanceWebhookConfigured {
  requireInstance(input.instanceId);
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
  upsertInstanceWebhook({
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
export function readInstanceWebhook(instanceId: string): InstanceWebhookState {
  requireInstance(instanceId);
  const row = getInstanceWebhook(instanceId);
  if (!row) return { configured: false };
  return viewFromStored(row.url, row.authHeader, row.authValue, row.events, row.updatedAt);
}

/** Remove the stored webhook. The instance then uses the global destinations. */
export function removeInstanceWebhook(instanceId: string): { deleted: boolean } {
  requireInstance(instanceId);
  return { deleted: deleteInstanceWebhook(instanceId) };
}
