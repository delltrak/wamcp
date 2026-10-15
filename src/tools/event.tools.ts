import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import { GetEventResponsesSchema, SendEventSchema } from "../schemas/event.schema.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";

export function registerEventTools(server: McpServer, instanceManager: InstanceManager): void {
  server.registerTool(
    "wa_send_event",
    {
      description:
        "Send a WhatsApp event message on Baileys with an ISO start/end, optional location or voice/video call link, and optional quoted message.",
      inputSchema: SendEventSchema,
    },
    async (params) => {
      try {
        const result = await instanceManager.getAdapter(params.instanceId).sendEvent({
          to: params.to,
          name: params.name,
          start: params.start,
          ...(params.description ? { description: params.description } : {}),
          ...(params.end ? { end: params.end } : {}),
          ...(params.locationText ? { locationText: params.locationText } : {}),
          ...(params.callType ? { callType: params.callType } : {}),
          ...(params.quotedMessageId ? { quotedMessageId: params.quotedMessageId } : {}),
        });
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_event", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_get_event_responses",
    {
      description:
        "Read event responses already received and stored locally for a Baileys event message.",
      inputSchema: GetEventResponsesSchema,
    },
    async (params) => {
      try {
        const responses = await instanceManager
          .getAdapter(params.instanceId)
          .getEventResponses(params.chatId, params.eventMessageId);
        return toolSuccess({
          chatId: params.chatId,
          eventMessageId: params.eventMessageId,
          count: responses.length,
          responses,
        });
      } catch (err) {
        return handleToolError("wa_get_event_responses", err, params.instanceId);
      }
    },
  );
}
