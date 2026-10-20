// ============================================================
// WA MCP — Chatwoot API-channel bridge
// Inbound WhatsApp messages open Chatwoot conversations.
// Agent replies arrive on POST /chatwoot/webhook and are queued
// to WhatsApp. Event-webhook delivery is a separate listener.
// ============================================================

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { InstanceManager } from "./instance-manager.js";
import type {
  ChannelEvent,
  ChannelEventPayload,
  ChannelType,
  MessageContent,
  NormalizedMessageEvent,
} from "../types/channel.types.js";
import { MEDIA_LIMITS } from "../constants.js";
import { isValidInstanceId, validateMediaUrl } from "../utils/validation.js";
import { createChildLogger } from "../utils/logger.js";
import {
  isChatwootJidIgnored,
  isChatwootNewsletterSource,
  parseChatwootSourceId,
  type ChatwootConfig,
  type EnabledChatwootConfig,
} from "./chatwoot-config.js";
import {
  ChatwootAttachmentTooLargeError,
  ChatwootClient,
  createChatwootTransport,
  fetchPinnedResource,
  type ChatwootTransport,
} from "./chatwoot-client.js";

const logger = createChildLogger({ service: "chatwoot" });
const MAX_WEBHOOK_BYTES = 1_048_576;
const MAX_SEEN = 2_000;
export const CHATWOOT_SIGNATURE_WINDOW_SECONDS = 300;
export const MAX_REPLY_ATTACHMENTS = 8;
export const MAX_REPLY_ATTACHMENT_BYTES = 16 * 1024 * 1024;
/**
 * Memory ceiling for delivery ids. A full map of ids that are still inside the
 * signature window is not evicted; the webhook is refused so Chatwoot can retry.
 */
export const MAX_CHATWOOT_DELIVERIES = 10_000;
/** Shutdown waits this long for background replies, then continues. */
export const CHATWOOT_REPLY_DRAIN_TIMEOUT_MS = 5_000;

export interface ChatwootRuntime {
  enqueueMessage(
    instanceId: string,
    to: string,
    content: MessageContent,
    channel?: ChannelType,
  ): Promise<{ status: "queued"; jobId: string }>;
  getInstanceChannel(id: string): ChannelType;
  listInstanceIds(): string[];
}

export interface ChatwootDownloadedAttachment {
  data: Buffer;
  contentType: string | null;
}

export type ChatwootAttachmentFetcher = (
  url: string,
  maxBytes: number,
) => Promise<ChatwootDownloadedAttachment>;

export interface ChatwootWebhookInput {
  rawBody: Buffer;
  headerSecret?: string;
  /** Legacy. The value is visible in proxy logs. Prefer the Chatwoot signature headers. */
  querySecret?: string;
  signature?: string;
  timestamp?: string;
  deliveryId?: string;
  nowSeconds?: number;
}

export type ChatwootAuthResult =
  | { ok: true; method: "signature"; deliveryId: string }
  | { ok: true; method: "legacy" }
  | { ok: false };

export interface ChatwootWebhookResult {
  status: number;
  body: Record<string, unknown>;
}

interface ChatwootAttachment {
  fileType: string;
  dataUrl: string;
}

interface ParsedChatwootWebhook {
  id: number;
  content: string;
  messageType: "incoming" | "outgoing" | "activity" | "other";
  privateNote: boolean;
  sourceId: string;
  deleted: boolean;
  senderType: string;
  inboxId: string | null;
  conversationId: number | null;
  sourceChatId: string;
  attachments: ChatwootAttachment[];
}

type ChatwootWebhookDecision =
  { action: "ignore"; reason: string } | { action: "accept"; parsed: ParsedChatwootWebhook };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sameSecret(expected: string, candidate: string | undefined): boolean {
  if (!candidate) return false;
  const left = createHash("sha256").update(expected).digest();
  const right = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(left, right);
}

function digestMatches(expected: Buffer, signature: string | undefined): boolean {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature?.trim() ?? "");
  const hex = match?.[1];
  if (!hex) return false;
  const provided = Buffer.from(hex, "hex");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}

