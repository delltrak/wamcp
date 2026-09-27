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
  DownloadMediaSchema,
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
        "Get recent messages from a chat. Returns messages ordered by most recent first, with sender, content, type, timestamp, and media fields (mediaLocal path under data/media/, mediaMimetype, mediaSize) when media was downloaded.",
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

  server.registerTool(
    "wa_download_media",
    {
      description:
        "Download (or return cached) media for a message. Persists under data/media/{instanceId}/{messageId}.{ext} on the wa-data volume. Returns mediaLocal path, mimetype, and size. Set asBase64=true to also get base64 (max 8MB).",
      inputSchema: DownloadMediaSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_download_media", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const result = await adapter.downloadMediaForMessage(params.chatId, params.messageId, {
          asBase64: params.asBase64 ?? false,
        });
        log.info(
          {
            duration: Date.now() - start,
            chatId: params.chatId,
            messageId: params.messageId,
            size: result.size,
            path: result.mediaLocal,
          },
          "Media downloaded",
        );
        return toolSuccess({
          chatId: params.chatId,
          messageId: params.messageId,
          mediaLocal: result.mediaLocal,
          mediaMimetype: result.mediaMimetype,
          size: result.size,
          ...(result.base64 !== undefined ? { base64: result.base64 } : {}),
        });
      } catch (err) {
        return handleToolError("wa_download_media", err, params.instanceId);
      }
    },
  );
}
