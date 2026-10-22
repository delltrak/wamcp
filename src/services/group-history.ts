import { createHash } from "node:crypto";
import { UnrecoverableError } from "bullmq";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import type { ChannelAdapter } from "../channels/channel.interface.js";
import {
  publishOwnDirectParticipantAdds,
  subscribeOwnDirectParticipantAdds,
  type OwnDirectParticipantAdd,
} from "../channels/baileys/group-history-event.js";
import type { GroupParticipant, Message } from "../types/channel.types.js";
import type { InstanceManager } from "./instance-manager.js";
import type { MessageQueue } from "./message-queue.js";
import { normalizeGroupJid } from "../utils/group-jid.js";
import { assertGroupHistoryWritesEnabled } from "../utils/group-history-error.js";
import { createChildLogger } from "../utils/logger.js";

const logger = createChildLogger({ service: "group-history" });

export const DEFAULT_GROUP_HISTORY_COUNT = 50;
export const MIN_GROUP_HISTORY_COUNT = 25;
export const MAX_GROUP_HISTORY_COUNT = 100;
export const MAX_GROUP_HISTORY_CHUNK_CHARS = 4_000;
export const MAX_GROUP_HISTORY_LINE_CHARS = 400;
export const MAX_GROUP_HISTORY_CHUNKS = 5;
export const MAX_GROUP_HISTORY_SCAN = 1_000;

export const GROUP_HISTORY_NOT_A_MEMBER_MESSAGE =
  "Participant is not a current member of this group.";
export const GROUP_HISTORY_EPHEMERAL_MESSAGE =
  "This group uses disappearing messages, so its history is not copied into a permanent direct message.";

export interface GroupHistoryCount {
  requestedCount: number;
  count: number;
  clamped: boolean;
}

export interface GroupHistorySendResult extends GroupHistoryCount {
  messagesIncluded: number;
  chunksSent: number;
  omittedMessages: number;
  note?: string;
}

export interface GroupHistoryChunkLimits {
  maxChars?: number;
  maxChunks?: number;
  maxLineChars?: number;
}

type GroupHistoryStubClaim = (instanceId: string, messageId: string) => boolean | Promise<boolean>;

export function clampGroupHistoryCount(requested?: number): GroupHistoryCount {
  const requestedCount = requested ?? DEFAULT_GROUP_HISTORY_COUNT;
  const count = Math.min(
    MAX_GROUP_HISTORY_COUNT,
    Math.max(MIN_GROUP_HISTORY_COUNT, requestedCount),
  );
  return { requestedCount, count, clamped: count !== requestedCount };
}

export function getGroupHistoryOnJoinCount(
  value = process.env.WA_GROUP_HISTORY_ON_JOIN_COUNT,
): number {
  if (value === undefined || value.trim() === "") return DEFAULT_GROUP_HISTORY_COUNT;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error("Invalid WA_GROUP_HISTORY_ON_JOIN_COUNT; expected an integer");
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Invalid WA_GROUP_HISTORY_ON_JOIN_COUNT; expected an integer");
  }
  return clampGroupHistoryCount(parsed).count;
}

export function isGroupHistoryOnJoinEnabled(value = process.env.WA_GROUP_HISTORY_ON_JOIN): boolean {
  if (value === undefined || value.trim() === "") return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error("Invalid WA_GROUP_HISTORY_ON_JOIN; expected true or false");
}

export function assertGroupHistoryOnJoinConfig(): void {
  isGroupHistoryOnJoinEnabled();
  getGroupHistoryOnJoinCount();
}

export function normalizeGroupHistoryParticipant(input: string): string {
  const value = input.trim();
  if (value.includes("@")) return value;
  return `${value.replace(/\D/g, "")}@s.whatsapp.net`;
}

function normalizeIdentity(input: string): string {
  const value = input
    .trim()
    .toLowerCase()
    .replace(/:\d+(?=@)/, "");
  return value.endsWith("@c.us") ? value.replace(/@c\.us$/, "@s.whatsapp.net") : value;
}

function identityKeys(input: string): string[] {
  const normalized = normalizeIdentity(input);
  const local = normalized.split("@", 1)[0]?.replace(/:\d+$/, "") ?? normalized;
  return [normalized, local, `${local}@s.whatsapp.net`];
}

