// ============================================================
// WA MCP — Instances Resource
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";

export function registerInstancesResource(
  server: McpServer,
  instanceManager: InstanceManager,
  messageQueue: MessageQueue,
): void {
  // List all instances
  server.resource(
    "instances-list",
    "whatsapp://instances",
    {
      description:
        "List all WhatsApp instances with connection status, phone number, and channel type",
      mimeType: "application/json",
    },
    async () => {
      const allInstances = instanceManager.getAllInstances();
      const data = allInstances.map((inst) => ({
        id: inst.id,
        name: inst.name,
        channel: inst.channel,
        phoneNumber: inst.phoneNumber,
        status: inst.status,
        createdAt: inst.createdAt,
        lastConnected: inst.lastConnected,
      }));
      return {
        contents: [
          {
            uri: "whatsapp://instances",
            mimeType: "application/json",
            text: JSON.stringify(data),
          },
        ],
      };
    },
  );

  // Single instance with queue stats
  server.resource(
    "instance-detail",
    "whatsapp://instances/{id}",
    {
      description: "Single instance details including uptime, message stats, and queue status",
      mimeType: "application/json",
    },
    async (uri) => {
      const id = uri.pathname.split("/").pop() ?? "";
      const instance = instanceManager.getInstance(id);
      const stats = await messageQueue.getQueueStats(id);
      // Strip sensitive fields before returning to agents
      const { cloudAccessToken: _token, ...safeInstance } = instance;
      const data = {
        ...safeInstance,
        cloudAccessToken: instance.cloudAccessToken ? "[REDACTED]" : null,
        queue: { outbound: stats },
      };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(data),
          },
        ],
      };
    },
  );
}
