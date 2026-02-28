// ============================================================
// WA MCP — Call Management Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";
import { createRequestLogger } from "../utils/logger.js";
import { RejectCallSchema } from "../schemas/call.schema.js";

export function registerCallTools(
  server: McpServer,
  instanceManager: InstanceManager,
  _messageQueue: MessageQueue,
): void {
  server.tool(
    "wa_reject_call",
    "Reject an incoming voice or video call. The call ID is received via the whatsapp/call.received notification.",
    RejectCallSchema.shape,
    async (params) => {
      const log = createRequestLogger("wa_reject_call", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.rejectCall(params.callId);
        log.info({ duration: Date.now() - start }, "Call rejected");
        return toolSuccess({ success: true, callId: params.callId });
      } catch (err) {
        return handleToolError("wa_reject_call", err, params.instanceId);
      }
    },
  );
}
