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
import { isValidInstanceId, validateMediaUrl } from "../utils/validation.js";
import { createChildLogger } from "../utils/logger.js";
import {
  isChatwootJidIgnored,
  parseChatwootSourceId,
  type ChatwootConfig,
  type EnabledChatwootConfig,
} from "./chatwoot-config.js";
import {
  ChatwootClient,
  createChatwootTransport,
  type ChatwootTransport,
} from "./chatwoot-client.js";

const logger = createChildLogger({ service: "chatwoot" });
const MAX_WEBHOOK_BYTES = 1_048_576;
const MAX_SEEN = 2_000;

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

export interface ChatwootWebhookInput {
  rawBody: Buffer;
  headerSecret?: string;
  querySecret?: string;
  signature?: string;
}

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
  sourceChatId: string;
  hintedInstanceId?: string;
  hintedChatId?: string;
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

/** Header, query secret, or HMAC of the raw body. */
export function chatwootWebhookAuthorized(input: {
  secret: string;
  rawBody: Buffer;
  headerSecret?: string;
  querySecret?: string;
  signature?: string;
}): boolean {
  if (sameSecret(input.secret, input.headerSecret) || sameSecret(input.secret, input.querySecret)) {
    return true;
  }
  const signature = input.signature?.trim();
  if (!signature) return false;
  const digest = createHmac("sha256", input.secret).update(input.rawBody).digest("hex");
  return sameSecret(`sha256=${digest}`, signature);
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

/** Translate the Chatwoot message_created payload into a routing decision. */
export function parseChatwootWebhook(body: unknown): ChatwootWebhookDecision {
  if (!isRecord(body)) return { action: "ignore", reason: "invalid_payload" };
  if (stringOf(body.event) !== "message_created") return { action: "ignore", reason: "event" };
  if (typeof body.id !== "number" || !Number.isFinite(body.id)) {
    return { action: "ignore", reason: "invalid_payload" };
  }

  const conversation = isRecord(body.conversation) ? body.conversation : {};
  const attributes = isRecord(conversation.additional_attributes)
    ? conversation.additional_attributes
    : {};
  const contactInbox = isRecord(conversation.contact_inbox) ? conversation.contact_inbox : {};
  const meta = isRecord(conversation.meta) ? conversation.meta : {};
  const metaSender = isRecord(meta.sender) ? meta.sender : {};
  const sender = isRecord(body.sender) ? body.sender : {};
  const hintedInstanceId = stringOf(attributes.wamcp_instance_id);
  const hintedChatId = stringOf(attributes.wamcp_chat_id);
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
      privateNote: body.private === true,
      sourceId: stringOf(body.source_id),
      deleted: isDeleted(body.content_attributes),
      senderType: stringOf(sender.type).toLowerCase(),
      inboxId:
        typeof inboxRaw === "number" || typeof inboxRaw === "string" ? String(inboxRaw) : null,
      sourceChatId:
        stringOf(contactInbox.source_id) || stringOf(metaSender.identifier) || hintedChatId,
      ...(hintedInstanceId ? { hintedInstanceId } : {}),
      ...(hintedChatId ? { hintedChatId } : {}),
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

function attachmentContent(attachment: ChatwootAttachment, baseUrl: string): MessageContent | null {
  const url = absoluteAttachmentUrl(attachment.dataUrl, baseUrl);
  if (!url || validateMediaUrl(url) !== null) return null;
  const kind = attachment.fileType.toLowerCase();
  if (kind === "image") return { type: "image", image: url };
  if (kind === "video") return { type: "video", video: url };
  if (kind === "audio") return { type: "audio", audio: url };
  if (kind === "file" || kind === "document") {
    return {
      type: "document",
      document: url,
      fileName: fileNameFromUrl(url),
      mimeType: "application/octet-stream",
    };
  }
  return null;
}

/** WhatsApp messages queued for one agent reply. Private attachment URLs are dropped. */
export function chatwootReplyContents(
  parsed: ParsedChatwootWebhook,
  baseUrl: string,
): MessageContent[] {
  const text = chatwootMarkdownToWhatsApp(parsed.content).trim().slice(0, 65_536);
  const attachments = parsed.attachments.flatMap((attachment) => {
    const content = attachmentContent(attachment, baseUrl);
    return content ? [content] : [];
  });
  if (attachments.length === 0) return text ? [{ type: "text", text }] : [];
  const first = attachments[0];
  if (first && text && (first.type === "image" || first.type === "video")) {
    return [{ ...first, caption: text }, ...attachments.slice(1)];
  }
  return [...(text ? [{ type: "text" as const, text }] : []), ...attachments];
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
  private readonly client: ChatwootClient | null;

  constructor(
    private readonly config: ChatwootConfig,
    private readonly runtime: ChatwootRuntime,
    transport?: ChatwootTransport,
  ) {
    if (!config.enabled) {
      this.client = null;
      return;
    }
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

  stop(): void {
    this.stopListener?.();
    this.stopListener = null;
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
    if (
      !chatwootWebhookAuthorized({
        secret: this.config.webhookSecret,
        rawBody: input.rawBody,
        ...(input.headerSecret === undefined ? {} : { headerSecret: input.headerSecret }),
        ...(input.querySecret === undefined ? {} : { querySecret: input.querySecret }),
        ...(input.signature === undefined ? {} : { signature: input.signature }),
      })
    ) {
      return { status: 401, body: { error: "Unauthorized" } };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(input.rawBody.toString("utf8")) as unknown;
    } catch {
      return { status: 400, body: { error: "Invalid JSON" } };
    }
    const decision = parseChatwootWebhook(parsedJson);
    if (decision.action === "ignore") {
      return { status: 200, body: { status: "ignored", reason: decision.reason } };
    }
    return this.deliverReply(this.config, decision.parsed);
  }

  private async deliverReply(
    config: EnabledChatwootConfig,
    parsed: ParsedChatwootWebhook,
  ): Promise<ChatwootWebhookResult> {
    if (parsed.privateNote || parsed.deleted || parsed.sourceId.startsWith("WAID:")) {
      return { status: 200, body: { status: "ignored", reason: "echo" } };
    }
    if (parsed.messageType !== "outgoing" || parsed.senderType === "contact") {
      return { status: 200, body: { status: "ignored", reason: "not_agent_reply" } };
    }
    if (parsed.inboxId && parsed.inboxId !== config.inboxId) {
      return { status: 200, body: { status: "ignored", reason: "inbox" } };
    }
    if (this.seenChatwootSet.has(parsed.id)) {
      return { status: 200, body: { status: "ignored", reason: "duplicate" } };
    }

    const destination = this.resolveDestination(config, parsed);
    if (!destination) {
      return { status: 422, body: { error: "Chatwoot reply destination could not be resolved" } };
    }
    if (isChatwootJidIgnored(destination.chatId, config.ignoreJids)) {
      return { status: 200, body: { status: "ignored", reason: "jid_filter" } };
    }
    const contents = chatwootReplyContents(parsed, config.url);
    if (contents.length === 0) {
      return { status: 200, body: { status: "ignored", reason: "empty" } };
    }

    let channel: ChannelType;
    try {
      channel = this.runtime.getInstanceChannel(destination.instanceId);
    } catch {
      return { status: 422, body: { error: "Chatwoot reply destination could not be resolved" } };
    }

    this.rememberNumber(parsed.id);
    try {
      for (const content of contents) {
        await this.runtime.enqueueMessage(
          destination.instanceId,
          destination.chatId,
          content,
          channel,
        );
      }
    } catch (error) {
      this.forgetNumber(parsed.id);
      logger.error(
        { err: error, instanceId: destination.instanceId },
        "Failed to queue Chatwoot reply",
      );
      return { status: 500, body: { error: "Failed to queue WhatsApp message" } };
    }
    return { status: 202, body: { status: "accepted" } };
  }

  private resolveDestination(
    config: EnabledChatwootConfig,
    parsed: ParsedChatwootWebhook,
  ): { instanceId: string; chatId: string } | null {
    const fromSource = parseChatwootSourceId(parsed.sourceChatId, config.instanceId);
    const chatId = parsed.hintedChatId || fromSource.chatId;
    if (!chatId) return null;
    const instanceId = [
      parsed.hintedInstanceId,
      fromSource.instanceId,
      config.instanceId,
      this.onlyInstanceId(),
    ].find(
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
  const result = await service.handleWebhook({
    rawBody,
    ...(headerSecret === undefined ? {} : { headerSecret }),
    ...(url.searchParams.get("secret")
      ? { querySecret: url.searchParams.get("secret") ?? undefined }
      : {}),
    ...(headerValue(req, "x-hub-signature-256")
      ? { signature: headerValue(req, "x-hub-signature-256") }
      : {}),
  });
  res.writeHead(result.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result.body));
}
