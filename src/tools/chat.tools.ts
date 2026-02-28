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
} from "../schemas/chat.schema.js";

export function registerChatTools(
  server: McpServer,
  instanceManager: InstanceManager,
  _messageQueue: MessageQueue,
): void {
  server.tool(
    "wa_archive_chat",
    "Archive or unarchive a chat. Archived chats are hidden from the main chat list.",
    ArchiveChatSchema.shape,
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

  server.tool(
    "wa_pin_chat",
    "Pin or unpin a chat. Pinned chats appear at the top of the chat list.",
    PinChatSchema.shape,
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

  server.tool(
    "wa_mute_chat",
    "Mute or unmute a chat. When muting, optionally specify muteUntil as a Unix timestamp in milliseconds.",
    MuteChatSchema.shape,
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

  server.tool(
    "wa_delete_chat",
    "Delete an entire chat for this account. This cannot be undone.",
    DeleteChatSchema.shape,
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

  server.tool(
    "wa_clear_chat",
    "Clear all messages in a chat. The chat remains but all messages are removed.",
    ClearChatSchema.shape,
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
}
