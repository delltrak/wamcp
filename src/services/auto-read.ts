// ============================================================
// WA MCP — Automatic Read Receipts
// ============================================================

import type { ChannelAdapter } from "../channels/channel.interface.js";
import type { Message } from "../types/channel.types.js";
import { logger } from "../utils/logger.js";

export type AutoReadMode = "off" | "on_fetch" | "on_receive";

export interface BaileysMessageKeyForRead {
  key: {
    remoteJid?: string | null;
    id?: string | null;
    fromMe?: boolean | null;
    participant?: string | null;
  };
}

let cachedSetting: string | undefined;
let cachedMode: AutoReadMode = "off";
let hasCachedSetting = false;

/** Read and validate WA_AUTO_READ, warning once whenever an invalid value is configured. */
export function getAutoReadMode(): AutoReadMode {
  const configured = process.env.WA_AUTO_READ;
  if (hasCachedSetting && configured === cachedSetting) return cachedMode;

  cachedSetting = configured;
  hasCachedSetting = true;

  const value = configured?.trim().toLowerCase();
  if (!value || value === "false") {
    cachedMode = "off";
  } else if (value === "on_fetch" || value === "on_receive") {
    cachedMode = value;
  } else {
    cachedMode = "off";
    logger.warn("Invalid WA_AUTO_READ; expected false, on_fetch or on_receive. Auto-read disabled");
  }

  return cachedMode;
}

export function isReadReceiptExcludedChat(chatId: string): boolean {
  const jid = chatId.toLowerCase();
  return jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter");
}

/** Schedule read receipts without waiting for WhatsApp or surfacing failures to the caller. */
export function scheduleReadReceipt(
  adapter: Pick<ChannelAdapter, "markRead">,
  chatId: string,
  messageIds: string[],
  instanceId: string,
  participant?: string,
): void {
  if (messageIds.length === 0 || !chatId || isReadReceiptExcludedChat(chatId)) return;

  void Promise.resolve()
    .then(() => adapter.markRead(chatId, messageIds, participant))
    .catch((err: unknown) => {
      logger.warn({ err, instanceId }, "Automatic read receipt failed");
    });
}

/** Mark incoming messages returned by a read tool or resource as read in the background. */
export function scheduleFetchedMessagesRead(
  adapter: Pick<ChannelAdapter, "markRead">,
  chatId: string,
  messages: Pick<Message, "id" | "isFromMe">[],
  instanceId: string,
): void {
  if (getAutoReadMode() !== "on_fetch" || isReadReceiptExcludedChat(chatId)) return;

  const messageIds = messages.filter((message) => !message.isFromMe).map((message) => message.id);
  scheduleReadReceipt(adapter, chatId, messageIds, instanceId);
}

/** Mark one incoming message as read when it arrives, without blocking event handling. */
export function scheduleIncomingMessageRead(
  adapter: Pick<ChannelAdapter, "markRead">,
  chatId: string,
  messageId: string | undefined,
  isFromMe: boolean,
  instanceId: string,
  participant?: string,
): void {
  if (getAutoReadMode() !== "on_receive" || isFromMe || !chatId || !messageId) return;
  scheduleReadReceipt(adapter, chatId, [messageId], instanceId, participant);
}

/** Only Baileys notify upserts represent newly arriving messages; history appends stay unread. */
export function scheduleBaileysMessagesRead(
  adapter: Pick<ChannelAdapter, "markRead">,
  upsertType: string,
  messages: BaileysMessageKeyForRead[],
  instanceId: string,
): void {
  if (upsertType !== "notify" || getAutoReadMode() !== "on_receive") return;

  for (const message of messages) {
    scheduleIncomingMessageRead(
      adapter,
      message.key.remoteJid ?? "",
      message.key.id ?? undefined,
      message.key.fromMe ?? false,
      instanceId,
      message.key.participant ?? undefined,
    );
  }
}
