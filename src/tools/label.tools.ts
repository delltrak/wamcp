import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import {
  ChatLabelSchema,
  CreateLabelSchema,
  DeleteLabelSchema,
  EditLabelSchema,
  ListLabelsSchema,
  MessageLabelSchema,
} from "../schemas/label.schema.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";

export function registerLabelTools(server: McpServer, instanceManager: InstanceManager): void {
  server.registerTool(
    "wa_list_labels",
    {
      description: "List locally stored WhatsApp Business labels for a Baileys instance.",
      inputSchema: ListLabelsSchema,
    },
    async (params) => {
      try {
        const labels = await instanceManager
          .getAdapter(params.instanceId)
          .listLabels(params.includeDeleted);
        return toolSuccess({ count: labels.length, labels });
      } catch (err) {
        return handleToolError("wa_list_labels", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_create_label",
    {
      description: "Create a WhatsApp Business label on a Baileys Business account.",
      inputSchema: CreateLabelSchema,
    },
    async (params) => {
      try {
        const label = await instanceManager
          .getAdapter(params.instanceId)
          .createLabel(params.name, params.color);
        return toolSuccess({ success: true, label });
      } catch (err) {
        return handleToolError("wa_create_label", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_edit_label",
    {
      description: "Rename or recolor a WhatsApp Business label on a Baileys Business account.",
      inputSchema: EditLabelSchema,
    },
    async (params) => {
      try {
        await instanceManager.getAdapter(params.instanceId).editLabel(params.labelId, {
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(params.color !== undefined ? { color: params.color } : {}),
        });
        return toolSuccess({ success: true, labelId: params.labelId });
      } catch (err) {
        return handleToolError("wa_edit_label", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_delete_label",
    {
      description: "Delete a WhatsApp Business label on a Baileys Business account.",
      inputSchema: DeleteLabelSchema,
    },
    async (params) => {
      try {
        await instanceManager.getAdapter(params.instanceId).deleteLabel(params.labelId);
        return toolSuccess({ success: true, labelId: params.labelId, deleted: true });
      } catch (err) {
        return handleToolError("wa_delete_label", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_add_chat_label",
    {
      description: "Apply a WhatsApp Business label to a chat.",
      inputSchema: ChatLabelSchema,
    },
    async (params) => {
      try {
        await instanceManager
          .getAdapter(params.instanceId)
          .setChatLabel(params.chatId, params.labelId, true);
        return toolSuccess({ success: true, chatId: params.chatId, labelId: params.labelId });
      } catch (err) {
        return handleToolError("wa_add_chat_label", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_remove_chat_label",
    {
      description: "Remove a WhatsApp Business label from a chat.",
      inputSchema: ChatLabelSchema,
    },
    async (params) => {
      try {
        await instanceManager
          .getAdapter(params.instanceId)
          .setChatLabel(params.chatId, params.labelId, false);
        return toolSuccess({ success: true, chatId: params.chatId, labelId: params.labelId });
      } catch (err) {
        return handleToolError("wa_remove_chat_label", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_add_message_label",
    {
      description: "Apply a WhatsApp Business label to a message.",
      inputSchema: MessageLabelSchema,
    },
    async (params) => {
      try {
        await instanceManager
          .getAdapter(params.instanceId)
          .setMessageLabel(params.chatId, params.messageId, params.labelId, true);
        return toolSuccess({
          success: true,
          chatId: params.chatId,
          messageId: params.messageId,
          labelId: params.labelId,
        });
      } catch (err) {
        return handleToolError("wa_add_message_label", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_remove_message_label",
    {
      description: "Remove a WhatsApp Business label from a message.",
      inputSchema: MessageLabelSchema,
    },
    async (params) => {
      try {
        await instanceManager
          .getAdapter(params.instanceId)
          .setMessageLabel(params.chatId, params.messageId, params.labelId, false);
        return toolSuccess({
          success: true,
          chatId: params.chatId,
          messageId: params.messageId,
          labelId: params.labelId,
        });
      } catch (err) {
        return handleToolError("wa_remove_message_label", err, params.instanceId);
      }
    },
  );
}
