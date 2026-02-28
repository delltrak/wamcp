// ============================================================
// WA MCP — Contacts Resource
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";

export function registerContactsResource(
  server: McpServer,
  instanceManager: InstanceManager,
): void {
  server.resource(
    "instance-contacts",
    "whatsapp://instances/{id}/contacts",
    {
      description: "All contacts for an instance: JID, name, phone, business flag",
      mimeType: "application/json",
    },
    async (uri) => {
      const parts = uri.pathname.split("/");
      const id = parts[parts.indexOf("instances") + 1] ?? "";
      const adapter = instanceManager.getAdapter(id);
      const contacts = await adapter.getContacts();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(contacts),
          },
        ],
      };
    },
  );
}
