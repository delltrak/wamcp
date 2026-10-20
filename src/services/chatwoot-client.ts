// ============================================================
// WA MCP — Chatwoot application API client
// Creates contacts and conversations, then posts messages.
// ============================================================

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ConnectionOptions } from "node:tls";
import { Agent } from "undici";
import { isNonPublicIp } from "../utils/validation.js";
import { createChildLogger } from "../utils/logger.js";
import {
  chatwootSourceId,
  isChatwootMetadataAddress,
  type EnabledChatwootConfig,
} from "./chatwoot-config.js";

const logger = createChildLogger({ service: "chatwoot" });

export class ChatwootRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(status > 0 ? `Chatwoot API request failed (${status})` : "Chatwoot API request failed");
    this.name = "ChatwootRequestError";
    this.status = status;
  }
}

/** The response body was larger than the byte cap passed to the pinned download. */
export class ChatwootAttachmentTooLargeError extends ChatwootRequestError {
  constructor() {
    super(0);
    this.name = "ChatwootAttachmentTooLargeError";
    this.message = "Chatwoot attachment exceeded the download size limit";
  }
}

export interface ChatwootRequest {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface ChatwootResponse {
  status: number;
  body: unknown;
}

export interface ChatwootTransport {
  request(input: ChatwootRequest): Promise<ChatwootResponse>;
}

export interface ChatwootDnsRecord {
  address: string;
  family: number;
}

export interface ChatwootTransportDeps {
  fetchImpl?: typeof fetch;
  resolveDns?: (hostname: string) => Promise<ChatwootDnsRecord[]>;
}

export interface ChatwootInboundMessage {
  instanceId: string;
  chatId: string;
  chatName?: string | null;
  senderName?: string | null;
  isGroup: boolean;
  messageId: string;
  isFromMe: boolean;
  text: string;
}

interface FoundContact {
  id: number;
  identifier: string;
  sourceIds: string[];
}

interface FoundConversation {
  id: number;
  inboxId: string;
  status: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPayloadList(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter(isRecord);
  if (!isRecord(body)) return [];
  const payload = body.payload ?? body.data;
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (isRecord(payload)) return [payload];
  return [];
}

function readId(body: unknown): number | null {
  if (!isRecord(body)) return null;
  if (typeof body.id === "number" && Number.isFinite(body.id)) return body.id;
  const payload = body.payload;
  if (!isRecord(payload)) return null;
  if (typeof payload.id === "number" && Number.isFinite(payload.id)) return payload.id;
  const contact = payload.contact;
  if (isRecord(contact) && typeof contact.id === "number" && Number.isFinite(contact.id)) {
    return contact.id;
  }
  const conversation = payload.conversation;
  if (
    isRecord(conversation) &&
    typeof conversation.id === "number" &&
    Number.isFinite(conversation.id)
  ) {
    return conversation.id;
  }
  return null;
}

function readSourceIds(contact: Record<string, unknown>): string[] {
  const raw = contact.contact_inboxes;
  if (!Array.isArray(raw)) return [];
  const sourceIds: string[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.source_id !== "string" || item.source_id.trim() === "") {
      continue;
    }
    sourceIds.push(item.source_id);
  }
  return sourceIds;
}

function readContacts(body: unknown): FoundContact[] {
  const contacts: FoundContact[] = [];
  for (const item of readPayloadList(body)) {
    if (typeof item.id !== "number" || !Number.isFinite(item.id)) continue;
    contacts.push({
      id: item.id,
      identifier: typeof item.identifier === "string" ? item.identifier : "",
      sourceIds: readSourceIds(item),
    });
  }
  return contacts;
}

function readCreatedSourceId(body: unknown): string {
  if (!isRecord(body) || !isRecord(body.payload)) return "";
  const inbox = body.payload.contact_inbox;
  if (!isRecord(inbox) || typeof inbox.source_id !== "string") return "";
  return inbox.source_id;
}

function readConversations(body: unknown): FoundConversation[] {
  const conversations: FoundConversation[] = [];
  for (const item of readPayloadList(body)) {
    if (typeof item.id !== "number" || !Number.isFinite(item.id)) continue;
    const inboxRaw = item.inbox_id;
    if (typeof inboxRaw !== "number" && typeof inboxRaw !== "string") continue;
    conversations.push({
      id: item.id,
      inboxId: String(inboxRaw),
      status: typeof item.status === "string" ? item.status : "",
    });
  }
  return conversations;
}

function pickConversation(conversations: FoundConversation[]): FoundConversation | undefined {
  const rank = (status: string): number => {
    if (status === "open") return 0;
    if (status === "pending") return 1;
    if (status === "snoozed") return 2;
    if (status === "resolved") return 3;
    return 4;
  };
  return [...conversations].sort((left, right) => rank(left.status) - rank(right.status))[0];
}

function individualPhone(chatId: string): string | undefined {
  const match = /^(\d{5,20})@s\.whatsapp\.net$/.exec(chatId);
  return match ? `+${match[1]}` : undefined;
}

function withoutControls(value: string): string {
  return Array.from(value)
    .map((char) => (char.charCodeAt(0) < 32 ? " " : char))
    .join("");
}

function contactName(message: ChatwootInboundMessage): string {
  const phone = individualPhone(message.chatId);
  const raw = message.chatName || message.senderName || phone || message.chatId;
  const cleaned = withoutControls(raw).trim();
  return (cleaned || message.chatId).slice(0, 200);
}

function pinnedConnect(
  hostname: string,
  address: string,
  family: 4 | 6,
  protocol: string,
): ConnectionOptions {
  return {
    lookup: (_lookupHost, options, callback) => {
      if (options.all) {
        callback(null, [{ address, family }]);
        return;
      }
      callback(null, address, family);
    },
    ...(protocol === "https:" && isIP(hostname) === 0 ? { servername: hostname } : {}),
  };
}

async function defaultResolve(hostname: string): Promise<ChatwootDnsRecord[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

async function pinAddress(
  url: URL,
  config: EnabledChatwootConfig,
  resolveDns: (hostname: string) => Promise<ChatwootDnsRecord[]>,
  allowPrivate: boolean,
): Promise<{ address: string; family: 4 | 6 }> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isChatwootMetadataAddress(hostname)) throw new ChatwootRequestError(0);
  const literal = isIP(hostname);
  const records =
    literal === 4 || literal === 6
      ? [{ address: hostname, family: literal }]
      : await resolveDns(hostname);
  const normalized = records.map((record) => ({
    address: record.address,
    family: isIP(record.address),
  }));
  const blocked = normalized.some((record) => {
    if (record.family !== 4 && record.family !== 6) return true;
    if (isChatwootMetadataAddress(record.address)) return true;
    return !allowPrivate && isNonPublicIp(record.address);
  });
  const selected = normalized[0];
  if (blocked || !selected || (selected.family !== 4 && selected.family !== 6)) {
    throw new ChatwootRequestError(0);
  }
  return { address: selected.address, family: selected.family };
}

