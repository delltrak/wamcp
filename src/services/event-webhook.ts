import { createHash, createHmac } from "node:crypto";
import { lookup as lookupDns } from "node:dns/promises";
import { isIP } from "node:net";
import type { ConnectionOptions } from "node:tls";
import { Queue, UnrecoverableError, Worker, type Job, type JobsOptions } from "bullmq";
import { Agent } from "undici";
import type { InstanceManager } from "./instance-manager.js";
import { QUEUE_COMPLETED_AGE_S, QUEUE_FAILED_AGE_S } from "../constants.js";
import type { ChannelEvent, ChannelEventPayload, MessageButton } from "../types/channel.types.js";
import { createChildLogger } from "../utils/logger.js";
import { getRedisConnectionOptions } from "./redis.js";
import { transcribeIncomingAudioIfConfigured } from "./incoming-audio-transcription.js";
import {
  loadEventWebhookConfig,
  type EventWebhookConfig,
  type EventWebhookDestination,
} from "./event-webhook-config.js";
import { isNonPublicIp } from "../utils/validation.js";

const logger = createChildLogger({ service: "event-webhook" });
const WEBHOOK_QUEUE_NAME = "wa-mcp-event-webhooks";
const MAX_WEBHOOK_RETRY_DELAY_MS = 5 * 60 * 1_000;
const WEBHOOK_BACKOFF_JITTER = 0.2;

export interface EventWebhookPayload {
  event: ChannelEvent;
  instanceId: string;
  chat: string | null;
  sender: string | null;
  type: string;
  text: string | null;
  transcription?: string;
  timestamp: number | null;
  mediaUrl?: string | null;
  mediaMimetype?: string;
  mimeType?: string;
  fileName?: string;
  caption?: string;
  size?: number;
  buttons?: MessageButton[];
  rawType?: string;
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
  transcription?: string;
  timestamp: number | null;
  messageId: string;
  media?: { id: string };
  mediaUrl?: string;
  mediaMimetype?: string;
  mimeType?: string;
  fileName?: string;
  caption?: string;
  size?: number;
  buttons?: MessageButton[];
  rawType?: string;
}

export type EventWebhookBody =
  | EventWebhookPayload
  | GrokBotWebhookPayload
  | (EventWebhookPayload & { messages: EventWebhookPayload[] })
  | (GrokBotWebhookPayload & { messages: GrokBotWebhookPayload[] })
  | { events: EventWebhookPayload[] }
  | { messages: GrokBotWebhookPayload[] };

export interface EventWebhookJob {
  destinationId: string;
  destinationIdentity: string;
  payload: EventWebhookBody;
}

export interface EventWebhookDnsAddress {
  address: string;
  family: number;
}

export type EventWebhookDnsResolver = (hostname: string) => Promise<EventWebhookDnsAddress[]>;

export class EventWebhookRetryableError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(retryAfterMs?: number) {
    super("Event webhook delivery failed transiently");
    this.name = "EventWebhookRetryableError";
    this.retryAfterMs = retryAfterMs;
  }
}

type EnqueueWebhookJob = (job: EventWebhookJob) => Promise<unknown>;
const MAX_BATCH_SIZE = 25;

interface BufferedDestinationEvents {
  payloads: (EventWebhookPayload | GrokBotWebhookPayload)[];
  timer: ReturnType<typeof setTimeout>;
}

type BufferedMessagePayload = EventWebhookPayload | GrokBotWebhookPayload;

interface BufferedMessageEntry {
  fallbackPayload: BufferedMessagePayload;
  payload?: BufferedMessagePayload;
  pendingTranscription: boolean;
}

interface BufferedMessageBatch {
  key: string;
  destination: EventWebhookDestination;
  entries: BufferedMessageEntry[];
  maxDeadlineAt: number;
  maxTimer: ReturnType<typeof setTimeout>;
  debounceTimer?: ReturnType<typeof setTimeout>;
  debounceExpired: boolean;
}

export type EventWebhookUnsubscribe = (() => void) & { flush: () => Promise<void> };

const resolveWebhookDns: EventWebhookDnsResolver = (hostname) =>
  lookupDns(hostname, { all: true, verbatim: true });

