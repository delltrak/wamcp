// ============================================================
// WA MCP — Messaging Zod Schemas
// ============================================================

import { z } from "zod";
import { isValidStatusRecipient } from "../utils/validation.js";

const MentionsSchema = z
  .array(z.string().trim().min(5))
  .max(100)
  .optional()
  .describe("Participant phone numbers or JIDs to mention in the message or caption");

export const SendTextSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    text: z.string().min(1).max(65536).describe("Message text content"),
    quotedMessageId: z.string().optional().describe("Message ID to reply to"),
    mentions: MentionsSchema,
  })
  .strict();

export const SendImageSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    image: z.string().min(1).describe("Image URL or base64-encoded data"),
    caption: z.string().optional().describe("Optional image caption"),
    quotedMessageId: z.string().optional().describe("Message ID to reply to"),
    mentions: MentionsSchema,
  })
  .strict();

export const SendVideoSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    video: z.string().min(1).describe("Video URL or base64-encoded data"),
    caption: z.string().optional().describe("Optional video caption"),
    quotedMessageId: z.string().optional().describe("Message ID to reply to"),
    mentions: MentionsSchema,
  })
  .strict();

export const SendPtvSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    video: z.string().min(1).describe("Video URL or base64-encoded data"),
    caption: z.string().optional().describe("Optional video caption"),
    mentions: MentionsSchema,
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
    mentions: MentionsSchema,
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
    mentions: MentionsSchema,
  })
  .strict();

export const SendDocumentSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    document: z.string().min(1).describe("Document URL or base64-encoded data"),
    fileName: z.string().min(1).describe("File name with extension"),
    mimeType: z.string().min(1).describe("MIME type of the document"),
    mentions: MentionsSchema,
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
    contactName: z.string().min(1).optional().describe("Contact display name for one contact"),
    contactPhone: z.string().min(5).optional().describe("Contact phone number for one contact"),
    contacts: z
      .array(
        z
          .object({
            name: z.string().min(1).describe("Contact display name"),
            phone: z.string().min(5).describe("Contact phone number"),
          })
          .strict(),
      )
      .min(1)
      .max(20)
      .optional()
      .describe("One or more contacts to share as vCards"),
  })
  .superRefine((value, context) => {
    const hasLegacyName = value.contactName !== undefined;
    const hasLegacyPhone = value.contactPhone !== undefined;
    const hasContacts = value.contacts !== undefined;
    if (hasLegacyName !== hasLegacyPhone || hasContacts === hasLegacyName) {
      context.addIssue({
        code: "custom",
        path: ["contacts"],
        message: "Provide either contacts or both contactName and contactPhone, but not both forms",
      });
    }
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

export const GetPollResultsSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID containing the poll"),
    messageId: z.string().min(1).describe("Poll creation message ID"),
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
    title: z.string().max(512).optional().describe("Optional preview title override"),
    description: z.string().max(2048).optional().describe("Optional preview description override"),
    thumbnail: z
      .string()
      .max(1_000_000)
      .optional()
      .describe("Optional preview thumbnail as base64-encoded image data"),
  })
  .strict();

export const SendButtonsSchema = z
  .object({
    instanceId: z.string().min(1),
    to: z.string().min(5),
    text: z.string().min(1).max(1024),
    footer: z.string().max(60).optional(),
    buttons: z
      .array(
        z
          .object({ id: z.string().min(1).max(256), text: z.string().trim().min(1).max(20) })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();

export const SendListSchema = z
  .object({
    instanceId: z.string().min(1),
    to: z.string().min(5),
    text: z.string().min(1).max(1024),
    footer: z.string().max(60).optional(),
    buttonText: z.string().trim().min(1).max(20),
    sections: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(24),
            rows: z
              .array(
                z
                  .object({
                    id: z.string().min(1).max(200),
                    title: z.string().trim().min(1).max(24),
                    description: z.string().max(72).optional(),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .refine(
    (value) => value.sections.reduce((total, section) => total + section.rows.length, 0) <= 10,
    {
      message: "A list may contain at most 10 rows",
      path: ["sections"],
    },
  );

export const SendMediaAlbumSchema = z
  .object({
    instanceId: z.string().min(1),
    to: z.string().min(5),
    images: z
      .array(
        z
          .object({
            image: z.string().min(1),
            caption: z.string().max(1024).optional(),
          })
          .strict(),
      )
      .min(2)
      .max(10),
  })
  .strict();

export const ReplyPrivatelyToGroupMessageSchema = z
  .object({
    instanceId: z.string().min(1),
    groupId: z.string().min(5).describe("Group JID containing the original message"),
    messageId: z
      .string()
      .min(1)
      .describe("Message ID whose author should receive the private reply"),
    text: z.string().min(1).max(65536),
  })
  .strict();

export const SendGroupMentionAllSchema = z
  .object({
    instanceId: z.string().min(1),
    groupId: z.string().min(5).describe("Group JID whose participants should all be mentioned"),
    text: z.string().trim().min(1).max(4096).describe("Message text to send with an @all mention"),
  })
  .strict();

export const GetMessageReceiptsSchema = z
  .object({
    instanceId: z.string().min(1),
    chatId: z.string().min(5),
    messageId: z.string().min(1),
  })
  .strict();

export const GetMessageReactionsSchema = z
  .object({
    instanceId: z.string().min(1),
    chatId: z.string().min(5),
    messageId: z.string().min(1),
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
    media: z
      .string()
      .min(1)
      .describe("Media URL or base64-encoded data; audio also accepts a base64 data URI"),
    type: z.enum(["image", "video", "audio"]).describe("Media type: image, video, or audio"),
  })
  .strict();

export const SendLiveLocationSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Recipient phone number or group JID"),
    latitude: z.number().min(-90).max(90).describe("Current GPS latitude"),
    longitude: z.number().min(-180).max(180).describe("Current GPS longitude"),
    accuracyInMeters: z.number().int().min(0).optional().describe("Location accuracy in meters"),
    comment: z.string().max(256).optional().describe("Optional note shown with the live location"),
  })
  .strict();

export const SendPresenceSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID to send presence to"),
    status: z
      .enum(["typing", "composing", "recording", "paused", "available", "unavailable"])
      .describe("Presence status to send"),
  })
  .strict();

export const SubscribePresenceSchema = z
  .object({
    instanceId: z.string().min(1),
    chatId: z
      .string()
      .min(5)
      .describe("Contact or group JID whose presence updates to subscribe to"),
  })
  .strict();

export const MarkReadSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID containing the messages"),
    messageIds: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .describe("Message IDs to mark as read (1-100 per request)"),
    participant: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional sender JID for group messages; otherwise resolved from stored message data",
      ),
  })
  .strict();

export const MarkPlayedSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    chatId: z.string().min(5).describe("Chat JID containing the audio messages"),
    messageIds: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .describe("Stored incoming audio or voice-note message IDs to mark as played (1-100)"),
    participant: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional sender JID for group audio when the stored message has no sender; otherwise resolved from storage",
      ),
  })
  .strict();
