import { safeGroupChanges } from "../utils/group-event-fields.js";
import { createHash, createHmac } from "node:crypto";
import { lookup as lookupDns } from "node:dns/promises";
import { isIP } from "node:net";
import type { ConnectionOptions } from "node:tls";
import { Queue, UnrecoverableError, Worker, type Job, type JobsOptions } from "bullmq";
import { and, eq, inArray, or } from "drizzle-orm";
import { Agent, fetch as undiciFetch } from "undici";
import { db } from "../db/client.js";
import { contacts } from "../db/schema.js";
import type { InstanceManager } from "./instance-manager.js";
import { QUEUE_COMPLETED_AGE_S, QUEUE_FAILED_AGE_S } from "../constants.js";
import {
  isWebhookRoutineEvent,
  WEBHOOK_ROUTINE_EVENTS,
  type BusinessLabel,
  type ChannelEvent,
  type ChannelEventPayload,
  type EventResponseStatus,
  type InstanceAuthMethod,
  type MessageButton,
} from "../types/channel.types.js";
import { createChildLogger } from "../utils/logger.js";
import { getRedisConnectionOptions } from "./redis.js";
import { transcribeIncomingAudioIfConfigured } from "./incoming-audio-transcription.js";
import {
  destinationsForInstance,
  eventWebhookAllowsHttp,
  storedInstanceDestinations,
  loadEventWebhookConfig,
  type EventWebhookConfig,
  type EventWebhookDestination,
} from "./event-webhook-config.js";
import {
  instanceWebhookStorageGeneration,
  listInstanceWebhooks,
} from "./instance-webhook-store.js";
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
  isForwarded?: boolean;
  buttons?: MessageButton[];
  rawType?: string;
  action?: string;
  groupId?: string;
  groupChanges?: Record<string, unknown>;
  participants?: string[];
  requestMethod?: string | null;
  memberLabel?: string | null;
  eventMessageId?: string;
  responseMessageId?: string;
  participant?: string;
  callId?: string;
  callStatus?: string;
  isVideo?: boolean;
  isGroup?: boolean;
  status?: EventResponseStatus;
  extraGuestCount?: number;
  label?: BusinessLabel;
  association?: { type: "chat" | "message"; chatId: string; messageId?: string };
  chatLabels?: BusinessLabel[];
  messageLabels?: BusinessLabel[];
  newsletterId?: string;
  mute?: "on" | "off";
  labeled?: boolean;
  labelId?: string;
  subject?: string | null;
  name?: string;
  description?: string | null;
  role?: string | null;
  memberCount?: number;
  serverId?: string | null;
  views?: number | null;
}

export type InstanceLifecycleWebhookPayload =
  | {
      event: "instance.connected";
      instanceId: string;
      phone: string | null;
      lid: string | null;
      pushName: string | null;
      connectedAt: number;
      wasPairing: boolean;
    }
  | {
      event: "instance.disconnected";
      instanceId: string;
      reason: string;
      statusCode: number | null;
      loggedOut: boolean;
      willReconnect: boolean;
      reconnectInMs?: number;
      disconnectedAt: number;
      offlineSinceMs?: number;
    }
  | {
      event: "instance.pairing_code_generated" | "instance.qr_generated";
      instanceId: string;
      method: InstanceAuthMethod;
      generatedAt: number;
      expiresAt: number;
    }
  | {
      event: "instance.pairing_expired" | "instance.qr_expired";
      instanceId: string;
      method: InstanceAuthMethod;
      generatedAt: number;
      expiredAt: number;
    };

export type NormalizedEventWebhookPayload = EventWebhookPayload | InstanceLifecycleWebhookPayload;

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
  isForwarded?: boolean;
  buttons?: MessageButton[];
  rawType?: string;
  chatLabels?: BusinessLabel[];
  messageLabels?: BusinessLabel[];
}

export type GrokBotInstanceEvent = Extract<ChannelEvent, `instance.${string}`>;

export interface GrokBotInstanceWebhookPayload {
  event: GrokBotInstanceEvent;
  instanceId: string;
  text: string;
  timestamp: number;
  method?: InstanceAuthMethod;
  reason?: string;
  statusCode?: number | null;
  status?: "connected" | "disconnected";
  wasPairing?: boolean;
  loggedOut?: boolean;
  willReconnect?: boolean;
  expiresAt?: number;
}

type WebhookRoutineEvent = (typeof WEBHOOK_ROUTINE_EVENTS)[number];

/**
 * #141 compact body for the six routine events under the grok-bot preset.
 * `timestamp` is the event time in Unix seconds. `event` keeps this body out of message batches.
 */
export interface GrokBotRoutineWebhookPayload {
  event: WebhookRoutineEvent;
  instanceId: string;
  chatId: string;
  chatName: string | null;
  senderId: string | null;
  senderName: string | null;
  isGroup: boolean;
  type: string;
  text: string | null;
  timestamp: number;
  messageId: string;
  memberCount?: number;
  subject?: string | null;
  description?: string | null;
  newsletterId?: string;
  mute?: "on" | "off";
  name?: string;
  role?: string | null;
  labeled?: boolean;
  labelId?: string;
  serverId?: string | null;
  views?: number | null;
}

export type EventWebhookBody =
  | EventWebhookPayload
  | InstanceLifecycleWebhookPayload
  | GrokBotWebhookPayload
  | GrokBotInstanceWebhookPayload
  | GrokBotRoutineWebhookPayload
  | (EventWebhookPayload & { messages: EventWebhookPayload[] })
  | (GrokBotWebhookPayload & { messages: GrokBotWebhookPayload[] })
  | {
      events: (
        NormalizedEventWebhookPayload | GrokBotInstanceWebhookPayload | GrokBotRoutineWebhookPayload
      )[];
    }
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

