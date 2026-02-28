// ============================================================
// WA MCP — Profile Resource
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";

export function registerProfileResource(server: McpServer, instanceManager: InstanceManager): void {
  server.resource(
    "instance-profile",
    "whatsapp://instances/{id}/profile",
    { description: "Own profile: name, status, picture URL", mimeType: "application/json" },
    async (uri) => {
      const parts = uri.pathname.split("/");
      const id = parts[parts.indexOf("instances") + 1] ?? "";
      const adapter = instanceManager.getAdapter(id);
      const profile = await adapter.getProfileInfo();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(profile),
          },
        ],
      };
    },
  );
}
