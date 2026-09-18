// ============================================================
// WA MCP — Messages Resource
// ============================================================

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import { varAsString } from "./resource-helpers.js";

export function registerMessagesResource(
  server: McpServer,
  instanceManager: InstanceManager,
): void {
  server.registerResource(
    "instance-messages",
    // No list callback: enumerating every chat of every instance would need a
    // connected adapter per instance. Agents reach this via wa_get_messages or
    // the chats resource, which do supply concrete chat IDs.
    new ResourceTemplate("whatsapp://instances/{id}/messages/{chatId}", { list: undefined }),
    {
      description:
        "Recent messages in a chat (paginated): sender, type, content, timestamp, status",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = varAsString(variables, "id");
      const chatId = varAsString(variables, "chatId");
      const adapter = instanceManager.getAdapter(id);
      const data = await adapter.getMessages(chatId, 50);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data) }],
      };
    },
  );
}
