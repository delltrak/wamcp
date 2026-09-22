// ============================================================
// WA MCP — Chat Management Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";
import { createRequestLogger } from "../utils/logger.js";
import {
  ArchiveChatSchema,
  PinChatSchema,
  MuteChatSchema,
  DeleteChatSchema,
  ClearChatSchema,
  GetMessagesSchema,
  ListChatsSchema,
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
    "wa_list_chats",
    {
      description:
        "List recent chats for an instance. Returns JID, display name, group flag, unread/pin/mute/archive state, and last activity timestamp. Use this to discover chatIds for wa_get_messages.",
      inputSchema: ListChatsSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_list_chats", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        let chats = await adapter.getChats();
        if (params.query) {
          const q = params.query.toLowerCase();
          chats = chats.filter(
            (c) =>
              c.jid.toLowerCase().includes(q) ||
              (c.name ? c.name.toLowerCase().includes(q) : false),
          );
        }
        const limit = params.limit ?? 50;
        chats = chats.slice(0, limit);
        log.info(
          { duration: Date.now() - start, count: chats.length, query: params.query ?? null },
          "Chats listed",
        );
        return toolSuccess({ count: chats.length, chats });
      } catch (err) {
        return handleToolError("wa_list_chats", err, params.instanceId);
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
}
