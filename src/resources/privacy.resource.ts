// ============================================================
// WA MCP — Privacy Resource
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import { perInstanceTemplate, varAsString } from "./resource-helpers.js";

export function registerPrivacyResource(server: McpServer, instanceManager: InstanceManager): void {
  server.registerResource(
    "instance-privacy",
    perInstanceTemplate(
      instanceManager,
      (id) => `whatsapp://instances/${id}/privacy`,
      (name) => `Privacy — ${name}`,
    ),
    {
      description: "Privacy settings for an instance",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = varAsString(variables, "id");
      const adapter = instanceManager.getAdapter(id);
      const data = await adapter.getPrivacySettings();
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data) }],
      };
    },
  );
}
