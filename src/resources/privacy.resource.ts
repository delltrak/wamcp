// ============================================================
// WA MCP — Privacy Settings Resource
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";

export function registerPrivacyResource(server: McpServer, instanceManager: InstanceManager): void {
  server.resource(
    "instance-privacy",
    "whatsapp://instances/{id}/privacy",
    {
      description: "Privacy settings: lastSeen, online, profilePic, status, readReceipts, groupAdd",
      mimeType: "application/json",
    },
    async (uri) => {
      const parts = uri.pathname.split("/");
      const id = parts[parts.indexOf("instances") + 1] ?? "";
      const adapter = instanceManager.getAdapter(id);
      const privacy = await adapter.getPrivacySettings();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(privacy),
          },
        ],
      };
    },
  );
}
