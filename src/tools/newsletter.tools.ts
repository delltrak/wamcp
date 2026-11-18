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
  NewsletterSendMediaSchema,
  NewsletterStatsSchema,
  NewsletterMuteSchema,
  NewsletterUnmuteSchema,
  NewsletterRemovePictureSchema,
  NewsletterDeleteSchema,
  NewsletterChangeOwnerSchema,
  NewsletterDemoteAdminSchema,
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
    "wa_newsletter_send_media",
    {
      description:
        "Send an image, video, audio clip, or document to a WhatsApp Channel/Newsletter (must be admin). Baileys only.",
      inputSchema: NewsletterSendMediaSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_newsletter_send_media", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const content =
          params.type === "document"
            ? {
                type: "document" as const,
                media: params.media,
                fileName: params.fileName ?? "document",
                ...(params.mimeType ? { mimeType: params.mimeType } : {}),
                ...(params.caption ? { caption: params.caption } : {}),
              }
            : params.type === "audio"
              ? {
                  type: "audio" as const,
                  media: params.media,
                  ...(params.mimeType ? { mimeType: params.mimeType } : {}),
                }
              : {
                  type: params.type,
                  media: params.media,
                  ...(params.caption ? { caption: params.caption } : {}),
                };
        const result = await adapter.newsletterSendMedia(params.jid, content);
        log.info(
          { duration: Date.now() - start, type: params.type },
          "Newsletter media message sent",
        );
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_newsletter_send_media", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_newsletter_stats",
    {
      description:
        "Fetch subscriber count and admin count for a WhatsApp Channel/Newsletter. Read-only; Baileys only.",
      inputSchema: NewsletterStatsSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_newsletter_stats", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const stats = await adapter.getNewsletterStats(params.jid);
        log.info({ duration: Date.now() - start }, "Newsletter stats read");
        return toolSuccess(stats);
      } catch (err) {
        return handleToolError("wa_newsletter_stats", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_newsletter_mute",
    {
      description:
        "Mute notifications for a WhatsApp Channel/Newsletter. This server operation is blocked unless WA_GROUP_WRITES_ENABLED=true or WA_APP_STATE_WRITES_ENABLED=true. Baileys only.",
      inputSchema: NewsletterMuteSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_newsletter_mute", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.newsletterMute(params.jid, true);
        log.info({ duration: Date.now() - start }, "Newsletter muted");
        return toolSuccess({ success: true, jid: params.jid, muted: true });
      } catch (err) {
        return handleToolError("wa_newsletter_mute", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_newsletter_unmute",
    {
      description:
        "Unmute notifications for a WhatsApp Channel/Newsletter. This server operation is blocked unless WA_GROUP_WRITES_ENABLED=true or WA_APP_STATE_WRITES_ENABLED=true. Baileys only.",
      inputSchema: NewsletterUnmuteSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_newsletter_unmute", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.newsletterMute(params.jid, false);
        log.info({ duration: Date.now() - start }, "Newsletter unmuted");
        return toolSuccess({ success: true, jid: params.jid, muted: false });
      } catch (err) {
        return handleToolError("wa_newsletter_unmute", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_newsletter_remove_picture",
    {
      description:
        "Remove the profile picture of a WhatsApp Channel/Newsletter. This server operation is blocked unless WA_GROUP_WRITES_ENABLED=true or WA_APP_STATE_WRITES_ENABLED=true. Baileys only.",
      inputSchema: NewsletterRemovePictureSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_newsletter_remove_picture", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.removeNewsletterPicture(params.jid);
        log.info({ duration: Date.now() - start }, "Newsletter picture removed");
        return toolSuccess({ success: true, jid: params.jid });
      } catch (err) {
        return handleToolError("wa_newsletter_remove_picture", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_newsletter_delete",
    {
      description:
        "Permanently delete a WhatsApp Channel/Newsletter (must be owner). This server operation is blocked unless WA_GROUP_WRITES_ENABLED=true or WA_APP_STATE_WRITES_ENABLED=true. Baileys only.",
      inputSchema: NewsletterDeleteSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_newsletter_delete", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.deleteNewsletter(params.jid);
        log.info({ duration: Date.now() - start }, "Newsletter deleted");
        return toolSuccess({ success: true, jid: params.jid, deleted: true });
      } catch (err) {
        return handleToolError("wa_newsletter_delete", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_newsletter_change_owner",
    {
      description:
        "Transfer ownership of a WhatsApp Channel/Newsletter to another user (must be owner). This server operation is blocked unless WA_GROUP_WRITES_ENABLED=true or WA_APP_STATE_WRITES_ENABLED=true. Baileys only.",
      inputSchema: NewsletterChangeOwnerSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_newsletter_change_owner", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.changeNewsletterOwner(params.jid, params.newOwnerJid);
        log.info({ duration: Date.now() - start }, "Newsletter owner changed");
        return toolSuccess({
          success: true,
          jid: params.jid,
          newOwnerJid: params.newOwnerJid,
        });
      } catch (err) {
        return handleToolError("wa_newsletter_change_owner", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_newsletter_demote_admin",
    {
      description:
        "Demote an admin of a WhatsApp Channel/Newsletter (must be owner). This server operation is blocked unless WA_GROUP_WRITES_ENABLED=true or WA_APP_STATE_WRITES_ENABLED=true. Baileys only.",
      inputSchema: NewsletterDemoteAdminSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_newsletter_demote_admin", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.demoteNewsletterAdmin(params.jid, params.userJid);
        log.info({ duration: Date.now() - start }, "Newsletter admin demoted");
        return toolSuccess({
          success: true,
          jid: params.jid,
          userJid: params.userJid,
        });
      } catch (err) {
        return handleToolError("wa_newsletter_demote_admin", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_download_newsletter_media",
    {
      description:
        "Download image, video, audio, document, or sticker media from a WhatsApp Channel post and save it the same way as received media. Posts without a media key are downloaded in the clear from the WhatsApp CDN and checked against fileSha256. messageId is the post server ID or message ID from wa_newsletter_list_posts. Returns the saved file path. Read-only. Baileys only.",
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
