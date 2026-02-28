// ============================================================
// WA MCP — Newsletter / Channel Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";
import { createRequestLogger } from "../utils/logger.js";
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
      const log = createRequestLogger("wa_newsletter_follow", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.newsletterFollow(params.jid);
        log.info({ duration: Date.now() - start }, "Newsletter followed");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_newsletter_follow", err, params.instanceId);
      }
    },
  );

  server.tool(
    "wa_newsletter_unfollow",
    "Unfollow a WhatsApp Channel/Newsletter. Baileys only.",
    NewsletterUnfollowSchema.shape,
    async (params) => {
      const log = createRequestLogger("wa_newsletter_unfollow", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.newsletterUnfollow(params.jid);
        log.info({ duration: Date.now() - start }, "Newsletter unfollowed");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_newsletter_unfollow", err, params.instanceId);
      }
    },
  );

  server.tool(
    "wa_newsletter_send",
    "Send a message to a WhatsApp Channel/Newsletter (must be admin). Baileys only.",
    NewsletterSendSchema.shape,
    async (params) => {
      const log = createRequestLogger("wa_newsletter_send", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const result = await adapter.newsletterSend(params.jid, params.text);
        log.info({ duration: Date.now() - start }, "Newsletter message sent");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_newsletter_send", err, params.instanceId);
      }
    },
  );
}
