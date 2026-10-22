// ============================================================
// WA MCP — Messaging Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { MediaService } from "../services/media.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";
import { planGroupMentionAll } from "../utils/group-mention.js";
import { createRequestLogger } from "../utils/logger.js";
import {
  SendTextSchema,
  SendImageSchema,
  SendVideoSchema,
  SendPtvSchema,
  SendStickerSchema,
  SendGifSchema,
  DownloadMediaSchema,
  SendAudioSchema,
  SendDocumentSchema,
  SendLocationSchema,
  SendContactSchema,
  SendPollSchema,
  GetPollResultsSchema,
  SendLiveLocationSchema,
  SendReactionSchema,
  SendLinkPreviewSchema,
  ForwardMessageSchema,
  EditMessageSchema,
  DeleteMessageSchema,
  PinMessageSchema,
  SendViewOnceSchema,
  SendPresenceSchema,
  MarkReadSchema,
  SubscribePresenceSchema,
  SendButtonsSchema,
  SendListSchema,
  SendMediaAlbumSchema,
  ReplyPrivatelyToGroupMessageSchema,
  SendGroupMentionAllSchema,
  GetMessageReceiptsSchema,
  GetMessageReactionsSchema,
} from "../schemas/messaging.schema.js";

export function registerMessagingTools(
  server: McpServer,
  instanceManager: InstanceManager,
  messageQueue: MessageQueue,
): void {
  const mediaService = new MediaService();

  server.registerTool(
    "wa_send_text",
    {
      description: `Send a text message to a WhatsApp contact or group.
Args:
  - instanceId: The instance to send from
  - to: Recipient phone number (e.g. "5511999999999") or group JID
  - text: Message content (max 65536 chars)
  - quotedMessageId (optional): Message ID to reply to
Returns: { status: "queued", jobId }`,
      inputSchema: SendTextSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_text", params.instanceId);
      const start = Date.now();
      try {
        const channel = instanceManager.getInstanceChannel(params.instanceId);
        const result = await messageQueue.enqueueMessage(
          params.instanceId,
          params.to,
          {
            type: "text",
            text: params.text,
            quotedMessageId: params.quotedMessageId,
            mentions: params.mentions,
          },
          channel,
        );
        log.info({ duration: Date.now() - start, to: params.to }, "Text message queued");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_text", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_image",
    {
      description:
        "Send an image to a WhatsApp contact or group. Image can be provided as a URL or base64-encoded data. Optional caption.",
      inputSchema: SendImageSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_image", params.instanceId);
      const start = Date.now();
      try {
        const channel = instanceManager.getInstanceChannel(params.instanceId);
        const result = await messageQueue.enqueueMessage(
          params.instanceId,
          params.to,
          {
            type: "image",
            image: params.image,
            caption: params.caption,
            quotedMessageId: params.quotedMessageId,
            mentions: params.mentions,
          },
          channel,
        );
        log.info({ duration: Date.now() - start, to: params.to }, "Image message queued");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_image", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_video",
    {
      description:
        "Send a video to a WhatsApp contact or group. Video can be provided as a URL or base64-encoded data. Optional caption.",
      inputSchema: SendVideoSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_video", params.instanceId);
      const start = Date.now();
      try {
        const channel = instanceManager.getInstanceChannel(params.instanceId);
        const result = await messageQueue.enqueueMessage(
          params.instanceId,
          params.to,
          {
            type: "video",
            video: params.video,
            caption: params.caption,
            quotedMessageId: params.quotedMessageId,
            mentions: params.mentions,
          },
          channel,
        );
        log.info({ duration: Date.now() - start, to: params.to }, "Video message queued");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_video", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_ptv",
    {
      description:
        "Send a round video note (PTV) to a WhatsApp contact or group. Baileys only; Cloud API does not support video notes.",
      inputSchema: SendPtvSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_ptv", params.instanceId);
      const start = Date.now();
      try {
        const channel = instanceManager.getInstanceChannel(params.instanceId);
        if (channel === "cloud") {
          throw new Error(
            "Video notes (PTV) are not supported on Cloud API; use a Baileys instance",
          );
        }
        const result = await messageQueue.enqueueMessage(
          params.instanceId,
          params.to,
          {
            type: "video",
            video: params.video,
            caption: params.caption,
            mentions: params.mentions,
            ptv: true,
          },
          channel,
        );
        log.info({ duration: Date.now() - start, to: params.to }, "PTV message queued");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_ptv", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_sticker",
    {
      description:
        "Send a native WhatsApp sticker. Accepts PNG, JPG, GIF, or WebP URL/base64; non-WebP images are converted to 512x512 WebP with transparent padding. Animated GIFs use ffmpeg.",
      inputSchema: SendStickerSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_sticker", params.instanceId);
      const start = Date.now();
      try {
        const channel = instanceManager.getInstanceChannel(params.instanceId);
        const sticker = await mediaService.prepareSticker(params.sticker, params.animated);
        const result = await messageQueue.enqueueMessage(
          params.instanceId,
          params.to,
          {
            type: "sticker",
            sticker: sticker.data.toString("base64"),
            animated: sticker.animated,
            quotedMessageId: params.quotedMessageId,
          },
          channel,
        );
        log.info(
          { duration: Date.now() - start, to: params.to, animated: sticker.animated },
          "Sticker message queued",
        );
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_sticker", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_gif",
    {
      description:
        "Send a GIF as a native WhatsApp looping video. GIF or MP4 URL/base64 is converted to silent H.264 MP4 with even dimensions. Available on Baileys instances.",
      inputSchema: SendGifSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_gif", params.instanceId);
      const start = Date.now();
      try {
        const channel = instanceManager.getInstanceChannel(params.instanceId);
        if (channel === "cloud") {
          throw new Error(
            "GIF playback sending is not supported on Cloud API; use a Baileys instance",
          );
        }
        const mp4 = await mediaService.convertGifToMp4(params.gif);
        const result = await messageQueue.enqueueMessage(
          params.instanceId,
          params.to,
          {
            type: "video",
            video: mp4.toString("base64"),
            caption: params.caption,
            gifPlayback: true,
            quotedMessageId: params.quotedMessageId,
            mentions: params.mentions,
          },
          channel,
        );
        log.info({ duration: Date.now() - start, to: params.to }, "GIF message queued");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_gif", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_audio",
    {
      description:
        "Send an audio file or voice note to a WhatsApp contact or group. Set ptt=true for voice note (push-to-talk).",
      inputSchema: SendAudioSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_audio", params.instanceId);
      const start = Date.now();
      try {
        const channel = instanceManager.getInstanceChannel(params.instanceId);
        const result = await messageQueue.enqueueMessage(
          params.instanceId,
          params.to,
          {
            type: "audio",
            audio: params.audio,
            ptt: params.ptt,
            quotedMessageId: params.quotedMessageId,
            mentions: params.mentions,
          },
          channel,
        );
        log.info({ duration: Date.now() - start, to: params.to }, "Audio message queued");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_audio", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_document",
    {
      description:
        "Send a document/file to a WhatsApp contact or group. Requires fileName and mimeType.",
      inputSchema: SendDocumentSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_document", params.instanceId);
      const start = Date.now();
      try {
        const channel = instanceManager.getInstanceChannel(params.instanceId);
        const result = await messageQueue.enqueueMessage(
          params.instanceId,
          params.to,
          {
            type: "document",
            document: params.document,
            fileName: params.fileName,
            mimeType: params.mimeType,
            mentions: params.mentions,
          },
          channel,
        );
        log.info({ duration: Date.now() - start, to: params.to }, "Document message queued");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_document", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_download_media",
    {
      description:
        "Download received image, video, audio, document, or sticker media. File mode returns a saved path; base64 mode returns inline data and has a 5 MB cap.",
      inputSchema: DownloadMediaSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_download_media", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const mode = params.mode ?? "file";
        const maxBytes = mediaService.getMediaDownloadMaxBytes(mode);
        const downloaded = await adapter.downloadMessageMedia(
          params.messageId,
          params.chatId,
          maxBytes,
          60_000,
        );
        const mimeType = downloaded.mimeType || "application/octet-stream";
        const fileName = mediaService.getDownloadedMediaFileName(
          downloaded.fileName,
          params.messageId,
          mimeType,
        );
        if (downloaded.data.length > maxBytes) {
          throw new Error(`Media exceeds maximum download size of ${maxBytes} bytes`);
        }

        const result =
          mode === "base64"
            ? {
                mode,
                path: null,
                mimeType,
                fileName,
                size: downloaded.data.length,
                base64: downloaded.data.toString("base64"),
              }
            : {
                mode,
                ...(await mediaService.saveDownloadedMedia(downloaded.data, fileName)),
                mimeType,
              };
        log.info(
          {
            duration: Date.now() - start,
            messageId: params.messageId,
            size: downloaded.data.length,
          },
          "Received media downloaded",
        );
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_download_media", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_location",
    {
      description: "Send a GPS location to a WhatsApp contact or group. Optional name and address.",
      inputSchema: SendLocationSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_location", params.instanceId);
      const start = Date.now();
      try {
        const channel = instanceManager.getInstanceChannel(params.instanceId);
        const result = await messageQueue.enqueueMessage(
          params.instanceId,
          params.to,
          {
            type: "location",
            latitude: params.latitude,
            longitude: params.longitude,
            name: params.name,
            address: params.address,
          },
          channel,
        );
        log.info({ duration: Date.now() - start, to: params.to }, "Location message queued");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_location", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_live_location",
    {
      description:
        "Send a live location message to a WhatsApp contact or group. Live location messages are available on Baileys only.",
      inputSchema: SendLiveLocationSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_live_location", params.instanceId);
      const start = Date.now();
      try {
        const channel = instanceManager.getInstanceChannel(params.instanceId);
        const result = await messageQueue.enqueueMessage(
          params.instanceId,
          params.to,
          {
            type: "location",
            latitude: params.latitude,
            longitude: params.longitude,
            isLive: true,
            accuracyInMeters: params.accuracyInMeters,
            comment: params.comment,
          },
          channel,
        );
        log.info({ duration: Date.now() - start, to: params.to }, "Live location queued");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_live_location", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_contact",
    {
      description:
        "Send one or more contacts as vCards to a WhatsApp contact or group. contactName/contactPhone remains available for one contact.",
      inputSchema: SendContactSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_contact", params.instanceId);
      const start = Date.now();
      try {
        const channel = instanceManager.getInstanceChannel(params.instanceId);
        const result = await messageQueue.enqueueMessage(
          params.instanceId,
          params.to,
          params.contacts
            ? { type: "contact", contacts: params.contacts }
            : {
                type: "contact",
                contactName: params.contactName!,
                contactPhone: params.contactPhone!,
              },
          channel,
        );
        log.info({ duration: Date.now() - start, to: params.to }, "Contact message queued");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_contact", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_poll",
    {
      description: "Create and send a poll to a WhatsApp contact or group. Supports 2-12 options.",
      inputSchema: SendPollSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_poll", params.instanceId);
      const start = Date.now();
      try {
        const channel = instanceManager.getInstanceChannel(params.instanceId);
        const result = await messageQueue.enqueueMessage(
          params.instanceId,
          params.to,
          {
            type: "poll",
            question: params.question,
            options: params.options,
            multiSelect: params.multiSelect,
          },
          channel,
        );
        log.info({ duration: Date.now() - start, to: params.to }, "Poll message queued");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_poll", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_get_poll_results",
    {
      description:
        "Read locally stored, decrypted votes for a WhatsApp poll. Requires the poll message to be stored on this Baileys instance.",
      inputSchema: GetPollResultsSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_get_poll_results", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const results = await adapter.getPollResults(params.chatId, params.messageId);
        log.info(
          { duration: Date.now() - start, options: results.options.length },
          "Poll results read",
        );
        return toolSuccess(results);
      } catch (err) {
        return handleToolError("wa_get_poll_results", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_reaction",
    {
      description:
        "React to a message with an emoji. Send an empty string emoji to remove a reaction.",
      inputSchema: SendReactionSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_reaction", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.sendReaction(params.chatId, params.messageId, params.emoji);
        log.info({ duration: Date.now() - start }, "Reaction sent");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_send_reaction", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_link_preview",
    {
      description:
        "Send a text message with a rich link preview. The URL is used to generate the preview.",
      inputSchema: SendLinkPreviewSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_link_preview", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const result = await adapter.sendLinkPreview(params.to, params.text, params.url, {
          title: params.title,
          description: params.description,
          thumbnail: params.thumbnail,
        });
        log.info({ duration: Date.now() - start, to: params.to }, "Link preview sent");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_link_preview", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_forward_message",
    {
      description: "Forward an existing message to another chat.",
      inputSchema: ForwardMessageSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_forward_message", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const result = await adapter.forwardMessage(params.to, params.messageId, params.fromChatId);
        log.info({ duration: Date.now() - start, to: params.to }, "Message forwarded");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_forward_message", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_edit_message",
    {
      description:
        "Edit a previously sent message. Only text messages sent by this instance can be edited.",
      inputSchema: EditMessageSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_edit_message", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.editMessage(params.chatId, params.messageId, params.newText);
        log.info({ duration: Date.now() - start }, "Message edited");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_edit_message", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_delete_message",
    {
      description:
        "Delete a message for everyone in the chat. Only messages sent by this instance can be deleted. For status@broadcast, an optional statusJidList can specify the deletion audience.",
      inputSchema: DeleteMessageSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_delete_message", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.deleteMessage(params.chatId, params.messageId, params.statusJidList);
        log.info({ duration: Date.now() - start }, "Message deleted");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_delete_message", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_pin_message",
    {
      description: "Pin or unpin a message in a chat.",
      inputSchema: PinMessageSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_pin_message", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.pinMessage(params.chatId, params.messageId, params.pin);
        log.info({ duration: Date.now() - start, pin: params.pin }, "Message pin toggled");
        return toolSuccess({ success: true, pinned: params.pin });
      } catch (err) {
        return handleToolError("wa_pin_message", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_view_once",
    {
      description: "Send a view-once image, video, or audio clip. Available on Baileys only.",
      inputSchema: SendViewOnceSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_view_once", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const result = await adapter.sendViewOnce(params.to, params.media, params.type);
        log.info({ duration: Date.now() - start, to: params.to }, "View-once sent");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_view_once", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_presence",
    {
      description:
        "Send a presence status (typing, recording, paused, available, unavailable) to a chat.",
      inputSchema: SendPresenceSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_presence", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.sendPresence(params.chatId, params.status);
        log.info({ duration: Date.now() - start }, "Presence sent");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_send_presence", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_subscribe_presence",
    {
      description:
        "Subscribe to presence updates for a contact or group. Later updates arrive as whatsapp/presence.updated notifications and configured event webhooks.",
      inputSchema: SubscribePresenceSchema,
    },
    async (params) => {
      try {
        await instanceManager.getAdapter(params.instanceId).subscribePresence(params.chatId);
        return toolSuccess({ success: true, chatId: params.chatId });
      } catch (err) {
        return handleToolError("wa_subscribe_presence", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_group_mention_all",
    {
      description:
        "Send a group message with WhatsApp's native @all mention. If native @all is unavailable, Baileys mentions each current participant instead. Notification delivery depends on WhatsApp and recipient settings. Cloud API does not support this helper.",
      inputSchema: SendGroupMentionAllSchema,
    },
    async (params) => {
      try {
        if (instanceManager.getInstanceChannel(params.instanceId) === "cloud") {
          throw new Error(
            "Group @all mentions are not supported on Cloud API; use a Baileys instance",
          );
        }
        const adapter = instanceManager.getAdapter(params.instanceId);
        const group = await adapter.getGroupMetadata(params.groupId);
        const plan = planGroupMentionAll({
          text: params.text,
          nativeSupported: await adapter.supportsNativeGroupMentionAll(),
          participants: group.participants.map((participant) => participant.jid),
        });
        const result = await messageQueue.enqueueMessage(
          params.instanceId,
          group.jid,
          plan.mode === "native"
            ? { type: "text", text: plan.text, mentionAll: true }
            : { type: "text", text: plan.text, mentions: plan.mentions },
          "baileys",
        );
        return toolSuccess(
          plan.mode === "native"
            ? { ...result, mode: "native" }
            : { ...result, mode: "participants", mentionCount: plan.mentions.length },
        );
      } catch (err) {
        return handleToolError("wa_send_group_mention_all", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_buttons",
    {
      description:
        "Send up to three reply buttons where supported. Baileys rc14 sends an explicit numbered text fallback; Cloud API sends an interactive button message.",
      inputSchema: SendButtonsSchema,
    },
    async (params) => {
      try {
        const channel = instanceManager.getInstanceChannel(params.instanceId);
        const result = await messageQueue.enqueueMessage(
          params.instanceId,
          params.to,
          { type: "buttons", text: params.text, footer: params.footer, buttons: params.buttons },
          channel,
        );
        return toolSuccess({
          ...result,
          mode: channel === "cloud" ? "interactive" : "text_fallback",
        });
      } catch (err) {
        return handleToolError("wa_send_buttons", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_list",
    {
      description:
        "Send a selectable list where supported. Baileys rc14 sends a readable text fallback; Cloud API sends an interactive list message.",
      inputSchema: SendListSchema,
    },
    async (params) => {
      try {
        const channel = instanceManager.getInstanceChannel(params.instanceId);
        const result = await messageQueue.enqueueMessage(
          params.instanceId,
          params.to,
          {
            type: "list",
            text: params.text,
            footer: params.footer,
            buttonText: params.buttonText,
            sections: params.sections,
          },
          channel,
        );
        return toolSuccess({
          ...result,
          mode: channel === "cloud" ? "interactive" : "text_fallback",
        });
      } catch (err) {
        return handleToolError("wa_send_list", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_media_album",
    {
      description:
        "Send 2 to 10 images as one Baileys media album. Cloud API does not support album grouping.",
      inputSchema: SendMediaAlbumSchema,
    },
    async (params) => {
      try {
        if (instanceManager.getInstanceChannel(params.instanceId) === "cloud") {
          throw new Error("Media albums are not supported on Cloud API; use a Baileys instance");
        }
        const result = await messageQueue.enqueueMediaAlbum(
          params.instanceId,
          params.to,
          params.images,
        );
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_media_album", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_reply_privately_to_group_message",
    {
      description:
        "Send a private direct message to the author of a stored group message. The original message must be available in local history.",
      inputSchema: ReplyPrivatelyToGroupMessageSchema,
    },
    async (params) => {
      try {
        const result = await instanceManager
          .getAdapter(params.instanceId)
          .replyPrivatelyToGroupMessage(params.groupId, params.messageId, params.text);
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_reply_privately_to_group_message", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_get_message_receipts",
    {
      description:
        "List locally stored per-participant delivered, read, and played receipts for a message. Cloud API does not expose participant-level receipts here.",
      inputSchema: GetMessageReceiptsSchema,
    },
    async (params) => {
      try {
        const receipts = await instanceManager
          .getAdapter(params.instanceId)
          .getMessageReceipts(params.chatId, params.messageId);
        return toolSuccess({
          chatId: params.chatId,
          messageId: params.messageId,
          count: receipts.length,
          receipts,
        });
      } catch (err) {
        return handleToolError("wa_get_message_receipts", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_get_message_reactions",
    {
      description:
        "List the latest locally stored reaction from each participant for a message. Cloud API reaction listing is unavailable.",
      inputSchema: GetMessageReactionsSchema,
    },
    async (params) => {
      try {
        const reactions = await instanceManager
          .getAdapter(params.instanceId)
          .getMessageReactions(params.chatId, params.messageId);
        return toolSuccess({
          chatId: params.chatId,
          messageId: params.messageId,
          count: reactions.length,
          reactions,
        });
      } catch (err) {
        return handleToolError("wa_get_message_reactions", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_mark_read",
    {
      description: "Mark specific messages as read in a chat.",
      inputSchema: MarkReadSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_mark_read", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.markRead(params.chatId, params.messageIds, params.participant);
        log.info({ duration: Date.now() - start }, "Messages marked read");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_mark_read", err, params.instanceId);
      }
    },
  );
}
