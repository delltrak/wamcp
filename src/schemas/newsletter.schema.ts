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