function validDeliveryId(value: string | undefined): string | null {
  const id = value?.trim() ?? "";
  if (!id || id.length > 200) return null;
  for (const char of id) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return null;
  }
  return id;
}

function signatureTimestamp(value: string | undefined, nowSeconds: number): string | null {
  const timestamp = value?.trim() ?? "";
  if (!/^\d{1,12}$/.test(timestamp)) return null;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return null;
  if (Math.abs(nowSeconds - seconds) > CHATWOOT_SIGNATURE_WINDOW_SECONDS) return null;
  return timestamp;
}

/**
 * Chatwoot v4.13+ sends X-Chatwoot-Signature: sha256=HMAC(secret, "<timestamp>.<raw body>").
 * Header and query secrets are accepted only when WA_CHATWOOT_ALLOW_LEGACY_SECRET is on
 * and the signature headers are absent.
 */
export function authorizeChatwootWebhook(input: {
  secret: string;
  rawBody: Buffer;
  headerSecret?: string;
  querySecret?: string;
  signature?: string;
  timestamp?: string;
  deliveryId?: string;
  nowSeconds?: number;
  allowLegacySecret?: boolean;
}): ChatwootAuthResult {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const timestamp = signatureTimestamp(input.timestamp, nowSeconds);
  const deliveryId = validDeliveryId(input.deliveryId);
  const signatureAttempt = Boolean(
    input.signature?.trim() || input.timestamp?.trim() || input.deliveryId?.trim(),
  );
  if (signatureAttempt) {
    if (!timestamp || !deliveryId || !input.signature?.trim()) return { ok: false };
    const digest = createHmac("sha256", input.secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), input.rawBody]))
      .digest();
    if (!digestMatches(digest, input.signature)) return { ok: false };
    return { ok: true, method: "signature", deliveryId };
  }
  if (
    input.allowLegacySecret &&
    (sameSecret(input.secret, input.headerSecret) || sameSecret(input.secret, input.querySecret))
  ) {
    return { ok: true, method: "legacy" };
  }
  return { ok: false };
}

function messageType(value: unknown): ParsedChatwootWebhook["messageType"] {
  if (value === "outgoing" || value === 1 || value === "1") return "outgoing";
  if (value === "incoming" || value === 0 || value === "0") return "incoming";
  if (value === "activity" || value === 2 || value === "2") return "activity";
  return "other";
}

function isDeleted(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const deleted = value.deleted;
  if (deleted === true) return true;
  return typeof deleted === "string" && deleted.trim().toLowerCase() === "true";
}

function positiveId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

/** Translate the Chatwoot message_created payload into a routing decision. */
export function parseChatwootWebhook(body: unknown): ChatwootWebhookDecision {
  if (!isRecord(body)) return { action: "ignore", reason: "invalid_payload" };
  if (stringOf(body.event) !== "message_created") return { action: "ignore", reason: "event" };
  if (typeof body.id !== "number" || !Number.isFinite(body.id)) {
    return { action: "ignore", reason: "invalid_payload" };
  }

  const conversation = isRecord(body.conversation) ? body.conversation : {};
  const contactInbox = isRecord(conversation.contact_inbox) ? conversation.contact_inbox : {};
  const sender = isRecord(body.sender) ? body.sender : {};
  const inboxRaw = conversation.inbox_id;
  const attachments = Array.isArray(body.attachments)
    ? body.attachments.filter(isRecord).flatMap((item) => {
        const dataUrl = stringOf(item.data_url);
        if (!dataUrl) return [];
        return [{ fileType: stringOf(item.file_type) || "file", dataUrl }];
      })
    : [];

  return {
    action: "accept",
    parsed: {
      id: body.id,
      content: typeof body.content === "string" ? body.content : "",
      messageType: messageType(body.message_type),
      privateNote: body.private === true || body.private === "true",
      sourceId: stringOf(body.source_id),
      deleted: isDeleted(body.content_attributes),
      senderType: stringOf(sender.type).toLowerCase(),
      inboxId:
        typeof inboxRaw === "number" || typeof inboxRaw === "string" ? String(inboxRaw) : null,
      conversationId: positiveId(conversation.id),
      sourceChatId: stringOf(contactInbox.source_id),
      attachments,
    },
  };
}

