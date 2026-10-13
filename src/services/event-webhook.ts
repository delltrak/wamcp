import { createHmac } from "node:crypto";
import { Queue, Worker, type Job, type JobsOptions } from "bullmq";
import type { InstanceManager } from "./instance-manager.js";
import { QUEUE_COMPLETED_AGE_S, QUEUE_FAILED_AGE_S } from "../constants.js";
import type { ChannelEvent, ChannelEventPayload } from "../types/channel.types.js";
import { createChildLogger } from "../utils/logger.js";
import { getRedisConnectionOptions } from "./redis.js";
import {
  loadEventWebhookConfig,
  type EventWebhookConfig,
  type EventWebhookDestination,
} from "./event-webhook-config.js";

const logger = createChildLogger({ service: "event-webhook" });
const WEBHOOK_QUEUE_NAME = "wa-mcp-event-webhooks";

export interface EventWebhookPayload {
  event: ChannelEvent;
  instanceId: string;
  chat: string | null;
  sender: string | null;
  type: string;
  text: string | null;
  timestamp: number | null;
}

export interface EventWebhookJob {
  destinationId: string;
  payload: EventWebhookPayload;
}

type EnqueueWebhookJob = (job: EventWebhookJob) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === "string") ?? null;
}

function firstNumber(...values: unknown[]): number | null {
  return values.find((value): value is number => typeof value === "number") ?? null;
}

/** Flatten a normalized channel event into the stable outgoing webhook shape. */
export function normalizeEventWebhookPayload(
  event: ChannelEvent,
  instanceId: string,
  payload: ChannelEventPayload[ChannelEvent],
): EventWebhookPayload {
  const data = payload as unknown as Record<string, unknown>;
  const message = isRecord(data.message) ? data.message : {};
  const changes = isRecord(data.changes) ? data.changes : {};

  return {
    event,
    instanceId,
    chat: firstString(data.chatId, data.groupId),
    sender: firstString(
      message.sender,
      data.participant,
      data.reactedBy,
      data.deletedBy,
      data.callerId,
      data.contactId,
    ),
    type: firstString(message.type, data.action, data.status) ?? event,
    text: firstString(message.content, data.newContent, data.emoji, changes.text),
    timestamp: firstNumber(message.timestamp, data.editedAt),
  };
}

export function shouldSendEventWebhook(
  event: ChannelEvent,
  payload: ChannelEventPayload[ChannelEvent],
  config: Pick<EventWebhookConfig, "events" | "ignoreFromMe">,
): boolean {
  if (!config.events.includes(event)) return false;
  if (
    event === "message.received" &&
    config.ignoreFromMe &&
    (payload as ChannelEventPayload["message.received"]).message.isFromMe
  ) {
    return false;
  }
  return true;
}

/**
 * Register an event listener whose queue writes are deliberately fire-and-forget.
 * Queue errors are handled here so they cannot escape into message processing.
 */
export function registerEventWebhookHandler(
  instanceManager: InstanceManager,
  config: EventWebhookConfig,
  enqueue: EnqueueWebhookJob,
  onEnqueueFailure: () => void = () =>
    logger.warn("Unable to enqueue outgoing event webhook; message processing continues"),
): () => void {
  return instanceManager.onAnyEvent(
    <E extends ChannelEvent>(event: E, instanceId: string, payload: ChannelEventPayload[E]) => {
      try {
        if (!shouldSendEventWebhook(event, payload, config)) return;

        const webhookPayload = normalizeEventWebhookPayload(
          event,
          instanceId,
          payload as ChannelEventPayload[ChannelEvent],
        );
        for (const destination of config.destinations) {
          try {
            void Promise.resolve(
              enqueue({ destinationId: destination.id, payload: webhookPayload }),
            ).catch(() => onEnqueueFailure());
          } catch {
            onEnqueueFailure();
          }
        }
      } catch {
        onEnqueueFailure();
      }
    },
  );
}

/** BullMQ applies exponential backoff between failed delivery attempts. */
export function eventWebhookJobOptions(config: EventWebhookConfig): JobsOptions {
  return {
    attempts: config.retryAttempts,
    backoff: { type: "exponential", delay: config.retryDelayMs },
    removeOnComplete: { age: QUEUE_COMPLETED_AGE_S },
    removeOnFail: { age: QUEUE_FAILED_AGE_S },
  };
}

export function createEventWebhookHeaders(
  body: string,
  destination: EventWebhookDestination,
  timestamp = Math.floor(Date.now() / 1000).toString(),
): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  for (const [name, value] of Object.entries(destination.headers)) {
    headers.set(name, value);
  }

  if (destination.secret) {
    const signature = createHmac("sha256", destination.secret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    headers.set("x-wa-event-timestamp", timestamp);
    headers.set("x-wa-event-signature", `sha256=${signature}`);
  }

  return headers;
}

/** Make one bounded HTTP attempt. Rejections are generic so errors cannot leak URL secrets. */
export async function postEventWebhook(
  destination: EventWebhookDestination,
  payload: EventWebhookPayload,
  timeoutMs: number,
  fetchRequest: typeof fetch = fetch,
): Promise<void> {
  try {
    const body = JSON.stringify(payload);
    const response = await fetchRequest(destination.url, {
      method: "POST",
      headers: createEventWebhookHeaders(body, destination),
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!response.ok) throw new Error();
  } catch {
    // Never include the URL, response body, headers, or underlying network error.
    throw new Error("Event webhook delivery failed");
  }
}

/** Dedicated BullMQ queue for outgoing normalized channel events. */
export class EventWebhookService {
  private readonly config: EventWebhookConfig;
  private queue: Queue<EventWebhookJob> | null = null;
  private worker: Worker<EventWebhookJob> | null = null;
  private removeEventHandler: (() => void) | null = null;

  constructor(config = loadEventWebhookConfig()) {
    this.config = config;
  }

  start(instanceManager: InstanceManager): void {
    if (this.queue || this.config.destinations.length === 0) return;

    const destinations = new Map(this.config.destinations.map((item) => [item.id, item]));
    this.queue = new Queue<EventWebhookJob>(WEBHOOK_QUEUE_NAME, {
      connection: getRedisConnectionOptions(),
      defaultJobOptions: eventWebhookJobOptions(this.config),
    });
    this.worker = new Worker<EventWebhookJob>(
      WEBHOOK_QUEUE_NAME,
      async (job: Job<EventWebhookJob>) => {
        const destination = destinations.get(job.data.destinationId);
        if (!destination) throw new Error("Unknown event webhook destination");
        await postEventWebhook(destination, job.data.payload, this.config.timeoutMs);
      },
      { connection: getRedisConnectionOptions() },
    );
    this.worker.on("failed", () => {
      logger.warn("Outgoing event webhook delivery attempt failed");
    });
    this.worker.on("error", () => {
      logger.error("Outgoing event webhook worker encountered an error");
    });

    this.removeEventHandler = registerEventWebhookHandler(instanceManager, this.config, (job) => {
      if (!this.queue) return Promise.reject(new Error("Event webhook queue is closed"));
      return this.queue.add("deliver", job);
    });
  }

  async close(): Promise<void> {
    this.removeEventHandler?.();
    this.removeEventHandler = null;

    const worker = this.worker;
    const queue = this.queue;
    this.worker = null;
    this.queue = null;

    await Promise.all([worker?.close(), queue?.close()]);
  }
}
