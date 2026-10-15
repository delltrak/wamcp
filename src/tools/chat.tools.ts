// ============================================================
// WA MCP — Chat Management Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";
import { createRequestLogger } from "../utils/logger.js";
import { scheduleFetchedMessagesRead } from "../services/auto-read.js";
import {
  ArchiveChatSchema,
  PinChatSchema,
  MuteChatSchema,
  DeleteChatSchema,
  ClearChatSchema,
  GetMessagesSchema,
  ListChatsSchema,
  MarkChatUnreadSchema,
  StarMessageSchema,
  FetchMessageHistorySchema,
  SetDisappearingMessagesSchema,
} from "../schemas/chat.schema.js";

export function registerChatTools(
  server: McpServer,
  instanceManager: InstanceManager,
  _messageQueue: MessageQueue,
): void {
  server.registerTool(
    "wa_archive_chat",
    {
      description:
        "Archive or unarchive a chat. Archived chats are hidden from the main chat list.",
      inputSchema: ArchiveChatSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_archive_chat", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyChat(params.chatId, {
          action: params.archive ? "archive" : "unarchive",
        });
        log.info({ duration: Date.now() - start, archive: params.archive }, "Chat archive toggled");
        return toolSuccess({ success: true, archived: params.archive });
      } catch (err) {
        return handleToolError("wa_archive_chat", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_pin_chat",
    {
      description: "Pin or unpin a chat. Pinned chats appear at the top of the chat list.",
      inputSchema: PinChatSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_pin_chat", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyChat(params.chatId, {
          action: params.pin ? "pin" : "unpin",
        });
        log.info({ duration: Date.now() - start, pin: params.pin }, "Chat pin toggled");
        return toolSuccess({ success: true, pinned: params.pin });
      } catch (err) {
        return handleToolError("wa_pin_chat", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_mute_chat",
    {
      description:
        "Mute or unmute a chat. When muting, optionally specify muteUntil as a Unix timestamp in milliseconds.",
      inputSchema: MuteChatSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_mute_chat", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyChat(params.chatId, {
          action: params.mute ? "mute" : "unmute",
          muteUntil: params.muteUntil,
        });
        log.info({ duration: Date.now() - start, mute: params.mute }, "Chat mute toggled");
        return toolSuccess({ success: true, muted: params.mute });
      } catch (err) {
        return handleToolError("wa_mute_chat", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_delete_chat",
    {
      description: "Delete an entire chat for this account. This cannot be undone.",
      inputSchema: DeleteChatSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_delete_chat", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyChat(params.chatId, { action: "delete" });
        log.info({ duration: Date.now() - start }, "Chat deleted");
        return toolSuccess({ success: true, deleted: true });
      } catch (err) {
        return handleToolError("wa_delete_chat", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_clear_chat",
    {
      description: "Clear all messages in a chat. The chat remains but all messages are removed.",
      inputSchema: ClearChatSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_clear_chat", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyChat(params.chatId, { action: "clear" });
        log.info({ duration: Date.now() - start }, "Chat cleared");
        return toolSuccess({ success: true, cleared: true });
      } catch (err) {
        return handleToolError("wa_clear_chat", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_get_messages",
    {
      description:
        "Get recent messages from a chat. Returns messages ordered by most recent first, with sender, content, type, and timestamp.",
      inputSchema: GetMessagesSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_get_messages", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const messages = await adapter.getMessages(params.chatId, params.limit);
        scheduleFetchedMessagesRead(adapter, params.chatId, messages, params.instanceId);
        log.info(
          { duration: Date.now() - start, chatId: params.chatId, count: messages.length },
          "Messages retrieved",
        );
        return toolSuccess({ chatId: params.chatId, count: messages.length, messages });
      } catch (err) {
        return handleToolError("wa_get_messages", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_list_chats",
    {
      description:
        "List chats stored for an instance, including each chat's current WhatsApp Business labels.",
      inputSchema: ListChatsSchema,
    },
    async (params) => {
      try {
        const chats = await instanceManager.getAdapter(params.instanceId).getChats();
        return toolSuccess({ count: chats.length, chats });
      } catch (err) {
        return handleToolError("wa_list_chats", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_mark_chat_unread",
    {
      description:
        "Mark a chat unread on Baileys. The stored recent messages are supplied as the required chat-modification range.",
      inputSchema: MarkChatUnreadSchema,
    },
    async (params) => {
      try {
        await instanceManager.getAdapter(params.instanceId).markChatUnread(params.chatId);
        return toolSuccess({ success: true, chatId: params.chatId, unread: true });
      } catch (err) {
        return handleToolError("wa_mark_chat_unread", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_star_message",
    {
      description: "Star or unstar a stored message on a Baileys account.",
      inputSchema: StarMessageSchema,
    },
    async (params) => {
      try {
        await instanceManager
          .getAdapter(params.instanceId)
          .starMessage(params.chatId, params.messageId, params.star);
        return toolSuccess({ success: true, messageId: params.messageId, starred: params.star });
      } catch (err) {
        return handleToolError("wa_star_message", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_fetch_message_history",
    {
      description:
        "Request older messages for a chat from Baileys using the oldest stored message as the anchor. Waits for ON_DEMAND history results up to timeoutMs.",
      inputSchema: FetchMessageHistorySchema,
    },
    async (params) => {
      try {
        const result = await instanceManager
          .getAdapter(params.instanceId)
          .fetchMessageHistory(params.chatId, params.count, params.timeoutMs);
        return toolSuccess({ chatId: params.chatId, ...result });
      } catch (err) {
        return handleToolError("wa_fetch_message_history", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_set_disappearing_messages",
    {
      description:
        "Set disappearing messages for a private chat: off, 24 hours, 7 days, or 90 days. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true. Baileys sends the protocol control message; Cloud API does not support this operation.",
      inputSchema: SetDisappearingMessagesSchema,
    },
    async (params) => {
      try {
        await instanceManager
          .getAdapter(params.instanceId)
          .setDisappearingMessages(params.chatId, params.duration);
        return toolSuccess({
          success: true,
          chatId: params.chatId,
          duration: params.duration,
        });
      } catch (err) {
        return handleToolError("wa_set_disappearing_messages", err, params.instanceId);
      }
    },
  );
}