/** Map a few Chatwoot markdown forms onto WhatsApp formatting. */
export function chatwootMarkdownToWhatsApp(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/__([^_\n]+)__/g, "*$1*")
    .replace(/~~([^~\n]+)~~/g, "~$1~");
}

function placeholder(type: string): string {
  switch (type) {
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker":
    case "location":
    case "contact":
    case "poll":
      return `[${type}]`;
    default:
      return "[message]";
  }
}

function sanitizeName(value: string): string {
  return Array.from(value)
    .map((char) => (char.charCodeAt(0) < 32 ? " " : char))
    .join("")
    .trim()
    .slice(0, 80);
}

/** Text stored on the Chatwoot message for one WhatsApp event. */
export function renderChatwootText(event: NormalizedMessageEvent): string {
  const message = event.message;
  const text = (message.content || message.caption || message.mediaCaption || "").trim();
  const body = text || placeholder(message.type);
  const prefix =
    event.isGroup === true && !message.isFromMe && event.senderName
      ? `${sanitizeName(event.senderName)}: `
      : "";
  let rendered = `${prefix}${body}`.trim();
  const media = message.mediaUrl?.trim();
  if (media && validateMediaUrl(media) === null && !rendered.includes(media)) {
    rendered = `${rendered}\n${media}`;
  }
  return rendered.slice(0, 65_536);
}

function absoluteAttachmentUrl(dataUrl: string, baseUrl: string): string | null {
  try {
    if (dataUrl.startsWith("/")) return new URL(dataUrl, `${baseUrl}/`).toString();
    return new URL(dataUrl).toString();
  } catch {
    return null;
  }
}

function fileNameFromUrl(url: string): string {
  try {
    const name = new URL(url).pathname.split("/").pop() || "file";
    const decoded = Array.from(decodeURIComponent(name))
      .filter((char) => char.charCodeAt(0) >= 32)
      .join("")
      .trim();
    return decoded.slice(0, 200) || "file";
  } catch {
    return "file";
  }
}

function attachmentMaxBytes(fileType: string): number | null {
  switch (fileType.toLowerCase()) {
    case "image":
      return MEDIA_LIMITS.image;
    case "video":
      return MEDIA_LIMITS.video;
    case "audio":
      return MEDIA_LIMITS.audio;
    case "file":
    case "document":
      return MEDIA_LIMITS.document;
    default:
      return null;
  }
}

function mimeTypeOf(value: string | null): string {
  const mime = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(mime) ? mime : "application/octet-stream";
}

type DownloadedAttachment =
  | { status: "ok"; content: MessageContent; bytes: number }
  | { status: "budget" }
  | { status: "download_failed" }
  | { status: "skipped" };

function logAttachmentBudget(fileType: string, remaining: number): void {
  logger.warn(
    {
      reason: "attachment_budget",
      fileType,
      remaining,
      cap: MAX_REPLY_ATTACHMENT_BYTES,
    },
    "Chatwoot attachment skipped because the reply byte budget is exhausted",
  );
}