function endpoint(
  config: EnabledChatwootConfig,
  path: string,
  query?: Record<string, string>,
): URL {
  const base = config.url.endsWith("/") ? config.url : `${config.url}/`;
  const url = new URL(path.replace(/^\//, ""), base);
  if (query) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  }
  return url;
}

/** HTTPS client that refuses metadata addresses and unsolicited private targets. */
export function createChatwootTransport(
  config: EnabledChatwootConfig,
  deps: ChatwootTransportDeps = {},
): ChatwootTransport {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveDns = deps.resolveDns ?? defaultResolve;

  return {
    async request(input) {
      const url = endpoint(config, input.path, input.query);
      const pinned = await pinAddress(url, config, resolveDns, config.allowPrivateUrl);
      const agent = new Agent({
        connect: pinnedConnect(url.hostname, pinned.address, pinned.family, url.protocol),
      });
      try {
        const response = await fetchImpl(url, {
          method: input.method,
          headers: {
            accept: "application/json",
            api_access_token: config.token,
            ...(input.body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
          redirect: "error",
          signal: AbortSignal.timeout(config.timeoutMs),
          dispatcher: agent,
        } as RequestInit & { dispatcher: Agent });
        const text = await response.text();
        let body: unknown = null;
        if (text) {
          try {
            body = JSON.parse(text) as unknown;
          } catch {
            throw new ChatwootRequestError(response.status);
          }
        }
        if (!response.ok) throw new ChatwootRequestError(response.status);
        return { status: response.status, body };
      } catch (error) {
        if (error instanceof ChatwootRequestError) throw error;
        throw new ChatwootRequestError(0);
      } finally {
        await agent.close();
      }
    },
  };
}

function sharesChatwootOrigin(target: URL, config: EnabledChatwootConfig): boolean {
  let base: URL;
  try {
    base = new URL(config.url);
  } catch {
    return false;
  }
  const host = (value: string): string => value.replace(/^\[|\]$/g, "").toLowerCase();
  if (target.protocol !== base.protocol || host(target.hostname) !== host(base.hostname)) {
    return false;
  }
  const port = (url: URL): string => url.port || (url.protocol === "https:" ? "443" : "80");
  return port(target) === port(base);
}

async function readLimitedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new ChatwootAttachmentTooLargeError();
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ChatwootAttachmentTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size,
  );
}

/**
 * Download one URL with the same pinned DNS, metadata block, and redirect refusal
 * as the Chatwoot API client. The API token is sent only to the configured origin.
 */
export async function fetchPinnedResource(
  target: URL,
  config: EnabledChatwootConfig,
  maxBytes: number,
  deps: ChatwootTransportDeps = {},
): Promise<{ data: Buffer; contentType: string | null }> {
  if (target.protocol !== "https:" && !(config.allowHttp && target.protocol === "http:")) {
    throw new ChatwootRequestError(0);
  }
  if (target.username || target.password) throw new ChatwootRequestError(0);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const allowPrivate = config.allowPrivateUrl && sharesChatwootOrigin(target, config);
  const pinned = await pinAddress(target, config, deps.resolveDns ?? defaultResolve, allowPrivate);
  const agent = new Agent({
    connect: pinnedConnect(target.hostname, pinned.address, pinned.family, target.protocol),
  });
  const headers: Record<string, string> = { accept: "*/*" };
  if (sharesChatwootOrigin(target, config)) headers.api_access_token = config.token;
  try {
    const response = await fetchImpl(target, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs),
      dispatcher: agent,
    } as RequestInit & { dispatcher: Agent });
    if (!response.ok) throw new ChatwootRequestError(response.status);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes)
      throw new ChatwootAttachmentTooLargeError();
    const data = await readLimitedResponse(response, maxBytes);
    const rawType = response.headers.get("content-type");
    const contentType = rawType?.split(";")[0]?.trim() || null;
    return { data, contentType };
  } catch (error) {
    if (error instanceof ChatwootRequestError) throw error;
    throw new ChatwootRequestError(0);
  } finally {
    await agent.close();
  }
}

