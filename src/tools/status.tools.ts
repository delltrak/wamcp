// ============================================================
// WA MCP — Status/Stories Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { toolSuccess, toolError } from "../types/mcp.types.js";
import {
  SendTextStatusSchema,
  SendImageStatusSchema,
  SendVideoStatusSchema,
} from "../schemas/status.schema.js";

export function registerStatusTools(
  server: McpServer,
  instanceManager: InstanceManager,
  _messageQueue: MessageQueue,
): void {
  server.tool(
    "wa_send_text_status",
    "Post a text status/story update visible to contacts.",
    SendTextStatusSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.sendStatus({
          type: "text",
          text: params.text,
          backgroundColor: params.backgroundColor,
          font: params.font,
        });
        return toolSuccess({ success: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_send_image_status",
    "Post an image status/story update visible to contacts.",
    SendImageStatusSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.sendStatus({
          type: "image",
          media: params.image,
          caption: params.caption,
        });
        return toolSuccess({ success: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_send_video_status",
    "Post a video status/story update visible to contacts.",
    SendVideoStatusSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.sendStatus({
          type: "video",
          media: params.video,
          caption: params.caption,
        });
        return toolSuccess({ success: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );
}
