import type { ChannelAdapter } from "../channels/channel.interface.js";
import type { ChannelEventPayload, Message } from "../types/channel.types.js";
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

export interface GroupHistoryCount {
  requestedCount: number;
  count: number;
  clamped: boolean;
}

export interface GroupHistorySendResult extends GroupHistoryCount {
  messagesIncluded: number;
  chunksSent: number;
  note?: string;
}

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
  if (!/^\d+$/.test(value.trim())) return DEFAULT_GROUP_HISTORY_COUNT;
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed)) return DEFAULT_GROUP_HISTORY_COUNT;
  return clampGroupHistoryCount(parsed).count;
}

export function isGroupHistoryOnJoinEnabled(value = process.env.WA_GROUP_HISTORY_ON_JOIN): boolean {
  return value?.trim().toLowerCase() === "true";
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

export async function sendGroupHistoryToMember(options: {
  instanceId: string;
  groupJid: string;
  participant: string;
  count?: number;
  adapter: ChannelAdapter;
  messageQueue: MessageQueue;
  timeZone?: string;
}): Promise<GroupHistorySendResult> {
  assertGroupHistoryWritesEnabled();
  const count = clampGroupHistoryCount(options.count);
  const groupJid = normalizeGroupJid(options.groupJid);
  const participant = normalizeGroupHistoryParticipant(options.participant);
  const [messages, chats, contacts] = await Promise.all([
    options.adapter.getMessages(groupJid, count.count),
    options.adapter.getChats(),
    options.adapter.getContacts(),
  ]);

  if (messages.length === 0) {
    return {
      ...count,
      messagesIncluded: 0,
      chunksSent: 0,
      note: "Nenhuma mensagem encontrada no histórico local deste grupo; nada foi enviado.",
    };
  }

  const groupName = chats.find((chat) => chat.jid === groupJid)?.name;
  const digest = formatGroupHistoryDigest({
    groupJid,
    groupName,
    messages,
    contacts,
    own: options.adapter.getLifecycleStatus?.(),
    timeZone: options.timeZone ?? process.env.TZ,
  });
  const chunks = chunkGroupHistoryDigest(digest);
  let chunksSent = 0;
  for (const chunk of chunks) {
    await options.messageQueue.enqueueGroupHistoryMessage(
      options.instanceId,
      participant,
      chunk,
      "baileys",
    );
    chunksSent += 1;
  }

  return { ...count, messagesIncluded: messages.length, chunksSent };
}

function equalIdentity(left: string, right: string): boolean {
  return normalizeIdentity(left) === normalizeIdentity(right);
}

export function isOwnGroupHistoryJoin(
  event: {
    action: string;
    directAdd?: boolean;
    author?: string | null;
    authorPn?: string | null;
    participants: string[];
  },
  own: { phone: string | null; lid: string | null } | undefined,
): boolean {
  if (event.action !== "add" || event.directAdd !== true || !own) return false;
  const authors = [event.author, event.authorPn].filter((value): value is string => !!value);
  const ownIds = [own.phone, own.lid].filter((value): value is string => !!value);
  return authors.some((author) => ownIds.some((identity) => equalIdentity(author, identity)));
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
): () => void {
  return instanceManager.onAnyEvent((event, instanceId, payload) => {
    if (event !== "group.participants_changed") return;
    if (!isGroupHistoryOnJoinEnabled()) return;
    if (process.env.WA_GROUP_WRITES_ENABLED?.trim().toLowerCase() !== "true") return;

    const groupEvent = payload as ChannelEventPayload["group.participants_changed"];
    if (groupEvent.action !== "add" || groupEvent.directAdd !== true) return;

    void (async () => {
      try {
        if (instanceManager.getInstanceChannel(instanceId) !== "baileys") return;
        const adapter = instanceManager.getAdapter(instanceId);
        const own = adapter.getLifecycleStatus?.();
        if (!isOwnGroupHistoryJoin(groupEvent, own)) return;

        for (const [index, participant] of groupEvent.participants.entries()) {
          const participantAliases = groupEvent.participantAliases?.[index] ?? [participant];
          if (participantAliases.some((identity) => isOwnGroupHistoryParticipant(identity, own))) {
            continue;
          }
          try {
            await sendGroupHistoryToMember({
              instanceId,
              groupJid: groupEvent.groupId,
              participant,
              count: getGroupHistoryOnJoinCount(),
              adapter,
              messageQueue,
            });
          } catch (error) {
            logger.warn(
              {
                instanceId,
                groupId: groupEvent.groupId,
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
            groupId: groupEvent.groupId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Automatic group history send failed",
        );
      }
    })();
  });
}
