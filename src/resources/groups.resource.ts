// ============================================================
// WA MCP — Groups Resource
// ============================================================

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import { perInstanceTemplate, varAsString } from "./resource-helpers.js";

export function registerGroupsResource(server: McpServer, instanceManager: InstanceManager): void {
  // List all groups
  server.registerResource(
    "instance-groups",
    perInstanceTemplate(
      instanceManager,
      (id) => `whatsapp://instances/${id}/groups`,
      (name) => `Groups — ${name}`,
    ),
    {
      description: "All groups for an instance: JID, subject, participant count, your role",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = varAsString(variables, "id");
      const adapter = instanceManager.getAdapter(id);
      // getChats returns all chats, filter for groups
      const chatList = await adapter.getChats();
      const data = chatList.filter((c) => c.isGroup);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data) }],
      };
    },
  );

  // Single group metadata
  server.registerResource(
    "instance-group-detail",
    // No list callback: listing groups requires a connected adapter per instance.
    new ResourceTemplate("whatsapp://instances/{id}/groups/{groupId}", { list: undefined }),
    {
      description: "Full group metadata: participants, admins, description, settings, invite link",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = varAsString(variables, "id");
      const groupId = varAsString(variables, "groupId");
      const adapter = instanceManager.getAdapter(id);
      const data = await adapter.getGroupMetadata(groupId);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data) }],
      };
    },
  );
}
