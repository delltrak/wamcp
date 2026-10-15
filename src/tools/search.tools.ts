import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import { SearchMessagesSchema } from "../schemas/search.schema.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";

export function registerSearchTools(server: McpServer, instanceManager: InstanceManager): void {
  server.registerTool(
    "wa_search_messages",
    {
      description:
        "Search the instance's local message database for a case-insensitive text substring, with optional inclusive date, sender, and chat filters. Results are newest first with offset pagination.",
      inputSchema: SearchMessagesSchema,
    },
    async (params) => {
      try {
        const result = await instanceManager.getAdapter(params.instanceId).searchMessages({
          query: params.query,
          ...(params.from ? { from: Math.floor(Date.parse(params.from) / 1000) } : {}),
          ...(params.to ? { to: Math.floor(Date.parse(params.to) / 1000) } : {}),
          ...(params.sender ? { sender: params.sender } : {}),
          ...(params.chatId ? { chatId: params.chatId } : {}),
          limit: params.limit,
          offset: params.offset,
        });
        return toolSuccess({
          query: params.query,
          count: result.messages.length,
          limit: params.limit,
          offset: params.offset,
          hasMore: result.hasMore,
          nextOffset: result.nextOffset,
          messages: result.messages,
        });
      } catch (err) {
        return handleToolError("wa_search_messages", err, params.instanceId);
      }
    },
  );
}
