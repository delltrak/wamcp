// ============================================================
// WA MCP — Chats Resource
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";

export function registerChatsResource(server: McpServer, instanceManager: InstanceManager): void {
  server.resource(
    "instance-chats",
    "whatsapp://instances/{id}/chats",
    {
      description:
        "Active chats for an instance: JID, last message, unread count, pinned, muted, archived",
      mimeType: "application/json",
    },
    async (uri) => {
      const parts = uri.pathname.split("/");
      const id = parts[parts.indexOf("instances") + 1] ?? "";
      const adapter = instanceManager.getAdapter(id);
      const chatList = await adapter.getChats();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(chatList),
          },
        ],
      };
    },
  );
}