function cleanSingleLine(input: string | null | undefined): string {
  return (input ?? "")
    .replace(/\r\n?|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function senderDisplayName(
  message: Message,
  contacts: Awaited<ReturnType<ChannelAdapter["getContacts"]>>,
  own: ReturnType<NonNullable<ChannelAdapter["getLifecycleStatus"]>> | undefined,
): string {
  const sender = message.senderId;
  const ownIds = [own?.phone, own?.lid].filter((value): value is string => !!value);
  if (message.isFromMe || sender === "me") {
    const name = cleanSingleLine(message.pushName ?? own?.pushName);
    if (name) return name;
    return ownIds[0] ? identityKeys(ownIds[0])[1]! : "me";
  }

  const senderKeys = new Set(identityKeys(sender));
  const contact = contacts.find((candidate) => {
    const candidateKeys = [candidate.jid, candidate.phone]
      .filter((value): value is string => !!value)
      .flatMap(identityKeys);
    return candidateKeys.some((key) => senderKeys.has(key));
  });
  const displayName = [contact?.name, message.pushName, contact?.notifyName]
    .map(cleanSingleLine)
    .find(Boolean);
  if (displayName) return displayName;
  return identityKeys(sender)[1] || sender;
}

function messageText(message: Message): string {
  const content = cleanSingleLine(message.content);
  const caption = cleanSingleLine(message.mediaCaption ?? message.caption ?? content);
  switch (message.type) {
    case "text":
      return content || "[mensagem sem texto]";
    case "image":
      return `[imagem]${caption ? ` ${caption}` : ""}`;
    case "video":
      return `[vídeo]${caption ? ` ${caption}` : ""}`;
    case "audio":
      return `[áudio]${caption ? ` ${caption}` : ""}`;
    case "document": {
      const fileName = cleanSingleLine(message.mediaFileName ?? message.fileName);
      return `${fileName ? `[documento: ${fileName}]` : "[documento]"}${caption ? ` ${caption}` : ""}`;
    }
    case "sticker":
      return "[figurinha]";
    case "location":
      return `[localização]${caption ? ` ${caption}` : ""}`;
    case "contact":
      return `[contato]${caption ? ` ${caption}` : ""}`;
    case "poll":
      return `[enquete]${caption ? ` ${caption}` : ""}`;
    case "reaction":
      return `[reação]${caption ? ` ${caption}` : ""}`;
    case "event":
      return `[evento]${caption ? ` ${caption}` : ""}`;
    case "album":
      return `[álbum]${caption ? ` ${caption}` : ""}`;
  }
}

function formatTimestamp(timestamp: number, timeZone?: string): { date: string; time: string } {
  const milliseconds = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1_000;
  const date = new Date(Number.isFinite(milliseconds) ? milliseconds : 0);
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
  };
  const parts = new Intl.DateTimeFormat("en-GB", options).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.get("year")}-${values.get("month")}-${values.get("day")}`,
    time: `${values.get("hour")}:${values.get("minute")}`,
  };
}

export function formatGroupHistoryDigest(options: {
  groupJid: string;
  groupName?: string | null;
  messages: Message[];
  contacts: Awaited<ReturnType<ChannelAdapter["getContacts"]>>;
  own?: ReturnType<NonNullable<ChannelAdapter["getLifecycleStatus"]>>;
  timeZone?: string;
}): string {
  const groupJid = normalizeGroupJid(options.groupJid);
  const groupName = cleanSingleLine(options.groupName) || groupJid;
  const sortedMessages = [...options.messages].sort(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
  );
  const lines = [`Histórico recente de "${groupName}" — ${sortedMessages.length} mensagens`];
  let previousDate: string | null = null;

  for (const message of sortedMessages) {
    const { date, time } = formatTimestamp(message.timestamp, options.timeZone);
    const datePrefix = date === previousDate ? "" : `${date} `;
    previousDate = date;
    lines.push(
      `${datePrefix}${time} ${senderDisplayName(message, options.contacts, options.own)}: ${messageText(message)}`,
    );
  }

  return lines.join("\n");
}

export function isShareableGroupHistoryMessage(message: Message): boolean {
  return (
    message.status !== "revoked" &&
    message.viewOnce !== true &&
    message.ephemeral !== true &&
    message.historySharingBlocked !== true
  );
}

function truncateLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  const ellipsis = "…";
  let end = maxChars - ellipsis.length;
  if (end < 1) return ellipsis;
  const code = line.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${line.slice(0, end)}${ellipsis}`;
}

