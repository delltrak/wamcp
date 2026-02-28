// ============================================================
// WA MCP — Call Management Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { toolSuccess, toolError } from "../types/mcp.types.js";
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
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.rejectCall(params.callId);
        return toolSuccess({ success: true, callId: params.callId });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );
}