async function downloadedAttachment(
  attachment: ChatwootAttachment,
  baseUrl: string,
  fetchAttachment: ChatwootAttachmentFetcher,
  budget: number,
): Promise<DownloadedAttachment> {
  const typeLimit = attachmentMaxBytes(attachment.fileType);
  const url = absoluteAttachmentUrl(attachment.dataUrl, baseUrl);
  if (typeLimit === null || !url) return { status: "skipped" };
  if (budget <= 0) {
    logAttachmentBudget(attachment.fileType, budget);
    return { status: "budget" };
  }
  const maxBytes = Math.min(typeLimit, budget);
  let downloaded: ChatwootDownloadedAttachment;
  try {
    downloaded = await fetchAttachment(url, maxBytes);
  } catch (error) {
    // The pinned fetcher throws when the body passes maxBytes. That is the reply
    // budget only when this cap is tighter than the per-type media limit.
    if (error instanceof ChatwootAttachmentTooLargeError && maxBytes < typeLimit) {
      logAttachmentBudget(attachment.fileType, budget);
      return { status: "budget" };
    }
    logger.warn(
      { err: error, fileType: attachment.fileType },
      "Chatwoot attachment was not downloaded",
    );
    return { status: "download_failed" };
  }
  if (downloaded.data.length === 0) return { status: "skipped" };
  if (downloaded.data.length > maxBytes) {
    logAttachmentBudget(attachment.fileType, budget);
    return { status: "budget" };
  }
  const encoded = downloaded.data.toString("base64");
  const kind = attachment.fileType.toLowerCase();
  if (kind === "image") {
    return {
      status: "ok",
      content: { type: "image", image: encoded },
      bytes: downloaded.data.length,
    };
  }
  if (kind === "video") {
    return {
      status: "ok",
      content: { type: "video", video: encoded },
      bytes: downloaded.data.length,
    };
  }
  if (kind === "audio") {
    return {
      status: "ok",
      content: { type: "audio", audio: encoded, mimeType: mimeTypeOf(downloaded.contentType) },
      bytes: downloaded.data.length,
    };
  }
  return {
    status: "ok",
    content: {
      type: "document",
      document: encoded,
      fileName: fileNameFromUrl(url),
      mimeType: mimeTypeOf(downloaded.contentType),
    },
    bytes: downloaded.data.length,
  };
}

export interface ChatwootReplyBuild {
  contents: MessageContent[];
  downloadFailed: boolean;
  budgetSkipped: number;
}

function budgetSkipReason(count: number): string {
  return count === 1
    ? "1 attachment exceeded the 16 MB reply budget and was not sent."
    : `${count} attachments exceeded the 16 MB reply budget and were not sent.`;
}

/** WhatsApp messages queued for one agent reply. Attachments are bytes, never remote URLs. */
export async function buildChatwootReplyContents(
  parsed: ParsedChatwootWebhook,
  baseUrl: string,
  fetchAttachment: ChatwootAttachmentFetcher,
): Promise<ChatwootReplyBuild> {
  const text = chatwootMarkdownToWhatsApp(parsed.content).trim().slice(0, 65_536);
  const attachments: MessageContent[] = [];
  let used = 0;
  let downloadFailed = false;
  let budgetSkipped = 0;
  for (const attachment of parsed.attachments.slice(0, MAX_REPLY_ATTACHMENTS)) {
    const remaining = MAX_REPLY_ATTACHMENT_BYTES - used;
    if (remaining <= 0) {
      budgetSkipped += 1;
      logAttachmentBudget(attachment.fileType, remaining);
      continue;
    }
    const downloaded = await downloadedAttachment(attachment, baseUrl, fetchAttachment, remaining);
    if (downloaded.status === "budget") {
      budgetSkipped += 1;
      continue;
    }
    if (downloaded.status === "download_failed") {
      downloadFailed = true;
      continue;
    }
    if (downloaded.status !== "ok") continue;
    attachments.push(downloaded.content);
    used += downloaded.bytes;
  }
  let contents: MessageContent[];
  if (attachments.length === 0) contents = text ? [{ type: "text", text }] : [];
  else {
    const first = attachments[0];
    if (first && text && (first.type === "image" || first.type === "video")) {
      contents = [{ ...first, caption: text }, ...attachments.slice(1)];
    } else {
      contents = [...(text ? [{ type: "text" as const, text }] : []), ...attachments];
    }
  }
  return { contents, downloadFailed, budgetSkipped };
}

