// ============================================================
// WA MCP — Baileys Event Normalization
// Maps raw Baileys events to normalized ChannelEvent types.
// ============================================================

import type { BaileysEventMap, WAMessage, WAMessageUpdate } from "@whiskeysockets/baileys";
import type {
  MessageType,
  MessageDeliveryStatus,
  NormalizedMessageEvent,
  NormalizedMessageUpdateEvent,
  NormalizedMessageDeleteEvent,
  NormalizedMessageReactionEvent,
  NormalizedMessageEditEvent,
  NormalizedPresenceEvent,
  NormalizedGroupUpdateEvent,
  NormalizedGroupParticipantsEvent,
  NormalizedContactUpdateEvent,
  NormalizedConnectionEvent,
  NormalizedCallEvent,
  PresenceStatus,
} from "../../types/channel.types.js";

/**
 * Extract the message type from a Baileys WAMessage.
 */
export function extractMessageType(msg: WAMessage): MessageType {
  const m = msg.message;
  if (!m) return "text";

  if (m.conversation || m.extendedTextMessage) return "text";
  if (
    m.imageMessage ||
    m.viewOnceMessage?.message?.imageMessage ||
    m.viewOnceMessageV2?.message?.imageMessage
  )
    return "image";
  if (
    m.videoMessage ||
    m.viewOnceMessage?.message?.videoMessage ||
    m.viewOnceMessageV2?.message?.videoMessage
  )
    return "video";
  if (m.audioMessage) return "audio";
  if (m.documentMessage || m.documentWithCaptionMessage) return "document";
  if (m.locationMessage || m.liveLocationMessage) return "location";
  if (m.contactMessage || m.contactsArrayMessage) return "contact";
  if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) return "poll";
  if (m.reactionMessage) return "reaction";
  if (m.stickerMessage) return "sticker";

  return "text";
}

/**
 * Extract text content from a Baileys WAMessage.
 */
export function extractTextContent(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;

  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.documentMessage?.caption) return m.documentMessage.caption;
  if (m.documentWithCaptionMessage?.message?.documentMessage?.caption) {
    return m.documentWithCaptionMessage.message.documentMessage.caption;
  }

  return null;
}

/**
 * Extract quoted message ID from a Baileys WAMessage.
 */
export function extractQuotedMessageId(msg: WAMessage): string | null {
  const ctx =
    msg.message?.extendedTextMessage?.contextInfo ??
    msg.message?.imageMessage?.contextInfo ??
    msg.message?.videoMessage?.contextInfo ??
    msg.message?.audioMessage?.contextInfo ??
    msg.message?.documentMessage?.contextInfo;

  return ctx?.stanzaId ?? null;
}

/**
 * Get the chat JID for a message (group or individual).
 */
export function getChatJid(msg: WAMessage): string {
  return msg.key.remoteJid ?? "";
}

/**
 * Get the sender JID for a message.
 */
export function getSenderJid(msg: WAMessage): string {
  // In group chats, participant holds the actual sender
  if (msg.key.participant) return msg.key.participant;
  // In individual chats, remoteJid is the sender (if not from me)
  if (!msg.key.fromMe) return msg.key.remoteJid ?? "";
  return "me";
}

// ---- Normalizers ----

/**
 * Normalize a Baileys messages.upsert event to NormalizedMessageEvent[].
 */
export function normalizeMessagesUpsert(
  instanceId: string,
  data: BaileysEventMap["messages.upsert"],
): NormalizedMessageEvent[] {
  // Only process notify-type messages (not history sync)
  if (data.type !== "notify") return [];

  return data.messages.map((msg) => ({
    instanceId,
    chatId: getChatJid(msg),
    message: {
      id: msg.key.id ?? "",
      sender: getSenderJid(msg),
      timestamp:
        typeof msg.messageTimestamp === "number"
          ? msg.messageTimestamp
          : Number(msg.messageTimestamp ?? 0),
      type: extractMessageType(msg),
      content: extractTextContent(msg),
      mediaUrl: null, // Media URLs are resolved separately
      quotedMessageId: extractQuotedMessageId(msg),
      isFromMe: msg.key.fromMe ?? false,
    },
  }));
}

/**
 * Normalize a Baileys messages.update event.
 */
export function normalizeMessagesUpdate(
  instanceId: string,
  updates: WAMessageUpdate[],
): NormalizedMessageUpdateEvent[] {
  return updates
    .filter((u) => u.update.status !== undefined)
    .map((u) => {
      const statusMap: Record<number, MessageDeliveryStatus> = {
        0: "received",
        1: "sent",
        2: "delivered",
        3: "read",
        4: "played",
      };

      return {
        instanceId,
        chatId: u.key.remoteJid ?? "",
        messageId: u.key.id ?? "",
        status: statusMap[u.update.status ?? 0] ?? "received",
      };
    });
}

