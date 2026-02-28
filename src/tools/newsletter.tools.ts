// ============================================================
// WA MCP — Newsletter / Channel Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { toolSuccess, toolError } from "../types/mcp.types.js";
import {
  NewsletterFollowSchema,
  NewsletterUnfollowSchema,
  NewsletterSendSchema,
} from "../schemas/newsletter.schema.js";

export function registerNewsletterTools(
  server: McpServer,
  instanceManager: InstanceManager,
  _messageQueue: MessageQueue,
): void {
  server.tool(
    "wa_newsletter_follow",
    "Follow a WhatsApp Channel/Newsletter. Baileys only.",
    NewsletterFollowSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.newsletterFollow(params.jid);
        return toolSuccess({ success: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_newsletter_unfollow",
    "Unfollow a WhatsApp Channel/Newsletter. Baileys only.",
    NewsletterUnfollowSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.newsletterUnfollow(params.jid);
        return toolSuccess({ success: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_newsletter_send",
    "Send a message to a WhatsApp Channel/Newsletter (must be admin). Baileys only.",
    NewsletterSendSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const result = await adapter.newsletterSend(params.jid, params.text);
        return toolSuccess(result);
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );
}
