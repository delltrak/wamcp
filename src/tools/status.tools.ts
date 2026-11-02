// ============================================================
// WA MCP — Status/Stories Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import type { GroupStatusSendResult, StatusSendResult } from "../types/channel.types.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";
import { createRequestLogger } from "../utils/logger.js";
import {
  SendTextStatusSchema,
  SendImageStatusSchema,
  SendVideoStatusSchema,
  GetStatusViewersSchema,
  SendGroupStatusSchema,
} from "../schemas/status.schema.js";

function groupStatusToolSuccess(result: GroupStatusSendResult) {
  return toolSuccess({
    success: true,
    messageId: result.messageId,
    groupId: result.groupId,
  });
}

function statusToolSuccess(result: StatusSendResult) {
  return toolSuccess({
    success: true,
    messageId: result.messageId,
    recipientCount: result.recipientCount,
    ...(result.omittedRecipientCount > 0
      ? {
          omittedRecipientCount: result.omittedRecipientCount,
          warning: result.warning,
        }
      : {}),
  });
}

export function registerStatusTools(
  server: McpServer,
  instanceManager: InstanceManager,
  _messageQueue: MessageQueue,
): void {
  server.registerTool(
    "wa_send_text_status",
    {
      description: "Post a text status/story update visible to contacts.",
      inputSchema: SendTextStatusSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_text_status", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const result = await adapter.sendStatus({
          type: "text",
          text: params.text,
          statusJidList: params.statusJidList,
          backgroundColor: params.backgroundColor,
          font: params.font,
        });
        log.info(
          {
            duration: Date.now() - start,
            messageId: result.messageId,
            recipientCount: result.recipientCount,
            omittedRecipientCount: result.omittedRecipientCount,
          },
          "Text status posted",
        );
        return statusToolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_text_status", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_image_status",
    {
      description: "Post an image status/story update visible to contacts.",
      inputSchema: SendImageStatusSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_image_status", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const result = await adapter.sendStatus({
          type: "image",
          media: params.image,
          statusJidList: params.statusJidList,
          caption: params.caption,
        });
        log.info(
          {
            duration: Date.now() - start,
            messageId: result.messageId,
            recipientCount: result.recipientCount,
            omittedRecipientCount: result.omittedRecipientCount,
          },
          "Image status posted",
        );
        return statusToolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_image_status", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_video_status",
    {
      description: "Post a video status/story update visible to contacts.",
      inputSchema: SendVideoStatusSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_video_status", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const result = await adapter.sendStatus({
          type: "video",
          media: params.video,
          statusJidList: params.statusJidList,
          caption: params.caption,
        });
        log.info(
          {
            duration: Date.now() - start,
            messageId: result.messageId,
            recipientCount: result.recipientCount,
            omittedRecipientCount: result.omittedRecipientCount,
          },
          "Video status posted",
        );
        return statusToolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_video_status", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_group_status",
    {
      description:
        "Post a text, image, or video status visible only to the members of one group (Updates tab, 24 hours, outside the chat). Baileys only. Requires WA_GROUP_STATUS_ENABLED=true (default false). Sends directly with relayMessage; it is not queued and does not write app state. Cloud API does not support group status.",
      inputSchema: SendGroupStatusSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_group_status", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const result = await adapter.sendGroupStatus({
          groupId: params.groupId,
          type: params.type,
          text: params.text,
          media: params.media,
          caption: params.caption,
          backgroundColor: params.backgroundColor,
          font: params.font,
        });
        log.info(
          { duration: Date.now() - start, messageId: result.messageId, groupId: result.groupId },
          "Group status posted",
        );
        return groupStatusToolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_group_status", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_get_status_viewers",
    {
      description:
        "List participants whose read or played receipts were stored for a sent status story. Baileys only; receipts are available only after this server observed them.",
      inputSchema: GetStatusViewersSchema,
    },
    async (params) => {
      try {
        const viewers = await instanceManager
          .getAdapter(params.instanceId)
          .getStatusViewers(params.messageId);
        return toolSuccess({ messageId: params.messageId, count: viewers.length, viewers });
      } catch (err) {
        return handleToolError("wa_get_status_viewers", err, params.instanceId);
      }
    },
  );
}
