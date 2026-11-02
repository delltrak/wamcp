// ============================================================
// WA MCP — Call Management Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";
import { createRequestLogger } from "../utils/logger.js";
import { CreateCallLinkSchema, RejectCallSchema } from "../schemas/call.schema.js";

export function registerCallTools(
  server: McpServer,
  instanceManager: InstanceManager,
  _messageQueue: MessageQueue,
): void {
  server.registerTool(
    "wa_reject_call",
    {
      description:
        "Reject an incoming voice or video call. The call ID is received via the whatsapp/call.received notification.",
      inputSchema: RejectCallSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_reject_call", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.rejectCall(params.callId, params.callFrom);
        log.info({ duration: Date.now() - start }, "Call rejected");
        return toolSuccess({ success: true, callId: params.callId });
      } catch (err) {
        return handleToolError("wa_reject_call", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_create_call_link",
    {
      description:
        "Create a WhatsApp audio or video call link on Baileys. createCallLink returns only a token; the result adds the public https://call.whatsapp.com/voice/ or /video/ URL. Optional startTime is Unix seconds and must be no more than 60 seconds in the past. Cloud API does not support this operation.",
      inputSchema: CreateCallLinkSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_create_call_link", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const result = await adapter.createCallLink(params.type, params.startTime);
        log.info({ duration: Date.now() - start, type: params.type }, "Call link created");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_create_call_link", err, params.instanceId);
      }
    },
  );
}