function splitLongLine(line: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const codePoint of line) {
    if (codePoint.length > maxChars) {
      throw new Error("Chunk size cannot fit a full Unicode code point");
    }
    if (current.length + codePoint.length > maxChars) {
      if (current) chunks.push(current);
      current = codePoint;
    } else {
      current += codePoint;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function chunkGroupHistoryDigest(
  text: string,
  maxChars = MAX_GROUP_HISTORY_CHUNK_CHARS,
): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error("Chunk size must be a positive safe integer");
  }

  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (line.length > maxChars) {
      if (current) chunks.push(current);
      const longLineChunks = splitLongLine(line, maxChars);
      chunks.push(...longLineChunks.slice(0, -1));
      current = longLineChunks.at(-1) ?? "";
      continue;
    }

    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxChars) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function numberGroupHistoryChunks(chunks: string[]): string[] {
  if (chunks.length < 2) return chunks;
  return chunks.map((chunk, index) => `(${index + 1}/${chunks.length})\n${chunk}`);
}

export function prepareGroupHistoryChunks(
  options: {
    groupJid: string;
    groupName?: string | null;
    messages: Message[];
    contacts: Awaited<ReturnType<ChannelAdapter["getContacts"]>>;
    own?: ReturnType<NonNullable<ChannelAdapter["getLifecycleStatus"]>>;
    timeZone?: string;
  },
  limits: GroupHistoryChunkLimits = {},
): { chunks: string[]; messagesIncluded: number; omittedMessages: number } {
  const maxChars = limits.maxChars ?? MAX_GROUP_HISTORY_CHUNK_CHARS;
  const maxChunks = limits.maxChunks ?? MAX_GROUP_HISTORY_CHUNKS;
  const maxLineChars = limits.maxLineChars ?? MAX_GROUP_HISTORY_LINE_CHARS;
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error("Chunk size must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1) {
    throw new Error("Chunk cap must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxLineChars) || maxLineChars < 1) {
    throw new Error("Line limit must be a positive safe integer");
  }

  const sorted = [...options.messages].sort(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
  );
  const pack = (included: Message[], omitted: number): string[] => {
    const digest = formatGroupHistoryDigest({ ...options, messages: included });
    const lines = digest.split("\n").map((line) => truncateLine(line, maxLineChars));
    if (omitted > 0) lines.splice(1, 0, `…mais ${omitted}`);
    return chunkGroupHistoryDigest(lines.join("\n"), maxChars);
  };

  const newest = (count: number): Message[] => sorted.slice(sorted.length - count);

  let low = 0;
  let high = sorted.length;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const chunks = pack(newest(mid), sorted.length - mid);
    if (chunks.length <= maxChunks) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (best === 0) {
    return { chunks: [], messagesIncluded: 0, omittedMessages: sorted.length };
  }
  const omittedMessages = sorted.length - best;
  return {
    chunks: numberGroupHistoryChunks(pack(newest(best), omittedMessages)),
    messagesIncluded: best,
    omittedMessages,
  };
}

function identitySet(value: string): Set<string> {
  const normalized = normalizeIdentity(value);
  const keys = new Set<string>([normalized]);
  if (normalized.includes("@")) {
    const canonical = jidNormalizedUser(normalized);
    if (canonical) keys.add(canonical.toLowerCase());
  }
  const localSource = [...keys][0] ?? normalized;
  const local = localSource.split("@", 1)[0]?.replace(/\D/g, "") ?? "";
  if (local && !normalized.endsWith("@lid")) {
    keys.add(local);
    keys.add(`${local}@s.whatsapp.net`);
  }
  return keys;
}

function memberIdentitySet(member: GroupParticipant): Set<string> {
  const keys = identitySet(member.jid);
  if (member.phone) {
    for (const key of identitySet(member.phone)) keys.add(key);
    const digits = member.phone.replace(/\D/g, "");
    if (digits) {
      for (const key of identitySet(`${digits}@s.whatsapp.net`)) keys.add(key);
    }
  }
  return keys;
}

function matchesMember(alias: string, member: GroupParticipant): boolean {
  const memberKeys = memberIdentitySet(member);
  for (const key of identitySet(alias)) {
    if (memberKeys.has(key)) return true;
  }
  return false;
}

function directMessageDestination(member: GroupParticipant): string {
  const phone = member.phone ? normalizeIdentity(member.phone) : "";
  if (phone) return jidNormalizedUser(normalizeGroupHistoryParticipant(phone));
  return jidNormalizedUser(member.jid) || member.jid;
}

export interface GroupHistoryDeliveryContext {
  groupJid: string;
  sources: Array<{ id: string; fingerprint: string }>;
}

export function groupHistoryMessageFingerprint(message: Message): string {
  // Delivery/read receipts can change while waiting. Only fingerprint content represented in the digest.
  return createHash("sha256")
    .update(
      JSON.stringify([
        message.id,
        message.senderId,
        message.type,
        message.content,
        message.mediaCaption,
        message.caption,
        message.mediaFileName,
        message.fileName,
        message.timestamp,
        message.isFromMe,
        message.pushName,
      ]),
    )
    .digest("hex");
}

/** Revalidate every chunk immediately before handing its permanent copy to WhatsApp. */
export async function validateGroupHistoryDelivery(
  adapter: ChannelAdapter,
  destination: string,
  context: GroupHistoryDeliveryContext | undefined,
): Promise<void> {
  if (!context?.groupJid || !context.sources?.length) {
    throw new UnrecoverableError(
      "Group history job has no source validation context; enqueue a new digest.",
    );
  }
  const metadata = await adapter.getGroupMetadata(context.groupJid);
  if ((metadata.ephemeralDuration ?? 0) > 0)
    throw new UnrecoverableError(GROUP_HISTORY_EPHEMERAL_MESSAGE);
  if (!metadata.participants.some((member) => matchesMember(destination, member))) {
    throw new UnrecoverableError(GROUP_HISTORY_NOT_A_MEMBER_MESSAGE);
  }
  const rows = await adapter.getMessages(context.groupJid, MAX_GROUP_HISTORY_SCAN);
  const current = new Map(rows.map((message) => [message.id, message]));
  for (const source of context.sources) {
    const message = current.get(source.id);
    if (
      !message ||
      !isShareableGroupHistoryMessage(message) ||
      groupHistoryMessageFingerprint(message) !== source.fingerprint
    ) {
      throw new UnrecoverableError(
        "Group history source changed or is no longer shareable; enqueue a new digest.",
      );
    }
  }
}

async function loadShareableGroupHistory(
  adapter: ChannelAdapter,
  groupJid: string,
  count: number,
): Promise<Message[]> {
  let window = Math.min(Math.max(count, 1), MAX_GROUP_HISTORY_SCAN);
  let rows = await adapter.getMessages(groupJid, window);
  let shareable = rows.filter(isShareableGroupHistoryMessage);
  while (shareable.length < count && rows.length === window && window < MAX_GROUP_HISTORY_SCAN) {
    const next = Math.min(window * 2, MAX_GROUP_HISTORY_SCAN);
    if (next === window) break;
    window = next;
    rows = await adapter.getMessages(groupJid, window);
    shareable = rows.filter(isShareableGroupHistoryMessage);
  }
  return shareable.slice(0, count);
}

export async function sendGroupHistoryToMember(options: {
  instanceId: string;
  groupJid: string;
  participant: string;
  participantAliases?: string[];
  count?: number;
  adapter: ChannelAdapter;
  messageQueue: MessageQueue;
  timeZone?: string;
  claimBeforeSend?: () => boolean | Promise<boolean>;
}): Promise<GroupHistorySendResult> {
  assertGroupHistoryWritesEnabled();
  const count = clampGroupHistoryCount(options.count);
  const groupJid = normalizeGroupJid(options.groupJid);
  const participant = normalizeGroupHistoryParticipant(options.participant);
  const aliases = [
    participant,
    ...(options.participantAliases ?? []).map((alias) => alias.trim()).filter(Boolean),
  ];
  const metadata = await options.adapter.getGroupMetadata(groupJid);
  if ((metadata.ephemeralDuration ?? 0) > 0) {
    throw new Error(GROUP_HISTORY_EPHEMERAL_MESSAGE);
  }
  const member = metadata.participants.find((candidate) =>
    aliases.some((alias) => matchesMember(alias, candidate)),
  );
  if (!member) throw new Error(GROUP_HISTORY_NOT_A_MEMBER_MESSAGE);
  const destination = directMessageDestination(member);

  const shareable = await loadShareableGroupHistory(options.adapter, groupJid, count.count);
  const empty = (note: string, omittedMessages = 0): GroupHistorySendResult => ({
    ...count,
    messagesIncluded: 0,
    chunksSent: 0,
    omittedMessages,
    note,
  });
  if (shareable.length === 0) {
    return empty("Nenhuma mensagem encontrada no histórico local deste grupo; nada foi enviado.");
  }

  const groupName = (await options.adapter.getChats()).find((chat) => chat.jid === groupJid)?.name;
  const contacts = await options.adapter.getContacts();
  const prepared = prepareGroupHistoryChunks({
    groupJid,
    groupName,
    messages: shareable,
    contacts,
    own: options.adapter.getLifecycleStatus?.(),
    timeZone: options.timeZone ?? process.env.TZ,
  });
  if (prepared.chunks.length === 0) {
    return empty(
      "O resumo não coube no limite de trechos; nada foi enviado.",
      prepared.omittedMessages,
    );
  }

  if (!((await options.claimBeforeSend?.()) ?? true)) {
    return empty("Este aviso de entrada já foi processado; nada foi enviado.");
  }
  const deliveryContext: GroupHistoryDeliveryContext = {
    groupJid,
    sources: shareable.map((message) => ({
      id: message.id,
      fingerprint: groupHistoryMessageFingerprint(message),
    })),
  };
  const omittedNote =
    prepared.omittedMessages > 0 ? `…mais ${prepared.omittedMessages}` : undefined;
  let chunksSent = 0;
  try {
    for (const chunk of prepared.chunks) {
      await options.messageQueue.enqueueGroupHistoryMessage(
        options.instanceId,
        destination,
        chunk,
        "baileys",
        deliveryContext,
      );
      chunksSent += 1;
    }
  } catch (error) {
    logger.warn(
      {
        instanceId: options.instanceId,
        groupId: groupJid,
        chunksSent,
        error: error instanceof Error ? error.message : String(error),
      },
      "Group history enqueue failed",
    );
    if (chunksSent === 0) throw error;
    return {
      ...count,
      messagesIncluded: prepared.messagesIncluded,
      chunksSent,
      omittedMessages: prepared.omittedMessages,
      note: [
        omittedNote,
        `Falha ao enfileirar o restante do histórico; ${chunksSent} trechos foram aceitos.`,
      ]
        .filter(Boolean)
        .join(" "),
    };
  }

  return {
    ...count,
    messagesIncluded: prepared.messagesIncluded,
    chunksSent,
    omittedMessages: prepared.omittedMessages,
    ...(omittedNote ? { note: omittedNote } : {}),
  };
}

function equalIdentity(left: string, right: string): boolean {
  return normalizeIdentity(left) === normalizeIdentity(right);
}

export function isOwnGroupHistoryParticipant(
  participant: string,
  own: { phone: string | null; lid: string | null } | undefined,
): boolean {
  if (!own) return false;
  return [own.phone, own.lid]
    .filter((value): value is string => !!value)
    .some((identity) => equalIdentity(participant, identity));
}

export function registerGroupHistoryOnJoin(
  instanceManager: InstanceManager,
  messageQueue: MessageQueue,
  claim: GroupHistoryStubClaim,
): () => void {
  assertGroupHistoryOnJoinConfig();
  return subscribeOwnDirectParticipantAdds(async (instanceId, add) => {
    void (await deliverOwnDirectParticipantAdd(
      instanceManager,
      messageQueue,
      claim,
      instanceId,
      add,
    ));
  });
}

async function deliverOwnDirectParticipantAdd(
  instanceManager: InstanceManager,
  messageQueue: MessageQueue,
  claim: GroupHistoryStubClaim,
  instanceId: string,
  add: OwnDirectParticipantAdd,
): Promise<void> {
  try {
    if (!isGroupHistoryOnJoinEnabled()) return;
    if (process.env.WA_GROUP_WRITES_ENABLED?.trim().toLowerCase() !== "true") return;
    if ((await instanceManager.getInstanceChannel(instanceId)) !== "baileys") return;

    const adapter = instanceManager.getAdapter(instanceId);
    const own = adapter.getLifecycleStatus?.();
    const targets = add.targets.filter(
      (target) =>
        !target.identities.some((identity) => isOwnGroupHistoryParticipant(identity, own)),
    );
    let decided = false;
    let owned = false;
    const claimBeforeSend = async (): Promise<boolean> => {
      if (!decided) {
        owned = await claim(instanceId, add.messageId);
        decided = true;
      }
      return owned;
    };
    if (targets.length === 0) {
      await claimBeforeSend();
      return;
    }

    for (const target of targets) {
      const participant = target.phoneJid ?? target.identities[0];
      if (!participant) continue;
      try {
        await sendGroupHistoryToMember({
          instanceId,
          groupJid: add.groupJid,
          participant,
          participantAliases: target.identities,
          count: getGroupHistoryOnJoinCount(),
          adapter,
          messageQueue,
          claimBeforeSend,
        });
      } catch (error) {
        logger.warn(
          {
            instanceId,
            groupId: add.groupJid,
            messageId: add.messageId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Automatic group history send failed",
        );
      }
    }
  } catch (error) {
    logger.warn(
      {
        instanceId,
        groupId: add.groupJid,
        messageId: add.messageId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Automatic group history send failed",
    );
  }
}

export { publishOwnDirectParticipantAdds };
