// ============================================================
// WA MCP — Newsletter / Channel Zod Schemas
// ============================================================

import { z } from "zod";

export const NewsletterFollowSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    jid: z.string().min(1).describe("Newsletter/Channel JID to follow"),
  })
  .strict();

export const NewsletterUnfollowSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    jid: z.string().min(1).describe("Newsletter/Channel JID to unfollow"),
  })
  .strict();

export const NewsletterSendSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    jid: z.string().min(1).describe("Newsletter/Channel JID to send to (must be admin)"),
    text: z.string().min(1).describe("Message text content"),
  })
  .strict();

export const DownloadNewsletterMediaSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    newsletterJid: z
      .string()
      .trim()
      .regex(/^\d{5,20}@newsletter$/, "Expected a WhatsApp Channel JID ending in @newsletter")
      .describe("Channel JID ending in @newsletter"),
    messageId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .describe("Channel post server ID or message ID returned by wa_newsletter_list_posts"),
  })
  .strict();

const NewsletterChannelJidSchema = z
  .string()
  .trim()
  .regex(/^\d{5,20}@newsletter$/, "Expected a WhatsApp Channel JID ending in @newsletter")
  .describe("Channel JID ending in @newsletter");

export const NewsletterSendMediaSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    jid: NewsletterChannelJidSchema,
    type: z
      .enum(["image", "video", "audio", "document"])
      .describe("Channel media post type: image, video, audio, or document"),
    media: z.string().min(1).describe("Media URL or base64-encoded data"),
    caption: z
      .string()
      .max(2048)
      .optional()
      .describe("Optional caption for image, video, or document"),
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe("File name with extension (required when type is document)"),
    mimeType: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe("MIME type of the document or audio file"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.type === "document" && !value.fileName) {
      context.addIssue({
        code: "custom",
        path: ["fileName"],
        message: "fileName is required when sending a document to a Channel",
      });
    }
  });

export const NewsletterStatsSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    jid: NewsletterChannelJidSchema,
  })
  .strict();

export const NewsletterMuteSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    jid: NewsletterChannelJidSchema,
  })
  .strict();

export const NewsletterUnmuteSchema = NewsletterMuteSchema;

export const NewsletterRemovePictureSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    jid: NewsletterChannelJidSchema,
  })
  .strict();

export const NewsletterDeleteSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    jid: NewsletterChannelJidSchema,
  })
  .strict();

export const NewsletterChangeOwnerSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    jid: NewsletterChannelJidSchema,
    newOwnerJid: z.string().trim().min(5).describe("Phone number or JID of the new Channel owner"),
  })
  .strict();

export const NewsletterDemoteAdminSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    jid: NewsletterChannelJidSchema,
    userJid: z
      .string()
      .trim()
      .min(5)
      .describe("Phone number or JID of the Channel admin to demote"),
  })
  .strict();
