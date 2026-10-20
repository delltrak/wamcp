// ============================================================
// WA MCP — Newsletter / Channel Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import { MediaService } from "../services/media.js";
import type { MessageQueue } from "../services/message-queue.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";
import { createRequestLogger } from "../utils/logger.js";
import {
  DownloadNewsletterMediaSchema,
  NewsletterFollowSchema,
  NewsletterUnfollowSchema,
  NewsletterSendSchema,
} from "../schemas/newsletter.schema.js";

const mediaService = new MediaService();

export function registerNewsletterTools(
  server: McpServer,
  instanceManager: InstanceManager,
  _messageQueue: MessageQueue,
): void {
  server.registerTool(
    "wa_newsletter_follow",
    {
      description:
        "Follow a WhatsApp Channel/Newsletter. This server operation is blocked unless WA_GROUP_WRITES_ENABLED=true or WA_APP_STATE_WRITES_ENABLED=true. Baileys only.",
      inputSchema: NewsletterFollowSchema,
    },
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

  server.registerTool(
    "wa_newsletter_unfollow",
    {
      description:
        "Unfollow a WhatsApp Channel/Newsletter. This server operation is blocked unless WA_GROUP_WRITES_ENABLED=true or WA_APP_STATE_WRITES_ENABLED=true. Baileys only.",
      inputSchema: NewsletterUnfollowSchema,
    },
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

  server.registerTool(
    "wa_newsletter_send",
    {
      description: "Send a message to a WhatsApp Channel/Newsletter (must be admin). Baileys only.",
      inputSchema: NewsletterSendSchema,
    },
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

  server.registerTool(
    "wa_download_newsletter_media",
    {
      description:
        "Download image, video, audio, document, or sticker media from a WhatsApp Channel post and save it the same way as received media. messageId is the post server ID or message ID from wa_newsletter_list_posts. Returns the saved file path. Read-only. Baileys only.",
      inputSchema: DownloadNewsletterMediaSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_download_newsletter_media", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const maxBytes = mediaService.getMediaDownloadMaxBytes("file");
        const downloaded = await adapter.downloadNewsletterMedia(
          params.newsletterJid,
          params.messageId,
          maxBytes,
          60_000,
        );
        if (downloaded.data.length > maxBytes) {
          throw new Error(`Media exceeds maximum download size of ${maxBytes} bytes`);
        }
        const mimeType = downloaded.mimeType || "application/octet-stream";
        const fileName = mediaService.getDownloadedMediaFileName(
          downloaded.fileName,
          params.messageId,
          mimeType,
        );
        const saved = await mediaService.saveDownloadedMedia(downloaded.data, fileName);
        log.info(
          {
            duration: Date.now() - start,
            messageId: params.messageId,
            size: downloaded.data.length,
          },
          "Channel post media downloaded",
        );
        return toolSuccess({
          newsletterJid: params.newsletterJid,
          messageId: params.messageId,
          mediaType: downloaded.mediaType,
          mimeType,
          mode: "file",
          ...saved,
        });
      } catch (err) {
        return handleToolError("wa_download_newsletter_media", err, params.instanceId);
      }
    },
  );
}
