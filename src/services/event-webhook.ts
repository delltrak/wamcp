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

export interface GrokBotWebhookPayload {
  instanceId: string;
  chatId: string;
  chatName: string | null;
  senderId: string | null;
  senderName: string | null;
  isGroup: boolean;
  type: string;
  text: string | null;
  timestamp: number | null;
  messageId: string;
  media?: { id: string };
}

export type EventWebhookBody =
  | EventWebhookPayload
  | GrokBotWebhookPayload
  | { events: EventWebhookPayload[] }
  | { messages: GrokBotWebhookPayload[] };

export interface EventWebhookJob {
  destinationId: string;
  payload: EventWebhookBody;
}

type EnqueueWebhookJob = (job: EventWebhookJob) => Promise<unknown>;
const MAX_BATCH_SIZE = 25;

interface BufferedDestinationEvents {
  payloads: (EventWebhookPayload | GrokBotWebhookPayload)[];
  timer: ReturnType<typeof setTimeout>;
}

export type EventWebhookUnsubscribe = (() => void) & { flush: () => Promise<void> };

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

/** Build the compact Grok Bot body. Message content carries captions/text only; media bytes are never copied. */
export function normalizeGrokBotWebhookPayload(
  instanceId: string,
  payload: ChannelEventPayload["message.received"],
): GrokBotWebhookPayload {
  const mediaId = payload.message.mediaUrl;
  const safeMediaId =
    mediaId && mediaId.length <= 256 && /^[A-Za-z0-9_.:-]+$/.test(mediaId) ? mediaId : undefined;
  const isGroup = payload.isGroup ?? payload.chatId.toLowerCase().endsWith("@g.us");

  return {
    instanceId,
    chatId: payload.chatId,
    chatName: payload.chatName ?? (isGroup ? null : (payload.senderName ?? null)),
    senderId: payload.message.sender || null,
    senderName: payload.senderName ?? null,
    isGroup,
    type: payload.message.type,
    text: payload.message.content,
    timestamp: payload.message.timestamp,
    messageId: payload.message.id,
    ...(safeMediaId ? { media: { id: safeMediaId } } : {}),
  };
}

export function shouldSendEventWebhook(
  event: ChannelEvent,
  payload: ChannelEventPayload[ChannelEvent],
  config: Pick<EventWebhookConfig, "events" | "ignoreFromMe"> &
    Partial<Pick<EventWebhookDestination, "preset" | "chatAllowlist" | "senderAllowlist">>,
): boolean {
  if (!config.events.includes(event)) return false;
  if (config.preset === "grok-bot" && event !== "message.received") return false;

  const data = payload as unknown as Record<string, unknown>;
  const message = isRecord(data.message) ? data.message : {};
  const chatId = typeof data.chatId === "string" ? data.chatId : "";
  const senderId = typeof message.sender === "string" ? message.sender : "";

  if (event === "message.received") {
    if (config.ignoreFromMe && message.isFromMe === true) return false;
    if (
      config.preset === "grok-bot" &&
      (chatId.toLowerCase() === "status@broadcast" ||
        chatId.toLowerCase().endsWith("@broadcast") ||
        chatId.toLowerCase().endsWith("@newsletter"))
    ) {
      return false;
    }
  }

  if (config.chatAllowlist && !config.chatAllowlist.includes(chatId)) return false;
  if (config.senderAllowlist && !config.senderAllowlist.includes(senderId)) return false;
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
): EventWebhookUnsubscribe {
  const buffers = new Map<string, BufferedDestinationEvents>();
  const pendingEnqueues = new Set<Promise<void>>();

  const safeFailureNotice = (): void => {
    try {
      onEnqueueFailure();
    } catch {
      // A reporting callback must not interrupt the channel event handler.
    }
  };

  const enqueuePayload = (
    destination: EventWebhookDestination,
    payload: EventWebhookBody,
  ): Promise<void> => {
    let enqueueResult: Promise<unknown>;
    try {
      enqueueResult = Promise.resolve(enqueue({ destinationId: destination.id, payload }));
    } catch {
      safeFailureNotice();
      return Promise.resolve();
    }
    const pending = enqueueResult.then(() => undefined).catch(() => safeFailureNotice());
    pendingEnqueues.add(pending);
    void pending.then(() => pendingEnqueues.delete(pending));
    return pending;
  };

  const flushDestination = (destination: EventWebhookDestination): Promise<void> => {
    const buffer = buffers.get(destination.id);
    if (!buffer) return Promise.resolve();
    clearTimeout(buffer.timer);
    buffers.delete(destination.id);
    if (buffer.payloads.length === 1) {
      return enqueuePayload(destination, buffer.payloads[0] as EventWebhookBody);
    }
    const payload: EventWebhookBody =
      destination.preset === "grok-bot"
        ? { messages: buffer.payloads as GrokBotWebhookPayload[] }
        : { events: buffer.payloads as EventWebhookPayload[] };
    return enqueuePayload(destination, payload);
  };

  const queuePayload = (
    destination: EventWebhookDestination,
    payload: EventWebhookPayload | GrokBotWebhookPayload,
  ): void => {
    if (destination.debounceMs === 0) {
      void enqueuePayload(destination, payload);
      return;
    }

    let buffer = buffers.get(destination.id);
    if (!buffer) {
      const timer = setTimeout(() => {
        void flushDestination(destination);
      }, destination.debounceMs);
      buffer = { payloads: [], timer };
      buffers.set(destination.id, buffer);
    }
    buffer.payloads.push(payload);
    if (buffer.payloads.length >= MAX_BATCH_SIZE) void flushDestination(destination);
  };

  const removeListener = instanceManager.onAnyEvent(
    <E extends ChannelEvent>(event: E, instanceId: string, payload: ChannelEventPayload[E]) => {
      try {
        for (const destination of config.destinations) {
          if (!shouldSendEventWebhook(event, payload, destination)) continue;

          if (destination.preset === "grok-bot" && event === "message.received") {
            queuePayload(
              destination,
              normalizeGrokBotWebhookPayload(
                instanceId,
                payload as ChannelEventPayload["message.received"],
              ),
            );
          } else {
            queuePayload(
              destination,
              normalizeEventWebhookPayload(
                event,
                instanceId,
                payload as ChannelEventPayload[ChannelEvent],
              ),
            );
          }
        }
      } catch {
        safeFailureNotice();
      }
    },
  );

  const unsubscribe = (() => {
    removeListener();
    void unsubscribe.flush();
  }) as EventWebhookUnsubscribe;
  unsubscribe.flush = async () => {
    for (const destination of config.destinations) void flushDestination(destination);
    while (pendingEnqueues.size > 0) await Promise.all([...pendingEnqueues]);
  };
  return unsubscribe;
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
  payload: EventWebhookBody,
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
  private removeEventHandler: EventWebhookUnsubscribe | null = null;

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
    const removeEventHandler = this.removeEventHandler;
    removeEventHandler?.();
    this.removeEventHandler = null;

    await removeEventHandler?.flush();

    const worker = this.worker;
    const queue = this.queue;
    this.worker = null;
    this.queue = null;

    await Promise.all([worker?.close(), queue?.close()]);
  }
}