function drainReplyJobs(jobs: Set<Promise<void>>, timeoutMs: number): Promise<void> {
  if (jobs.size === 0) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = Promise.allSettled(jobs).then(() => undefined);
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([pending, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((item) => item.trim());
    return first?.trim();
  }
  return undefined;
}

function readLimitedBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | "too_large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: Buffer | "too_large") => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > maxBytes) {
        req.destroy();
        finish("too_large");
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => finish(Buffer.concat(chunks)));
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

export class ChatwootService {
  private stopListener: (() => void) | null = null;
  private readonly seenWa: string[] = [];
  private readonly seenWaSet = new Set<string>();
  private readonly seenChatwoot: number[] = [];
  private readonly seenChatwootSet = new Set<number>();
  private readonly deliveries = new Map<string, number>();
  private readonly replyJobs = new Set<Promise<void>>();
  private stopped = false;
  private readonly client: ChatwootClient | null;
  private readonly fetchAttachment: ChatwootAttachmentFetcher;

  constructor(
    private readonly config: ChatwootConfig,
    private readonly runtime: ChatwootRuntime,
    transport?: ChatwootTransport,
    attachments?: ChatwootAttachmentFetcher,
  ) {
    if (!config.enabled) {
      this.client = null;
      this.fetchAttachment = async () => {
        throw new Error("Chatwoot is disabled");
      };
      return;
    }
    const enabled = config;
    this.fetchAttachment =
      attachments ?? ((url, maxBytes) => fetchPinnedResource(new URL(url), enabled, maxBytes));
    this.client = new ChatwootClient(config, transport ?? createChatwootTransport(config));
    logger.info(
      {
        accountId: config.accountId,
        inboxId: config.inboxId,
        instanceId: config.instanceId ?? null,
      },
      "Chatwoot integration enabled",
    );
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  start(instanceManager: InstanceManager): void {
    if (!this.config.enabled) return;
    this.stopListener = instanceManager.onAnyEvent(
      <E extends ChannelEvent>(event: E, instanceId: string, payload: ChannelEventPayload[E]) => {
        if (event !== "message.received") return;
        void this.forwardReceived(
          instanceId,
          payload as ChannelEventPayload["message.received"],
        ).catch((error: unknown) => {
          logger.error({ err: error, instanceId }, "Chatwoot inbound sync failed");
        });
      },
    );
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.stopListener?.();
    this.stopListener = null;
    return drainReplyJobs(this.replyJobs, CHATWOOT_REPLY_DRAIN_TIMEOUT_MS);
  }

  /** Mirror one WhatsApp message into Chatwoot. Failures stay inside this listener. */
  async forwardReceived(instanceId: string, event: NormalizedMessageEvent): Promise<void> {
    if (!this.config.enabled || !this.client) return;
    if (this.config.instanceId && this.config.instanceId !== instanceId) return;
    if (isChatwootJidIgnored(event.chatId, this.config.ignoreJids)) return;
    const messageId = event.message.id.trim();
    if (!messageId) return;
    const dedupKey = `${instanceId}:${messageId}`;
    if (this.seenWaSet.has(dedupKey)) return;
    this.remember(this.seenWaSet, this.seenWa, dedupKey);
    try {
      await this.client.syncMessage({
        instanceId,
        chatId: event.chatId,
        ...(event.chatName === undefined ? {} : { chatName: event.chatName }),
        ...(event.senderName === undefined ? {} : { senderName: event.senderName }),
        isGroup: event.isGroup === true,
        messageId,
        isFromMe: event.message.isFromMe,
        text: renderChatwootText(event),
      });
    } catch (error) {
      this.forget(this.seenWaSet, this.seenWa, dedupKey);
      throw error;
    }
  }

  /** Accept an agent reply and queue it for WhatsApp when the integration is enabled. */
  async handleWebhook(input: ChatwootWebhookInput): Promise<ChatwootWebhookResult> {
    if (!this.config.enabled || !this.client) {
      return { status: 404, body: { error: "Not found" } };
    }
    if (this.stopped) {
      return { status: 503, body: { error: "Chatwoot bridge is stopping" } };
    }
    const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    const auth = authorizeChatwootWebhook({
      secret: this.config.webhookSecret,
      rawBody: input.rawBody,
      allowLegacySecret: this.config.allowLegacySecret,
      ...(input.headerSecret === undefined ? {} : { headerSecret: input.headerSecret }),
      ...(input.querySecret === undefined ? {} : { querySecret: input.querySecret }),
      ...(input.signature === undefined ? {} : { signature: input.signature }),
      ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
      ...(input.deliveryId === undefined ? {} : { deliveryId: input.deliveryId }),
      nowSeconds,
    });
    if (!auth.ok) return { status: 401, body: { error: "Unauthorized" } };
    const deliveryId = auth.method === "signature" ? auth.deliveryId : undefined;
    if (deliveryId && this.deliverySeen(deliveryId, nowSeconds)) {
      return { status: 200, body: { status: "ignored", reason: "duplicate" } };
    }
    if (deliveryId) {
      const signedAt = Number(input.timestamp);
      const stored = this.rememberDelivery(
        deliveryId,
        signedAt + CHATWOOT_SIGNATURE_WINDOW_SECONDS,
        nowSeconds,
      );
      if (!stored) {
        return { status: 503, body: { error: "Chatwoot delivery cache is full" } };
      }
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(input.rawBody.toString("utf8")) as unknown;
    } catch {
      if (deliveryId) this.forgetDelivery(deliveryId);
      return { status: 400, body: { error: "Invalid JSON" } };
    }
    const decision = parseChatwootWebhook(parsedJson);
    if (decision.action === "ignore") {
      return { status: 200, body: { status: "ignored", reason: decision.reason } };
    }
    const claimed = this.claimReply(this.config, decision.parsed);
    if (claimed.action === "reject") {
      if (deliveryId && claimed.result.status >= 400) this.forgetDelivery(deliveryId);
      return claimed.result;
    }
    this.trackReply(this.sendReply(this.config, decision.parsed, claimed.destination, deliveryId));
    return { status: 202, body: { status: "accepted" } };
  }

  /** Synchronous gate. The Chatwoot message id is reserved before any await. */
  private claimReply(
    config: EnabledChatwootConfig,
    parsed: ParsedChatwootWebhook,
  ):
    | { action: "reject"; result: ChatwootWebhookResult }
    | { action: "accept"; destination: { instanceId: string; chatId: string } } {
    if (parsed.privateNote || parsed.deleted || parsed.sourceId.startsWith("WAID:")) {
      return {
        action: "reject",
        result: { status: 200, body: { status: "ignored", reason: "echo" } },
      };
    }
    if (parsed.messageType !== "outgoing" || parsed.senderType === "contact") {
      return {
        action: "reject",
        result: { status: 200, body: { status: "ignored", reason: "not_agent_reply" } },
      };
    }
    if (parsed.inboxId !== config.inboxId) {
      return {
        action: "reject",
        result: { status: 200, body: { status: "ignored", reason: "inbox" } },
      };
    }
    if (this.seenChatwootSet.has(parsed.id)) {
      return {
        action: "reject",
        result: { status: 200, body: { status: "ignored", reason: "duplicate" } },
      };
    }
    this.rememberNumber(parsed.id);

    if (isChatwootNewsletterSource(parsed.sourceChatId)) {
      logger.info({ reason: "newsletter" }, "Ignoring Chatwoot reply to a newsletter");
      return {
        action: "reject",
        result: { status: 200, body: { status: "ignored", reason: "newsletter" } },
      };
    }

    const destination = this.resolveDestination(config, parsed);
    if (!destination) {
      this.forgetNumber(parsed.id);
      return {
        action: "reject",
        result: {
          status: 422,
          body: { error: "Chatwoot reply destination could not be resolved" },
        },
      };
    }
    if (!this.runtime.listInstanceIds().includes(destination.instanceId)) {
      this.forgetNumber(parsed.id);
      return {
        action: "reject",
        result: {
          status: 422,
          body: { error: "Chatwoot reply instance does not exist" },
        },
      };
    }
    if (config.blockGroupReplies && destination.chatId.endsWith("@g.us")) {
      return {
        action: "reject",
        result: { status: 200, body: { status: "ignored", reason: "group" } },
      };
    }
    if (isChatwootJidIgnored(destination.chatId, config.ignoreJids)) {
      return {
        action: "reject",
        result: { status: 200, body: { status: "ignored", reason: "jid_filter" } },
      };
    }
    const text = chatwootMarkdownToWhatsApp(parsed.content).trim();
    if (!text && parsed.attachments.length === 0) {
      return {
        action: "reject",
        result: { status: 200, body: { status: "ignored", reason: "empty" } },
      };
    }
    return { action: "accept", destination };
  }

  /** Downloads and queues after the webhook has already been answered. */
  private async sendReply(
    config: EnabledChatwootConfig,
    parsed: ParsedChatwootWebhook,
    destination: { instanceId: string; chatId: string },
    deliveryId?: string,
  ): Promise<void> {
    let queued = 0;
    let pendingNote: string | null = null;
    try {
      const built = await buildChatwootReplyContents(parsed, config.url, this.fetchAttachment);
      const problems: string[] = [];
      if (built.budgetSkipped > 0) problems.push(budgetSkipReason(built.budgetSkipped));
      if (built.downloadFailed) problems.push("An attachment could not be downloaded.");
      pendingNote = problems.length > 0 ? problems.join(" ") : null;
      if (built.contents.length === 0) {
        this.releaseReply(parsed.id, deliveryId);
        await this.reportReplyFailure(
          parsed,
          pendingNote ?? "The reply had nothing left to send.",
          false,
        );
        return;
      }
      const channel = this.runtime.getInstanceChannel(destination.instanceId);
      for (const content of built.contents) {
        await this.runtime.enqueueMessage(
          destination.instanceId,
          destination.chatId,
          content,
          channel,
        );
        queued += 1;
      }
      if (pendingNote) await this.reportReplyFailure(parsed, pendingNote, true);
    } catch (error) {
      if (queued === 0) this.releaseReply(parsed.id, deliveryId);
      logger.error(
        { err: error, instanceId: destination.instanceId },
        "Failed to queue Chatwoot reply",
      );
      const reason = pendingNote
        ? `${pendingNote} The outbound queue did not accept the WhatsApp reply.`
        : "The outbound queue did not accept the WhatsApp reply.";
      await this.reportReplyFailure(parsed, reason, queued > 0);
    }
  }

  /** Tell the agent. A private note is used because message status cannot be set to failed. */
  private async reportReplyFailure(
    parsed: ParsedChatwootWebhook,
    reason: string,
    partial: boolean,
  ): Promise<void> {
    const lead = partial ? "WhatsApp reply was only partly sent." : "WhatsApp reply was not sent.";
    if (!this.client || parsed.conversationId === null) {
      logger.warn({ reason }, "Chatwoot reply failed and was not reported to the conversation");
      return;
    }
    try {
      await this.client.postPrivateNote(parsed.conversationId, `${lead} ${reason}`);
    } catch (error) {
      logger.warn({ err: error }, "Chatwoot failure note was not posted");
    }
  }

  private trackReply(job: Promise<void>): void {
    const tracked = job
      .catch((error: unknown) => {
        logger.error({ err: error }, "Chatwoot background reply failed");
      })
      .finally(() => {
        this.replyJobs.delete(tracked);
      });
    this.replyJobs.add(tracked);
  }

  private releaseReply(messageId: number, deliveryId?: string): void {
    this.forgetNumber(messageId);
    if (deliveryId) this.forgetDelivery(deliveryId);
  }

  private resolveDestination(
    config: EnabledChatwootConfig,
    parsed: ParsedChatwootWebhook,
  ): { instanceId: string; chatId: string } | null {
    const fromSource = parseChatwootSourceId(parsed.sourceChatId, config.instanceId);
    const chatId = fromSource.chatId;
    if (!chatId) return null;
    const instanceId = [fromSource.instanceId, config.instanceId, this.onlyInstanceId()].find(
      (candidate): candidate is string => candidate !== undefined && isValidInstanceId(candidate),
    );
    if (!instanceId) return null;
    if (config.instanceId && instanceId !== config.instanceId) return null;
    return { instanceId, chatId };
  }

  private onlyInstanceId(): string | undefined {
    const ids = this.runtime.listInstanceIds();
    return ids.length === 1 ? ids[0] : undefined;
  }

  private deliverySeen(id: string, nowSeconds: number): boolean {
    this.pruneDeliveries(nowSeconds);
    const expiresAt = this.deliveries.get(id);
    return expiresAt !== undefined && expiresAt >= nowSeconds;
  }

  private rememberDelivery(id: string, expiresAt: number, nowSeconds: number): boolean {
    this.pruneDeliveries(nowSeconds);
    if (!this.deliveries.has(id) && this.deliveries.size >= MAX_CHATWOOT_DELIVERIES) return false;
    this.deliveries.set(id, expiresAt);
    return true;
  }

  private forgetDelivery(id: string): void {
    this.deliveries.delete(id);
  }

  /**
   * Map iteration is insertion order. Drop the expired prefix and stop at the
   * first id that is still inside the window. Live ids are never evicted.
   */
  private pruneDeliveries(nowSeconds: number): void {
    for (const [id, expiresAt] of this.deliveries) {
      if (expiresAt >= nowSeconds) break;
      this.deliveries.delete(id);
    }
  }

  private remember(set: Set<string>, order: string[], key: string): void {
    if (set.has(key)) return;
    set.add(key);
    order.push(key);
    while (order.length > MAX_SEEN) {
      const removed = order.shift();
      if (removed) set.delete(removed);
    }
  }

  private forget(set: Set<string>, order: string[], key: string): void {
    set.delete(key);
    const index = order.lastIndexOf(key);
    if (index >= 0) order.splice(index, 1);
  }

  private rememberNumber(id: number): void {
    if (this.seenChatwootSet.has(id)) return;
    this.seenChatwootSet.add(id);
    this.seenChatwoot.push(id);
    while (this.seenChatwoot.length > MAX_SEEN) {
      const removed = this.seenChatwoot.shift();
      if (removed !== undefined) this.seenChatwootSet.delete(removed);
    }
  }

  private forgetNumber(id: number): void {
    this.seenChatwootSet.delete(id);
    const index = this.seenChatwoot.lastIndexOf(id);
    if (index >= 0) this.seenChatwoot.splice(index, 1);
  }
}

/** HTTP entry for the Chatwoot API-channel webhook. */
export async function handleChatwootHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  service: ChatwootService,
): Promise<void> {
  if (!service.isEnabled()) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    req.destroy();
    return;
  }
  const rawBody = await readLimitedBody(req, MAX_WEBHOOK_BYTES);
  if (rawBody === "too_large") {
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Payload too large" }));
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const headerSecret =
    headerValue(req, "x-chatwoot-webhook-secret") ?? headerValue(req, "x-wa-chatwoot-secret");
  // ?secret= is ignored unless WA_CHATWOOT_ALLOW_LEGACY_SECRET=true. It shows up in proxy logs.
  const querySecret = url.searchParams.get("secret");
  const result = await service.handleWebhook({
    rawBody,
    ...(headerSecret === undefined ? {} : { headerSecret }),
    ...(querySecret ? { querySecret } : {}),
    ...(headerValue(req, "x-chatwoot-signature")
      ? { signature: headerValue(req, "x-chatwoot-signature") }
      : {}),
    ...(headerValue(req, "x-chatwoot-timestamp")
      ? { timestamp: headerValue(req, "x-chatwoot-timestamp") }
      : {}),
    ...(headerValue(req, "x-chatwoot-delivery")
      ? { deliveryId: headerValue(req, "x-chatwoot-delivery") }
      : {}),
  });
  res.writeHead(result.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result.body));
}
