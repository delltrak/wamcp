// ============================================================
// WA MCP — Messages Resource
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";

export function registerMessagesResource(
  server: McpServer,
  instanceManager: InstanceManager,
): void {
  server.resource(
    "instance-messages",
    "whatsapp://instances/{id}/messages/{chatId}",
    {
      description:
        "Recent messages in a chat (paginated): sender, type, content, timestamp, status",
      mimeType: "application/json",
    },
    async (uri) => {
      const parts = uri.pathname.split("/");
      const instanceIdx = parts.indexOf("instances");
      const id = parts[instanceIdx + 1] ?? "";
      const chatId = parts[parts.indexOf("messages") + 1] ?? "";
      const adapter = instanceManager.getAdapter(id);
      const messageList = await adapter.getMessages(chatId, 50);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(messageList),
          },
        ],
      };
    },
  );
}
