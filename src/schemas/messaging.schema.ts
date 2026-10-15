// ============================================================
// WA MCP — Messaging Zod Schemas
// ============================================================

import { z } from "zod";
import { isValidStatusRecipient } from "../utils/validation.js";

export const SendTextSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    text: z.string().min(1).max(65536).describe("Message text content"),
    quotedMessageId: z.string().optional().describe("Message ID to reply to"),
  })
  .strict();

export const SendImageSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    image: z.string().min(1).describe("Image URL or base64-encoded data"),
    caption: z.string().optional().describe("Optional image caption"),
    quotedMessageId: z.string().optional().describe("Message ID to reply to"),
  })
  .strict();

export const SendVideoSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    video: z.string().min(1).describe("Video URL or base64-encoded data"),
    caption: z.string().optional().describe("Optional video caption"),
    quotedMessageId: z.string().optional().describe("Message ID to reply to"),
  })
  .strict();

export const SendPtvSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    video: z.string().min(1).describe("Video URL or base64-encoded data"),
    caption: z.string().optional().describe("Optional video caption"),
  })
  .strict();

export const SendStickerSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    sticker: z.string().min(1).describe("Sticker image URL or base64-encoded data"),
    animated: z
      .boolean()
      .optional()
      .describe("Optional hint that a GIF sticker input should retain its animation"),
    quotedMessageId: z.string().optional().describe("Message ID to reply to"),
  })
  .strict();

export const SendGifSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    gif: z.string().min(1).describe("GIF or MP4 URL or base64-encoded data"),
    caption: z.string().optional().describe("Optional caption"),
    quotedMessageId: z.string().optional().describe("Message ID to reply to"),
  })
  .strict();

export const DownloadMediaSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID with the received message"),
    messageId: z.string().min(1).describe("Received message ID to download"),
    chatId: z.string().min(5).optional().describe("Optional chat JID to verify the message"),
    mode: z.enum(["file", "base64"]).default("file").describe("Return a saved path or base64 data"),
  })
  .strict();

export const SendAudioSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    audio: z.string().min(1).describe("Audio URL or base64-encoded data"),
    ptt: z.boolean().default(false).describe("Send as voice note (push-to-talk)"),
    quotedMessageId: z.string().optional().describe("Message ID to reply to"),
  })
  .strict();

export const SendDocumentSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    document: z.string().min(1).describe("Document URL or base64-encoded data"),
    fileName: z.string().min(1).describe("File name with extension"),
    mimeType: z.string().min(1).describe("MIME type of the document"),
  })
  .strict();

export const SendLocationSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    latitude: z.number().min(-90).max(90).describe("GPS latitude"),
    longitude: z.number().min(-180).max(180).describe("GPS longitude"),
    name: z.string().optional().describe("Location name"),
    address: z.string().optional().describe("Location address"),
  })
  .strict();

export const SendContactSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    contactName: z.string().min(1).describe("Contact display name"),
    contactPhone: z.string().min(5).describe("Contact phone number"),
  })
  .strict();

export const SendPollSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    question: z.string().min(1).describe("Poll question"),
    options: z.array(z.string().min(1)).min(2).max(12).describe("Poll options (2-12 choices)"),
    multiSelect: z.boolean().default(false).describe("Allow multiple selections"),
  })
  .strict();

export const SendReactionSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    chatId: z.string().min(5).describe("Chat JID where the message is"),
    messageId: z.string().min(1).describe("Message ID to react to"),
    emoji: z.string().describe("Emoji to react with (empty string to remove reaction)"),
  })
  .strict();

export const SendLinkPreviewSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    text: z.string().min(1).describe("Message text content"),
    url: z.string().url().describe("URL for the link preview"),
  })
  .strict();

export const ForwardMessageSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID to forward to"),
    messageId: z.string().min(1).describe("Message ID to forward"),
    fromChatId: z.string().min(5).describe("Chat JID where the original message is"),
  })
  .strict();

export const EditMessageSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID where the message is"),
    messageId: z.string().min(1).describe("Message ID to edit"),
    newText: z.string().min(1).describe("New text content for the message"),
  })
  .strict();

export const DeleteMessageSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID where the message is"),
    messageId: z.string().min(1).describe("Message ID to delete for everyone"),
    statusJidList: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .refine(isValidStatusRecipient, "Expected an individual WhatsApp phone number or JID"),
      )
      .optional()
      .describe("Optional status deletion audience; only valid when chatId is status@broadcast"),
  })
  .superRefine((value, context) => {
    if (value.statusJidList !== undefined && value.chatId !== "status@broadcast") {
      context.addIssue({
        code: "custom",
        path: ["statusJidList"],
        message: "statusJidList is only valid when chatId is status@broadcast",
      });
    }
  })
  .strict();

export const PinMessageSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID where the message is"),
    messageId: z.string().min(1).describe("Message ID to pin or unpin"),
    pin: z.boolean().describe("true to pin, false to unpin"),
  })
  .strict();

export const SendViewOnceSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    media: z.string().min(1).describe("Media URL or base64-encoded data"),
    type: z.enum(["image", "video"]).describe("Media type: image or video"),
  })
  .strict();

export const SendPresenceSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID to send presence to"),
    status: z
      .enum(["composing", "recording", "paused", "available", "unavailable"])
      .describe("Presence status to send"),
  })
  .strict();

export const MarkReadSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID containing the messages"),
    messageIds: z.array(z.string().min(1)).min(1).describe("Message IDs to mark as read"),
    participant: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional sender JID for group messages; otherwise resolved from stored message data",
      ),
  })
  .strict();
