// ============================================================
// WA MCP — Contacts Resource
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import { perInstanceTemplate, varAsString } from "./resource-helpers.js";

export function registerContactsResource(
  server: McpServer,
  instanceManager: InstanceManager,
): void {
  server.registerResource(
    "instance-contacts",
    perInstanceTemplate(
      instanceManager,
      (id) => `whatsapp://instances/${id}/contacts`,
      (name) => `Contacts — ${name}`,
    ),
    {
      description: "All contacts for an instance: JID, name, phone, business flag",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = varAsString(variables, "id");
      const adapter = instanceManager.getAdapter(id);
      const data = await adapter.getContacts();
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data) }],
      };
    },
  );
}