export interface EventWebhookFailureDiagnostics {
  httpStatus?: number;
  errorName?: string;
  errorMessage?: string;
  errorCode?: string;
}

export class EventWebhookRetryableError extends Error {
  readonly retryAfterMs: number | undefined;
  readonly httpStatus: number | undefined;
  readonly errorName: string | undefined;
  readonly errorMessage: string | undefined;
  readonly errorCode: string | undefined;

  constructor(retryAfterMs?: number, diagnostics: EventWebhookFailureDiagnostics = {}) {
    super("Event webhook delivery failed transiently");
    this.name = "EventWebhookRetryableError";
    this.retryAfterMs = retryAfterMs;
    this.httpStatus = diagnostics.httpStatus;
    this.errorName = diagnostics.errorName;
    this.errorMessage = diagnostics.errorMessage;
    this.errorCode = diagnostics.errorCode;
  }
}

type EnqueueWebhookJob = (job: EventWebhookJob) => Promise<unknown>;
const MAX_BATCH_SIZE = 25;

type BufferedDestinationPayload =
  | NormalizedEventWebhookPayload
  | GrokBotWebhookPayload
  | GrokBotInstanceWebhookPayload
  | GrokBotRoutineWebhookPayload;

interface BufferedDestinationEvents {
  payloads: BufferedDestinationPayload[];
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

function isGrokBotMessagePayload(
  payload: BufferedDestinationPayload,
): payload is GrokBotWebhookPayload {
  return !("event" in payload) && "messageId" in payload;
}

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

function businessLabel(value: unknown): BusinessLabel | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.color !== "number" ||
    typeof value.deleted !== "boolean"
  ) {
    return undefined;
  }
  return {
    id: value.id,
    name: value.name,
    color: value.color,
    deleted: value.deleted,
    ...(typeof value.predefinedId === "string" ? { predefinedId: value.predefinedId } : {}),
  };
}

function businessLabels(value: unknown): BusinessLabel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const labels = value.map(businessLabel).filter((label): label is BusinessLabel => !!label);
  return labels.length ? labels : undefined;
}

function safeLifecycleReason(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .trim()
    .slice(0, 120);
}