export function createPinnedWebhookConnectionOptions(
  hostname: string,
  address: string,
  family: 4 | 6,
  protocol: string,
): ConnectionOptions {
  return {
    lookup: (_hostname, options, callback) => {
      if (options.all) {
        callback(null, [{ address, family }]);
        return;
      }
      callback(null, address, family);
    },
    ...(protocol === "https:" && isIP(hostname) === 0 ? { servername: hostname } : {}),
  };
}

async function resolvePinnedWebhookAddress(
  url: URL,
  resolveDns: EventWebhookDnsResolver,
): Promise<{ hostname: string; address: string; family: 4 | 6 }> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await resolveDns(hostname);
  const normalized = addresses.map(({ address }) => ({ address, family: isIP(address) }));

  if (
    normalized.length === 0 ||
    normalized.some(
      ({ address, family }) => (family !== 4 && family !== 6) || isNonPublicIp(address),
    )
  ) {
    throw new UnrecoverableError("Event webhook delivery failed permanently");
  }

  const pinned = normalized[0];
  if (!pinned || (pinned.family !== 4 && pinned.family !== 6)) {
    throw new UnrecoverableError("Event webhook delivery failed permanently");
  }

  return { hostname, address: pinned.address, family: pinned.family };
}

export function eventWebhookDestinationIdentity(destination: EventWebhookDestination): string {
  const identity = {
    id: destination.id,
    url: destination.url,
    headers: Object.entries(destination.headers).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
    secret: destination.secret ?? null,
    preset: destination.preset ?? null,
    events: [...destination.events].sort(),
    ignoreFromMe: destination.ignoreFromMe,
    chatAllowlist: destination.chatAllowlist ? [...destination.chatAllowlist].sort() : null,
    senderAllowlist: destination.senderAllowlist ? [...destination.senderAllowlist].sort() : null,
    debounceMs: destination.debounceMs,
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_ABORTED",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function errorProperty(value: unknown, property: string): unknown {
  return typeof value === "object" && value !== null && property in value
    ? (value as Record<string, unknown>)[property]
    : undefined;
}

function isRetryableNetworkError(error: unknown): boolean {
  const isFetchTypeError = error instanceof TypeError;
  let current = error;
  let hasCause = false;
  const visited = new Set<unknown>();

  while (current && !visited.has(current)) {
    visited.add(current);
    const name = errorProperty(current, "name");
    const code = errorProperty(current, "code");
    const message = errorProperty(current, "message");
    if (message === "unexpected redirect") return false;
    if (name === "TimeoutError" || name === "AbortError") return true;
    if (typeof code === "string" && RETRYABLE_NETWORK_ERROR_CODES.has(code)) return true;

    const cause = errorProperty(current, "cause");
    if (cause === undefined) break;
    hasCause = true;
    current = cause;
  }

  // Fetch uses TypeError for network failures. Errors with an unrecognized cause
  // (such as TLS certificate failures or refused redirects) are permanent.
  return isFetchTypeError && !hasCause;
}

function firstString(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === "string") ?? null;
}

function firstNumber(...values: unknown[]): number | null {
  return values.find((value): value is number => typeof value === "number") ?? null;
}

function safeDirectMediaUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function messageButtons(value: unknown): MessageButton[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const buttons = value.filter(
    (item): item is MessageButton =>
      isRecord(item) && typeof item.type === "string" && typeof item.text === "string",
  );
  return buttons.length ? buttons : undefined;
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
  const buttons = messageButtons(message.buttons);
  const mimeType = firstString(message.mimeType, message.mediaMimetype);
  const fileName = firstString(message.fileName, message.mediaFileName);
  const caption = firstString(message.caption, message.mediaCaption);
  const size = firstNumber(message.size, message.mediaSize);

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
    ...(typeof message.mediaUrl === "string" ? { mediaUrl: message.mediaUrl } : {}),
    ...(typeof message.mediaMimetype === "string" ? { mediaMimetype: message.mediaMimetype } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(fileName ? { fileName } : {}),
    ...(caption ? { caption } : {}),
    ...(size !== null ? { size } : {}),
    ...(buttons ? { buttons } : {}),
    ...(typeof message.rawType === "string" ? { rawType: message.rawType } : {}),
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
  const directMediaUrl = safeDirectMediaUrl(mediaId);
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
    ...(directMediaUrl ? { mediaUrl: directMediaUrl } : {}),
    ...(payload.message.mediaMimetype ? { mediaMimetype: payload.message.mediaMimetype } : {}),
    ...((payload.message.mimeType ?? payload.message.mediaMimetype)
      ? { mimeType: payload.message.mimeType ?? payload.message.mediaMimetype }
      : {}),
    ...((payload.message.fileName ?? payload.message.mediaFileName)
      ? { fileName: payload.message.fileName ?? payload.message.mediaFileName }
      : {}),
    ...((payload.message.caption ?? payload.message.mediaCaption)
      ? { caption: payload.message.caption ?? payload.message.mediaCaption }
      : {}),
    ...((payload.message.size ?? payload.message.mediaSize)
      ? { size: payload.message.size ?? payload.message.mediaSize }
      : {}),
    ...(payload.message.buttons ? { buttons: payload.message.buttons } : {}),
    ...(payload.message.rawType ? { rawType: payload.message.rawType } : {}),
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
  const messageBuffers = new Map<string, BufferedMessageBatch>();
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
      enqueueResult = Promise.resolve(
        enqueue({
          destinationId: destination.id,
          destinationIdentity: eventWebhookDestinationIdentity(destination),
          payload,
        }),
      );
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

  const clearMessageBatchTimers = (batch: BufferedMessageBatch): void => {
    clearTimeout(batch.maxTimer);
    if (batch.debounceTimer) clearTimeout(batch.debounceTimer);
  };

  const flushMessageBatch = (batch: BufferedMessageBatch, force: boolean): Promise<void> => {
    if (messageBuffers.get(batch.key) !== batch) return Promise.resolve();
    if (!force && batch.entries.some((entry) => entry.pendingTranscription)) {
      return Promise.resolve();
    }

    clearMessageBatchTimers(batch);
    messageBuffers.delete(batch.key);

    const payloads = batch.entries.map((entry) => {
      if (entry.pendingTranscription) {
        // The max-wait and shutdown paths use the same original-message fallback
        // as a failed transcription, so a slow provider cannot hold a chat open.
        entry.pendingTranscription = false;
        entry.payload = entry.fallbackPayload;
      }
      return entry.payload ?? entry.fallbackPayload;
    });
    const lastPayload = payloads[payloads.length - 1];
    if (!lastPayload) return Promise.resolve();

    const payload = { ...lastPayload, messages: payloads } as EventWebhookBody;
    return enqueuePayload(batch.destination, payload);
  };

  const scheduleMessageDebounce = (batch: BufferedMessageBatch): void => {
    if (batch.debounceTimer) clearTimeout(batch.debounceTimer);
    const remainingMaxWait = Math.max(0, batch.maxDeadlineAt - Date.now());
    const delay = Math.min(config.messageDebounceMs, remainingMaxWait);
    batch.debounceExpired = false;
    batch.debounceTimer = setTimeout(() => {
      batch.debounceTimer = undefined;
      if (messageBuffers.get(batch.key) !== batch) return;
      batch.debounceExpired = true;
      if (!batch.entries.some((entry) => entry.pendingTranscription)) {
        void flushMessageBatch(batch, false);
      }
    }, delay);
  };

  const queueMessagePayload = (
    destination: EventWebhookDestination,
    instanceId: string,
    chatId: string,
    payload: BufferedMessagePayload,
    transcription: Promise<string> | undefined,
    withTranscription: (text: string) => BufferedMessagePayload,
  ): void => {
    const key = JSON.stringify([destination.id, instanceId, chatId]);
    let batch = messageBuffers.get(key);
    if (!batch) {
      const maxDeadlineAt = Date.now() + config.messageDebounceMaxMs;
      const created = {
        key,
        destination,
        entries: [],
        maxDeadlineAt,
        maxTimer: setTimeout(() => {
          void flushMessageBatch(created, true);
        }, config.messageDebounceMaxMs),
        debounceExpired: false,
      } satisfies BufferedMessageBatch;
      batch = created;
      messageBuffers.set(key, batch);
    }

    const entry: BufferedMessageEntry = {
      fallbackPayload: payload,
      pendingTranscription: Boolean(transcription),
      ...(!transcription ? { payload } : {}),
    };
    batch.entries.push(entry);
    scheduleMessageDebounce(batch);

    if (batch.entries.length >= MAX_BATCH_SIZE) {
      void flushMessageBatch(batch, true);
      return;
    }

    if (transcription) {
      void transcription.then(
        (text) => {
          if (!entry.pendingTranscription) return;
          entry.pendingTranscription = false;
          entry.payload = withTranscription(text);
          if (
            messageBuffers.get(key) === batch &&
            batch.debounceExpired &&
            !batch.entries.some((item) => item.pendingTranscription)
          ) {
            void flushMessageBatch(batch, false);
          }
        },
        (error: unknown) => {
          if (!entry.pendingTranscription) return;
          entry.pendingTranscription = false;
          entry.payload = entry.fallbackPayload;
          logger.warn(
            { instanceId },
            "Incoming audio transcription failed; outgoing webhook will use the original message",
          );
          if (
            messageBuffers.get(key) === batch &&
            batch.debounceExpired &&
            !batch.entries.some((item) => item.pendingTranscription)
          ) {
            void flushMessageBatch(batch, false);
          }
          void error;
        },
      );
    }
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

          let webhookPayload: EventWebhookPayload | GrokBotWebhookPayload;
          if (destination.preset === "grok-bot" && event === "message.received") {
            webhookPayload = normalizeGrokBotWebhookPayload(
              instanceId,
              payload as ChannelEventPayload["message.received"],
            );
          } else {
            webhookPayload = normalizeEventWebhookPayload(
              event,
              instanceId,
              payload as ChannelEventPayload[ChannelEvent],
            );
          }

          if (config.messageDebounceMs > 0) {
            if (event !== "message.received") {
              void enqueuePayload(destination, webhookPayload);
              continue;
            }

            const messageEvent = payload as ChannelEventPayload["message.received"];
            const chatId = messageEvent.chatId;
            if (!chatId) {
              void enqueuePayload(destination, webhookPayload);
              continue;
            }

            let transcription: Promise<string> | undefined;
            if (messageEvent.message.type === "audio") {
              try {
                transcription = transcribeIncomingAudioIfConfigured(
                  instanceManager,
                  instanceId,
                  messageEvent,
                );
              } catch {
                logger.warn(
                  { instanceId },
                  "Unable to start incoming audio transcription; outgoing webhook will use the original message",
                );
              }
            }

            const withTranscription = (text: string): BufferedMessagePayload => {
              const transcribedEvent = {
                ...messageEvent,
                message: { ...messageEvent.message, transcription: text },
              } as unknown as ChannelEventPayload["message.received"];
              const normalized =
                destination.preset === "grok-bot"
                  ? normalizeGrokBotWebhookPayload(instanceId, transcribedEvent)
                  : normalizeEventWebhookPayload("message.received", instanceId, transcribedEvent);
              return { ...normalized, transcription: text };
            };

            queueMessagePayload(
              destination,
              instanceId,
              chatId,
              webhookPayload,
              transcription,
              withTranscription,
            );
            continue;
          }

          queuePayload(destination, webhookPayload);
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
    for (const batch of messageBuffers.values()) void flushMessageBatch(batch, true);
    for (const destination of config.destinations) void flushDestination(destination);
    while (pendingEnqueues.size > 0) await Promise.all([...pendingEnqueues]);
  };
  return unsubscribe;
}

/** Parse Retry-After as delta-seconds or an HTTP date, with a five-minute ceiling. */
export function parseEventWebhookRetryAfter(
  value: string | null,
  nowMs = Date.now(),
  maxDelayMs = MAX_WEBHOOK_RETRY_DELAY_MS,
): number | undefined {
  if (value === null || value.trim() === "") return undefined;

  const retryAfter = value.trim();
  if (/^\d+$/.test(retryAfter)) {
    const seconds = Number(retryAfter);
    if (seconds >= maxDelayMs / 1_000) return maxDelayMs;
    return Math.max(0, seconds * 1_000);
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(retryAfter)) return undefined;

  const retryAtMs = Date.parse(retryAfter);
  if (!Number.isFinite(retryAtMs)) return undefined;
  return Math.min(maxDelayMs, Math.max(0, retryAtMs - nowMs));
}

/** Calculate capped exponential backoff with 20% downward jitter and a Retry-After floor. */
export function calculateEventWebhookBackoff(
  attemptsMade: number,
  retryDelayMs: number,
  retryAfterMs?: number,
  randomValue = Math.random(),
): number {
  const attempt = Number.isFinite(attemptsMade) ? Math.max(1, Math.floor(attemptsMade)) : 1;
  const exponentialDelay = Math.min(MAX_WEBHOOK_RETRY_DELAY_MS, retryDelayMs * 2 ** (attempt - 1));
  const random = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0.5;
  const jitteredDelay = Math.floor(
    exponentialDelay * (1 - WEBHOOK_BACKOFF_JITTER + random * WEBHOOK_BACKOFF_JITTER),
  );
  const retryAfter = Math.min(MAX_WEBHOOK_RETRY_DELAY_MS, Math.max(0, retryAfterMs ?? 0));
  return Math.min(MAX_WEBHOOK_RETRY_DELAY_MS, Math.max(jitteredDelay, retryAfter));
}

export function eventWebhookBackoffStrategy(retryDelayMs: number) {
  return (attemptsMade: number, _type?: string, error?: Error): number => {
    if (!(error instanceof EventWebhookRetryableError)) return -1;
    return calculateEventWebhookBackoff(attemptsMade, retryDelayMs, error.retryAfterMs);
  };
}

/** BullMQ retries only errors explicitly classified as transient. */
export function eventWebhookJobOptions(config: EventWebhookConfig): JobsOptions {
  return {
    attempts: config.retryAttempts,
    backoff: { type: "wa-event-webhook", delay: config.retryDelayMs },
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
  resolveDns: EventWebhookDnsResolver = resolveWebhookDns,
): Promise<void> {
  let response: Response | undefined;
  let dispatcher: Agent | undefined;
  try {
    const url = new URL(destination.url);
    let pinned: { hostname: string; address: string; family: 4 | 6 };
    try {
      pinned = await resolvePinnedWebhookAddress(url, resolveDns);
    } catch (error) {
      if (error instanceof UnrecoverableError) throw error;
      if (isRetryableNetworkError(error)) throw new EventWebhookRetryableError();
      throw new UnrecoverableError("Event webhook delivery failed permanently");
    }
    dispatcher = new Agent({
      connect: createPinnedWebhookConnectionOptions(
        pinned.hostname,
        pinned.address,
        pinned.family,
        url.protocol,
      ),
    });
    const body = JSON.stringify(payload);
    try {
      response = await fetchRequest(destination.url, {
        method: "POST",
        headers: createEventWebhookHeaders(body, destination),
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
        dispatcher,
      } as RequestInit & { dispatcher: Agent });
    } catch (error) {
      if (isRetryableNetworkError(error)) throw new EventWebhookRetryableError();
      throw new UnrecoverableError("Event webhook delivery failed permanently");
    }

    if (response.status === 429 || response.status >= 500) {
      throw new EventWebhookRetryableError(
        parseEventWebhookRetryAfter(response.headers.get("retry-after")),
      );
    }
    if (!response.ok) {
      throw new UnrecoverableError("Event webhook delivery failed permanently");
    }
  } catch (error) {
    if (error instanceof EventWebhookRetryableError || error instanceof UnrecoverableError) {
      throw error;
    }
    // Never include the URL, response body, headers, or underlying network error.
    throw new UnrecoverableError("Event webhook delivery failed permanently");
  } finally {
    try {
      await response?.body?.cancel();
    } catch {
      // Response cleanup must not expose endpoint details or mask the delivery result.
    }
    try {
      await dispatcher?.close();
    } catch {
      // The request dispatcher is scoped to this attempt and must not be reused.
    }
  }
}

export async function processEventWebhookJob(
  job: EventWebhookJob,
  destinations: ReadonlyMap<string, EventWebhookDestination>,
  timeoutMs: number,
  deliver: typeof postEventWebhook = postEventWebhook,
): Promise<void> {
  const destination = destinations.get(job.destinationId);
  if (!destination || job.destinationIdentity !== eventWebhookDestinationIdentity(destination)) {
    throw new UnrecoverableError(
      "Event webhook destination does not match this service configuration",
    );
  }
  await deliver(destination, job.payload, timeoutMs);
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
      prefix: this.config.queuePrefix,
      defaultJobOptions: eventWebhookJobOptions(this.config),
    });
    this.worker = new Worker<EventWebhookJob>(
      WEBHOOK_QUEUE_NAME,
      (job: Job<EventWebhookJob>) =>
        processEventWebhookJob(job.data, destinations, this.config.timeoutMs),
      {
        connection: getRedisConnectionOptions(),
        prefix: this.config.queuePrefix,
        settings: { backoffStrategy: eventWebhookBackoffStrategy(this.config.retryDelayMs) },
      },
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
