// ============================================================
// WA MCP — Profile Resource
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import { perInstanceTemplate, varAsString } from "./resource-helpers.js";

export function registerProfileResource(server: McpServer, instanceManager: InstanceManager): void {
  server.registerResource(
    "instance-profile",
    perInstanceTemplate(
      instanceManager,
      (id) => `whatsapp://instances/${id}/profile`,
      (name) => `Profile — ${name}`,
    ),
    {
      description: "Own profile for an instance: name, status, picture URL",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = varAsString(variables, "id");
      const adapter = instanceManager.getAdapter(id);
      const data = await adapter.getProfileInfo();
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data) }],
      };
    },
  );
}