/** Flatten a normalized channel event into the stable outgoing webhook shape. */
export function normalizeEventWebhookPayload(
  event: ChannelEvent,
  instanceId: string,
  payload: ChannelEventPayload[ChannelEvent],
): NormalizedEventWebhookPayload {
  const data = payload as unknown as Record<string, unknown>;

  const lifecycleNumber = (key: string): number | undefined => {
    const value = data[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };

  if (event === "instance.connected") {
    return {
      event,
      instanceId,
      phone: firstString(data.phone),
      lid: firstString(data.lid),
      pushName: firstString(data.pushName),
      connectedAt: lifecycleNumber("connectedAt") ?? 0,
      wasPairing: data.wasPairing === true,
    };
  }

  if (event === "instance.disconnected") {
    const reconnectInMs = lifecycleNumber("reconnectInMs");
    const offlineSinceMs = lifecycleNumber("offlineSinceMs");
    const statusCode = lifecycleNumber("statusCode");
    return {
      event,
      instanceId,
      reason: firstString(data.reason) ?? "unknown",
      statusCode: statusCode ?? null,
      loggedOut: data.loggedOut === true,
      willReconnect: data.willReconnect === true,
      ...(reconnectInMs !== undefined ? { reconnectInMs } : {}),
      disconnectedAt: lifecycleNumber("disconnectedAt") ?? 0,
      ...(offlineSinceMs !== undefined ? { offlineSinceMs } : {}),
    };
  }

  if (event === "instance.pairing_code_generated" || event === "instance.qr_generated") {
    return {
      event,
      instanceId,
      method: event === "instance.pairing_code_generated" ? "pairing_code" : "qr",
      generatedAt: lifecycleNumber("generatedAt") ?? 0,
      expiresAt: lifecycleNumber("expiresAt") ?? 0,
    };
  }

  if (event === "instance.pairing_expired" || event === "instance.qr_expired") {
    return {
      event,
      instanceId,
      method: event === "instance.pairing_expired" ? "pairing_code" : "qr",
      generatedAt: lifecycleNumber("generatedAt") ?? 0,
      expiredAt: lifecycleNumber("expiredAt") ?? 0,
    };
  }

  const message = isRecord(data.message) ? data.message : {};
  const changes = isRecord(data.changes) ? data.changes : {};
  const buttons = messageButtons(message.buttons);
  const mimeType = firstString(message.mimeType, message.mediaMimetype);
  const fileName = firstString(message.fileName, message.mediaFileName);
  const caption = firstString(message.caption, message.mediaCaption);
  const size = firstNumber(message.size, message.mediaSize);
  const label = businessLabel(data.label);
  const chatLabels = businessLabels(data.chatLabels);
  const messageLabels = businessLabels(message.labels);
  const associationData = isRecord(data.association) ? data.association : undefined;
  const associationType = associationData?.type;
  const associationChatId = firstString(associationData?.chatId);
  const associationMessageId = firstString(associationData?.messageId);
  const association =
    (associationType === "chat" || associationType === "message") && associationChatId
      ? {
          type: associationType as "chat" | "message",
          chatId: associationChatId,
          ...(associationMessageId ? { messageId: associationMessageId } : {}),
        }
      : undefined;
  const action = firstString(data.action);
  const memberLabel =
    typeof data.memberLabel === "string" || data.memberLabel === null
      ? data.memberLabel
      : undefined;
  const participant = firstString(data.participant);
  const responseStatus = firstString(data.status);
  const status =
    responseStatus === "GOING" ||
    responseStatus === "NOT_GOING" ||
    responseStatus === "MAYBE" ||
    responseStatus === "UNKNOWN"
      ? responseStatus
      : undefined;
  const eventMessageId = firstString(data.eventMessageId);
  const responseMessageId = firstString(data.responseMessageId);
  const extraGuestCount = firstNumber(data.extraGuestCount);

  return {
    event,
    instanceId,
    chat: firstString(data.chatId, data.groupId, data.newsletterId, association?.chatId),
    sender: firstString(
      message.sender,
      data.participant,
      data.reactedBy,
      data.deletedBy,
      data.callerId,
      data.contactId,
      participant,
    ),
    type:
      firstString(
        message.type,
        data.action,
        event === "event.response" ? undefined : data.status,
      ) ?? event,
    text:
      firstString(message.content, message.text, data.newContent, data.emoji, changes.text) ??
      routineEventText(event, data),
    timestamp: firstNumber(message.timestamp, data.editedAt, data.timestamp),
    ...(typeof message.mediaUrl === "string" ? { mediaUrl: message.mediaUrl } : {}),
    ...(typeof message.mediaMimetype === "string" ? { mediaMimetype: message.mediaMimetype } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(fileName ? { fileName } : {}),
    ...(caption ? { caption } : {}),
    ...(size !== null ? { size } : {}),
    ...(isRecord(data.message) ? { isForwarded: message.isForwarded === true } : {}),
    ...(buttons ? { buttons } : {}),
    ...(typeof message.rawType === "string" ? { rawType: message.rawType } : {}),
    ...(action ? { action } : {}),
    ...(event === "group.member_label_changed"
      ? {
          groupId: firstString(data.groupId) ?? "",
          memberLabel: memberLabel ?? null,
        }
      : {}),
    ...(event === "group.updated"
      ? { groupId: firstString(data.groupId) ?? "", groupChanges: safeGroupChanges(changes) }
      : {}),
    ...(event === "group.participants_changed"
      ? {
          groupId: firstString(data.groupId) ?? "",
          participants: Array.isArray(data.participants)
            ? data.participants.filter((p): p is string => typeof p === "string")
            : [],
        }
      : {}),
    ...(event === "group.join_request"
      ? { groupId: firstString(data.groupId) ?? "", requestMethod: firstString(data.method) }
      : {}),
    ...(eventMessageId ? { eventMessageId } : {}),
    ...(responseMessageId ? { responseMessageId } : {}),
    ...(participant ? { participant } : {}),
    ...(event === "call.received" && typeof data.callId === "string"
      ? { callId: data.callId }
      : {}),
    ...(event === "call.received" && typeof data.status === "string"
      ? { callStatus: data.status }
      : {}),
    ...(event === "call.received" && typeof data.isVideo === "boolean"
      ? { isVideo: data.isVideo }
      : {}),
    ...(event === "call.received" && typeof data.isGroup === "boolean"
      ? { isGroup: data.isGroup }
      : {}),
    ...(status ? { status } : {}),
    ...(extraGuestCount !== null ? { extraGuestCount } : {}),
    ...(label ? { label } : {}),
    ...(association ? { association } : {}),
    ...(chatLabels ? { chatLabels } : {}),
    ...(messageLabels ? { messageLabels } : {}),
    ...optionalWebhookFields(event, data, message),
  };
}

/** Short Portuguese text for the routine preset. Message content wins when it exists. */
function routineEventText(event: ChannelEvent, data: Record<string, unknown>): string | null {
  if (!isWebhookRoutineEvent(event)) return null;
  const labelName = isRecord(data.label) ? firstString(data.label.name) : null;
  switch (event) {
    case "group.joined": {
      const subject = firstString(data.subject);
      return subject ? `Você entrou no grupo ${subject}` : "Você entrou em um grupo";
    }
    case "label.association":
      if (data.labeled === true) {
        return labelName ? `Etiqueta "${labelName}" aplicada` : "Etiqueta aplicada";
      }
      return labelName ? `Etiqueta "${labelName}" removida` : "Etiqueta removida";
    case "newsletter.joined": {
      const name = firstString(data.name);
      return name ? `Você entrou no canal ${name}` : "Você entrou em um canal";
    }
    case "newsletter.left": {
      const name = firstString(data.name);
      return name ? `Você saiu do canal ${name}` : "Você saiu de um canal";
    }
    case "newsletter.message":
      return "Nova mensagem no canal";
    case "newsletter.mute":
      if (data.mute === "on") return "Canal silenciado";
      if (data.mute === "off") return "Canal com som";
      return null;
    default:
      return null;
  }
}

function optionalWebhookFields(
  event: ChannelEvent,
  data: Record<string, unknown>,
  message: Record<string, unknown>,
): Partial<EventWebhookPayload> {
  const newsletterId = firstString(data.newsletterId);
  const fields: Partial<EventWebhookPayload> = {
    ...(newsletterId ? { newsletterId } : {}),
  };
  if (event === "group.joined") {
    fields.subject = firstString(data.subject);
    fields.description = firstString(data.description);
    // #141: member count only. A full roster is not copied into the webhook body.
    fields.memberCount = firstNumber(data.memberCount) ?? 0;
  }
  if (event === "newsletter.joined" || event === "newsletter.left") {
    const name = firstString(data.name);
    if (name) fields.name = name;
    fields.description = firstString(data.description) ?? null;
    fields.role = firstString(data.role) ?? null;
  }
  if (event === "newsletter.mute" && (data.mute === "on" || data.mute === "off")) {
    fields.mute = data.mute;
  }
  if (event === "newsletter.message") {
    fields.serverId = typeof message.serverId === "string" ? message.serverId : null;
    fields.views = typeof message.views === "number" ? message.views : null;
  }
  if (event === "label.association") {
    fields.labeled = data.labeled === true;
    const labelId = firstString(data.labelId);
    if (labelId) fields.labelId = labelId;
  }
  return fields;
}

/**
 * #141: grok-bot destinations receive routine events with chatId, senderId, and messageId.
 * timestamp is the event time in Unix seconds, or the time this body is built when the
 * channel event has none. The standard body remains normalizeEventWebhookPayload.
 */
export function normalizeGrokBotRoutineWebhookPayload(
  event: WebhookRoutineEvent,
  instanceId: string,
  payload: ChannelEventPayload[WebhookRoutineEvent],
): GrokBotRoutineWebhookPayload {
  const data = payload as unknown as Record<string, unknown>;
  const message = isRecord(data.message) ? data.message : {};
  const association = isRecord(data.association) ? data.association : {};
  const chatId =
    firstString(data.chatId, data.groupId, data.newsletterId, association.chatId) ?? "";
  const observed = firstNumber(message.timestamp, data.timestamp);
  const details = optionalWebhookFields(event, data, message);

  return {
    event,
    instanceId,
    chatId,
    chatName: firstString(data.subject, data.name),
    senderId: firstString(message.sender, data.author, data.participant),
    senderName: null,
    isGroup: chatId.toLowerCase().endsWith("@g.us"),
    type: event,
    text: firstString(message.text, message.content) ?? routineEventText(event, data),
    timestamp: observed ?? Math.floor(Date.now() / 1000),
    messageId: firstString(message.id, data.messageId, association.messageId) ?? "",
    ...(details.memberCount !== undefined ? { memberCount: details.memberCount } : {}),
    ...(details.subject !== undefined ? { subject: details.subject } : {}),
    ...(details.description !== undefined ? { description: details.description } : {}),
    ...(details.newsletterId ? { newsletterId: details.newsletterId } : {}),
    ...(details.mute ? { mute: details.mute } : {}),
    ...(details.name ? { name: details.name } : {}),
    ...(details.role !== undefined ? { role: details.role } : {}),
    ...(details.labeled !== undefined ? { labeled: details.labeled } : {}),
    ...(details.labelId ? { labelId: details.labelId } : {}),
    ...(details.serverId !== undefined ? { serverId: details.serverId } : {}),
    ...(details.views !== undefined ? { views: details.views } : {}),
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
    isForwarded: payload.message.isForwarded === true,
    ...(payload.message.buttons ? { buttons: payload.message.buttons } : {}),
    ...(payload.message.rawType ? { rawType: payload.message.rawType } : {}),
    ...(payload.chatLabels?.length ? { chatLabels: payload.chatLabels } : {}),
    ...(payload.message.labels?.length ? { messageLabels: payload.message.labels } : {}),
  };
}

/** Build a compact lifecycle body without copying credentials or challenge material. */
export function normalizeGrokBotInstanceWebhookPayload(
  event: GrokBotInstanceEvent,
  instanceId: string,
  payload: ChannelEventPayload[ChannelEvent],
): GrokBotInstanceWebhookPayload {
  const normalized = normalizeEventWebhookPayload(
    event,
    instanceId,
    payload,
  ) as InstanceLifecycleWebhookPayload;

  switch (event) {
    case "instance.connected": {
      const connected = normalized as Extract<
        InstanceLifecycleWebhookPayload,
        { event: "instance.connected" }
      >;
      return {
        event,
        instanceId,
        text: "WhatsApp conectado",
        timestamp: connected.connectedAt,
        status: "connected",
        wasPairing: connected.wasPairing,
      };
    }
    case "instance.disconnected": {
      const disconnected = normalized as Extract<
        InstanceLifecycleWebhookPayload,
        { event: "instance.disconnected" }
      >;
      const reason = safeLifecycleReason(disconnected.reason);
      return {
        event,
        instanceId,
        text: `WhatsApp desconectado (${reason || "unknown"})`,
        timestamp: disconnected.disconnectedAt,
        reason,
        statusCode: disconnected.statusCode,
        status: "disconnected",
        loggedOut: disconnected.loggedOut,
        willReconnect: disconnected.willReconnect,
      };
    }
    case "instance.pairing_code_generated":
    case "instance.qr_generated": {
      const generated = normalized as Extract<
        InstanceLifecycleWebhookPayload,
        { event: "instance.pairing_code_generated" | "instance.qr_generated" }
      >;
      return {
        event,
        instanceId,
        text:
          event === "instance.pairing_code_generated" ? "Código de pareamento gerado" : "QR gerado",
        timestamp: generated.generatedAt,
        method: generated.method,
        expiresAt: generated.expiresAt,
      };
    }
    case "instance.pairing_expired":
    case "instance.qr_expired": {
      const expired = normalized as Extract<
        InstanceLifecycleWebhookPayload,
        { event: "instance.pairing_expired" | "instance.qr_expired" }
      >;
      return {
        event,
        instanceId,
        text:
          event === "instance.pairing_expired" ? "Código de pareamento expirado" : "QR expirado",
        timestamp: expired.expiredAt,
        method: expired.method,
      };
    }
  }
}

function addJidCandidate(candidates: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const jid = value.trim();
  if (jid.includes("@")) candidates.push(jid);
}

/** #140: drop a WhatsApp device suffix (`:12` before `@`) and compare case-insensitively. */
const JID_DEVICE_SUFFIX = /:\d+(?=@)/;

export function normalizeIgnoreJid(value: string): string {
  return value.trim().toLowerCase().replace(JID_DEVICE_SUFFIX, "");
}

/**
 * JIDs used by WA_EVENT_WEBHOOK_IGNORE_JIDS (#140).
 * Address wildcards match only chatJids. Exact and starred entries also match identityJids.
 * Participant arrays are not included.
 */
export function eventIgnoreJidSets(payload: ChannelEventPayload[ChannelEvent]): {
  chatJids: string[];
  identityJids: string[];
} {
  const data = payload as unknown as Record<string, unknown>;
  const message = isRecord(data.message) ? data.message : {};
  const association = isRecord(data.association) ? data.association : {};
  const chatJids: string[] = [];
  addJidCandidate(chatJids, data.chatId);
  addJidCandidate(chatJids, data.groupId);
  addJidCandidate(chatJids, data.newsletterId);
  addJidCandidate(chatJids, association.chatId);
  const identityJids: string[] = [];
  addJidCandidate(identityJids, data.participant);
  addJidCandidate(identityJids, data.callerId);
  addJidCandidate(identityJids, data.reactedBy);
  addJidCandidate(identityJids, data.deletedBy);
  addJidCandidate(identityJids, data.author);
  addJidCandidate(identityJids, data.contactId);
  addJidCandidate(identityJids, data.chatLid);
  addJidCandidate(identityJids, data.senderLid);
  addJidCandidate(identityJids, data.fromLid);
  addJidCandidate(identityJids, data.participantLid);
  addJidCandidate(identityJids, message.sender);
  addJidCandidate(identityJids, message.senderLid);
  addJidCandidate(identityJids, message.senderPn);
  return { chatJids, identityJids };
}

/** Chat, sender, and LID fields a JID ignore rule can see. Participant lists are not included. */
export function eventJidCandidates(payload: ChannelEventPayload[ChannelEvent]): string[] {
  const { chatJids, identityJids } = eventIgnoreJidSets(payload);
  return [...chatJids, ...identityJids];
}

export function jidMatchesIgnorePattern(jid: string, pattern: string): boolean {
  const normalizedJid = normalizeIgnoreJid(jid);
  const normalizedPattern = normalizeIgnoreJid(pattern);
  if (!normalizedJid || !normalizedPattern) return false;
  if (normalizedPattern.startsWith("@")) return normalizedJid.endsWith(normalizedPattern);
  const star = normalizedPattern.indexOf("*");
  if (star === -1) return normalizedJid === normalizedPattern;
  const prefix = normalizedPattern.slice(0, star);
  const suffix = normalizedPattern.slice(star + 1);
  return (
    normalizedJid.length >= prefix.length + suffix.length &&
    normalizedJid.startsWith(prefix) &&
    normalizedJid.endsWith(suffix)
  );
}

function phoneJidFromStoredPhone(phone: string): string | undefined {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return undefined;
  return `${digits}@s.whatsapp.net`;
}

/**
 * #140: a LID-only message has no phone alias on the event. Use the contact row
 * (jid, lid, phone) so an exact or starred phone entry can still match.
 * Address wildcards do not use these aliases.
 */
function lookupStoredJidAliases(instanceId: string, jids: readonly string[]): string[] {
  const needles = [
    ...new Set(
      jids
        .map((jid) => normalizeIgnoreJid(jid))
        .filter(
          (jid) => jid.endsWith("@lid") || jid.endsWith("@s.whatsapp.net") || jid.endsWith("@c.us"),
        ),
    ),
  ];
  if (!instanceId || needles.length === 0) return [];
  try {
    const rows = db
      .select({ jid: contacts.jid, phone: contacts.phone, lid: contacts.lid })
      .from(contacts)
      .where(
        and(
          eq(contacts.instanceId, instanceId),
          or(inArray(contacts.jid, needles), inArray(contacts.lid, needles)),
        ),
      )
      .all();
    const aliases: string[] = [];
    for (const row of rows) {
      if (row.jid) aliases.push(row.jid);
      if (row.lid) aliases.push(row.lid);
      if (row.phone) {
        const phoneJid = phoneJidFromStoredPhone(row.phone);
        if (phoneJid) aliases.push(phoneJid);
      }
    }
    return aliases;
  } catch {
    logger.warn("Unable to resolve stored LID mappings for the JID ignore filter");
    return [];
  }
}

export function eventMatchesIgnoreJids(
  payload: ChannelEventPayload[ChannelEvent],
  ignoreJids: readonly string[] | undefined,
): boolean {
  if (!ignoreJids || ignoreJids.length === 0) return false;
  const { chatJids, identityJids } = eventIgnoreJidSets(payload);
  const domainPatterns: string[] = [];
  const specificPatterns: string[] = [];
  for (const pattern of ignoreJids) {
    if (normalizeIgnoreJid(pattern).startsWith("@")) domainPatterns.push(pattern);
    else specificPatterns.push(pattern);
  }
  if (
    domainPatterns.some((pattern) => chatJids.some((jid) => jidMatchesIgnorePattern(jid, pattern)))
  ) {
    return true;
  }
  if (specificPatterns.length === 0) return false;
  const instanceId =
    typeof (payload as { instanceId?: unknown }).instanceId === "string"
      ? (payload as { instanceId: string }).instanceId
      : "";
  const resolved = lookupStoredJidAliases(instanceId, [...chatJids, ...identityJids]);
  return [...chatJids, ...identityJids, ...resolved].some((jid) =>
    specificPatterns.some((pattern) => jidMatchesIgnorePattern(jid, pattern)),
  );
}

export function shouldSendEventWebhook(
  event: ChannelEvent,
  payload: ChannelEventPayload[ChannelEvent],
  config: Pick<EventWebhookConfig, "events" | "ignoreFromMe"> &
    Partial<
      Pick<EventWebhookDestination, "preset" | "chatAllowlist" | "senderAllowlist" | "ignoreJids">
    >,
): boolean {
  if (!config.events.includes(event)) return false;
  if (
    config.preset === "grok-bot" &&
    event !== "message.received" &&
    !event.startsWith("instance.") &&
    !isWebhookRoutineEvent(event)
  ) {
    return false;
  }

  const data = payload as unknown as Record<string, unknown>;
  const message = isRecord(data.message) ? data.message : {};
  const association = isRecord(data.association) ? data.association : {};
  const chatId =
    typeof data.chatId === "string"
      ? data.chatId
      : typeof data.groupId === "string"
        ? data.groupId
        : typeof association.chatId === "string"
          ? association.chatId
          : "";
  const senderId =
    typeof message.sender === "string"
      ? message.sender
      : typeof data.participant === "string"
        ? data.participant
        : typeof data.callerId === "string"
          ? data.callerId
          : "";

  if (event === "message.received" || event === "newsletter.message") {
    if (config.ignoreFromMe && message.isFromMe === true) return false;
    if (
      event === "message.received" &&
      config.preset === "grok-bot" &&
      (chatId.toLowerCase() === "status@broadcast" ||
        chatId.toLowerCase().endsWith("@broadcast") ||
        chatId.toLowerCase().endsWith("@newsletter"))
    ) {
      return false;
    }
  }

  if (!event.startsWith("instance.")) {
    if (eventMatchesIgnoreJids(payload, config.ignoreJids)) return false;
    if (config.chatAllowlist && !config.chatAllowlist.includes(chatId)) return false;
    if (config.senderAllowlist && !config.senderAllowlist.includes(senderId)) return false;
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
  destinationsFor: (instanceId: string) => readonly EventWebhookDestination[] = () =>
    config.destinations,
): EventWebhookUnsubscribe {
  if (config.messageDebounceMs > 0) {
    for (const destination of config.destinations) {
      if (destination.debounceMs > 0) {
        logger.warn(
          { destinationId: destination.id, debounceMs: destination.debounceMs },
          "Destination debounce is ignored while per-chat batching is enabled",
        );
      }
    }
  }

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
    const buffer = buffers.get(eventWebhookDestinationIdentity(destination));
    if (!buffer) return Promise.resolve();
    clearTimeout(buffer.timer);
    buffers.delete(eventWebhookDestinationIdentity(destination));
    if (buffer.payloads.length === 1) {
      return enqueuePayload(destination, buffer.payloads[0] as EventWebhookBody);
    }
    const payload: EventWebhookBody =
      destination.preset === "grok-bot" && buffer.payloads.every(isGrokBotMessagePayload)
        ? { messages: buffer.payloads as GrokBotWebhookPayload[] }
        : {
            events: buffer.payloads as (
              | NormalizedEventWebhookPayload
              | GrokBotInstanceWebhookPayload
              | GrokBotRoutineWebhookPayload
            )[],
          };
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
    const key = JSON.stringify([eventWebhookDestinationIdentity(destination), instanceId, chatId]);
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
    payload: BufferedDestinationPayload,
  ): void => {
    if (destination.debounceMs === 0) {
      void enqueuePayload(destination, payload);
      return;
    }

    let buffer = buffers.get(eventWebhookDestinationIdentity(destination));
    if (
      buffer &&
      destination.preset === "grok-bot" &&
      isGrokBotMessagePayload(buffer.payloads[0]!) !== isGrokBotMessagePayload(payload)
    ) {
      void flushDestination(destination);
      buffer = undefined;
    }
    if (!buffer) {
      const timer = setTimeout(() => {
        void flushDestination(destination);
      }, destination.debounceMs);
      buffer = { payloads: [], timer };
      buffers.set(eventWebhookDestinationIdentity(destination), buffer);
    }
    buffer.payloads.push(payload);
    if (buffer.payloads.length >= MAX_BATCH_SIZE) void flushDestination(destination);
  };

  const removeListener = instanceManager.onAnyEvent(
    <E extends ChannelEvent>(event: E, instanceId: string, payload: ChannelEventPayload[E]) => {
      try {
        for (const destination of destinationsFor(instanceId)) {
          if (!shouldSendEventWebhook(event, payload, destination)) continue;

          let webhookPayload: BufferedDestinationPayload;
          if (destination.preset === "grok-bot" && event === "message.received") {
            webhookPayload = normalizeGrokBotWebhookPayload(
              instanceId,
              payload as ChannelEventPayload["message.received"],
            );
          } else if (destination.preset === "grok-bot" && event.startsWith("instance.")) {
            webhookPayload = normalizeGrokBotInstanceWebhookPayload(
              event as GrokBotInstanceEvent,
              instanceId,
              payload as ChannelEventPayload[ChannelEvent],
            );
          } else if (destination.preset === "grok-bot" && isWebhookRoutineEvent(event)) {
            webhookPayload = normalizeGrokBotRoutineWebhookPayload(
              event,
              instanceId,
              payload as ChannelEventPayload[typeof event],
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
              return { ...(normalized as EventWebhookPayload), transcription: text };
            };

            queueMessagePayload(
              destination,
              instanceId,
              chatId,
              webhookPayload as BufferedMessagePayload,
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

function redactedWebhookEndpoint(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "[invalid URL]";
  }
}

function safeWebhookErrorMessage(value: string, destination?: EventWebhookDestination): string {
  let message = value;
  const destinationUrl = destination?.url;
  if (destinationUrl) {
    message = message.split(destinationUrl).join("[redacted URL]");
    try {
      const path = new URL(destinationUrl).pathname;
      if (path.length > 1) {
        message = message.split(path).join("[redacted path]");
        try {
          const decodedPath = decodeURIComponent(path);
          if (decodedPath !== path && decodedPath.length > 1) {
            message = message.split(decodedPath).join("[redacted path]");
          }
        } catch {
          // Keep the encoded path redaction when it is not valid percent encoding.
        }
      }
    } catch {
      // Invalid destinations are rejected before delivery; continue scrubbing other secrets.
    }
  }
  const secrets = [
    destinationUrl,
    destination?.secret,
    ...Object.values(destination?.headers ?? {}),
  ]
    .filter((secret): secret is string => !!secret)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) message = message.split(secret).join("[redacted]");
  message = message.replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted URL]");
  message = message.replace(/([?&][^=\s]+)=([^&#\s]*)/g, "$1=[redacted]");
  message = message.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]");
  return message.trim().slice(0, 240) || "Event webhook delivery failed";
}

function readWebhookFailureDiagnostics(
  error: unknown,
  destination?: EventWebhookDestination,
): EventWebhookFailureDiagnostics {
  let candidate = error;
  let selected: unknown = error;
  let code: unknown;
  const visited = new Set<unknown>();
  while (candidate && !visited.has(candidate)) {
    visited.add(candidate);
    const candidateCode = errorProperty(candidate, "code");
    const candidateName = errorProperty(candidate, "name");
    if (code === undefined && typeof candidateCode === "string") code = candidateCode;
    if (
      typeof candidateCode === "string" ||
      candidateName === "TimeoutError" ||
      candidateName === "AbortError"
    ) {
      selected = candidate;
    }
    const cause = errorProperty(candidate, "cause");
    if (cause === undefined) break;
    candidate = cause;
  }

  const existingStatus = errorProperty(error, "httpStatus");
  const statusCode = errorProperty(error, "statusCode");
  const candidateStatus =
    typeof existingStatus === "number"
      ? existingStatus
      : typeof statusCode === "number"
        ? statusCode
        : undefined;
  const existingName = errorProperty(error, "errorName");
  const sourceName = errorProperty(selected, "name");
  const errorName =
    typeof existingName === "string"
      ? existingName
      : typeof sourceName === "string"
        ? sourceName
        : "Error";
  const existingMessage = errorProperty(error, "errorMessage");
  const sourceMessage = errorProperty(selected, "message");
  const message =
    typeof existingMessage === "string"
      ? existingMessage
      : typeof sourceMessage === "string"
        ? sourceMessage
        : "Event webhook delivery failed";
  const existingCode = errorProperty(error, "errorCode");
  const errorCode = typeof existingCode === "string" ? existingCode : code;

  return {
    ...(typeof candidateStatus === "number" && candidateStatus >= 100 && candidateStatus <= 599
      ? { httpStatus: candidateStatus }
      : {}),
    errorName: /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(errorName) ? errorName : "Error",
    errorMessage: safeWebhookErrorMessage(message, destination),
    ...(typeof errorCode === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(errorCode)
      ? { errorCode }
      : {}),
  };
}

function addWebhookFailureDiagnostics<T extends Error>(
  error: T,
  diagnostics: EventWebhookFailureDiagnostics,
): T {
  Object.assign(error, diagnostics);
  return error;
}

/** Safe structured fields shared by failed-attempt logs and their unit tests. */
export function eventWebhookFailureLogData(
  attempt: number | undefined,
  error: unknown,
  destination?: EventWebhookDestination,
): Record<string, unknown> {
  const diagnostics = readWebhookFailureDiagnostics(error, destination);
  return {
    ...(attempt !== undefined
      ? { attempt: Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1 }
      : {}),
    ...(destination
      ? { destinationId: destination.id, endpoint: redactedWebhookEndpoint(destination.url) }
      : {}),
    httpStatus: diagnostics.httpStatus ?? null,
    errorName: diagnostics.errorName ?? "Error",
    errorMessage: diagnostics.errorMessage ?? "Event webhook delivery failed",
    errorCode: diagnostics.errorCode ?? null,
  };
}

/** Make one bounded HTTP attempt. Rejections are generic so errors cannot leak URL secrets. */
export async function postEventWebhook(
  destination: EventWebhookDestination,
  payload: EventWebhookBody,
  timeoutMs: number,
  // Use the client from the same Undici version as Agent: Node's bundled fetch
  // can still use the legacy dispatcher contract.
  fetchRequest: typeof fetch | typeof undiciFetch = undiciFetch,
  resolveDns: EventWebhookDnsResolver = resolveWebhookDns,
): Promise<void> {
  let response: Response | Awaited<ReturnType<typeof undiciFetch>> | undefined;
  let dispatcher: Agent | undefined;
  try {
    const url = new URL(destination.url);
    let pinned: { hostname: string; address: string; family: 4 | 6 };
    try {
      pinned = await resolvePinnedWebhookAddress(url, resolveDns);
    } catch (error) {
      const diagnostics = readWebhookFailureDiagnostics(error, destination);
      if (error instanceof UnrecoverableError) {
        throw addWebhookFailureDiagnostics(error, diagnostics);
      }
      if (isRetryableNetworkError(error)) {
        throw new EventWebhookRetryableError(undefined, diagnostics);
      }
      throw addWebhookFailureDiagnostics(
        new UnrecoverableError("Event webhook delivery failed permanently"),
        diagnostics,
      );
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
        headers: Object.fromEntries(createEventWebhookHeaders(body, destination)),
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
        dispatcher,
      });
    } catch (error) {
      const diagnostics = readWebhookFailureDiagnostics(error, destination);
      if (isRetryableNetworkError(error)) {
        throw new EventWebhookRetryableError(undefined, diagnostics);
      }
      throw addWebhookFailureDiagnostics(
        new UnrecoverableError("Event webhook delivery failed permanently"),
        diagnostics,
      );
    }

    if (response.status === 429 || response.status >= 500) {
      throw new EventWebhookRetryableError(
        parseEventWebhookRetryAfter(response.headers.get("retry-after")),
        {
          httpStatus: response.status,
          errorName: "HttpError",
          errorMessage: `HTTP ${response.status}`,
        },
      );
    }
    if (!response.ok) {
      throw addWebhookFailureDiagnostics(
        new UnrecoverableError("Event webhook delivery failed permanently"),
        {
          httpStatus: response.status,
          errorName: "HttpError",
          errorMessage: `HTTP ${response.status}`,
        },
      );
    }
  } catch (error) {
    if (error instanceof EventWebhookRetryableError || error instanceof UnrecoverableError) {
      throw error;
    }
    throw addWebhookFailureDiagnostics(
      new UnrecoverableError("Event webhook delivery failed permanently"),
      readWebhookFailureDiagnostics(error, destination),
    );
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
  const destination = destinations.get(job.destinationIdentity);
  if (
    !destination ||
    job.destinationId !== destination.id ||
    job.destinationIdentity !== eventWebhookDestinationIdentity(destination)
  ) {
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
  private readonly knownDestinations = new Map<string, EventWebhookDestination>();
  private knownDestinationsGeneration = -1;
  private boundManager: InstanceManager | null = null;

  constructor(config = loadEventWebhookConfig()) {
    this.config = config;
  }

  /** Reload instance webhooks and start the worker once any destination exists. */
  sync(): void {
    if (this.boundManager) this.start(this.boundManager);
  }

  start(instanceManager: InstanceManager): void {
    this.boundManager = instanceManager;
    this.rebuildKnownDestinations();
    if (!this.hasDeliveryWork()) return;
    if (this.queue) return;

    this.queue = new Queue<EventWebhookJob>(WEBHOOK_QUEUE_NAME, {
      connection: getRedisConnectionOptions(),
      prefix: this.config.queuePrefix,
      defaultJobOptions: eventWebhookJobOptions(this.config),
    });
    this.worker = new Worker<EventWebhookJob>(
      WEBHOOK_QUEUE_NAME,
      (job: Job<EventWebhookJob>) =>
        processEventWebhookJob(job.data, this.destinationMap(), this.config.timeoutMs),
      {
        connection: getRedisConnectionOptions(),
        prefix: this.config.queuePrefix,
        settings: { backoffStrategy: eventWebhookBackoffStrategy(this.config.retryDelayMs) },
      },
    );
    this.worker.on("failed", (job, error) => {
      const destination = job ? this.destinationMap().get(job.data.destinationIdentity) : undefined;
      logger.warn(
        eventWebhookFailureLogData(job?.attemptsMade, error, destination),
        "Outgoing event webhook delivery attempt failed",
      );
    });
    this.worker.on("error", () => {
      logger.error("Outgoing event webhook worker encountered an error");
    });

    this.removeEventHandler = registerEventWebhookHandler(
      instanceManager,
      this.config,
      (job) => {
        if (!this.queue) return Promise.reject(new Error("Event webhook queue is closed"));
        return this.queue.add("deliver", job);
      },
      undefined,
      (instanceId) => destinationsForInstance(this.config, instanceId),
    );
  }

  private hasDeliveryWork(): boolean {
    return this.config.destinations.length > 0 || listInstanceWebhooks().length > 0;
  }

  /** Cached map; storage changes invalidate it before the next delivery. */
  destinationMap(): ReadonlyMap<string, EventWebhookDestination> {
    if (this.knownDestinationsGeneration !== instanceWebhookStorageGeneration()) {
      this.rebuildKnownDestinations();
    }
    return this.knownDestinations;
  }

  private rebuildKnownDestinations(): void {
    this.knownDestinationsGeneration = instanceWebhookStorageGeneration();
    this.knownDestinations.clear();
    for (const destination of this.config.destinations) {
      this.knownDestinations.set(eventWebhookDestinationIdentity(destination), destination);
    }
    for (const destination of storedInstanceDestinations(this.config, eventWebhookAllowsHttp())) {
      this.knownDestinations.set(eventWebhookDestinationIdentity(destination), destination);
    }
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
