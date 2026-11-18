import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import {
  CancelEventSchema,
  GetEventResponsesSchema,
  SendEventSchema,
} from "../schemas/event.schema.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";

export function registerEventTools(server: McpServer, instanceManager: InstanceManager): void {
  server.registerTool(
    "wa_send_event",
    {
      description:
        "Send a WhatsApp event message on Baileys with an ISO start/end, optional location (with optional GPS coordinates) or voice/video call link, guest/scheduled-call flags, and optional quoted message.",
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
          ...(params.latitude !== undefined ? { latitude: params.latitude } : {}),
          ...(params.longitude !== undefined ? { longitude: params.longitude } : {}),
          ...(params.callType ? { callType: params.callType } : {}),
          ...(params.extraGuestsAllowed !== undefined
            ? { extraGuestsAllowed: params.extraGuestsAllowed }
            : {}),
          ...(params.isScheduleCall !== undefined ? { isScheduleCall: params.isScheduleCall } : {}),
          ...(params.quotedMessageId ? { quotedMessageId: params.quotedMessageId } : {}),
        });
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_event", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_cancel_event",
    {
      description:
        "Cancel a previously sent WhatsApp event message on Baileys. The original event message must be stored locally and sent by this instance.",
      inputSchema: CancelEventSchema,
    },
    async (params) => {
      try {
        const result = await instanceManager
          .getAdapter(params.instanceId)
          .cancelEvent(params.chatId, params.eventMessageId);
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_cancel_event", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_get_event_responses",
    {
      description:
        "Read locally stored RSVP participants, statuses, timestamps, extra guests, and per-status counts for a Baileys event message.",
      inputSchema: GetEventResponsesSchema,
    },
    async (params) => {
      try {
        const responses = await instanceManager
          .getAdapter(params.instanceId)
          .getEventResponses(params.chatId, params.eventMessageId);
        const counts = {
          GOING: 0,
          NOT_GOING: 0,
          MAYBE: 0,
          UNKNOWN: 0,
        };
        for (const response of responses) counts[response.status]++;
        return toolSuccess({
          chatId: params.chatId,
          eventMessageId: params.eventMessageId,
          count: responses.length,
          counts,
          responses,
        });
      } catch (err) {
        return handleToolError("wa_get_event_responses", err, params.instanceId);
      }
    },
  );
}
