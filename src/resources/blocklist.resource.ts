// ============================================================
// WA MCP — Blocklist Resource
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";

export function registerBlocklistResource(
  server: McpServer,
  instanceManager: InstanceManager,
): void {
  server.resource(
    "instance-blocklist",
    "whatsapp://instances/{id}/blocklist",
    { description: "Blocked contacts for an instance", mimeType: "application/json" },
    async (uri) => {
      const parts = uri.pathname.split("/");
      const id = parts[parts.indexOf("instances") + 1] ?? "";
      const adapter = instanceManager.getAdapter(id);
      const blocklist = await adapter.getBlocklist();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(blocklist),
          },
        ],
      };
    },
  );
}
