// ============================================================
// WA MCP — Chats Resource
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import { perInstanceTemplate, varAsString } from "./resource-helpers.js";

export function registerChatsResource(server: McpServer, instanceManager: InstanceManager): void {
  server.registerResource(
    "instance-chats",
    perInstanceTemplate(
      instanceManager,
      (id) => `whatsapp://instances/${id}/chats`,
      (name) => `Chats — ${name}`,
    ),
    {
      description:
        "Active chats for an instance: JID, last message, unread count, pinned, muted, archived",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = varAsString(variables, "id");
      const adapter = instanceManager.getAdapter(id);
      const data = await adapter.getChats();
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data) }],
      };
    },
  );
}