/**
 * Normalize a Baileys messages.delete event.
 */
export function normalizeMessagesDelete(
  instanceId: string,
  data: BaileysEventMap["messages.delete"],
): NormalizedMessageDeleteEvent[] {
  if ("keys" in data) {
    return data.keys.map((key) => ({
      instanceId,
      chatId: key.remoteJid ?? "",
      messageId: key.id ?? "",
      deletedBy: key.participant ?? key.remoteJid ?? "",
    }));
  }
  return [];
}

/**
 * Normalize a Baileys messages.reaction event.
 */
export function normalizeMessagesReaction(
  instanceId: string,
  reactions: BaileysEventMap["messages.reaction"],
): NormalizedMessageReactionEvent[] {
  return reactions.map((r) => ({
    instanceId,
    chatId: r.key.remoteJid ?? "",
    messageId: r.key.id ?? "",
    emoji: r.reaction?.text ?? "",
    reactedBy: r.reaction?.key?.participant ?? r.reaction?.key?.remoteJid ?? "",
  }));
}

/**
 * Normalize a Baileys message edit event.
 */
export function normalizeMessageEdit(
  instanceId: string,
  msg: WAMessage,
  chatId: string,
): NormalizedMessageEditEvent {
  const editedContent =
    msg.message?.protocolMessage?.editedMessage?.conversation ??
    msg.message?.protocolMessage?.editedMessage?.extendedTextMessage?.text ??
    "";

  return {
    instanceId,
    chatId,
    messageId: msg.message?.protocolMessage?.key?.id ?? msg.key.id ?? "",
    newContent: editedContent,
    editedAt:
      typeof msg.messageTimestamp === "number"
        ? msg.messageTimestamp
        : Number(msg.messageTimestamp ?? Date.now() / 1000),
  };
}

/**
 * Normalize a Baileys presence.update event.
 */
export function normalizePresenceUpdate(
  instanceId: string,
  data: BaileysEventMap["presence.update"],
): NormalizedPresenceEvent[] {
  const results: NormalizedPresenceEvent[] = [];
  const chatId = data.id;

  for (const [participant, presence] of Object.entries(data.presences)) {
    const statusMap: Record<string, PresenceStatus> = {
      composing: "composing",
      recording: "recording",
      paused: "paused",
      available: "available",
      unavailable: "unavailable",
    };

    results.push({
      instanceId,
      chatId,
      participant,
      status: statusMap[presence.lastKnownPresence] ?? "unavailable",
    });
  }

  return results;
}

/**
 * Normalize a Baileys groups.update event.
 */
export function normalizeGroupsUpdate(
  instanceId: string,
  updates: BaileysEventMap["groups.update"],
): NormalizedGroupUpdateEvent[] {
  return updates.map((update) => ({
    instanceId,
    groupId: update.id ?? "",
    changes: { ...update } as Record<string, unknown>,
  }));
}

/**
 * Normalize a Baileys group-participants.update event.
 */
export function normalizeGroupParticipantsUpdate(
  instanceId: string,
  data: BaileysEventMap["group-participants.update"],
): NormalizedGroupParticipantsEvent {
  const actionMap: Record<string, "add" | "remove" | "promote" | "demote"> = {
    add: "add",
    remove: "remove",
    promote: "promote",
    demote: "demote",
  };

  return {
    instanceId,
    groupId: data.id,
    action: actionMap[data.action] ?? "add",
    participants: data.participants,
  };
}

/**
 * Normalize a Baileys contacts.update event.
 */
export function normalizeContactsUpdate(
  instanceId: string,
  contacts: BaileysEventMap["contacts.update"],
): NormalizedContactUpdateEvent[] {
  return contacts.map((contact) => ({
    instanceId,
    contactId: contact.id ?? "",
    changes: { ...contact } as Record<string, unknown>,
  }));
}

/**
 * Normalize a Baileys connection.update event.
 */
export function normalizeConnectionUpdate(
  instanceId: string,
  data: BaileysEventMap["connection.update"],
): NormalizedConnectionEvent | null {
  if (data.connection === undefined && data.qr === undefined) return null;

  const statusMap: Record<string, "open" | "close" | "connecting"> = {
    open: "open",
    close: "close",
    connecting: "connecting",
  };

  return {
    instanceId,
    status: data.connection ? (statusMap[data.connection] ?? "connecting") : "connecting",
    qrCode: data.qr,
  };
}

/**
 * Normalize a Baileys call event.
 */
export function normalizeCallEvent(
  instanceId: string,
  calls: BaileysEventMap["call"],
): NormalizedCallEvent[] {
  return calls.map((call) => ({
    instanceId,
    callerId: call.from ?? "",
    isVideo: call.isVideo ?? false,
    callId: call.id ?? "",
  }));
}