/** Finds or creates the Chatwoot contact and conversation for one WhatsApp chat. */
export class ChatwootClient {
  private readonly conversations = new Map<string, number>();
  private readonly pending = new Map<string, Promise<number>>();

  constructor(
    private readonly config: EnabledChatwootConfig,
    private readonly transport: ChatwootTransport,
  ) {}

  async syncMessage(message: ChatwootInboundMessage): Promise<void> {
    const conversationId = await this.conversationId(message);
    await this.request(
      "POST",
      `/api/v1/accounts/${this.config.accountId}/conversations/${conversationId}/messages`,
      {
        content: message.text,
        message_type: message.isFromMe ? "outgoing" : "incoming",
        private: false,
        source_id: `WAID:${message.messageId}`,
      },
    );
  }

  /**
   * The application API cannot mark an already accepted message as failed.
   * A private note is the supported way to show the agent what did not send.
   */
  async postPrivateNote(conversationId: number, content: string): Promise<void> {
    await this.request(
      "POST",
      `/api/v1/accounts/${this.config.accountId}/conversations/${conversationId}/messages`,
      {
        content: content.slice(0, 10_000),
        message_type: "outgoing",
        private: true,
      },
    );
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<unknown> {
    const response = await this.transport.request({ method, path, body, query });
    return response.body;
  }

  private sourceId(message: ChatwootInboundMessage): string {
    return chatwootSourceId(message.instanceId, message.chatId, this.config.instanceId);
  }

  private async conversationId(message: ChatwootInboundMessage): Promise<number> {
    const key = `${message.instanceId}|${message.chatId}`;
    const cached = this.conversations.get(key);
    if (cached) return cached;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = this.findOrCreateConversation(message)
      .then((id) => {
        this.conversations.set(key, id);
        return id;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }

  private async findOrCreateConversation(message: ChatwootInboundMessage): Promise<number> {
    const sourceId = this.sourceId(message);
    const contactId = await this.ensureContact(message, sourceId);
    const listed = await this.request(
      "GET",
      `/api/v1/accounts/${this.config.accountId}/contacts/${contactId}/conversations`,
    );
    const selected = pickConversation(
      readConversations(listed).filter((item) => item.inboxId === this.config.inboxId),
    );
    if (selected) {
      if (selected.status === "resolved" || selected.status === "snoozed") {
        try {
          await this.request(
            "POST",
            `/api/v1/accounts/${this.config.accountId}/conversations/${selected.id}/toggle_status`,
            { status: "open" },
          );
        } catch (error) {
          logger.warn(
            { err: error, conversationId: selected.id },
            "Chatwoot conversation was not reopened",
          );
        }
      }
      return selected.id;
    }

    const created = await this.request(
      "POST",
      `/api/v1/accounts/${this.config.accountId}/conversations`,
      {
        source_id: sourceId,
        inbox_id: Number(this.config.inboxId),
        contact_id: contactId,
        status: "open",
        additional_attributes: {
          wamcp_instance_id: message.instanceId,
          wamcp_chat_id: message.chatId,
        },
      },
    );
    const id = readId(created);
    if (!id) throw new ChatwootRequestError(0);
    return id;
  }

  private async ensureContact(message: ChatwootInboundMessage, sourceId: string): Promise<number> {
    const existing = await this.findContact(sourceId, message.chatId);
    if (existing) {
      await this.ensureInbox(existing, sourceId);
      return existing.id;
    }

    const phone = individualPhone(message.chatId);
    try {
      const created = await this.request(
        "POST",
        `/api/v1/accounts/${this.config.accountId}/contacts`,
        {
          inbox_id: Number(this.config.inboxId),
          name: contactName(message),
          identifier: sourceId,
          ...(phone ? { phone_number: phone } : {}),
        },
      );
      const id = readId(created);
      if (!id) throw new ChatwootRequestError(0);
      if (readCreatedSourceId(created) !== sourceId) await this.createInbox(id, sourceId);
      return id;
    } catch (error) {
      if (error instanceof ChatwootRequestError && (error.status === 409 || error.status === 422)) {
        const again = await this.findContact(sourceId, message.chatId);
        if (again) {
          await this.ensureInbox(again, sourceId);
          return again.id;
        }
      }
      throw error;
    }
  }

  private async findContact(sourceId: string, chatId: string): Promise<FoundContact | null> {
    const body = await this.request(
      "GET",
      `/api/v1/accounts/${this.config.accountId}/contacts/search`,
      undefined,
      { q: sourceId },
    );
    return (
      readContacts(body).find(
        (contact) =>
          contact.identifier === sourceId ||
          contact.identifier === chatId ||
          contact.sourceIds.includes(sourceId) ||
          contact.sourceIds.includes(chatId),
      ) ?? null
    );
  }

  private async ensureInbox(contact: FoundContact, sourceId: string): Promise<void> {
    if (contact.sourceIds.includes(sourceId)) return;
    await this.createInbox(contact.id, sourceId);
  }

  private async createInbox(contactId: number, sourceId: string): Promise<void> {
    try {
      await this.request(
        "POST",
        `/api/v1/accounts/${this.config.accountId}/contacts/${contactId}/contact_inboxes`,
        { inbox_id: Number(this.config.inboxId), source_id: sourceId },
      );
    } catch (error) {
      if (error instanceof ChatwootRequestError && (error.status === 409 || error.status === 422)) {
        return;
      }
      throw error;
    }
  }
}
