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
