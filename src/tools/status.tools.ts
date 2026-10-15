// ============================================================
// WA MCP — Status/Stories Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import type { StatusSendResult } from "../types/channel.types.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";
import { createRequestLogger } from "../utils/logger.js";
import {
  SendTextStatusSchema,
  SendImageStatusSchema,
  SendVideoStatusSchema,
  GetStatusViewersSchema,
} from "../schemas/status.schema.js";

function statusToolSuccess(result: StatusSendResult) {
  return toolSuccess({
    success: true,
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
