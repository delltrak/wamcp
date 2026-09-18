// ============================================================
// WA MCP — Messaging Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";
import { createRequestLogger } from "../utils/logger.js";
import {
  SendTextSchema,
  SendImageSchema,
  SendVideoSchema,
  SendAudioSchema,
  SendDocumentSchema,
  SendLocationSchema,
  SendContactSchema,
  SendPollSchema,
  SendReactionSchema,
  SendLinkPreviewSchema,
  ForwardMessageSchema,
  EditMessageSchema,
  DeleteMessageSchema,
  PinMessageSchema,
  SendViewOnceSchema,
  SendPresenceSchema,
  MarkReadSchema,
} from "../schemas/messaging.schema.js";

export function registerMessagingTools(
  server: McpServer,
  instanceManager: InstanceManager,
  messageQueue: MessageQueue,
): void {
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
          { type: "text", text: params.text, quotedMessageId: params.quotedMessageId },
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
          { type: "audio", audio: params.audio, ptt: params.ptt },
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
    "wa_send_contact",
    {
      description: "Send a vCard contact to a WhatsApp contact or group.",
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
          { type: "contact", contactName: params.contactName, contactPhone: params.contactPhone },
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
        const result = await adapter.sendLinkPreview(params.to, params.text, params.url);
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
        "Delete a message for everyone in the chat. Only messages sent by this instance can be deleted.",
      inputSchema: DeleteMessageSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_delete_message", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.deleteMessage(params.chatId, params.messageId);
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
      description:
        "Send a view-once image or video. The media disappears after the recipient views it once.",
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
        await adapter.markRead(params.chatId, params.messageIds);
        log.info({ duration: Date.now() - start }, "Messages marked read");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_mark_read", err, params.instanceId);
      }
    },
  );
}
