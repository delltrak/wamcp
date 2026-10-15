// ============================================================
// WA MCP — Baileys Channel Adapter
// Full implementation of ChannelAdapter using
// @whiskeysockets/baileys for the WhatsApp Web protocol.
// ============================================================

import makeWASocket, {
  DisconnectReason,
  proto,
  BufferJSON,
  downloadMediaMessage,
  decryptEventResponse,
  makeCacheableSignalKeyStore,
  type WASocket,
  type GroupParticipant as BaileysGroupParticipant,
  type GroupMetadata as BaileysGroupMetadata,
  type WAMessage,
  type BaileysEventMap,
  type AnyMessageContent,
  type MiscMessageGenerationOptions,
  type EventMessageOptions,
  type MinimalMessage,
  type WAMessageKey,
  type CatalogCollection,
  type GetCatalogOptions,
  type NewsletterMetadata,
  type OrderDetails,
  type Product,
  type ProductCreate,
  type ProductUpdate,
  type BinaryNode,
  jidNormalizedUser,
  ALL_WA_PATCH_NAMES,
} from "@whiskeysockets/baileys";
import { randomUUID } from "node:crypto";
import { Boom } from "@hapi/boom";
import type { ChannelAdapter, ChannelEventHandler } from "../channel.interface.js";
import type {
  ConnectionStatus,
  MessageContent,
  MessageResponse,
  GroupResponse,
  NumberExistsResponse,
  BusinessProfile,
  ProfileInfo,
  PrivacySettings,
  PrivacyUpdate,
  Contact,
  ContactResyncResult,
  Chat,
  Message,
  GroupSummary,
  GroupMetadata,
  ChatModification,
  GroupModification,
  ParticipantAction,
  StatusContent,
  StatusSendResult,
  CloudCredentials,
  ChannelEvent,
  ChannelEventPayload,
  NormalizedMessageEvent,
  MessageDeliveryStatus,
  BusinessLabel,
  EventResponse,
  EventResponseUnknownReason,
  EventResponseStatus,
  MessageSearchOptions,
  SendEventOptions,
  NormalizedLabelUpdateEvent,
  CatalogProductCreateInput,
  CatalogProductUpdateInput,
  NewsletterPost,
  NewsletterPostsPage,
} from "../../types/channel.types.js";
import { useSqliteAuthState, clearAuthState } from "./baileys.auth.js";
import { normalizePrivacySettings } from "./privacy.js";
import { getWaVersion } from "./baileys.version.js";
import { decodeEventResponseMessage, eventResponseName } from "./event-response.js";
import { messageTimestampToMilliseconds, messageTimestampToSeconds } from "./message-timestamp.js";
import { db, sqlite } from "../../db/client.js";
import {
  chats as chatsTable,
  messages as messagesTable,
  statusAudiences as statusAudiencesTable,
  labels as labelsTable,
  labelAssociations as labelAssociationsTable,
  eventResponses as eventResponsesTable,
  contacts as contactsTable,
} from "../../db/schema.js";
import { eq, and, desc, asc, ne, inArray, or, sql } from "drizzle-orm";
import { searchStoredMessages } from "../../services/message-search.js";
import {
  normalizeMessagesUpsert,
  normalizeMessagesUpdate,
  normalizeMessagesDelete,
  normalizeMessagesReaction,
  normalizeMessageEdit,
  normalizePresenceUpdate,
  normalizeGroupsUpdate,
  normalizeGroupParticipantsUpdate,
  normalizeContactsUpdate,
  normalizeConnectionUpdate,
  normalizeCallEvent,
  normalizeLidInMessage,
  extractMessageDetails,
  unwrapMessageContent,
  extractQuotedMessageId,
  isMessageForwarded,
  getChatJid,
  getSenderJid,
} from "./baileys.events.js";
import {
  DEFAULT_AUTO_RECONNECT,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  MAX_BASE64_MEDIA_BYTES,
  MEDIA_LIMITS,
} from "../../constants.js";
import { createChildLogger } from "../../utils/logger.js";
import { scheduleBaileysMessagesRead } from "../../services/auto-read.js";
import { QuotedMessageResolutionError } from "../../utils/quoted-message.js";
import { isValidStatusRecipient } from "../../utils/validation.js";
import { normalizeGroupJid } from "../../utils/group-jid.js";
import { MediaService } from "../../services/media.js";
import { resolveFfmpegTimeoutMs, WHATSAPP_VOICE_MIME_TYPE } from "../../tts/audio.js";
import { preparePttAudio } from "../../tts/waveform.js";
import {
  ContactStore,
  type ContactPnResolver,
  type ContactSyncRecord,
} from "../../services/contact-store.js";

const logger = createChildLogger({ service: "baileys-adapter" });
const mediaService = new MediaService();
const DEFAULT_STATUS_MAX_RECIPIENTS = 256;
const STATUS_BROADCAST_JID = "status@broadcast";
const MAX_EVENT_RESPONSE_DECRYPT_ATTEMPTS = 16;
const APP_STATE_WRITES_DISABLED_ERROR =
  "WhatsApp account, server, and app-state writes are disabled because changes can get this linked device removed (see issue #71). Set WA_APP_STATE_WRITES_ENABLED=true to enable at your own risk.";

interface EventResponseJidCandidate {
  jid: string;
  kind: string;
}

interface DecryptedStoredEventResponse {
  eventMessageId: string;
  chatId: string;
  responder: string;
  response: EventResponseStatus;
  timestamp: number | null;
  extraGuestCount: number | null;
}

type StoredEventResponseDecryptResult =
  | { status: "decrypted"; value: DecryptedStoredEventResponse; attemptedCombinations: number }
  | { status: "failed"; attemptedCombinations: number; allCandidatesTried: boolean }
  | { status: "missing" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStoredEventResponseEntry(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return [
    "eventResponseMessageKey",
    "response",
    "eventResponseMessage",
    "event_response_message",
    "eventResponse",
    "event_response",
  ].some((field) => Object.hasOwn(value, field));
}

function isBinaryNode(value: unknown): value is BinaryNode {
  if (!isRecord(value) || typeof value.tag !== "string" || !isRecord(value.attrs)) return false;
  const content = value.content;
  return (
    content === undefined ||
    typeof content === "string" ||
    content instanceof Uint8Array ||
    Array.isArray(content)
  );
}

function binaryNodeChildren(node: BinaryNode, tag?: string): BinaryNode[] {
  if (!Array.isArray(node.content)) return [];
  return node.content.filter(
    (child): child is BinaryNode => isBinaryNode(child) && (tag === undefined || child.tag === tag),
  );
}

function findBinaryNode(node: BinaryNode, tag: string): BinaryNode | undefined {
  if (node.tag === tag) return node;
  for (const child of binaryNodeChildren(node)) {
    const match = findBinaryNode(child, tag);
    if (match) return match;
  }
  return undefined;
}

function findBinaryNodes(node: BinaryNode, tag: string): BinaryNode[] {
  const matches: BinaryNode[] = node.tag === tag ? [node] : [];
  for (const child of binaryNodeChildren(node)) matches.push(...findBinaryNodes(child, tag));
  return matches;
}

function parseNodeInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function decodedNewsletterMessage(content: string | Uint8Array | undefined): {
  type: string | null;
  text: string | null;
} {
  if (content === undefined) return { type: null, text: null };
  try {
    const bytes =
      typeof content === "string" ? Buffer.from(content, "binary") : Buffer.from(content);
    let message = proto.Message.decode(bytes).toJSON() as Record<string, unknown>;
    const wrappers = [
      "ephemeralMessage",
      "viewOnceMessage",
      "viewOnceMessageV2",
      "viewOnceMessageV2Extension",
      "documentWithCaptionMessage",
      "editedMessage",
      "deviceSentMessage",
    ];
    for (let depth = 0; depth < 6; depth++) {
      const wrapper = wrappers.find((key) => isRecord(message[key]));
      if (!wrapper) break;
      const wrapped = message[wrapper] as Record<string, unknown>;
      if (!isRecord(wrapped.message)) break;
      message = wrapped.message;
    }

    const messageKey = Object.keys(message).find((key) => key !== "messageContextInfo");
    if (!messageKey) return { type: null, text: null };

    const messageValue = message[messageKey];
    const typeByProtoField: Record<string, string> = {
      conversation: "text",
      extendedTextMessage: "text",
      imageMessage: "image",
      videoMessage: "video",
      audioMessage: "audio",
      documentMessage: "document",
      stickerMessage: "sticker",
      locationMessage: "location",
      liveLocationMessage: "location",
      contactMessage: "contact",
      contactsArrayMessage: "contact",
      pollCreationMessage: "poll",
      pollCreationMessageV2: "poll",
      pollCreationMessageV3: "poll",
      reactionMessage: "reaction",
      eventMessage: "event",
    };
    const type = typeByProtoField[messageKey] ?? messageKey;
    if (typeof messageValue === "string") return { type, text: messageValue };
    if (isRecord(messageValue)) {
      const text =
        typeof messageValue.text === "string"
          ? messageValue.text
          : typeof messageValue.caption === "string"
            ? messageValue.caption
            : null;
      return { type, text };
    }
    return { type, text: null };
  } catch {
    return { type: null, text: null };
  }
}

function parseNewsletterPost(node: BinaryNode): NewsletterPost | null {
  const serverId = node.attrs.server_id ?? node.attrs.message_id ?? node.attrs.id;
  if (!serverId) return null;

  const plaintext = findBinaryNode(node, "plaintext");
  const decoded = decodedNewsletterMessage(
    typeof plaintext?.content === "string" || plaintext?.content instanceof Uint8Array
      ? plaintext.content
      : undefined,
  );
  const viewsNode = binaryNodeChildren(node, "views_count")[0];
  const reactionsNode = binaryNodeChildren(node, "reactions")[0];
  const reactions = reactionsNode
    ? binaryNodeChildren(reactionsNode, "reaction").map((reaction) => ({
        code: reaction.attrs.code ?? "",
        count: parseNodeInteger(reaction.attrs.count) ?? 0,
      }))
    : [];

  return {
    id: node.attrs.id ?? node.attrs.message_id ?? serverId,
    serverId,
    timestamp: parseNodeInteger(node.attrs.t ?? node.attrs.timestamp),
    type: decoded.type ?? node.attrs.type ?? null,
    text: decoded.text,
    views: parseNodeInteger(viewsNode?.attrs.count ?? node.attrs.views),
    reactions,
  };
}

function parseNewsletterMessagesResponse(response: BinaryNode): NewsletterPostsPage {
  const messagesNode = findBinaryNode(response, "messages");
  const messages = messagesNode ? findBinaryNodes(messagesNode, "message") : [];
  const posts = messages.flatMap((node) => {
    const post = parseNewsletterPost(node);
    return post ? [post] : [];
  });
  const postsWithTimestamp = posts.filter((post) => post.timestamp !== null);
  const oldest = postsWithTimestamp.length
    ? postsWithTimestamp.reduce((candidate, post) =>
        post.timestamp! < candidate.timestamp! ? post : candidate,
      )
    : posts[0];
  const newest = postsWithTimestamp.length
    ? postsWithTimestamp.reduce((candidate, post) =>
        post.timestamp! > candidate.timestamp! ? post : candidate,
      )
    : posts.at(-1);
  const after = newest ? parseNodeInteger(newest.serverId) : null;

  return {
    posts,
    pagination: {
      oldestServerId: oldest?.serverId ?? null,
      newestServerId: newest?.serverId ?? null,
      after,
    },
  };
}

function sizeLabel(maxBytes: number): string {
  return maxBytes < 1024 * 1024 ? `${maxBytes} bytes` : `${Math.round(maxBytes / 1024 / 1024)} MB`;
}

function isContactEligibleChatNameJid(jid: string): boolean {
  const normalizedJid = jid.toLowerCase();
  const server = normalizedJid.slice(normalizedJid.lastIndexOf("@") + 1);
  return (
    normalizedJid !== STATUS_BROADCAST_JID &&
    server !== "g.us" &&
    server !== "broadcast" &&
    server !== "newsletter"
  );
}

function groupPictureFailure(error: unknown, operation: "update" | "remove"): Error {
  const errorObject =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined;
  const output = errorObject?.output;
  const statusCode =
    typeof output === "object" && output !== null && "statusCode" in output
      ? (output as Record<string, unknown>).statusCode
      : errorObject?.statusCode;
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();

  if (
    statusCode === 404 ||
    /item-not-found|group (?:was )?not found|group does not exist/.test(lowered)
  ) {
    return new Error("Group not found");
  }
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /not-authorized|not authorized|not an admin|admin permission|forbidden/.test(lowered)
  ) {
    return new Error(`Only a group admin can ${operation} this group's picture`);
  }
  return error instanceof Error ? error : new Error(message);
}

function parseBooleanEnv(value: string | undefined, key: string, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value.trim().toLowerCase() === "true") return true;
  if (value.trim().toLowerCase() === "false") return false;
  throw new Error(`Invalid ${key}; expected true or false`);
}

