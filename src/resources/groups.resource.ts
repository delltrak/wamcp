// ============================================================
// WA MCP — Groups Resource
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";

export function registerGroupsResource(server: McpServer, instanceManager: InstanceManager): void {
  // List all groups
  server.resource(
    "instance-groups",
    "whatsapp://instances/{id}/groups",
    {
      description: "All groups for an instance: JID, subject, participant count, your role",
      mimeType: "application/json",
    },
    async (uri) => {
      const parts = uri.pathname.split("/");
      const id = parts[parts.indexOf("instances") + 1] ?? "";
      const adapter = instanceManager.getAdapter(id);
      // getChats returns all chats, filter for groups
      const chatList = await adapter.getChats();
      const groups = chatList.filter((c) => c.isGroup);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(groups),
          },
        ],
      };
    },
  );

  // Single group metadata
  server.resource(
    "instance-group-detail",
    "whatsapp://instances/{id}/groups/{groupId}",
    {
      description: "Full group metadata: participants, admins, description, settings, invite link",
      mimeType: "application/json",
    },
    async (uri) => {
      const parts = uri.pathname.split("/");
      const instanceIdx = parts.indexOf("instances");
      const id = parts[instanceIdx + 1] ?? "";
      const groupId = parts[parts.indexOf("groups") + 1] ?? "";
      const adapter = instanceManager.getAdapter(id);
      const metadata = await adapter.getGroupMetadata(groupId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(metadata),
          },
        ],
      };
    },
  );
}
