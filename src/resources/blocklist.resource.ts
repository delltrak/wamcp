// ============================================================
// WA MCP — Blocklist Resource
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import { perInstanceTemplate, varAsString } from "./resource-helpers.js";

export function registerBlocklistResource(
  server: McpServer,
  instanceManager: InstanceManager,
): void {
  server.registerResource(
    "instance-blocklist",
    perInstanceTemplate(
      instanceManager,
      (id) => `whatsapp://instances/${id}/blocklist`,
      (name) => `Blocklist — ${name}`,
    ),
    {
      description: "Blocked contacts for an instance",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = varAsString(variables, "id");
      const adapter = instanceManager.getAdapter(id);
      const data = await adapter.getBlocklist();
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data) }],
      };
    },
  );
}