function parsePositiveIntegerEnv(value: string | undefined, key: string, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`Invalid ${key}; expected a positive integer`);
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${key}; expected a positive integer`);
  }
  return parsed;
}

function serializeIncomingMessage(message?: WAMessage): string | null {
  if (!message) return null;
  // Keep the complete proto message: event and poll decryption need messageContextInfo.messageSecret.
  return JSON.stringify(
    {
      key: message.key,
      message: message.message,
      messageTimestamp: message.messageTimestamp,
    } as WAMessage,
    BufferJSON.replacer,
  );
}

function serializeWAMessage(message?: WAMessage): string | null {
  if (!message) return null;
  return JSON.stringify(message, BufferJSON.replacer);
}

function hasMeaningfulValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return value;
  if (value instanceof Uint8Array) return value.byteLength > 0;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (typeof value !== "object" || value === null) return false;

  return Object.entries(value).some(
    ([key, nested]) =>
      key !== "contextInfo" &&
      key !== "messageContextInfo" &&
      key !== "senderKeyDistributionMessage" &&
      hasMeaningfulValue(nested),
  );
}

function hasStoredContentField(content: Record<string, unknown>): boolean {
  return Object.entries(content).some(([key, value]) => {
    if (
      key === "senderKeyDistributionMessage" ||
      key === "messageContextInfo" ||
      key === "contextInfo"
    ) {
      return false;
    }
    return value !== null && value !== undefined;
  });
}

function findNestedField(value: unknown, field: string): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || value instanceof Uint8Array) return undefined;
  if (Array.isArray(value)) {
    for (const nested of value) {
      const match = findNestedField(nested, field);
      if (match) return match;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const candidate = record[field];
  if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
    return candidate as Record<string, unknown>;
  }

  for (const [key, nested] of Object.entries(record)) {
    if (
      key === "contextInfo" ||
      key === "messageContextInfo" ||
      key === "senderKeyDistributionMessage"
    ) {
      continue;
    }
    const match = findNestedField(nested, field);
    if (match) return match;
  }
  return undefined;
}

function hasForwardableContent(message: WAMessage, allowEmptyStoredProto = false): boolean {
  const content = unwrapMessageContent(message.message);
  if (!content) return false;

  const mediaFields: Record<string, string> = {
    image: "imageMessage",
    video: "videoMessage",
    audio: "audioMessage",
    document: "documentMessage",
    sticker: "stickerMessage",
  };
  const mediaField = mediaFields[extractMessageDetails(message).type];
  if (mediaField) {
    const media = findNestedField(content, mediaField);
    const mediaKey = media?.mediaKey;
    const hasMediaKey =
      (typeof mediaKey === "string" && mediaKey.trim().length > 0) ||
      (mediaKey instanceof Uint8Array && mediaKey.byteLength > 0);
    const hasMediaReference = [media?.url, media?.directPath, media?.handle].some(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
    return hasMediaKey && hasMediaReference;
  }

  if (typeof content.conversation === "string" && content.conversation.trim()) return true;
  if ("extendedTextMessage" in content) {
    const extendedText = content.extendedTextMessage;
    return (
      typeof extendedText === "object" &&
      extendedText !== null &&
      typeof (extendedText as { text?: unknown }).text === "string" &&
      (extendedText as { text: string }).text.trim().length > 0
    );
  }

  return (
    Object.entries(content).some(
      ([key, value]) =>
        key !== "senderKeyDistributionMessage" &&
        key !== "messageContextInfo" &&
        key !== "contextInfo" &&
        hasMeaningfulValue(value),
    ) ||
    (allowEmptyStoredProto && hasStoredContentField(content))
  );
}

interface HistoryFetchWaiter {
  chatId: string;
  requested: number;
  stored: number;
  peerDataRequestSessionId?: string;
  receivedMatchingHistorySet: boolean;
  seenMessageIds: Set<string>;
  resolve: (result: { requested: number; stored: number; timedOut: boolean }) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

function businessLabelsUnsupported(): Error {
  return new Error(
    "WhatsApp Business labels require a Business account and Baileys label support; this account or operation is unsupported.",
  );
}

function labelOperationError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/not supported|unsupported|business account|business labels?/i.test(message)) {
    return businessLabelsUnsupported();
  }
  return error instanceof Error ? error : new Error(message);
}

export class BaileysAdapter implements ChannelAdapter {
  private sock: WASocket | null = null;
  private readonly contactStore: ContactStore;
  private status: ConnectionStatus = "disconnected";
  private qrCode: string | null = null;
  private pairingPhone: string | null = null;
  private pairingCodeValue: string | null = null;
  private pairingCodeResolver: ((code: string | null) => void) | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private saveCreds: (() => Promise<void>) | null = null;
  private authMeId: string | undefined;
  private authMeLid: string | undefined;

  private readonly autoReconnect: boolean;
  private readonly appStateWritesEnabled: boolean;
  private readonly markOnlineOnConnect: boolean;
  private readonly maxStatusRecipients: number;
  private readonly listeners = new Map<ChannelEvent, Set<ChannelEventHandler<ChannelEvent>>>();
  private pendingSocketEventProcessing: Promise<void> = Promise.resolve();
  private activeHistoryFetch: HistoryFetchWaiter | null = null;

  constructor(
    private readonly instanceId: string,
    contactStore?: ContactStore,
  ) {
    this.contactStore = contactStore ?? new ContactStore(instanceId, db);
    this.autoReconnect = process.env.WA_AUTO_RECONNECT !== "false" && DEFAULT_AUTO_RECONNECT;
    this.appStateWritesEnabled = parseBooleanEnv(
      process.env.WA_APP_STATE_WRITES_ENABLED,
      "WA_APP_STATE_WRITES_ENABLED",
      false,
    );
    this.markOnlineOnConnect = parseBooleanEnv(
      process.env.WA_MARK_ONLINE_ON_CONNECT,
      "WA_MARK_ONLINE_ON_CONNECT",
      false,
    );
    this.maxStatusRecipients = parsePositiveIntegerEnv(
      process.env.WA_STATUS_MAX_RECIPIENTS,
      "WA_STATUS_MAX_RECIPIENTS",
      DEFAULT_STATUS_MAX_RECIPIENTS,
    );
  }

  // ---- Private helpers ----

  private requireAppStateWritesEnabled(): void {
    if (!this.appStateWritesEnabled) throw new Error(APP_STATE_WRITES_DISABLED_ERROR);
  }

  private getSock(): WASocket {
    if (!this.sock || this.status !== "connected") {
      throw new Error("Instance not connected");
    }
    return this.sock;
  }

  private normalizeJid(input: string): string {
    if (input.includes("@")) return input;
    const cleaned = input.replace(/[^0-9]/g, "");
    return `${cleaned}@s.whatsapp.net`;
  }

  private normalizeStatusRecipient(input: string): string | null {
    const value = input.trim();
    if (!isValidStatusRecipient(value)) return null;

    const jid = value.includes("@")
      ? jidNormalizedUser(value)
      : jidNormalizedUser(`${value.replace(/[^0-9]/g, "")}@s.whatsapp.net`);
    return jid && isValidStatusRecipient(jid) ? jid : null;
  }

  private resolveStatusAudience(
    sock: WASocket,
    requestedJids?: string[],
  ): { statusJidList: string[]; omittedRecipientCount: number; warning?: string } {
    const recipients: string[] = [];
    const seen = new Set<string>();
    const addRecipient = (input: string, explicit: boolean): void => {
      const jid = this.normalizeStatusRecipient(input);
      if (!jid) {
        if (explicit) {
          throw new Error(
            `Invalid status recipient '${input}'; expected an individual WhatsApp phone number or JID`,
          );
        }
        return;
      }
      if (seen.has(jid)) return;
      seen.add(jid);
      recipients.push(jid);
    };

    const ownJid = sock.user?.id ? this.normalizeStatusRecipient(sock.user.id) : null;
    if (ownJid) addRecipient(ownJid, false);

    const audienceJids =
      requestedJids ?? this.contactStore.getContacts().map((contact) => contact.jid);
    for (const jid of audienceJids) addRecipient(jid, requestedJids !== undefined);

    if (recipients.length === 0) {
      throw new Error(
        "Cannot send status: the audience is empty. Connect the account or provide at least one individual phone number or JID.",
      );
    }

    const statusJidList = recipients.slice(0, this.maxStatusRecipients);
    const omittedRecipientCount = recipients.length - statusJidList.length;
    const warning =
      omittedRecipientCount > 0
        ? `Status audience exceeded WA_STATUS_MAX_RECIPIENTS (${this.maxStatusRecipients}); the list was truncated and ${omittedRecipientCount} recipient(s) were omitted.`
        : undefined;
    if (warning) {
      logger.warn(
        {
          instanceId: this.instanceId,
          maxRecipients: this.maxStatusRecipients,
          recipientCount: statusJidList.length,
          omittedRecipientCount,
        },
        "Status recipient list truncated to configured cap",
      );
    }

    return { statusJidList, omittedRecipientCount, warning };
  }

  private reuseStoredStatusAudience(sock: WASocket, storedJids: string[]): string[] {
    const statusJidList: string[] = [];
    const seen = new Set<string>();
    const addRecipient = (jid: string): void => {
      const normalized = this.normalizeStatusRecipient(jid);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      statusJidList.push(jid);
    };

    const ownJid = sock.user?.id ? this.normalizeStatusRecipient(sock.user.id) : null;
    if (ownJid) addRecipient(ownJid);
    for (const jid of storedJids) addRecipient(jid);

    if (statusJidList.length === 0) {
      throw new Error(
        "Cannot revoke status: the saved audience is empty and the account JID is unavailable.",
      );
    }
    return statusJidList;
  }

  /** Resolve a PN JID from a LID using the signal repository mapping */
  async resolvePn(lidOrPn: string): Promise<string> {
    if (!lidOrPn.endsWith("@lid") || !this.sock) return lidOrPn;
    const pn = await this.sock.signalRepository.lidMapping.getPNForLID(lidOrPn);
    return pn ?? lidOrPn;
  }

  private resolveMedia(input: string): { url: string } | Buffer {
    if (input.startsWith("https://")) {
      return { url: input };
    }
    if (input.startsWith("http://")) {
      throw new Error("Media URLs must use HTTPS");
    }
    if (input.startsWith("file://") || input.startsWith("data:")) {
      throw new Error("file:// and data: URLs are not allowed");
    }
    return Buffer.from(input, "base64");
  }

  private generateVCard(name: string, phone: string): string {
    const cleaned = phone.replace(/[^0-9]/g, "");
    return [
      "BEGIN:VCARD",
      "VERSION:3.0",
      `FN:${name}`,
      `TEL;type=CELL;waid=${cleaned}:+${cleaned}`,
      "END:VCARD",
    ].join("\n");
  }

  private getQuotedMessage(remoteJid: string, messageId: string): WAMessage {
    const row = db
      .select({
        id: messagesTable.id,
        chatId: messagesTable.chatId,
        senderId: messagesTable.senderId,
        type: messagesTable.type,
        content: messagesTable.content,
        isFromMe: messagesTable.isFromMe,
        timestamp: messagesTable.timestamp,
        rawData: messagesTable.rawData,
      })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.instanceId, this.instanceId),
          eq(messagesTable.chatId, remoteJid),
          eq(messagesTable.id, messageId),
        ),
      )
      .get();

    if (!row) {
      throw new QuotedMessageResolutionError(
        `Quoted message '${messageId}' could not be resolved in chat '${remoteJid}'. It may be unavailable or belong to a different chat.`,
      );
    }

    let storedMessage: WAMessage | undefined;
    if (row.rawData) {
      try {
        storedMessage = JSON.parse(row.rawData, BufferJSON.reviver) as WAMessage;
      } catch {
        // The normalized fields below still provide a usable quote when raw data is malformed.
      }
    }

    const isGroup = row.chatId.endsWith("@g.us");
    const fromMe = row.isFromMe === 1;
    const participant = isGroup
      ? row.senderId === "me"
        ? (storedMessage?.key?.participant ?? this.sock?.user?.id)
        : row.senderId
      : undefined;

    if (isGroup && !participant) {
      throw new QuotedMessageResolutionError(
        `Quoted message '${messageId}' in group '${remoteJid}' is missing its participant information.`,
      );
    }

    const storedContent = storedMessage?.message;
    const hasStoredContent =
      storedContent &&
      Object.keys(storedContent).some(
        (key) =>
          key === "conversation" ||
          (key.includes("Message") && key !== "senderKeyDistributionMessage"),
      );

    return {
      ...storedMessage,
      key: {
        ...storedMessage?.key,
        remoteJid: row.chatId,
        id: row.id,
        fromMe,
        ...(participant ? { participant } : {}),
      },
      message: hasStoredContent
        ? storedContent
        : this.buildStoredMessageContent(row.type, row.content),
      messageTimestamp: storedMessage?.messageTimestamp ?? row.timestamp,
    };
  }

  private buildStoredMessageContent(
    type: Message["type"],
    content: string | null,
  ): NonNullable<WAMessage["message"]> {
    switch (type) {
      case "text":
        return { conversation: content ?? "" };
      case "image":
        return { imageMessage: content === null ? {} : { caption: content } };
      case "video":
        return { videoMessage: content === null ? {} : { caption: content } };
      case "audio":
        return { audioMessage: {} };
      case "document":
        return { documentMessage: content === null ? {} : { caption: content } };
      case "location":
        return { locationMessage: {} };
      case "contact":
        return { contactMessage: content === null ? {} : { displayName: content } };
      case "poll":
        return { pollCreationMessage: content === null ? {} : { name: content } };
      case "reaction":
        return { reactionMessage: content === null ? {} : { text: content } };
      case "sticker":
        return { stickerMessage: {} };
      case "event":
        return { eventMessage: content === null ? {} : { name: content } };
    }
  }

  validateQuotedMessage(to: string, messageId: string): void {
    this.getQuotedMessage(this.normalizeJid(to), messageId);
  }

  private getMeJid(): string {
    const meJid = this.sock?.user?.id;
    if (!meJid) throw new Error("Not authenticated");
    return meJid;
  }

  // ---- Lifecycle ----

  async connect(): Promise<void> {
    if (this.sock) {
      logger.warn({ instanceId: this.instanceId }, "Already connected or connecting");
      return;
    }

    this.status = "connecting";

    const { state, saveCreds } = await useSqliteAuthState(this.instanceId);
    this.saveCreds = saveCreds;
    this.authMeId = state.creds.me?.id;
    this.authMeLid = state.creds.me?.lid;

    const { version } = await getWaVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger: logger.child({ instanceId: this.instanceId }),
      generateHighQualityLinkPreview: true,
      syncFullHistory: true,
      markOnlineOnConnect: this.markOnlineOnConnect,
      getMessage: async (key: WAMessageKey): Promise<proto.IMessage | undefined> => {
        if (!key.id) return undefined;
        const conditions = [
          eq(messagesTable.instanceId, this.instanceId),
          eq(messagesTable.id, key.id),
        ];
        const remoteJids = new Set<string>();
        for (const jid of [key.remoteJid, key.remoteJidAlt]) {
          if (!jid) continue;
          remoteJids.add(jidNormalizedUser(jid));
          remoteJids.add(await this.resolveJidToPn(jid));
        }
        if (remoteJids.size > 0) {
          conditions.push(inArray(messagesTable.chatId, [...remoteJids]));
        }
        const row = db
          .select({ rawData: messagesTable.rawData })
          .from(messagesTable)
          .where(and(...conditions))
          .get();
        if (!row?.rawData) return undefined;

        try {
          const stored = JSON.parse(row.rawData, BufferJSON.reviver) as WAMessage;
          return stored.message ?? undefined;
        } catch {
          return undefined;
        }
      },
    });

    this.sock = sock;
    this.bindEvents(sock);
  }

  async disconnect(): Promise<void> {
    this.clearReconnectTimer();
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.status = "disconnected";
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  // ---- Authentication ----

  async getQrCode(): Promise<string | null> {
    return this.qrCode;
  }

  async getPairingCode(phone: string): Promise<string | null> {
    if (this.status === "disconnected" || !this.sock) {
      throw new Error("Instance not connected");
    }

    // Already have the code cached
    if (this.pairingCodeValue) {
      return this.pairingCodeValue;
    }

    // QR event already fired before this call — request pairing code immediately
    if (this.qrCode && this.sock) {
      await new Promise((r) => setTimeout(r, 1000));
      const code = await this.sock.requestPairingCode(phone);
      this.pairingCodeValue = code ?? null;
      return this.pairingCodeValue;
    }

    // QR event hasn't fired yet — register phone and wait for it (30s timeout)
    this.pairingPhone = phone;
    return new Promise<string | null>((resolve, reject) => {
      this.pairingCodeResolver = resolve;
      setTimeout(() => {
        this.pairingCodeResolver = null;
        reject(new Error("Pairing code timeout — QR event did not fire within 30s"));
      }, 30000);
    });
  }

  async setCredentials(_creds: CloudCredentials): Promise<void> {
    throw new Error("setCredentials is only available for Cloud API instances");
  }

  // ---- Messaging ----

  async sendMessage(to: string, content: MessageContent): Promise<MessageResponse> {
    const sock = this.getSock();
    const jid = this.normalizeJid(to);
    let msg: AnyMessageContent;
    const opts: MiscMessageGenerationOptions = {};

    switch (content.type) {
      case "text":
        msg = { text: content.text };
        if (content.quotedMessageId) {
          opts.quoted = this.getQuotedMessage(jid, content.quotedMessageId);
        }
        break;
      case "image":
        msg = { image: this.resolveMedia(content.image), caption: content.caption };
        if (content.quotedMessageId) {
          opts.quoted = this.getQuotedMessage(jid, content.quotedMessageId);
        }
        break;
      case "video":
        msg = {
          video: this.resolveMedia(content.video),
          caption: content.caption,
          ...(content.gifPlayback ? { gifPlayback: true } : {}),
          ...(content.ptv ? { ptv: true } : {}),
        };
        if (content.quotedMessageId) {
          opts.quoted = this.getQuotedMessage(jid, content.quotedMessageId);
        }
        break;
      case "sticker":
        msg = { sticker: this.resolveMedia(content.sticker) };
        if (content.quotedMessageId) {
          opts.quoted = this.getQuotedMessage(jid, content.quotedMessageId);
        }
        break;
      case "audio":
        if (content.ptt) {
          const fallback = {
            audio: this.resolveMedia(content.audio),
            ptt: true,
            mimetype: content.mimeType ?? WHATSAPP_VOICE_MIME_TYPE,
          };
          try {
            const source = await mediaService.getMediaBuffer(content.audio, {
              maxBytes: MAX_BASE64_MEDIA_BYTES,
              timeoutMs: resolveFfmpegTimeoutMs(process.env.WA_TTS_TIMEOUT_MS),
            });
            const prepared = await preparePttAudio(source, content.mimeType);
            if (prepared.seconds === undefined || prepared.waveform === undefined) {
              logger.warn(
                { instanceId: this.instanceId },
                "PTT waveform or duration unavailable; sending audio without metadata",
              );
            }
            const audioMessage: {
              audio: Buffer;
              ptt: true;
              mimetype: string;
              seconds?: number;
              waveform?: Uint8Array;
            } = {
              audio: prepared.audio,
              ptt: true,
              mimetype: prepared.mimeType,
              ...(prepared.seconds !== undefined ? { seconds: prepared.seconds } : {}),
              ...(prepared.waveform !== undefined ? { waveform: prepared.waveform } : {}),
            };
            msg = audioMessage;
          } catch {
            logger.warn(
              { instanceId: this.instanceId },
              "PTT audio preparation failed; sending audio without waveform or duration",
            );
            msg = fallback;
          }
        } else {
          msg = {
            audio: this.resolveMedia(content.audio),
            ptt: false,
            mimetype: content.mimeType ?? WHATSAPP_VOICE_MIME_TYPE,
          };
        }
        if (content.quotedMessageId) {
          opts.quoted = this.getQuotedMessage(jid, content.quotedMessageId);
        }
        break;
      case "document":
        msg = {
          document: this.resolveMedia(content.document),
          fileName: content.fileName,
          mimetype: content.mimeType,
        };
        break;
      case "location":
        msg = {
          location: {
            degreesLatitude: content.latitude,
            degreesLongitude: content.longitude,
            name: content.name,
            address: content.address,
          },
        };
        break;
      case "contact":
        msg = {
          contacts: {
            displayName: content.contactName,
            contacts: [{ vcard: this.generateVCard(content.contactName, content.contactPhone) }],
          },
        };
        break;
      case "poll":
        msg = {
          poll: {
            name: content.question,
            values: content.options,
            selectableCount: content.multiSelect ? 0 : 1,
          },
        };
        break;
      case "reaction":
        throw new Error("Use sendReaction() for reactions");
      default:
        throw new Error(`Unsupported message type: ${(content as MessageContent).type}`);
    }

    const result = await sock.sendMessage(jid, msg, opts);
    this.persistOutgoingMessage(result, jid);
    return { messageId: result?.key.id ?? "", timestamp: Date.now(), status: "sent" };
  }

  async sendEvent(options: SendEventOptions): Promise<MessageResponse> {
    const sock = this.getSock();
    const jid = this.normalizeJid(options.to);
    const startDate = new Date(options.start);
    const endDate = options.end ? new Date(options.end) : undefined;
    if (Number.isNaN(startDate.getTime()) || (endDate && Number.isNaN(endDate.getTime()))) {
      throw new Error("Event start and end must be valid ISO datetimes");
    }

    const event: EventMessageOptions = {
      name: options.name,
      ...(options.description ? { description: options.description } : {}),
      startDate,
      ...(endDate ? { endDate } : {}),
      ...(options.locationText
        ? { location: { name: options.locationText, address: options.locationText } }
        : {}),
      ...(options.callType ? { call: options.callType === "voice" ? "audio" : "video" } : {}),
    };
    const sendOptions: MiscMessageGenerationOptions = {};
    if (options.quotedMessageId) {
      sendOptions.quoted = this.getQuotedMessage(jid, options.quotedMessageId);
    }

    const result = await sock.sendMessage(jid, { event }, sendOptions);
    if (result) {
      this.persistSourceMessage(result);
      if (result.key.id) await this.retryPendingEventResponses(result.key.id);
    }
    return {
      messageId: result?.key.id ?? "",
      timestamp: Date.now(),
      status: "sent",
    };
  }

  async getEventResponses(chatId: string, eventMessageId: string): Promise<EventResponse[]> {
    const jid = jidNormalizedUser(this.normalizeJid(chatId));
    const chatAliases = new Set([jid, await this.resolveJidToPn(jid)]);
    const eventMessage = db
      .select({ chatId: messagesTable.chatId, rawData: messagesTable.rawData })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.instanceId, this.instanceId),
          eq(messagesTable.id, eventMessageId),
          eq(messagesTable.type, "event"),
        ),
      )
      .get();

    if (eventMessage) {
      const eventChatAliases = new Set([
        eventMessage.chatId,
        await this.resolveJidToPn(eventMessage.chatId),
      ]);
      if (eventMessage.rawData) {
        try {
          const stored = JSON.parse(eventMessage.rawData, BufferJSON.reviver) as WAMessage;
          const key = stored.key;
          for (const keyJid of [key.remoteJid, key.remoteJidAlt]) {
            if (!keyJid) continue;
            eventChatAliases.add(keyJid);
            eventChatAliases.add(await this.resolveJidToPn(keyJid));
          }
        } catch {
          // The normalized row chat ID remains sufficient if raw proto data is malformed.
        }
      }

      if (![...chatAliases].some((alias) => eventChatAliases.has(alias))) return [];
      for (const alias of eventChatAliases) chatAliases.add(alias);
    }

    // Retry by event ID so stored rows under either LID or PN chat aliases are included.
    await this.retryPendingEventResponses(eventMessageId);

    const rows = db
      .select()
      .from(eventResponsesTable)
      .where(
        and(
          eq(eventResponsesTable.instanceId, this.instanceId),
          eq(eventResponsesTable.eventMessageId, eventMessageId),
          inArray(eventResponsesTable.chatId, [...chatAliases]),
        ),
      )
      .orderBy(asc(eventResponsesTable.timestamp), asc(eventResponsesTable.responder))
      .all();

    return Promise.all(
      rows.map(async (row) => {
        const participant = await this.resolveJidToPn(row.responder);
        const contact = db
          .select({ phone: contactsTable.phone })
          .from(contactsTable)
          .where(
            and(
              eq(contactsTable.instanceId, this.instanceId),
              or(eq(contactsTable.jid, row.responder), eq(contactsTable.lid, row.responder)),
            ),
          )
          .get();
        const phone =
          contact?.phone ??
          (participant.endsWith("@s.whatsapp.net") ? participant.slice(0, -15) : undefined);
        const status = eventResponseName(row.response);
        const unknownDetails =
          status === "UNKNOWN" ? await this.getUnknownEventResponseDetails(row) : {};
        return {
          participant,
          responder: participant,
          ...(phone ? { phone } : {}),
          status,
          response: status,
          timestamp: row.timestamp,
          messageId: row.responseMessageId,
          ...(row.extraGuestCount === null ? {} : { extraGuestCount: row.extraGuestCount }),
          ...unknownDetails,
        };
      }),
    );
  }

  async starMessage(chatId: string, messageId: string, star: boolean): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const jid = this.normalizeJid(chatId);
    const stored = db
      .select({ fromMe: messagesTable.isFromMe })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.instanceId, this.instanceId),
          eq(messagesTable.chatId, jid),
          eq(messagesTable.id, messageId),
        ),
      )
      .get();
    if (!stored) throw new Error(`Message '${messageId}' was not found in chat '${jid}'`);

    await sock.chatModify(
      { star: { messages: [{ id: messageId, fromMe: stored.fromMe === 1 }], star } },
      jid,
    );
    db.update(messagesTable)
      .set({ starred: star ? 1 : 0 })
      .where(
        and(
          eq(messagesTable.instanceId, this.instanceId),
          eq(messagesTable.chatId, jid),
          eq(messagesTable.id, messageId),
        ),
      )
      .run();
  }

  private persistOutgoingMessage(result: WAMessage | undefined, jid: string): void {
    const outgoingId = result?.key.id;
    if (!result?.message || !outgoingId) return;

    const outgoing: WAMessage = {
      ...result,
      key: {
        ...result.key,
        remoteJid: result.key.remoteJid ?? jid,
        fromMe: true,
      },
    };
    const details = extractMessageDetails(outgoing);
    this.persistMessage(
      {
        instanceId: this.instanceId,
        chatId: outgoing.key.remoteJid ?? jid,
        message: {
          id: outgoingId,
          sender: "me",
          timestamp: messageTimestampToSeconds(
            outgoing.messageTimestamp,
            Math.floor(Date.now() / 1000),
          ),
          type: details.type,
          content: details.content,
          mediaUrl: details.mediaUrl,
          ...(details.mediaMimetype ? { mediaMimetype: details.mediaMimetype } : {}),
          quotedMessageId: extractQuotedMessageId(outgoing),
          isFromMe: true,
          isForwarded: isMessageForwarded(outgoing),
        },
      },
      outgoing,
      true,
    );
  }

  async editMessage(chatId: string, msgId: string, newText: string): Promise<void> {
    const sock = this.getSock();
    const jid = this.normalizeJid(chatId);
    await sock.sendMessage(jid, {
      text: newText,
      edit: { remoteJid: jid, id: msgId, fromMe: true },
    } as AnyMessageContent);
  }

  async deleteMessage(chatId: string, msgId: string, requestedJids?: string[]): Promise<void> {
    const sock = this.getSock();
    const jid = this.normalizeJid(chatId);
    const storedMessage = db
      .select({ chatId: messagesTable.chatId, isFromMe: messagesTable.isFromMe })
      .from(messagesTable)
      .where(and(eq(messagesTable.instanceId, this.instanceId), eq(messagesTable.id, msgId)))
      .get();
    if (storedMessage && (storedMessage.isFromMe !== 1 || storedMessage.chatId !== jid)) {
      throw new Error(
        `Cannot revoke message '${msgId}': the stored message is not an outgoing message in chat '${jid}'.`,
      );
    }

    if (jid === STATUS_BROADCAST_JID) {
      const storedJids =
        requestedJids === undefined ? this.getStoredStatusAudience(msgId) : undefined;
      const statusJidList =
        requestedJids !== undefined
          ? this.resolveStatusAudience(sock, requestedJids).statusJidList
          : storedJids !== undefined
            ? this.reuseStoredStatusAudience(sock, storedJids)
            : this.resolveStatusAudience(sock).statusJidList;
      await sock.sendMessage(
        jid,
        { delete: { remoteJid: jid, id: msgId, fromMe: true } },
        { statusJidList },
      );
    } else {
      await sock.sendMessage(jid, {
        delete: { remoteJid: jid, id: msgId, fromMe: true },
      });
    }
    this.updateMessageStatus(msgId, "revoked", jid, 1);
  }

  async forwardMessage(to: string, msgId: string, fromChat: string): Promise<MessageResponse> {
    const sock = this.getSock();
    const toJid = this.normalizeJid(to);
    const fromJid = this.normalizeJid(fromChat);
    const row = db
      .select({
        id: messagesTable.id,
        chatId: messagesTable.chatId,
        type: messagesTable.type,
        content: messagesTable.content,
        isFromMe: messagesTable.isFromMe,
        timestamp: messagesTable.timestamp,
        rawData: messagesTable.rawData,
      })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.instanceId, this.instanceId),
          eq(messagesTable.chatId, fromJid),
          eq(messagesTable.id, msgId),
        ),
      )
      .get();

    if (!row) {
      throw new Error(`Message '${msgId}' was not found in chat '${fromJid}'`);
    }

    let sourceMessage: WAMessage | undefined;
    if (row.rawData) {
      try {
        const parsed: unknown = JSON.parse(row.rawData, BufferJSON.reviver);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          sourceMessage = parsed as WAMessage;
        }
      } catch {
        // Older or malformed rows can still use the normalized text fallback below.
      }
    }

    const hasStoredFullOriginal = sourceMessage !== undefined;
    if (!hasForwardableContent(sourceMessage ?? ({} as WAMessage), hasStoredFullOriginal)) {
      if (row.type === "text" && typeof row.content === "string" && row.content.trim()) {
        sourceMessage = {
          ...sourceMessage,
          key: {
            ...sourceMessage?.key,
            remoteJid: row.chatId,
            id: row.id,
            fromMe: row.isFromMe === 1,
          },
          message: { conversation: row.content },
          messageTimestamp: row.timestamp,
        } as WAMessage;
      } else {
        throw new Error(
          `Message '${msgId}' cannot be forwarded because its full content is unavailable`,
        );
      }
    }

    const fullMessage: WAMessage = {
      ...sourceMessage,
      key: {
        ...sourceMessage?.key,
        remoteJid: row.chatId,
        id: row.id,
        fromMe: row.isFromMe === 1,
      },
    } as WAMessage;

    if (!hasForwardableContent(fullMessage, hasStoredFullOriginal)) {
      throw new Error(
        `Message '${msgId}' cannot be forwarded because its full content is unavailable`,
      );
    }

    const result = await sock.sendMessage(toJid, { forward: fullMessage });
    this.persistOutgoingMessage(result, toJid);
    return { messageId: result?.key.id ?? "", timestamp: Date.now(), status: "sent" };
  }

  async sendReaction(chatId: string, msgId: string, emoji: string): Promise<void> {
    const sock = this.getSock();
    const jid = this.normalizeJid(chatId);
    await sock.sendMessage(jid, {
      react: { text: emoji, key: { remoteJid: jid, id: msgId } },
    });
  }

  async pinMessage(chatId: string, msgId: string, pin: boolean): Promise<void> {
    const sock = this.getSock();
    const jid = this.normalizeJid(chatId);
    const pinMsg = {
      pin: { remoteJid: jid, id: msgId, fromMe: true },
      type: pin ? 1 : 0,
      time: pin ? 604800 : undefined,
    };
    await sock.sendMessage(jid, pinMsg as unknown as AnyMessageContent);
  }

  async sendViewOnce(to: string, media: string, type: "image" | "video"): Promise<MessageResponse> {
    const sock = this.getSock();
    const jid = this.normalizeJid(to);
    const resolved = this.resolveMedia(media);

    const msg: AnyMessageContent =
      type === "image" ? { image: resolved, viewOnce: true } : { video: resolved, viewOnce: true };

    const result = await sock.sendMessage(jid, msg);
    return { messageId: result?.key.id ?? "", timestamp: Date.now(), status: "sent" };
  }

  async sendLinkPreview(to: string, text: string, _url: string): Promise<MessageResponse> {
    const sock = this.getSock();
    const jid = this.normalizeJid(to);
    const result = await sock.sendMessage(jid, { text });
    return { messageId: result?.key.id ?? "", timestamp: Date.now(), status: "sent" };
  }

  // ---- Presence ----

  async sendPresence(
    chatId: string,
    presenceStatus: "composing" | "recording" | "paused" | "available" | "unavailable",
  ): Promise<void> {
    const sock = this.getSock();
    await sock.sendPresenceUpdate(presenceStatus, this.normalizeJid(chatId));
  }

  async markRead(chatId: string, messageIds: string[], participant?: string): Promise<void> {
    const sock = this.getSock();
    const jid = this.normalizeJid(chatId);
    const isGroup = jid.endsWith("@g.us");
    const keys = messageIds.flatMap((id) => {
      if (!isGroup) return [{ remoteJid: jid, id }];

      const storedMessage = db
        .select({ senderId: messagesTable.senderId, isFromMe: messagesTable.isFromMe })
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.instanceId, this.instanceId),
            eq(messagesTable.chatId, jid),
            eq(messagesTable.id, id),
          ),
        )
        .get();
      const messageParticipant = storedMessage?.senderId || participant;

      if (!messageParticipant || messageParticipant === "me") {
        logger.warn(
          { instanceId: this.instanceId, messageId: id },
          "Skipping group read receipt because the message participant is unavailable",
        );
        return [];
      }

      return [
        {
          remoteJid: jid,
          id,
          participant: messageParticipant,
          fromMe: storedMessage?.isFromMe === 1,
        },
      ];
    });

    if (keys.length === 0) return;
    await sock.readMessages(keys);
  }

  // ---- Chats ----

  async modifyChat(chatId: string, modification: ChatModification): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const jid = this.normalizeJid(chatId);

    switch (modification.action) {
      case "archive":
        await sock.chatModify({ archive: true, lastMessages: [] }, jid);
        break;
      case "unarchive":
        await sock.chatModify({ archive: false, lastMessages: [] }, jid);
        break;
      case "pin":
        await sock.chatModify({ pin: true }, jid);
        break;
      case "unpin":
        await sock.chatModify({ pin: false }, jid);
        break;
      case "mute":
        await sock.chatModify(
          { mute: modification.muteUntil ?? Date.now() + 8 * 60 * 60 * 1000 },
          jid,
        );
        break;
      case "unmute":
        await sock.chatModify({ mute: null }, jid);
        break;
      case "delete":
        await sock.chatModify({ delete: true, lastMessages: [] }, jid);
        break;
      case "clear":
        await sock.chatModify({ clear: true, lastMessages: [] }, jid);
        break;
    }
  }

  async markChatUnread(chatId: string): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const jid = this.normalizeJid(chatId);
    const rows = db
      .select({
        id: messagesTable.id,
        chatId: messagesTable.chatId,
        senderId: messagesTable.senderId,
        isFromMe: messagesTable.isFromMe,
        timestamp: messagesTable.timestamp,
        rawData: messagesTable.rawData,
      })
      .from(messagesTable)
      .where(and(eq(messagesTable.instanceId, this.instanceId), eq(messagesTable.chatId, jid)))
      .orderBy(desc(messagesTable.timestamp), desc(messagesTable.id))
      .limit(50)
      .all();
    if (rows.length === 0) {
      throw new Error(`Cannot mark chat '${jid}' unread because it has no stored messages`);
    }

    const lastMessages: MinimalMessage[] = rows.map((row) => {
      let raw: WAMessage | undefined;
      if (row.rawData) {
        try {
          raw = JSON.parse(row.rawData, BufferJSON.reviver) as WAMessage;
        } catch {
          // Reconstruct the minimum Baileys key from the normalized row.
        }
      }
      const key: WAMessageKey = {
        ...(raw?.key ?? {}),
        remoteJid: jid,
        id: row.id,
        fromMe: row.isFromMe === 1,
      };
      if (jid.endsWith("@g.us") && !key.fromMe && !key.participant) {
        key.participant = row.senderId;
      }
      return {
        key,
        messageTimestamp: row.timestamp,
      };
    });

    await sock.chatModify({ markRead: false, lastMessages }, jid);
  }

  private async requireBusinessLabelSupport(sock: WASocket, methods: string[]): Promise<string> {
    if (!sock.user?.id) throw new Error("Not authenticated");
    const socket = sock as unknown as Record<string, unknown>;
    if (methods.some((method) => typeof socket[method] !== "function")) {
      throw businessLabelsUnsupported();
    }

    let profile;
    try {
      profile = await sock.getBusinessProfile(this.normalizeJid(sock.user.id));
    } catch (error) {
      throw labelOperationError(error);
    }
    if (!profile) throw businessLabelsUnsupported();
    return this.normalizeJid(sock.user.id);
  }

  private persistLabel(label: BusinessLabel): void {
    db.insert(labelsTable)
      .values({
        instanceId: this.instanceId,
        id: label.id,
        name: label.name,
        color: label.color,
        deleted: label.deleted ? 1 : 0,
        predefinedId: label.predefinedId ?? null,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [labelsTable.instanceId, labelsTable.id],
        set: {
          name: label.name,
          color: label.color,
          deleted: label.deleted ? 1 : 0,
          predefinedId: label.predefinedId ?? null,
          updatedAt: Date.now(),
        },
      })
      .run();
  }

  private persistLabelAssociation(
    labelId: string,
    type: "chat" | "message",
    chatId: string,
    messageId: string | undefined,
    add: boolean,
  ): void {
    const associationMessageId = type === "message" ? (messageId ?? "") : "";
    const where = and(
      eq(labelAssociationsTable.instanceId, this.instanceId),
      eq(labelAssociationsTable.labelId, labelId),
      eq(labelAssociationsTable.type, type),
      eq(labelAssociationsTable.chatId, chatId),
      eq(labelAssociationsTable.messageId, associationMessageId),
    );
    if (!add) {
      db.delete(labelAssociationsTable).where(where).run();
      return;
    }
    db.insert(labelAssociationsTable)
      .values({
        instanceId: this.instanceId,
        labelId,
        type,
        chatId,
        messageId: associationMessageId,
        updatedAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
  }

  private getLabelsFor(type: "chat" | "message", chatId: string, messageId = ""): BusinessLabel[] {
    const filters = [
      eq(labelAssociationsTable.instanceId, this.instanceId),
      eq(labelAssociationsTable.type, type),
      eq(labelAssociationsTable.chatId, chatId),
    ];
    if (type === "message") filters.push(eq(labelAssociationsTable.messageId, messageId));
    const ids = db
      .select({ labelId: labelAssociationsTable.labelId })
      .from(labelAssociationsTable)
      .where(and(...filters))
      .all()
      .map((row) => row.labelId);
    if (ids.length === 0) return [];

    return db
      .select()
      .from(labelsTable)
      .where(
        and(
          eq(labelsTable.instanceId, this.instanceId),
          eq(labelsTable.deleted, 0),
          inArray(labelsTable.id, ids),
        ),
      )
      .orderBy(asc(labelsTable.name))
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        color: row.color,
        deleted: row.deleted === 1,
        ...(row.predefinedId ? { predefinedId: row.predefinedId } : {}),
      }));
  }

  async listLabels(includeDeleted = false): Promise<BusinessLabel[]> {
    const sock = this.getSock();
    await this.requireBusinessLabelSupport(sock, []);
    const filters = [eq(labelsTable.instanceId, this.instanceId)];
    if (!includeDeleted) filters.push(eq(labelsTable.deleted, 0));
    return db
      .select()
      .from(labelsTable)
      .where(and(...filters))
      .orderBy(asc(labelsTable.name))
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        color: row.color,
        deleted: row.deleted === 1,
        ...(row.predefinedId ? { predefinedId: row.predefinedId } : {}),
      }));
  }

  async createLabel(name: string, color: number): Promise<BusinessLabel> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const jid = await this.requireBusinessLabelSupport(sock, ["addLabel"]);
    const label: BusinessLabel = { id: randomUUID(), name, color, deleted: false };
    try {
      await sock.addLabel(jid, {
        id: label.id,
        name: label.name,
        color: label.color,
        deleted: false,
      });
    } catch (error) {
      throw labelOperationError(error);
    }
    this.persistLabel(label);
    return label;
  }

  async editLabel(id: string, update: { name?: string; color?: number }): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const jid = await this.requireBusinessLabelSupport(sock, ["addLabel"]);
    try {
      await sock.addLabel(jid, { id, ...update, deleted: false });
    } catch (error) {
      throw labelOperationError(error);
    }
    const existing = db
      .select()
      .from(labelsTable)
      .where(and(eq(labelsTable.instanceId, this.instanceId), eq(labelsTable.id, id)))
      .get();
    if (existing) {
      this.persistLabel({
        id,
        name: update.name ?? existing.name,
        color: update.color ?? existing.color,
        deleted: false,
        ...(existing.predefinedId ? { predefinedId: existing.predefinedId } : {}),
      });
    }
  }

  async deleteLabel(id: string): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const jid = await this.requireBusinessLabelSupport(sock, ["addLabel"]);
    try {
      await sock.addLabel(jid, { id, deleted: true });
    } catch (error) {
      throw labelOperationError(error);
    }
    const existing = db
      .select()
      .from(labelsTable)
      .where(and(eq(labelsTable.instanceId, this.instanceId), eq(labelsTable.id, id)))
      .get();
    this.persistLabel({
      id,
      name: existing?.name ?? id,
      color: existing?.color ?? 0,
      deleted: true,
      ...(existing?.predefinedId ? { predefinedId: existing.predefinedId } : {}),
    });
  }

  async setChatLabel(chatId: string, labelId: string, add: boolean): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const jid = this.normalizeJid(chatId);
    await this.requireBusinessLabelSupport(sock, [add ? "addChatLabel" : "removeChatLabel"]);
    try {
      if (add) await sock.addChatLabel(jid, labelId);
      else await sock.removeChatLabel(jid, labelId);
    } catch (error) {
      throw labelOperationError(error);
    }
    this.persistLabelAssociation(labelId, "chat", jid, undefined, add);
  }

  async setMessageLabel(
    chatId: string,
    messageId: string,
    labelId: string,
    add: boolean,
  ): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const jid = this.normalizeJid(chatId);
    await this.requireBusinessLabelSupport(sock, [add ? "addMessageLabel" : "removeMessageLabel"]);
    try {
      if (add) await sock.addMessageLabel(jid, messageId, labelId);
      else await sock.removeMessageLabel(jid, messageId, labelId);
    } catch (error) {
      throw labelOperationError(error);
    }
    this.persistLabelAssociation(labelId, "message", jid, messageId, add);
  }

  async createQuickReply(input: { shortcut: string; message: string }): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    await sock.addOrEditQuickReply({ shortcut: input.shortcut, message: input.message });
  }

  async editQuickReply(input: {
    shortcut: string;
    message: string;
    timestamp: string;
  }): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    await sock.addOrEditQuickReply({
      shortcut: input.shortcut,
      message: input.message,
      timestamp: input.timestamp,
    });
  }

  async deleteQuickReply(timestamp: string): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    await sock.removeQuickReply(timestamp);
  }

  async setDisappearingMessages(
    chatId: string,
    duration: 0 | 86400 | 604800 | 7776000,
  ): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const jid = this.normalizeStatusRecipient(chatId);
    if (!jid) {
      throw new Error(
        "Invalid private chat ID; expected an individual WhatsApp phone number or JID",
      );
    }
    await sock.sendMessage(jid, {
      disappearingMessagesInChat: duration === 0 ? false : duration,
    });
  }

  // ---- Groups ----

  async createGroup(name: string, participants: string[]): Promise<GroupResponse> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const jids = participants.map((p) => this.normalizeJid(p));
    const result = await sock.groupCreate(name, jids);
    return { groupId: result.id, inviteCode: undefined };
  }

  async modifyGroup(groupId: string, modification: GroupModification): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const jid = this.normalizeJid(groupId);

    switch (modification.action) {
      case "updateSubject":
        await sock.groupUpdateSubject(jid, String(modification.value ?? ""));
        break;
      case "updateDescription":
        await sock.groupUpdateDescription(jid, String(modification.value ?? ""));
        break;
      case "updateSettings":
        await sock.groupSettingUpdate(
          jid,
          modification.value === "announcement" ? "announcement" : "not_announcement",
        );
        break;
      case "leave":
        await sock.groupLeave(jid);
        break;
      case "revokeInvite":
        await sock.groupRevokeInvite(jid);
        break;
      case "toggleEphemeral": {
        const duration = typeof modification.value === "number" ? modification.value : 0;
        await sock.sendMessage(jid, { disappearingMessagesInChat: duration });
        break;
      }
    }
  }

  async modifyParticipants(
    groupId: string,
    participants: string[],
    action: ParticipantAction,
  ): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const jid = this.normalizeJid(groupId);
    const jids = participants.map((p) => this.normalizeJid(p));
    await sock.groupParticipantsUpdate(jid, jids, action);
  }

  async listGroups(): Promise<GroupSummary[]> {
    const sock = this.getSock();
    const groups = await sock.groupFetchAllParticipating();
    const ownJids = await this.getOwnGroupParticipantJids(sock);
    const summaries = await Promise.all(
      Object.entries(groups).map(async ([key, metadata]) => {
        const role = await this.getOwnGroupRole(metadata.participants ?? [], ownJids);
        return {
          jid: metadata.id || key,
          subject: metadata.subject ?? "",
          description: metadata.desc ?? null,
          participantCount: metadata.participants?.length ?? 0,
          isAdmin: role.isAdmin,
          isSuperAdmin: role.isSuperAdmin,
        } satisfies GroupSummary;
      }),
    );

    return summaries.sort(
      (left, right) =>
        left.subject.localeCompare(right.subject, undefined, { sensitivity: "base" }) ||
        left.jid.localeCompare(right.jid),
    );
  }

  async getGroupMetadata(groupId: string): Promise<GroupMetadata> {
    const sock = this.getSock();
    const jid = normalizeGroupJid(groupId);
    const meta = await sock.groupMetadata(jid);
    return this.normalizeGroupMetadata(meta);
  }

  private async normalizeGroupMetadata(meta: BaileysGroupMetadata): Promise<GroupMetadata> {
    const participants = await Promise.all(
      (meta.participants ?? []).map(async (participant) => {
        const role: "admin" | "superadmin" | "member" =
          participant.admin === "superadmin"
            ? "superadmin"
            : participant.admin === "admin"
              ? "admin"
              : "member";
        const participantJids = await this.getGroupParticipantIdentities(participant);
        const phoneJid = participant.phoneNumber
          ? jidNormalizedUser(participant.phoneNumber)
          : [...participantJids].find((candidate) => candidate.endsWith("@s.whatsapp.net"));
        const phone = phoneJid?.endsWith("@s.whatsapp.net")
          ? (phoneJid.split("@")[0]?.split(":")[0] ?? null)
          : null;

        return {
          jid: participant.id,
          role,
          phone,
          isAdmin: role === "admin" || role === "superadmin",
          isSuperAdmin: role === "superadmin",
        };
      }),
    );
    const participantCount = meta.participants?.length ?? 0;

    return {
      jid: meta.id,
      subject: meta.subject,
      description: meta.desc ?? null,
      owner: meta.owner ?? null,
      ownerJid: meta.owner ?? null,
      creation: meta.creation ?? null,
      participants,
      participantCount,
      size: participantCount,
      announce: meta.announce ?? false,
      restrict: meta.restrict ?? false,
      isAnnounce: meta.announce ?? false,
      isLocked: meta.restrict ?? false,
      ephemeralDuration: meta.ephemeralDuration ?? null,
      inviteCode: null,
      createdAt: meta.creation ?? null,
    };
  }

  async updateGroupPicture(groupId: string, image: string): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const jid = normalizeGroupJid(groupId);
    await this.requireGroupPictureAdmin(sock, jid, "update");
    const jpeg = await mediaService.prepareGroupProfilePicture(image);
    try {
      await sock.updateProfilePicture(jid, jpeg);
    } catch (error) {
      throw groupPictureFailure(error, "update");
    }
  }

  async removeGroupPicture(groupId: string): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const jid = normalizeGroupJid(groupId);
    await this.requireGroupPictureAdmin(sock, jid, "remove");
    try {
      await sock.removeProfilePicture(jid);
    } catch (error) {
      throw groupPictureFailure(error, "remove");
    }
  }

  private async getOwnGroupParticipantJids(sock: WASocket): Promise<Set<string>> {
    return this.getNormalizedGroupIdentities([sock.user?.id, sock.user?.lid]);
  }

  private async getGroupParticipantIdentities(
    participant: Pick<BaileysGroupParticipant, "id" | "phoneNumber" | "lid">,
  ): Promise<Set<string>> {
    return this.getNormalizedGroupIdentities([
      participant.id,
      participant.phoneNumber,
      participant.lid,
    ]);
  }

  private async getNormalizedGroupIdentities(
    candidates: Array<string | undefined>,
  ): Promise<Set<string>> {
    const identities = new Set(
      candidates
        .filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0)
        .map((candidate) => jidNormalizedUser(candidate)),
    );

    if ([...identities].some((identity) => identity.endsWith("@s.whatsapp.net"))) {
      return identities;
    }

    for (const identity of identities) {
      if (!identity.endsWith("@lid")) continue;
      try {
        const phoneJid = jidNormalizedUser(await this.resolvePn(identity));
        if (phoneJid !== identity) identities.add(phoneJid);
      } catch {
        // The direct LID identities still support comparisons when no phone mapping exists.
      }
    }
    return identities;
  }

  private async getOwnGroupRole(
    participants: BaileysGroupParticipant[],
    ownJids: Set<string>,
  ): Promise<{ isAdmin: boolean; isSuperAdmin: boolean }> {
    let isAdmin = false;
    let isSuperAdmin = false;
    for (const participant of participants) {
      const participantJids = await this.getGroupParticipantIdentities(participant);
      if (![...participantJids].some((participantJid) => ownJids.has(participantJid))) continue;
      if (participant.admin === "admin" || participant.admin === "superadmin") isAdmin = true;
      if (participant.admin === "superadmin") isSuperAdmin = true;
    }
    return { isAdmin, isSuperAdmin };
  }

  private async requireGroupPictureAdmin(
    sock: WASocket,
    groupJid: string,
    operation: "update" | "remove",
  ): Promise<void> {
    let metadata: Awaited<ReturnType<WASocket["groupMetadata"]>>;
    try {
      metadata = await sock.groupMetadata(groupJid);
    } catch (error) {
      throw groupPictureFailure(error, operation);
    }
    if (!metadata) throw new Error("Group not found");

    const ownJids = await this.getOwnGroupParticipantJids(sock);
    const role = await this.getOwnGroupRole(metadata.participants ?? [], ownJids);
    if (!role.isAdmin) {
      throw new Error(`Only a group admin can ${operation} this group's picture`);
    }
  }

  async getGroupInviteCode(groupId: string): Promise<string> {
    const sock = this.getSock();
    const code = await sock.groupInviteCode(this.normalizeJid(groupId));
    return code ?? "";
  }

  async joinGroup(inviteCode: string): Promise<string> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const groupId = await sock.groupAcceptInvite(inviteCode);
    return groupId ?? "";
  }

  async handleJoinRequest(
    groupId: string,
    participantJid: string,
    action: "approve" | "reject",
  ): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const jid = this.normalizeJid(groupId);
    const participant = this.normalizeJid(participantJid);
    await sock.groupRequestParticipantsUpdate(jid, [participant], action);
  }

  async setGroupJoinApprovalMode(groupId: string, mode: "on" | "off"): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    await sock.groupJoinApprovalMode(normalizeGroupJid(groupId), mode);
  }

  async setGroupMemberAddMode(
    groupId: string,
    mode: "admin_add" | "all_member_add",
  ): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    await sock.groupMemberAddMode(normalizeGroupJid(groupId), mode);
  }

  // ---- Communities ----

  async createCommunity(subject: string, description = ""): Promise<GroupMetadata | null> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const community = await sock.communityCreate(subject, description);
    return community ? this.normalizeGroupMetadata(community) : null;
  }

  async listCommunities(): Promise<Record<string, GroupMetadata>> {
    const sock = this.getSock();
    const communities = await sock.communityFetchAllParticipating();
    const entries = await Promise.all(
      Object.entries(communities).map(
        async ([jid, metadata]) => [jid, await this.normalizeGroupMetadata(metadata)] as const,
      ),
    );
    return Object.fromEntries(entries);
  }

  async getCommunityMetadata(communityId: string): Promise<GroupMetadata> {
    const sock = this.getSock();
    const metadata = await sock.communityMetadata(normalizeGroupJid(communityId));
    return this.normalizeGroupMetadata(metadata);
  }

  async linkGroupToCommunity(groupId: string, communityId: string): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    await sock.communityLinkGroup(normalizeGroupJid(groupId), normalizeGroupJid(communityId));
  }

  async unlinkGroupFromCommunity(groupId: string, communityId: string): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    await sock.communityUnlinkGroup(normalizeGroupJid(groupId), normalizeGroupJid(communityId));
  }

  async leaveCommunity(communityId: string): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    await sock.communityLeave(normalizeGroupJid(communityId));
  }

  // ---- Contacts ----

  async checkNumberExists(phone: string): Promise<NumberExistsResponse> {
    const sock = this.getSock();
    const jid = this.normalizeJid(phone);
    const results = await sock.onWhatsApp(jid);
    const result = results?.[0];
    return { exists: !!result?.exists, jid: result?.jid ?? null };
  }

  async blockContact(jid: string): Promise<void> {
    const sock = this.getSock();
    await sock.updateBlockStatus(this.normalizeJid(jid), "block");
  }

  async unblockContact(jid: string): Promise<void> {
    const sock = this.getSock();
    await sock.updateBlockStatus(this.normalizeJid(jid), "unblock");
  }

  async getBlocklist(): Promise<string[]> {
    const sock = this.getSock();
    const list = await sock.fetchBlocklist();
    return list.filter((jid): jid is string => jid !== undefined);
  }

  async getContactAbout(jid: string): Promise<string | null> {
    const sock = this.getSock();
    const normalizedJid = this.normalizeStatusRecipient(jid);
    if (!normalizedJid) {
      throw new Error("Invalid contact ID; expected an individual WhatsApp phone number or JID");
    }
    const status = await sock.fetchStatus(normalizedJid);
    const result = status?.find((entry) => entry.id === normalizedJid);
    return typeof result?.status === "string" ? result.status : null;
  }

  async getBusinessProfile(jid: string): Promise<BusinessProfile | null> {
    const sock = this.getSock();
    const profile = await sock.getBusinessProfile(this.normalizeJid(jid));
    if (!profile) return null;
    return {
      name: profile.wid ?? "",
      description: profile.description ?? undefined,
      category: profile.category ?? undefined,
      website: profile.website?.[0] ?? undefined,
      email: profile.email ?? undefined,
      address: profile.address ?? undefined,
    };
  }

  // ---- Profile ----

  async updateProfilePicture(image: Buffer): Promise<void> {
    const sock = this.getSock();
    await sock.updateProfilePicture(this.getMeJid(), image);
  }

  async removeProfilePicture(): Promise<void> {
    const sock = this.getSock();
    await sock.removeProfilePicture(this.getMeJid());
  }

  async updateProfileName(name: string): Promise<void> {
    // Baileys implements updateProfileName through chatModify/appPatch.
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    await sock.updateProfileName(name);
  }

  async updateProfileStatus(statusText: string): Promise<void> {
    const sock = this.getSock();
    await sock.updateProfileStatus(statusText);
  }

  async updatePrivacy(update: PrivacyUpdate): Promise<void> {
    const sock = this.getSock();
    // Baileys has separate privacy update methods per setting
    switch (update.setting) {
      case "lastSeen":
        await sock.updateLastSeenPrivacy(update.value);
        break;
      case "online":
        await sock.updateOnlinePrivacy(update.value);
        break;
      case "profilePic":
        await sock.updateProfilePicturePrivacy(update.value);
        break;
      case "status":
        await sock.updateStatusPrivacy(update.value);
        break;
      case "readReceipts":
        await sock.updateReadReceiptsPrivacy(update.value);
        break;
      case "groupAdd":
        await sock.updateGroupsAddPrivacy(update.value);
        break;
      case "calls":
        await sock.updateCallPrivacy(update.value);
        break;
      case "defaultDisappearingMode":
        await sock.updateDefaultDisappearingMode(update.value);
        break;
    }
  }

  async getPrivacySettings(forceRefresh = true): Promise<PrivacySettings> {
    const sock = this.getSock();
    const settings = await sock.fetchPrivacySettings(forceRefresh);
    return normalizePrivacySettings(settings);
  }

  async getProfilePicture(jid: string): Promise<string | null> {
    const sock = this.getSock();
    try {
      const url = await sock.profilePictureUrl(this.normalizeJid(jid), "image");
      return url ?? null;
    } catch {
      return null;
    }
  }

  // ---- Status / Stories ----

  async sendStatus(content: StatusContent): Promise<StatusSendResult> {
    const sock = this.getSock();
    const statusJid = STATUS_BROADCAST_JID;
    const audience = this.resolveStatusAudience(sock, content.statusJidList);
    const messageOptions: MiscMessageGenerationOptions = {
      statusJidList: audience.statusJidList,
      broadcast: true,
      ...(content.type === "text" && content.backgroundColor !== undefined
        ? { backgroundColor: content.backgroundColor }
        : {}),
      ...(content.type === "text" && content.font !== undefined ? { font: content.font } : {}),
    };

    let messageId: string | null | undefined;
    switch (content.type) {
      case "text":
        messageId = (
          await sock.sendMessage(
            statusJid,
            {
              text: content.text ?? "",
            },
            messageOptions,
          )
        )?.key.id;
        break;
      case "image":
        messageId = (
          await sock.sendMessage(
            statusJid,
            {
              image: this.resolveMedia(content.media ?? ""),
              caption: content.caption,
            },
            messageOptions,
          )
        )?.key.id;
        break;
      case "video":
        messageId = (
          await sock.sendMessage(
            statusJid,
            {
              video: this.resolveMedia(content.media ?? ""),
              caption: content.caption,
            },
            messageOptions,
          )
        )?.key.id;
        break;
    }

    if (messageId) this.persistStatusAudience(messageId, audience.statusJidList);

    return {
      recipientCount: audience.statusJidList.length,
      omittedRecipientCount: audience.omittedRecipientCount,
      ...(audience.warning ? { warning: audience.warning } : {}),
    };
  }

  // ---- Newsletter / Channels ----

  async newsletterFollow(jid: string): Promise<void> {
    const sock = this.getSock();
    await sock.newsletterFollow(jid);
  }

  async newsletterUnfollow(jid: string): Promise<void> {
    const sock = this.getSock();
    await sock.newsletterUnfollow(jid);
  }

  async newsletterSend(jid: string, text: string): Promise<MessageResponse> {
    const sock = this.getSock();
    const result = await sock.sendMessage(jid, { text });
    return { messageId: result?.key.id ?? "", timestamp: Date.now(), status: "sent" };
  }

  async createNewsletter(name: string, description?: string): Promise<NewsletterMetadata> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    return sock.newsletterCreate(name, description);
  }

  async getNewsletterMetadata(
    type: "invite" | "jid",
    key: string,
  ): Promise<NewsletterMetadata | null> {
    if (type === "jid" && !/^\d{5,20}@newsletter$/.test(key)) {
      throw new Error("Invalid Channel JID; expected a JID ending in @newsletter");
    }
    const sock = this.getSock();
    return sock.newsletterMetadata(type, key);
  }

  async updateNewsletterName(jid: string, name: string): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    await sock.newsletterUpdateName(jid, name);
  }

  async updateNewsletterDescription(jid: string, description: string): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    await sock.newsletterUpdateDescription(jid, description);
  }

  async updateNewsletterPicture(jid: string, image: string): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const jpeg = await mediaService.prepareGroupProfilePicture(image);
    await sock.newsletterUpdatePicture(jid, jpeg);
  }

  async reactToNewsletterMessage(jid: string, serverId: string, reaction?: string): Promise<void> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    await sock.newsletterReactMessage(jid, serverId, reaction);
  }

  async fetchNewsletterMessages(
    jid: string,
    count: number,
    since: number,
    after: number,
  ): Promise<NewsletterPostsPage> {
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      throw new Error("Invalid count; expected an integer from 1 to 100");
    }
    if (!Number.isSafeInteger(since) || since < 0) {
      throw new Error("Invalid since value; expected a non-negative Unix timestamp");
    }
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error("Invalid after cursor; expected a non-negative numeric Channel server ID");
    }
    const sock = this.getSock();
    const response: unknown = await sock.newsletterFetchMessages(jid, count, since, after);
    return isBinaryNode(response)
      ? parseNewsletterMessagesResponse(response)
      : { posts: [], pagination: { oldestServerId: null, newestServerId: null, after: null } };
  }

  // ---- Business catalog ----

  private async prepareCatalogImages(images: string[]): Promise<Buffer[]> {
    return Promise.all(
      images.map((image) => mediaService.getMediaBuffer(image, { maxBytes: MEDIA_LIMITS.image })),
    );
  }

  async getCatalog(
    options: GetCatalogOptions,
  ): Promise<{ products: Product[]; nextPageCursor: string | undefined }> {
    const sock = this.getSock();
    return sock.getCatalog(options);
  }

  async getCollections(
    jid?: string,
    limit?: number,
  ): Promise<{ collections: CatalogCollection[] }> {
    const sock = this.getSock();
    return sock.getCollections(jid, limit);
  }

  async createProduct(input: CatalogProductCreateInput): Promise<Product> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const create: ProductCreate = {
      ...input,
      originCountryCode: input.originCountryCode,
      images: await this.prepareCatalogImages(input.images),
    };
    return sock.productCreate(create);
  }

  async updateProduct(productId: string, input: CatalogProductUpdateInput): Promise<Product> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    const update: ProductUpdate = {
      ...input,
      images: await this.prepareCatalogImages(input.images),
    };
    return sock.productUpdate(productId, update);
  }

  async deleteProducts(productIds: string[]): Promise<{ deleted: number }> {
    this.requireAppStateWritesEnabled();
    const sock = this.getSock();
    return sock.productDelete(productIds);
  }

  async getOrderDetails(orderId: string, tokenBase64: string): Promise<OrderDetails> {
    const sock = this.getSock();
    return sock.getOrderDetails(orderId, tokenBase64);
  }

  // ---- Calls ----

  async rejectCall(callId: string): Promise<void> {
    const sock = this.getSock();
    // rejectCall requires (callId, callFrom) — we pass empty string for callFrom
    // as we don't have the caller info in this context
    await sock.rejectCall(callId, "");
  }

  // ---- Data access ----

  async getContacts(search?: string): Promise<Contact[]> {
    for (const lid of this.contactStore.getUnresolvedLids()) {
      const pn = await this.resolvePn(lid);
      if (pn !== lid) this.contactStore.updateLidMapping(lid, pn);
    }
    return this.contactStore.getContacts(search);
  }

  async resyncContacts(): Promise<ContactResyncResult> {
    const sock = this.getSock();
    const contactsBefore = this.contactStore.getContactCount();
    const collections: ContactResyncResult["sources"]["appState"]["collections"] = [];

    for (const collection of ALL_WA_PATCH_NAMES) {
      const before = this.contactStore.getContactCount();
      let errorMessage: string | undefined;
      try {
        // false preserves incremental existing-session behavior and avoids initial-sync handling.
        await sock.resyncAppState([collection], false);
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(
          { instanceId: this.instanceId, collection, error },
          "Contact app-state resync failed",
        );
      }
      await this.waitForSocketEventProcessing(sock);
      collections.push({
        collection,
        success: errorMessage === undefined,
        contactsAdded: Math.max(0, this.contactStore.getContactCount() - before),
        ...(errorMessage ? { error: errorMessage } : {}),
      });
    }

    const resolveLidToPn: ContactPnResolver = async (lid) => {
      try {
        return await sock.signalRepository.lidMapping.getPNForLID(lid);
      } catch (error) {
        logger.debug({ instanceId: this.instanceId, lid, error }, "Failed to resolve contact LID");
        return null;
      }
    };
    const localStore = await this.contactStore.recoverFromLocalData(resolveLidToPn);
    const contactsAfter = this.contactStore.getContactCount();

    return {
      contactsBefore,
      contactsAfter,
      added: Math.max(0, contactsAfter - contactsBefore),
      sources: {
        appState: { collections },
        localStore,
      },
    };
  }

  private async waitForSocketEventProcessing(sock: WASocket): Promise<void> {
    while (sock.ev.isBuffering()) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await this.pendingSocketEventProcessing;
  }

  async getChats(): Promise<Chat[]> {
    const rows = db
      .select()
      .from(chatsTable)
      .where(eq(chatsTable.instanceId, this.instanceId))
      .orderBy(desc(chatsTable.lastMessageAt), desc(chatsTable.updatedAt))
      .all();
    const labelRows = db
      .select()
      .from(labelsTable)
      .where(and(eq(labelsTable.instanceId, this.instanceId), eq(labelsTable.deleted, 0)))
      .all();
    const labelsById = new Map(
      labelRows.map((row) => [
        row.id,
        {
          id: row.id,
          name: row.name,
          color: row.color,
          deleted: false,
          ...(row.predefinedId ? { predefinedId: row.predefinedId } : {}),
        } satisfies BusinessLabel,
      ]),
    );
    const associationRows = db
      .select({ chatId: labelAssociationsTable.chatId, labelId: labelAssociationsTable.labelId })
      .from(labelAssociationsTable)
      .where(
        and(
          eq(labelAssociationsTable.instanceId, this.instanceId),
          eq(labelAssociationsTable.type, "chat"),
        ),
      )
      .all();
    const labelIdsByChat = new Map<string, string[]>();
    for (const association of associationRows) {
      const ids = labelIdsByChat.get(association.chatId) ?? [];
      ids.push(association.labelId);
      labelIdsByChat.set(association.chatId, ids);
    }

    return rows.map((row) => ({
      jid: row.jid,
      name: row.name,
      isGroup: row.isGroup === 1,
      unreadCount: row.unreadCount,
      isPinned: row.isPinned === 1,
      isMuted: row.isMuted === 1,
      isArchived: row.isArchived === 1,
      lastMessageAt: row.lastMessageAt,
      labels: (labelIdsByChat.get(row.jid) ?? []).flatMap((id) => {
        const label = labelsById.get(id);
        return label ? [label] : [];
      }),
    }));
  }

  async getMessages(chatId: string, limit = 50): Promise<Message[]> {
    const jid = this.normalizeJid(chatId);
    const rows = db
      .select()
      .from(messagesTable)
      .where(and(eq(messagesTable.instanceId, this.instanceId), eq(messagesTable.chatId, jid)))
      .orderBy(desc(messagesTable.timestamp), desc(messagesTable.id))
      .limit(limit)
      .all();

    return rows.map((r) => {
      let details: ReturnType<typeof extractMessageDetails> | undefined;
      if (r.rawData) {
        try {
          details = extractMessageDetails(JSON.parse(r.rawData, BufferJSON.reviver) as WAMessage);
        } catch {
          // The normalized fields remain available if raw data is malformed.
        }
      }
      const labels = this.getLabelsFor("message", r.chatId, r.id);
      return {
        id: r.id,
        chatId: r.chatId,
        senderId: r.senderId,
        // Re-normalizing stored raw messages also repairs rows written while an
        // earlier build persisted unsupported content with type "unknown".
        type: details?.type ?? (r.type as Message["type"]),
        content: r.content,
        mediaUrl: r.mediaUrl,
        ...(r.mediaMimetype || details?.mediaMimetype
          ? { mediaMimetype: r.mediaMimetype ?? details?.mediaMimetype }
          : {}),
        ...(r.mediaMimetype || details?.mediaMimetype
          ? { mimeType: r.mediaMimetype ?? details?.mediaMimetype }
          : {}),
        ...(details?.mediaFileName
          ? { mediaFileName: details.mediaFileName, fileName: details.mediaFileName }
          : {}),
        ...(details?.mediaSize ? { mediaSize: details.mediaSize, size: details.mediaSize } : {}),
        ...(details?.mediaCaption
          ? { mediaCaption: details.mediaCaption, caption: details.mediaCaption }
          : {}),
        ...(details?.buttons ? { buttons: details.buttons } : {}),
        ...(details?.rawType ? { rawType: details.rawType } : {}),
        quotedMessageId: r.quotedId,
        isFromMe: r.isFromMe === 1,
        isForwarded: r.isForwarded === 1,
        status: r.status as Message["status"],
        timestamp: r.timestamp,
        starred: r.starred === 1,
        ...(labels.length ? { labels } : {}),
      };
    });
  }

  async searchMessages(
    options: MessageSearchOptions,
  ): Promise<{ messages: Message[]; hasMore: boolean; nextOffset: number | null }> {
    const result = searchStoredMessages(sqlite, this.instanceId, options);
    return {
      ...result,
      messages: result.messages.map((message) => {
        const labels = this.getLabelsFor("message", message.chatId, message.id);
        return labels.length ? { ...message, labels } : message;
      }),
    };
  }

  async fetchMessageHistory(
    chatId: string,
    count: number,
    timeoutMs = 10_000,
  ): Promise<{ requested: number; stored: number; timedOut: boolean }> {
    const sock = this.getSock();
    const jid = this.normalizeJid(chatId);
    if (this.activeHistoryFetch) {
      throw new Error(
        "Another on-demand message history fetch is already in progress for this instance",
      );
    }
    const oldest = db
      .select({
        id: messagesTable.id,
        senderId: messagesTable.senderId,
        isFromMe: messagesTable.isFromMe,
        timestamp: messagesTable.timestamp,
        rawData: messagesTable.rawData,
      })
      .from(messagesTable)
      .where(and(eq(messagesTable.instanceId, this.instanceId), eq(messagesTable.chatId, jid)))
      .orderBy(asc(messagesTable.timestamp), asc(messagesTable.id))
      .get();
    if (!oldest) {
      throw new Error(`Cannot fetch older history for '${jid}' without a stored message anchor`);
    }

    let raw: WAMessage | undefined;
    if (oldest.rawData) {
      try {
        raw = JSON.parse(oldest.rawData, BufferJSON.reviver) as WAMessage;
      } catch {
        // The normalized database fields below are enough to construct an anchor key.
      }
    }
    const oldestKey: WAMessageKey = {
      ...(raw?.key ?? {}),
      remoteJid: jid,
      id: oldest.id,
      fromMe: oldest.isFromMe === 1,
    };
    if (jid.endsWith("@g.us") && !oldestKey.fromMe && !oldestKey.participant) {
      oldestKey.participant = oldest.senderId;
    } else if (jid.endsWith("@g.us") && oldestKey.fromMe && !oldestKey.participant) {
      oldestKey.participant = sock.user?.id;
    }
    const oldestTimestamp = messageTimestampToMilliseconds(
      raw?.messageTimestamp ?? oldest.timestamp,
      Number(oldest.timestamp) * 1000,
    );

    const resultPromise = new Promise<{ requested: number; stored: number; timedOut: boolean }>(
      (resolve, reject) => {
        const waiter = {
          chatId: jid,
          requested: count,
          stored: 0,
          receivedMatchingHistorySet: false,
          seenMessageIds: new Set(),
          resolve,
          reject,
          timer: undefined as unknown as ReturnType<typeof setTimeout>,
        } satisfies HistoryFetchWaiter;
        waiter.timer = setTimeout(() => this.finishHistoryFetch(true, waiter), timeoutMs);
        this.activeHistoryFetch = waiter;
      },
    );

    try {
      const waiter = this.activeHistoryFetch as HistoryFetchWaiter | null;
      if (!waiter) throw new Error("History fetch waiter was not initialized");
      void sock
        .fetchMessageHistory(count, oldestKey, oldestTimestamp)
        .then((peerDataRequestSessionId) => {
          waiter.peerDataRequestSessionId = peerDataRequestSessionId;
        })
        .catch((error: unknown) => {
          this.failHistoryFetch(error, waiter);
        });
    } catch (error) {
      this.failHistoryFetch(error);
    }
    return resultPromise;
  }

  private finishHistoryFetch(timedOut: boolean, expectedWaiter?: HistoryFetchWaiter): void {
    const waiter = this.activeHistoryFetch;
    if (!waiter || (expectedWaiter && waiter !== expectedWaiter)) return;
    clearTimeout(waiter.timer);
    this.activeHistoryFetch = null;
    waiter.resolve({ requested: waiter.requested, stored: waiter.stored, timedOut });
  }

  private failHistoryFetch(error: unknown, expectedWaiter?: HistoryFetchWaiter): void {
    const waiter = this.activeHistoryFetch;
    if (!waiter || (expectedWaiter && waiter !== expectedWaiter)) return;
    clearTimeout(waiter.timer);
    this.activeHistoryFetch = null;
    waiter.reject(error);
  }

  private persistSourceMessage(source: WAMessage): boolean {
    if (!source.key.id || !source.key.remoteJid) return false;
    normalizeLidInMessage(source);
    const unwrappedContent = unwrapMessageContent(source.message, { unwrapProtocolEdits: false });
    if (unwrappedContent?.protocolMessage) return false;
    const details = extractMessageDetails(source);
    const normalized: NormalizedMessageEvent = {
      instanceId: this.instanceId,
      chatId: getChatJid(source),
      message: {
        id: source.key.id,
        sender: getSenderJid(source),
        timestamp:
          typeof source.messageTimestamp === "number"
            ? source.messageTimestamp
            : Number(source.messageTimestamp ?? 0),
        type: details.type,
        content: details.content,
        mediaUrl: details.mediaUrl,
        ...(details.mediaMimetype ? { mediaMimetype: details.mediaMimetype } : {}),
        ...(details.buttons ? { buttons: details.buttons } : {}),
        ...(details.rawType ? { rawType: details.rawType } : {}),
        quotedMessageId: extractQuotedMessageId(source),
        isFromMe: source.key.fromMe ?? false,
      },
    };
    return this.persistMessage(normalized, source);
  }

  async downloadMessageAudio(
    messageId: string,
    maxBytes?: number,
    timeoutMs?: number,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const row = db
      .select({
        type: messagesTable.type,
        rawData: messagesTable.rawData,
        mimetype: messagesTable.mediaMimetype,
      })
      .from(messagesTable)
      .where(and(eq(messagesTable.instanceId, this.instanceId), eq(messagesTable.id, messageId)))
      .get();

    if (!row) throw new Error(`Message '${messageId}' not found`);
    if (row.type !== "audio") throw new Error(`Message '${messageId}' is not audio`);
    if (!row.rawData) {
      throw new Error(`Audio media for message '${messageId}' is no longer available`);
    }

    const message = JSON.parse(row.rawData, BufferJSON.reviver) as WAMessage;
    const audioMessage = unwrapMessageContent(message.message)?.audioMessage as
      NonNullable<WAMessage["message"]>["audioMessage"] | undefined;
    if (!audioMessage) throw new Error(`Audio media for message '${messageId}' is unavailable`);

    if (maxBytes !== undefined && audioMessage.fileLength !== undefined) {
      const fileLength = Number(audioMessage.fileLength);
      if (Number.isFinite(fileLength) && fileLength > maxBytes) {
        throw new Error(
          `Audio exceeds maximum transcription size of ${Math.round(maxBytes / 1024 / 1024)} MB`,
        );
      }
    }

    const sock = this.getSock();
    const downloadOptions = timeoutMs
      ? { options: { signal: AbortSignal.timeout(timeoutMs) } }
      : {};
    const stream = await downloadMediaMessage(message, "stream", downloadOptions, {
      logger: logger.child({ instanceId: this.instanceId, messageId }),
      reuploadRequest: sock.updateMediaMessage,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (maxBytes !== undefined && size > maxBytes) {
        stream.destroy();
        throw new Error(
          `Audio exceeds maximum transcription size of ${Math.round(maxBytes / 1024 / 1024)} MB`,
        );
      }
      chunks.push(buffer);
    }

    return {
      data: Buffer.concat(chunks, size),
      mimeType: row.mimetype ?? audioMessage.mimetype ?? "audio/ogg",
    };
  }

  async downloadMessageMedia(
    messageId: string,
    chatId?: string,
    maxBytes?: number,
    timeoutMs?: number,
  ): Promise<{ data: Buffer; mimeType: string; fileName?: string }> {
    const where = chatId
      ? and(
          eq(messagesTable.instanceId, this.instanceId),
          eq(messagesTable.id, messageId),
          eq(messagesTable.chatId, chatId),
        )
      : and(eq(messagesTable.instanceId, this.instanceId), eq(messagesTable.id, messageId));
    const row = db
      .select({
        type: messagesTable.type,
        rawData: messagesTable.rawData,
        mimetype: messagesTable.mediaMimetype,
      })
      .from(messagesTable)
      .where(where)
      .get();

    if (!row) throw new Error(`Message '${messageId}' not found`);
    const mediaFields: Record<string, string> = {
      image: "imageMessage",
      video: "videoMessage",
      audio: "audioMessage",
      document: "documentMessage",
      sticker: "stickerMessage",
    };
    const mediaField = mediaFields[row.type];
    if (!mediaField) throw new Error(`Message '${messageId}' does not contain downloadable media`);
    if (!row.rawData) {
      throw new Error(`Media for message '${messageId}' is no longer available`);
    }

    const message = JSON.parse(row.rawData, BufferJSON.reviver) as WAMessage;
    const unwrapped = unwrapMessageContent(message.message);
    const media = unwrapped?.[mediaField];
    if (!media || typeof media !== "object") {
      throw new Error(`Media for message '${messageId}' is unavailable`);
    }
    const mediaMessage = media as Record<string, unknown>;
    const fileLength = Number(mediaMessage.fileLength);
    if (maxBytes !== undefined && Number.isFinite(fileLength) && fileLength > maxBytes) {
      throw new Error(`Media exceeds maximum download size of ${sizeLabel(maxBytes)}`);
    }

    const sock = this.getSock();
    const downloadOptions = timeoutMs
      ? { options: { signal: AbortSignal.timeout(timeoutMs) } }
      : {};
    const stream = await downloadMediaMessage(message, "stream", downloadOptions, {
      logger: logger.child({ instanceId: this.instanceId, messageId }),
      reuploadRequest: sock.updateMediaMessage,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (maxBytes !== undefined && size > maxBytes) {
        stream.destroy();
        throw new Error(`Media exceeds maximum download size of ${sizeLabel(maxBytes)}`);
      }
      chunks.push(buffer);
    }

    const mimeType =
      row.mimetype ??
      (typeof mediaMessage.mimetype === "string"
        ? mediaMessage.mimetype
        : "application/octet-stream");
    return {
      data: Buffer.concat(chunks, size),
      mimeType,
      ...(typeof mediaMessage.fileName === "string" ? { fileName: mediaMessage.fileName } : {}),
    };
  }

  async getProfileInfo(): Promise<ProfileInfo> {
    const sock = this.getSock();
    const meJid = this.getMeJid();

    let pictureUrl: string | null = null;
    try {
      const url = await sock.profilePictureUrl(meJid, "image");
      pictureUrl = url ?? null;
    } catch {
      // no profile picture
    }

    return {
      name: sock.user?.name ?? "",
      status: "",
      pictureUrl,
    };
  }

  // ---- Message Persistence ----

  private persistMessage(
    event: NormalizedMessageEvent,
    source?: WAMessage,
    persistFullMessage = false,
  ): boolean {
    try {
      const existed = db
        .select({ id: messagesTable.id })
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.instanceId, event.instanceId),
            eq(messagesTable.id, event.message.id),
          ),
        )
        .get();
      const { message, chatId, instanceId } = event;
      const isForwarded = message.isForwarded === true || isMessageForwarded(source);
      const needsRawData =
        message.type === "image" ||
        message.type === "video" ||
        message.type === "audio" ||
        message.type === "document" ||
        message.type === "sticker" ||
        message.type === "event" ||
        !!message.buttons?.length ||
        !!message.rawType;
      const rawData = persistFullMessage
        ? serializeWAMessage(source)
        : needsRawData
          ? serializeIncomingMessage(source)
          : null;
      db.insert(messagesTable)
        .values({
          id: message.id,
          instanceId,
          chatId,
          senderId: message.sender,
          type: message.type,
          content: message.content,
          mediaUrl: message.mediaUrl,
          mediaMimetype: message.mediaMimetype ?? null,
          quotedId: message.quotedMessageId,
          isFromMe: message.isFromMe ? 1 : 0,
          isForwarded: isForwarded ? 1 : 0,
          status: message.isFromMe ? "sent" : "received",
          timestamp: message.timestamp,
          pushName: source?.pushName ?? null,
          rawData,
        })
        .onConflictDoUpdate({
          target: [messagesTable.instanceId, messagesTable.id],
          set: {
            type: message.type === "text" ? sql`${messagesTable.type}` : message.type,
            content: message.content,
            status: sql`CASE WHEN ${messagesTable.status} = 'revoked' THEN 'revoked' ELSE excluded.status END`,
            pushName: sql`coalesce(excluded.push_name, ${messagesTable.pushName})`,
            mediaUrl: sql`coalesce(excluded.media_url, ${messagesTable.mediaUrl})`,
            mediaMimetype: sql`coalesce(excluded.media_mimetype, ${messagesTable.mediaMimetype})`,
            rawData: sql`coalesce(excluded.raw_data, ${messagesTable.rawData})`,
            isForwarded: sql`CASE WHEN excluded.is_forwarded = 1 THEN 1 ELSE ${messagesTable.isForwarded} END`,
          },
        })
        .run();
      logger.info(
        { instanceId, messageId: message.id, chatId, fromMe: message.isFromMe },
        "Message persisted to DB",
      );
      return !existed;
    } catch (err) {
      logger.error({ err, messageId: event.message.id }, "Failed to persist message");
      return false;
    }
  }

  private attachMessageLabels(event: NormalizedMessageEvent): NormalizedMessageEvent {
    const chatLabels = this.getLabelsFor("chat", event.chatId);
    const messageLabels = this.getLabelsFor("message", event.chatId, event.message.id);
    return {
      ...event,
      ...(chatLabels.length ? { chatLabels } : {}),
      message: {
        ...event.message,
        ...(messageLabels.length ? { labels: messageLabels } : {}),
      },
    };
  }

  private async resolveJidToPn(jid: string): Promise<string> {
    const normalized = jidNormalizedUser(jid);
    if (!normalized.endsWith("@lid")) return normalized;
    try {
      return jidNormalizedUser(await this.resolvePn(normalized));
    } catch {
      return normalized;
    }
  }

  private async canonicalEventChatJid(key: WAMessageKey): Promise<string> {
    const candidates = [key.remoteJid, key.remoteJidAlt].filter((jid): jid is string => !!jid);
    const groupJid = candidates.find((jid) => jid.endsWith("@g.us"));
    if (groupJid) return jidNormalizedUser(groupJid);
    const pnJid = candidates.find((jid) => jidNormalizedUser(jid).endsWith("@s.whatsapp.net"));
    return this.resolveJidToPn(pnJid ?? candidates[0] ?? "");
  }

  private async canonicalEventAuthorJid(key: WAMessageKey): Promise<string> {
    const meId = jidNormalizedUser(this.sock?.user?.id ?? "me");
    const author = key.fromMe ? meId : (key.participant ?? key.remoteJid);
    if (!author) return "";

    const normalizedAuthor = jidNormalizedUser(author);
    const resolvedAuthor = await this.resolveJidToPn(normalizedAuthor);
    if (!normalizedAuthor.endsWith("@lid") || !resolvedAuthor.endsWith("@lid")) {
      return resolvedAuthor;
    }
    if (key.fromMe) return resolvedAuthor;

    const alternateAuthor = key.participant ? key.participantAlt : key.remoteJidAlt;
    const normalizedAlternate = alternateAuthor ? jidNormalizedUser(alternateAuthor) : "";
    return normalizedAlternate.endsWith("@s.whatsapp.net") ? normalizedAlternate : resolvedAuthor;
  }

  private async getStoredEventMessage(key: WAMessageKey): Promise<WAMessage | null> {
    if (!key.id) return null;
    const row = db
      .select({
        chatId: messagesTable.chatId,
        type: messagesTable.type,
        rawData: messagesTable.rawData,
      })
      .from(messagesTable)
      .where(and(eq(messagesTable.instanceId, this.instanceId), eq(messagesTable.id, key.id)))
      .get();
    if (!row || row.type !== "event" || !row.rawData) return null;

    try {
      const stored = JSON.parse(row.rawData, BufferJSON.reviver) as WAMessage;
      const requestedChat = await this.canonicalEventChatJid(key);
      const storedChat = await this.resolveJidToPn(row.chatId);
      const storedKey = stored.key;
      const storedAliases = new Set([storedChat]);
      for (const jid of [storedKey.remoteJid, storedKey.remoteJidAlt]) {
        if (!jid) continue;
        storedAliases.add(jidNormalizedUser(jid));
        storedAliases.add(await this.resolveJidToPn(jid));
      }
      if (requestedChat && !storedAliases.has(requestedChat)) return null;
      if (!stored.message?.messageContextInfo?.messageSecret) return null;
      return stored;
    } catch {
      return null;
    }
  }

  private async eventResponseJidCandidates(
    key: WAMessageKey,
    kind: "creator" | "responder",
    supplementalKeys: WAMessageKey[] = [],
  ): Promise<EventResponseJidCandidate[]> {
    const candidates: EventResponseJidCandidate[] = [];
    const seeds: EventResponseJidCandidate[] = [];
    const seen = new Set<string>();
    const add = (jid: string | null | undefined, candidateKind: string): void => {
      if (!jid) return;
      try {
        const normalized = jidNormalizedUser(jid);
        if (
          !normalized ||
          normalized.endsWith("@g.us") ||
          normalized.endsWith("@broadcast") ||
          seen.has(normalized)
        ) {
          return;
        }
        seen.add(normalized);
        const candidate = { jid: normalized, kind: candidateKind };
        candidates.push(candidate);
        seeds.push(candidate);
      } catch {
        // Malformed stored JIDs are ignored; remaining aliases may still be usable.
      }
    };

    const addOwnAccount = (): void => {
      const user = this.sock?.user;
      const sockId = user?.id;
      add(sockId, sockId?.endsWith("@lid") ? "own_lid" : "own_pn");
      add(user?.phoneNumber, "own_phone_number");
      const authMeId = this.authMeId;
      add(authMeId, authMeId?.endsWith("@lid") ? "auth_creds_me_lid" : "auth_creds_me_id");
      add(user?.lid, "own_lid");
      add(this.authMeLid, "auth_creds_me_lid");
    };

    const addKeyAuthor = (
      authorKey: WAMessageKey,
      keyKind: string,
      includeFromMeFields = false,
    ): void => {
      if (authorKey.fromMe) {
        addOwnAccount();
        if (!includeFromMeFields) return;
      }

      const isGroup =
        authorKey.remoteJid?.endsWith("@g.us") || authorKey.remoteJidAlt?.endsWith("@g.us");
      const fields = isGroup
        ? ([
            [authorKey.participant, `${keyKind}_participant`],
            [authorKey.participantAlt, `${keyKind}_participant_alt`],
            [authorKey.remoteJid, `${keyKind}_remote_jid`],
            [authorKey.remoteJidAlt, `${keyKind}_remote_jid_alt`],
          ] as const)
        : ([
            [authorKey.remoteJid, `${keyKind}_remote_jid`],
            [authorKey.remoteJidAlt, `${keyKind}_remote_jid_alt`],
            [authorKey.participant, `${keyKind}_participant`],
            [authorKey.participantAlt, `${keyKind}_participant_alt`],
          ] as const);
      for (const [jid, fieldKind] of fields) add(jid, fieldKind);
    };

    addKeyAuthor(key, `${kind}_stored_key`);
    for (const [index, supplementalKey] of supplementalKeys.entries()) {
      addKeyAuthor(supplementalKey, `${kind}_creation_key_${index}`, true);
    }

    const lidMapping = this.sock?.signalRepository?.lidMapping;
    for (const seed of [...seeds]) {
      if (seed.jid.endsWith("@lid") && lidMapping?.getPNForLID) {
        try {
          add(await lidMapping.getPNForLID(seed.jid), `${seed.kind}_mapped_pn`);
        } catch {
          // Mapping is best effort; retain the stored identity candidate.
        }
      } else if (seed.jid.endsWith("@s.whatsapp.net") && lidMapping?.getLIDForPN) {
        try {
          add(await lidMapping.getLIDForPN(seed.jid), `${seed.kind}_mapped_lid`);
        } catch {
          // Mapping is best effort; retain the stored identity candidate.
        }
      }
    }

    return candidates;
  }

  private async decryptStoredEventResponse(
    encrypted: proto.Message.IEncEventResponseMessage,
    responseKey: WAMessageKey,
  ): Promise<StoredEventResponseDecryptResult> {
    const eventKey = encrypted.eventCreationMessageKey;
    if (!eventKey?.id) return { status: "missing" };
    const storedEvent = await this.getStoredEventMessage(eventKey);
    const messageSecret = storedEvent?.message?.messageContextInfo?.messageSecret;
    if (!storedEvent?.key || !messageSecret) return { status: "missing" };

    const creatorCandidates = await this.eventResponseJidCandidates(storedEvent.key, "creator", [
      eventKey,
    ]);
    const responderCandidates = await this.eventResponseJidCandidates(responseKey, "responder");
    const responder =
      (await this.canonicalEventAuthorJid(responseKey)) ||
      responderCandidates.find((candidate) => candidate.jid.endsWith("@s.whatsapp.net"))?.jid ||
      responderCandidates[0]?.jid ||
      "";
    const chatId = await this.canonicalEventChatJid(storedEvent.key);
    if (!responder || !chatId) {
      logger.debug(
        {
          instanceId: this.instanceId,
          eventMessageId: eventKey.id,
          attempts: 0,
          candidateJidsTried: { creator: [], responder: [] },
        },
        "Unable to decrypt event response",
      );
      return { status: "failed", attemptedCombinations: 0, allCandidatesTried: false };
    }

    let attemptedCombinations = 0;
    const triedCreatorIndices = new Set<number>();
    const triedResponderIndices = new Set<number>();
    for (const [creatorCandidateIndex, creatorCandidate] of creatorCandidates.entries()) {
      for (const [responderCandidateIndex, responderCandidate] of responderCandidates.entries()) {
        if (attemptedCombinations >= MAX_EVENT_RESPONSE_DECRYPT_ATTEMPTS) break;
        attemptedCombinations += 1;
        triedCreatorIndices.add(creatorCandidateIndex);
        triedResponderIndices.add(responderCandidateIndex);
        try {
          const decrypted = decryptEventResponse(encrypted, {
            eventCreatorJid: creatorCandidate.jid,
            eventMsgId: eventKey.id,
            eventEncKey: messageSecret,
            responderJid: responderCandidate.jid,
          });
          const decoded = decodeEventResponseMessage(decrypted);
          const timestampValue = decoded?.timestampMs;
          const timestamp =
            timestampValue === null || timestampValue === undefined
              ? null
              : Number(timestampValue.toString());
          if (attemptedCombinations > 1) {
            logger.debug(
              {
                instanceId: this.instanceId,
                eventMessageId: eventKey.id,
                attempts: attemptedCombinations,
                creatorCandidateIndex,
                creatorKind: creatorCandidate.kind,
                creatorJid: creatorCandidate.jid,
                responderCandidateIndex,
                responderKind: responderCandidate.kind,
                responderJid: responderCandidate.jid,
              },
              "Decrypted event response with an alternate JID combination",
            );
          }
          return {
            status: "decrypted",
            attemptedCombinations,
            value: {
              eventMessageId: eventKey.id,
              chatId,
              responder,
              response: eventResponseName(decoded?.response),
              timestamp: timestamp !== null && Number.isFinite(timestamp) ? timestamp : null,
              extraGuestCount:
                typeof decoded?.extraGuestCount === "number" &&
                Number.isFinite(decoded.extraGuestCount)
                  ? decoded.extraGuestCount
                  : null,
            },
          };
        } catch {
          // A different LID/PN combination may match the encrypted payload.
        }
      }
      if (attemptedCombinations >= MAX_EVENT_RESPONSE_DECRYPT_ATTEMPTS) break;
    }

    logger.debug(
      {
        instanceId: this.instanceId,
        eventMessageId: eventKey.id,
        attempts: attemptedCombinations,
        candidateJidsTried: {
          creator: [...triedCreatorIndices].map((index) => ({
            index,
            ...creatorCandidates[index],
          })),
          responder: [...triedResponderIndices].map((index) => ({
            index,
            ...responderCandidates[index],
          })),
        },
      },
      "Unable to decrypt event response",
    );
    return {
      status: "failed",
      attemptedCombinations,
      allCandidatesTried:
        attemptedCombinations === creatorCandidates.length * responderCandidates.length,
    };
  }

  private persistResolvedEventResponse(
    response: {
      eventMessageId: string;
      chatId: string;
      responder: string;
      response: EventResponseStatus;
      timestamp: number | null;
      responseMessageId: string | null;
      extraGuestCount: number | null;
      rawData: string | null;
    },
    emitEvent = true,
  ): void {
    const previous = db
      .select()
      .from(eventResponsesTable)
      .where(
        and(
          eq(eventResponsesTable.instanceId, this.instanceId),
          eq(eventResponsesTable.eventMessageId, response.eventMessageId),
          eq(eventResponsesTable.responder, response.responder),
        ),
      )
      .get();

    if (previous && previous.response !== "UNKNOWN" && response.response === "UNKNOWN") {
      return;
    }

    if (
      previous &&
      previous.response !== "UNKNOWN" &&
      previous.timestamp !== null &&
      response.timestamp !== null &&
      response.timestamp < previous.timestamp
    ) {
      return;
    }

    const changed =
      !previous ||
      previous.response !== response.response ||
      previous.timestamp !== response.timestamp ||
      previous.responseMessageId !== response.responseMessageId ||
      previous.extraGuestCount !== response.extraGuestCount;

    db.insert(eventResponsesTable)
      .values({
        instanceId: this.instanceId,
        eventMessageId: response.eventMessageId,
        chatId: response.chatId,
        responder: response.responder,
        response: response.response,
        timestamp: response.timestamp,
        responseMessageId: response.responseMessageId,
        extraGuestCount: response.extraGuestCount,
        rawData: response.rawData,
      })
      .onConflictDoUpdate({
        target: [
          eventResponsesTable.instanceId,
          eventResponsesTable.eventMessageId,
          eventResponsesTable.responder,
        ],
        set: {
          chatId: response.chatId,
          response: response.response,
          timestamp: response.timestamp,
          responseMessageId: response.responseMessageId,
          extraGuestCount: response.extraGuestCount,
          rawData: response.rawData,
        },
      })
      .run();

    if (!emitEvent || !changed) return;
    this.emit("event.response", {
      instanceId: this.instanceId,
      chatId: response.chatId,
      eventMessageId: response.eventMessageId,
      participant: response.responder,
      responseMessageId: response.responseMessageId,
      status: response.response,
      timestamp: response.timestamp,
      ...(response.extraGuestCount === null ? {} : { extraGuestCount: response.extraGuestCount }),
    });
  }

  private async persistEventResponses(
    key: WAMessageKey,
    responses: proto.IEventResponse[],
  ): Promise<void> {
    const eventMessageId = key.id;
    if (!eventMessageId || !key.remoteJid) return;
    const chatId = await this.canonicalEventChatJid(key);

    for (const entry of responses) {
      const responseKey = entry.eventResponseMessageKey;
      if (!responseKey) continue;
      const responder = await this.canonicalEventAuthorJid(responseKey);
      if (!responder) continue;
      const eventResponse = entry as proto.IEventResponse & {
        senderTimestampMs?: unknown;
        response?: unknown;
        eventResponse?: unknown;
      };
      const responseMessage = decodeEventResponseMessage(eventResponse);
      const timestampValue =
        eventResponse.senderTimestampMs ?? responseMessage?.timestampMs ?? entry.timestampMs;
      const timestamp = this.timestampValueToMilliseconds(timestampValue);
      this.persistResolvedEventResponse({
        eventMessageId,
        chatId,
        responder,
        response: eventResponseName(responseMessage?.response),
        timestamp,
        responseMessageId: responseKey.id ?? null,
        extraGuestCount:
          typeof responseMessage?.extraGuestCount === "number" &&
          Number.isFinite(responseMessage.extraGuestCount)
            ? responseMessage.extraGuestCount
            : null,
        rawData: JSON.stringify(entry, BufferJSON.replacer),
      });
    }
  }

  private timestampValueToMilliseconds(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const timestamp = Number(
      typeof value === "object" && value !== null && "toString" in value
        ? (value as { toString(): string }).toString()
        : value,
    );
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  private async persistEncryptedEventResponse(
    message: WAMessage,
    encrypted: proto.Message.IEncEventResponseMessage,
  ): Promise<void> {
    const eventKey = encrypted.eventCreationMessageKey;
    if (!eventKey?.id || !eventKey.remoteJid) return;
    const responder = await this.canonicalEventAuthorJid(message.key);
    if (!responder) return;
    const chatId = await this.canonicalEventChatJid(eventKey);
    const rawData = serializeIncomingMessage(message);
    const decrypted = await this.decryptStoredEventResponse(encrypted, message.key);
    if (decrypted.status === "decrypted") {
      this.persistResolvedEventResponse({
        ...decrypted.value,
        responseMessageId: message.key.id ?? null,
        rawData,
      });
      return;
    }

    this.persistResolvedEventResponse(
      {
        eventMessageId: eventKey.id,
        chatId,
        responder,
        response: "UNKNOWN",
        timestamp: messageTimestampToMilliseconds(message.messageTimestamp, 0) || null,
        responseMessageId: message.key.id ?? null,
        extraGuestCount: null,
        rawData,
      },
      false,
    );
  }

  private async retryPendingEventResponses(eventMessageId?: string): Promise<void> {
    const conditions = [
      eq(eventResponsesTable.instanceId, this.instanceId),
      eq(eventResponsesTable.response, "UNKNOWN"),
    ];
    if (eventMessageId) conditions.push(eq(eventResponsesTable.eventMessageId, eventMessageId));
    const pending = db
      .select()
      .from(eventResponsesTable)
      .where(and(...conditions))
      .all();

    for (const row of pending) {
      if (!row.rawData) continue;
      try {
        const stored: unknown = JSON.parse(row.rawData, BufferJSON.reviver);
        if (isStoredEventResponseEntry(stored)) {
          const responseKey = isRecord(stored.eventResponseMessageKey)
            ? (stored.eventResponseMessageKey as WAMessageKey)
            : undefined;
          const decoded = decodeEventResponseMessage(stored);
          const responderFromKey = responseKey
            ? await this.canonicalEventAuthorJid(responseKey)
            : "";
          const responder =
            responderFromKey ||
            (await this.canonicalEventAuthorJid({
              remoteJid: row.chatId,
              participant: row.responder,
              fromMe: false,
            }));
          if (!responder) continue;
          const chatFromKey = responseKey ? await this.canonicalEventChatJid(responseKey) : "";
          const chatId = chatFromKey || (await this.resolveJidToPn(row.chatId));
          this.persistResolvedEventResponse({
            eventMessageId: row.eventMessageId,
            chatId,
            responder,
            response: eventResponseName(decoded?.response),
            timestamp: this.timestampValueToMilliseconds(
              stored.senderTimestampMs ?? decoded?.timestampMs ?? stored.timestampMs,
            ),
            responseMessageId: responseKey?.id ?? row.responseMessageId,
            extraGuestCount:
              typeof decoded?.extraGuestCount === "number" &&
              Number.isFinite(decoded.extraGuestCount)
                ? decoded.extraGuestCount
                : null,
            rawData: row.rawData,
          });
          if (row.responder !== responder) {
            db.delete(eventResponsesTable)
              .where(
                and(
                  eq(eventResponsesTable.instanceId, this.instanceId),
                  eq(eventResponsesTable.eventMessageId, row.eventMessageId),
                  eq(eventResponsesTable.responder, row.responder),
                  eq(eventResponsesTable.response, "UNKNOWN"),
                ),
              )
              .run();
          }
          continue;
        }

        if (!isRecord(stored)) continue;
        const message = stored as unknown as WAMessage;
        const content = unwrapMessageContent(message.message, { unwrapProtocolEdits: false });
        const encrypted = content?.encEventResponseMessage;
        if (!encrypted) continue;
        const decrypted = await this.decryptStoredEventResponse(encrypted, message.key);
        if (decrypted.status !== "decrypted") continue;
        this.persistResolvedEventResponse({
          ...decrypted.value,
          responseMessageId: message.key.id ?? row.responseMessageId,
          rawData: row.rawData,
        });
        if (row.responder !== decrypted.value.responder) {
          db.delete(eventResponsesTable)
            .where(
              and(
                eq(eventResponsesTable.instanceId, this.instanceId),
                eq(eventResponsesTable.eventMessageId, row.eventMessageId),
                eq(eventResponsesTable.responder, row.responder),
                eq(eventResponsesTable.response, "UNKNOWN"),
              ),
            )
            .run();
        }
      } catch (error) {
        logger.debug(
          { instanceId: this.instanceId, eventMessageId: row.eventMessageId, error },
          "Unable to retry pending event response decryption",
        );
      }
    }
  }

  private async getUnknownEventResponseDetails(row: {
    eventMessageId: string;
    rawData: string | null;
  }): Promise<{
    unknownReason: EventResponseUnknownReason;
    recoverable: boolean;
    attemptedCombinations?: number;
  }> {
    const details = (unknownReason: EventResponseUnknownReason) => ({
      unknownReason,
      recoverable:
        unknownReason !== "missing_payload" &&
        unknownReason !== "missing_event_secret" &&
        unknownReason !== "decrypt_failed_all_candidates",
    });
    if (!row.rawData) return details("missing_payload");

    let stored: unknown;
    try {
      stored = JSON.parse(row.rawData, BufferJSON.reviver);
    } catch {
      return details("unrecognized_response");
    }

    if (isStoredEventResponseEntry(stored)) {
      const unknownReason =
        eventResponseName(decodeEventResponseMessage(stored)?.response) === "UNKNOWN"
          ? "unrecognized_response"
          : "decrypt_failed";
      return {
        ...details(unknownReason),
        ...(unknownReason === "decrypt_failed" ? { attemptedCombinations: 0 } : {}),
      };
    }
    if (!isRecord(stored)) return details("unrecognized_response");

    const message = stored as unknown as WAMessage;
    const content = unwrapMessageContent(message.message, { unwrapProtocolEdits: false });
    const encrypted = content?.encEventResponseMessage as
      proto.Message.IEncEventResponseMessage | undefined;
    if (!encrypted?.eventCreationMessageKey?.id) return details("unrecognized_response");

    const event = db
      .select({ type: messagesTable.type, rawData: messagesTable.rawData })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.instanceId, this.instanceId),
          eq(messagesTable.id, encrypted.eventCreationMessageKey.id),
        ),
      )
      .get();
    if (!event || event.type !== "event" || !event.rawData) {
      return details("missing_event_secret");
    }

    try {
      const eventMessage = JSON.parse(event.rawData, BufferJSON.reviver) as WAMessage;
      if (!eventMessage.message?.messageContextInfo?.messageSecret) {
        return details("missing_event_secret");
      }
    } catch {
      return details("missing_event_secret");
    }

    const decrypted = await this.decryptStoredEventResponse(encrypted, message.key);
    if (decrypted.status === "failed") {
      return {
        ...details(
          decrypted.attemptedCombinations > 0 && decrypted.allCandidatesTried
            ? "decrypt_failed_all_candidates"
            : "decrypt_failed",
        ),
        attemptedCombinations: decrypted.attemptedCombinations,
      };
    }
    if (decrypted.status === "missing") {
      return { ...details("decrypt_failed"), attemptedCombinations: 0 };
    }
    const unknownReason =
      decrypted.value.response === "UNKNOWN" ? "unrecognized_response" : "decrypt_failed";
    return {
      ...details(unknownReason),
      ...(unknownReason === "decrypt_failed"
        ? { attemptedCombinations: decrypted.attemptedCombinations }
        : {}),
    };
  }

  private persistChats(chats: Array<{ id?: string | null; name?: string | null }>): void {
    for (const chat of chats) {
      const jid = chat.id?.trim();
      if (!jid) continue;

      const name = chat.name?.trim() || null;
      const isGroup = jid.endsWith("@g.us") ? 1 : 0;
      db.insert(chatsTable)
        .values({
          instanceId: this.instanceId,
          jid,
          name,
          isGroup,
          updatedAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: [chatsTable.instanceId, chatsTable.jid],
          set: {
            name: sql`coalesce(excluded.name, ${chatsTable.name})`,
            isGroup,
            updatedAt: Date.now(),
          },
        })
        .run();
    }
  }

  private updateMessageStatus(
    messageId: string,
    status: MessageDeliveryStatus,
    chatId?: string,
    isFromMe?: number,
  ): void {
    try {
      const filters = [
        eq(messagesTable.instanceId, this.instanceId),
        eq(messagesTable.id, messageId),
        ne(messagesTable.status, "revoked"),
      ];
      if (chatId !== undefined) filters.push(eq(messagesTable.chatId, chatId));
      if (isFromMe !== undefined) filters.push(eq(messagesTable.isFromMe, isFromMe));

      db.update(messagesTable)
        .set({ status })
        .where(and(...filters))
        .run();
    } catch (err) {
      logger.error({ err, messageId }, "Failed to update message status");
    }
  }

  private persistStatusAudience(messageId: string, recipientJids: string[]): void {
    try {
      db.insert(statusAudiencesTable)
        .values({
          instanceId: this.instanceId,
          messageId,
          recipientJids: JSON.stringify(recipientJids),
          createdAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: [statusAudiencesTable.instanceId, statusAudiencesTable.messageId],
          set: { recipientJids: JSON.stringify(recipientJids), createdAt: Date.now() },
        })
        .run();
    } catch (err) {
      logger.error(
        { err, instanceId: this.instanceId, messageId },
        "Failed to persist status audience",
      );
    }
  }

  private getStoredStatusAudience(messageId: string): string[] | undefined {
    try {
      const row = db
        .select({ recipientJids: statusAudiencesTable.recipientJids })
        .from(statusAudiencesTable)
        .where(
          and(
            eq(statusAudiencesTable.instanceId, this.instanceId),
            eq(statusAudiencesTable.messageId, messageId),
          ),
        )
        .get();
      if (!row) return undefined;

      const parsed: unknown = JSON.parse(row.recipientJids);
      if (
        !Array.isArray(parsed) ||
        !parsed.every(
          (jid): jid is string => typeof jid === "string" && isValidStatusRecipient(jid),
        )
      ) {
        return undefined;
      }
      return parsed;
    } catch (err) {
      logger.warn(
        { err, instanceId: this.instanceId, messageId },
        "Failed to read stored status audience",
      );
      return undefined;
    }
  }

  // ---- Events ----

  on<E extends ChannelEvent>(event: E, handler: ChannelEventHandler<E>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler as ChannelEventHandler<ChannelEvent>);
  }

  off<E extends ChannelEvent>(event: E, handler: ChannelEventHandler<E>): void {
    this.listeners.get(event)?.delete(handler as ChannelEventHandler<ChannelEvent>);
  }

  // ---- Private event helpers ----

  private emit<E extends ChannelEvent>(event: E, payload: ChannelEventPayload[E]): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(payload as ChannelEventPayload[ChannelEvent]);
        } catch (err) {
          logger.error({ err, event }, "Error in event handler");
        }
      }
    }
  }

  private bindEvents(sock: WASocket): void {
    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrCode = qr;
        this.status = "qr_pending";

        if (this.pairingPhone && sock) {
          // Evolution API pattern: call requestPairingCode inside the QR event, with a small delay
          setTimeout(async () => {
            try {
              const code = await sock.requestPairingCode(this.pairingPhone!);
              this.pairingCodeValue = code ?? null;
              if (this.pairingCodeResolver) {
                this.pairingCodeResolver(this.pairingCodeValue);
                this.pairingCodeResolver = null;
              }
              logger.info({ instanceId: this.instanceId, code }, "Pairing code generated");
            } catch (err) {
              logger.error({ instanceId: this.instanceId, err }, "Failed to generate pairing code");
              if (this.pairingCodeResolver) {
                this.pairingCodeResolver(null);
                this.pairingCodeResolver = null;
              }
            }
          }, 1000);
        }
      }

      if (connection === "open") {
        this.status = "connected";
        this.qrCode = null;
        this.pairingPhone = null;
        this.pairingCodeValue = null;
        this.pairingCodeResolver = null;
        this.reconnectAttempt = 0;
        logger.info({ instanceId: this.instanceId }, "Connected to WhatsApp");
      }

      if (connection === "close") {
        this.status = "disconnected";
        const boom = (lastDisconnect?.error as Boom)?.output;
        const statusCode = boom?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          logger.info({ instanceId: this.instanceId }, "Logged out, clearing auth");
          clearAuthState(this.instanceId);
          this.sock = null;
        } else if (this.autoReconnect) {
          this.scheduleReconnect();
        }
      }

      const normalized = normalizeConnectionUpdate(this.instanceId, update);
      if (normalized) {
        this.emit("connection.changed", normalized);
      }
    });

    // creds.update is not buffered — use ev.on directly
    sock.ev.on("creds.update", async () => {
      await this.saveCreds?.();
    });

    const resolveLidToPn: ContactPnResolver = async (lid) => {
      try {
        return await sock.signalRepository.lidMapping.getPNForLID(lid);
      } catch (error) {
        logger.debug({ instanceId: this.instanceId, lid, error }, "Failed to resolve contact LID");
        return null;
      }
    };

    const persistContacts = async (contacts: ContactSyncRecord[]) => {
      await this.contactStore.upsertContacts(contacts, resolveLidToPn);
    };

    // Use ev.process() to receive ALL buffered events after sync flush
    const processEvents = async (events: Partial<BaileysEventMap>) => {
      const eventKeys = Object.keys(events);
      if (eventKeys.length > 0) {
        logger.info({ instanceId: this.instanceId, events: eventKeys }, "ev.process fired");
      }

      // --- LID Mapping (v7+): store LID <-> PN mappings ---
      if (events["lid-mapping.update"]) {
        const mapping = events["lid-mapping.update"];
        this.contactStore.updateLidMapping(mapping.lid, mapping.pn);
        await this.retryPendingEventResponses();
        logger.info(
          { instanceId: this.instanceId, lid: mapping.lid, pn: mapping.pn },
          "LID mapping updated",
        );
      }

      // --- Chats: extract phonebook names from chat metadata ---
      if (events["chats.upsert"]) {
        this.persistChats(events["chats.upsert"]);
        const namedChats = events["chats.upsert"].filter(
          (ch): ch is typeof ch & { id: string; name: string } =>
            !!ch.id && !!ch.name && isContactEligibleChatNameJid(ch.id),
        );
        if (namedChats.length > 0) {
          await persistContacts(namedChats.map((ch) => ({ id: ch.id, name: ch.name })));
          logger.info(
            { instanceId: this.instanceId, count: namedChats.length },
            "Contacts persisted from chat names (chats.upsert)",
          );
        }
      }

      if (events["chats.update"]) {
        this.persistChats(events["chats.update"]);
        const namedChats = events["chats.update"].filter(
          (ch): ch is typeof ch & { id: string; name: string } =>
            !!ch.id && !!ch.name && isContactEligibleChatNameJid(ch.id),
        );
        if (namedChats.length > 0) {
          await persistContacts(namedChats.map((ch) => ({ id: ch.id, name: ch.name })));
          logger.info(
            { instanceId: this.instanceId, count: namedChats.length },
            "Contacts persisted from chat names (chats.update)",
          );
        }
      }

      // --- Contacts (arrives buffered during initial sync) ---
      if (events["contacts.upsert"]) {
        const contacts = events["contacts.upsert"];
        await persistContacts(contacts);
        logger.info(
          { instanceId: this.instanceId, count: contacts.length },
          "Contacts persisted (upsert)",
        );
      }

      if (events["contacts.update"]) {
        await persistContacts(events["contacts.update"]);
        const normalized = normalizeContactsUpdate(this.instanceId, events["contacts.update"]);
        for (const event of normalized) this.emit("contact.updated", event);
      }

      // --- History sync: contacts arrive here during first sync ---
      if (events["messaging-history.set"]) {
        const {
          contacts = [],
          chats = [],
          messages = [],
          syncType,
          peerDataRequestSessionId,
        } = events["messaging-history.set"];
        this.persistChats(chats);
        const contactCount = contacts.filter((contact) => contact.id).length;
        const chatContactCount = chats.filter(
          (chat) =>
            !!chat.id &&
            !!chat.name &&
            !chat.id.endsWith("@g.us") &&
            !chat.id.endsWith("@broadcast"),
        ).length;
        await this.contactStore.handleHistorySync({ contacts, chats }, resolveLidToPn);
        if (contactCount > 0) {
          logger.info(
            { instanceId: this.instanceId, contacts: contactCount, chats: chats.length },
            "Contacts persisted (history sync)",
          );
        }
        if (chatContactCount > 0) {
          logger.info(
            { instanceId: this.instanceId, chatContacts: chatContactCount },
            "Contacts persisted from chat names",
          );
        }

        if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
          const waiter = this.activeHistoryFetch;
          const sessionMatchesWaiter =
            !!waiter &&
            (peerDataRequestSessionId == null ||
              peerDataRequestSessionId === waiter.peerDataRequestSessionId);
          if (sessionMatchesWaiter) waiter.receivedMatchingHistorySet = true;

          for (const message of messages) {
            const inserted = this.persistSourceMessage(message);
            const content = unwrapMessageContent(message.message, {
              unwrapProtocolEdits: false,
            });
            if (content?.encEventResponseMessage) {
              await this.persistEncryptedEventResponse(message, content.encEventResponseMessage);
            }
            if (content?.eventMessage && message.key.id) {
              await this.retryPendingEventResponses(message.key.id);
            }
            const messageChatId = message.key.remoteJid ?? "";
            if (
              inserted &&
              sessionMatchesWaiter &&
              waiter &&
              messageChatId === waiter.chatId &&
              message.key.id &&
              !waiter.seenMessageIds.has(message.key.id)
            ) {
              waiter.seenMessageIds.add(message.key.id);
              waiter.stored++;
            }
          }
        }
      }

      if (events["messaging-history.status"]) {
        const historyStatus = events["messaging-history.status"];
        const waiter = this.activeHistoryFetch;
        const statusSessionId = (
          historyStatus as typeof historyStatus & { peerDataRequestSessionId?: string | null }
        ).peerDataRequestSessionId;
        if (
          historyStatus.syncType === proto.HistorySync.HistorySyncType.ON_DEMAND &&
          historyStatus.status === "complete" &&
          waiter?.receivedMatchingHistorySet &&
          (statusSessionId == null || statusSessionId === waiter.peerDataRequestSessionId)
        ) {
          this.finishHistoryFetch(false, waiter);
        }
      }

      // --- Messages ---
      if (events["messages.upsert"]) {
        const data = events["messages.upsert"];
        logger.info(
          { instanceId: this.instanceId, type: data.type, count: data.messages.length },
          "messages.upsert event received",
        );
        for (const msg of data.messages) {
          normalizeLidInMessage(msg);
          const unwrappedContent = unwrapMessageContent(msg.message, {
            unwrapProtocolEdits: false,
          });
          const protocolMessage = unwrappedContent?.protocolMessage as
            NonNullable<WAMessage["message"]>["protocolMessage"] | undefined;

          if (protocolMessage?.type === 14) {
            const editEvent = normalizeMessageEdit(
              this.instanceId,
              msg,
              msg.key.remoteJid ?? "",
              unwrappedContent,
            );
            this.emit("message.edited", editEvent);
            continue;
          }

          if (msg.pushName && msg.key.remoteJid && !msg.key.fromMe) {
            await persistContacts([{ id: msg.key.remoteJid, notify: msg.pushName }]);
          }

          // Persist ALL messages (notify + append) to DB
          if (msg.key.id && msg.key.remoteJid && !protocolMessage) {
            const details = extractMessageDetails(msg);
            const normalized: NormalizedMessageEvent = {
              instanceId: this.instanceId,
              chatId: getChatJid(msg),
              message: {
                id: msg.key.id,
                sender: getSenderJid(msg),
                timestamp: messageTimestampToSeconds(msg.messageTimestamp, 0),
                type: details.type,
                content: details.content,
                mediaUrl: details.mediaUrl,
                ...(details.mediaMimetype ? { mediaMimetype: details.mediaMimetype } : {}),
                ...(details.buttons ? { buttons: details.buttons } : {}),
                ...(details.rawType ? { rawType: details.rawType } : {}),
                quotedMessageId: extractQuotedMessageId(msg),
                isFromMe: msg.key.fromMe ?? false,
              },
            };
            this.persistMessage(normalized, msg);
          }

          if (unwrappedContent?.encEventResponseMessage) {
            await this.persistEncryptedEventResponse(msg, unwrappedContent.encEventResponseMessage);
          }
          if (unwrappedContent?.eventMessage && msg.key.id) {
            await this.retryPendingEventResponses(msg.key.id);
          }
        }

        scheduleBaileysMessagesRead(this, data.type, data.messages, this.instanceId);

        // Emit events only for incoming notify-type messages (not our own sends)
        const notifyEvents = normalizeMessagesUpsert(this.instanceId, data);
        logger.info(
          { instanceId: this.instanceId, notifyCount: notifyEvents.length },
          "Notify messages for emission",
        );
        for (const event of notifyEvents) {
          this.emit("message.received", this.attachMessageLabels(event));
        }
      }

      if (events["messages.update"]) {
        for (const update of events["messages.update"]) {
          if (update.key.id && update.key.remoteJid && typeof update.update.starred === "boolean") {
            db.update(messagesTable)
              .set({ starred: update.update.starred ? 1 : 0 })
              .where(
                and(
                  eq(messagesTable.instanceId, this.instanceId),
                  eq(messagesTable.chatId, update.key.remoteJid),
                  eq(messagesTable.id, update.key.id),
                ),
              )
              .run();
          }
          if (update.key.id && update.key.remoteJid && update.update.eventResponses) {
            await this.persistEventResponses(update.key, update.update.eventResponses);
          }
        }
        const normalized = normalizeMessagesUpdate(this.instanceId, events["messages.update"]);
        for (const event of normalized) {
          this.updateMessageStatus(event.messageId, event.status);
          this.emit("message.updated", event);
        }
      }

      if (events["messages.delete"]) {
        const normalized = normalizeMessagesDelete(this.instanceId, events["messages.delete"]);
        for (const event of normalized) this.emit("message.deleted", event);
      }

      if (events["messages.reaction"]) {
        const normalized = normalizeMessagesReaction(this.instanceId, events["messages.reaction"]);
        for (const event of normalized) this.emit("message.reaction", event);
      }

      // --- Presence ---
      if (events["presence.update"]) {
        const normalized = normalizePresenceUpdate(this.instanceId, events["presence.update"]);
        for (const event of normalized) this.emit("presence.updated", event);
      }

      // --- Groups ---
      if (events["groups.update"]) {
        const normalized = normalizeGroupsUpdate(this.instanceId, events["groups.update"]);
        for (const event of normalized) this.emit("group.updated", event);
      }

      if (events["group-participants.update"]) {
        const event = normalizeGroupParticipantsUpdate(
          this.instanceId,
          events["group-participants.update"],
        );
        this.emit("group.participants_changed", event);
      }

      // --- Calls ---
      if (events["call"]) {
        const normalized = normalizeCallEvent(this.instanceId, events["call"]);
        for (const event of normalized) this.emit("call.received", event);
      }

      if (events["labels.edit"]) {
        const label = events["labels.edit"];
        const normalizedLabel: BusinessLabel = {
          id: label.id,
          name: label.name,
          color: label.color,
          deleted: label.deleted,
          ...(label.predefinedId ? { predefinedId: label.predefinedId } : {}),
        };
        this.persistLabel(normalizedLabel);
        this.emit("label.updated", {
          instanceId: this.instanceId,
          action: "edited",
          label: normalizedLabel,
        });
      }

      if (events["labels.association"]) {
        const { association, type } = events["labels.association"];
        const associationType = association.type === "label_jid" ? "chat" : "message";
        const chatId = association.chatId;
        const messageId = association.type === "label_message" ? association.messageId : undefined;
        this.persistLabelAssociation(
          association.labelId,
          associationType,
          chatId,
          messageId,
          type === "add",
        );
        const storedLabel = db
          .select()
          .from(labelsTable)
          .where(
            and(
              eq(labelsTable.instanceId, this.instanceId),
              eq(labelsTable.id, association.labelId),
            ),
          )
          .get();
        const label: BusinessLabel = storedLabel
          ? {
              id: storedLabel.id,
              name: storedLabel.name,
              color: storedLabel.color,
              deleted: storedLabel.deleted === 1,
              ...(storedLabel.predefinedId ? { predefinedId: storedLabel.predefinedId } : {}),
            }
          : { id: association.labelId, name: association.labelId, color: 0, deleted: false };
        const labelEvent: NormalizedLabelUpdateEvent = {
          instanceId: this.instanceId,
          action: type === "add" ? "associated" : "disassociated",
          label,
          chatId,
          association: {
            type: associationType,
            chatId,
            ...(messageId ? { messageId } : {}),
          },
        };
        this.emit("label.updated", labelEvent);
      }
    };

    sock.ev.process((events) => {
      const processing = processEvents(events);
      const tracked = processing.catch((error: unknown) => {
        logger.error(
          { instanceId: this.instanceId, error },
          "Buffered Baileys event processing failed",
        );
      });
      this.pendingSocketEventProcessing = Promise.all([
        this.pendingSocketEventProcessing,
        tracked,
      ]).then(() => undefined);
      return processing;
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      logger.error(
        { instanceId: this.instanceId, attempts: this.reconnectAttempt },
        "Max reconnect attempts reached",
      );
      return;
    }

    const delay = Math.min(
      RECONNECT_INITIAL_DELAY_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_DELAY_MS,
    );

    this.reconnectAttempt++;
    logger.info(
      { instanceId: this.instanceId, attempt: this.reconnectAttempt, delayMs: delay },
      "Scheduling reconnect",
    );

    this.reconnectTimer = setTimeout(async () => {
      try {
        this.sock = null;
        await this.connect();
      } catch (err) {
        logger.error({ err, instanceId: this.instanceId }, "Reconnect failed");
        this.scheduleReconnect();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
  }
}
