// ============================================================
// WA MCP — Business, Community, and Channel Schemas
// ============================================================

import { z } from "zod";
import { isValidGroupId } from "../utils/group-jid.js";

const InstanceIdSchema = z.string().min(1).describe("The instance ID");

const GroupIdSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isValidGroupId, "Expected a WhatsApp group ID or a JID ending in @g.us");

const NewsletterJidSchema = z
  .string()
  .trim()
  .regex(/^\d{5,20}@newsletter$/, "Expected a WhatsApp Channel JID ending in @newsletter");

const CatalogImagesSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(10)
  .describe("Product image URLs (HTTPS) or base64-encoded image data");

export const CreateQuickReplySchema = z
  .object({
    instanceId: InstanceIdSchema,
    shortcut: z.string().trim().min(1).max(50).describe("Shortcut text, without a leading slash"),
    message: z.string().min(1).max(4096).describe("Quick reply message"),
  })
  .strict();

export const EditQuickReplySchema = z
  .object({
    instanceId: InstanceIdSchema,
    timestamp: z.string().regex(/^\d+$/).describe("Quick reply sync timestamp used as its ID"),
    shortcut: z.string().trim().min(1).max(50).describe("Updated shortcut text"),
    message: z.string().min(1).max(4096).describe("Updated quick reply message"),
  })
  .strict();

export const DeleteQuickReplySchema = z
  .object({
    instanceId: InstanceIdSchema,
    timestamp: z.string().regex(/^\d+$/).describe("Quick reply sync timestamp used as its ID"),
  })
  .strict();

export const CreateCommunitySchema = z
  .object({
    instanceId: InstanceIdSchema,
    name: z.string().trim().min(1).max(100).describe("Community name"),
    description: z.string().max(2048).optional().describe("Optional community description"),
  })
  .strict();

export const ListCommunitiesSchema = z.object({ instanceId: InstanceIdSchema }).strict();

export const GetCommunityDetailsSchema = z
  .object({ instanceId: InstanceIdSchema, communityId: GroupIdSchema })
  .strict();

export const LinkCommunityGroupSchema = z
  .object({
    instanceId: InstanceIdSchema,
    communityId: GroupIdSchema,
    groupId: GroupIdSchema,
  })
  .strict();

export const UnlinkCommunityGroupSchema = LinkCommunityGroupSchema;
export const LeaveCommunitySchema = GetCommunityDetailsSchema;

export const CreateNewsletterSchema = z
  .object({
    instanceId: InstanceIdSchema,
    name: z.string().trim().min(1).max(100).describe("Channel name"),
    description: z.string().max(255).optional().describe("Optional Channel description"),
  })
  .strict();

export const GetNewsletterMetadataSchema = z
  .object({
    instanceId: InstanceIdSchema,
    type: z.enum(["jid", "invite"]).describe("Look up by Channel JID or invite code"),
    key: z.string().trim().min(1).describe("Channel JID or invite code"),
  })
  .strict();

export const UpdateNewsletterNameSchema = z
  .object({
    instanceId: InstanceIdSchema,
    jid: NewsletterJidSchema,
    name: z.string().trim().min(1).max(100),
  })
  .strict();

export const UpdateNewsletterDescriptionSchema = z
  .object({
    instanceId: InstanceIdSchema,
    jid: NewsletterJidSchema,
    description: z.string().max(255),
  })
  .strict();

export const UpdateNewsletterPictureSchema = z
  .object({
    instanceId: InstanceIdSchema,
    jid: NewsletterJidSchema,
    image: z.string().min(1).describe("PNG, JPG, GIF, or WebP image as an HTTPS URL or base64"),
  })
  .strict();

export const ReactToNewsletterMessageSchema = z
  .object({
    instanceId: InstanceIdSchema,
    jid: NewsletterJidSchema,
    serverId: z.string().min(1).describe("Channel post server ID"),
    reaction: z.string().max(16).describe("Emoji reaction; empty string removes the reaction"),
  })
  .strict();

export const ListNewsletterMessagesSchema = z
  .object({
    instanceId: InstanceIdSchema,
    jid: NewsletterJidSchema,
    count: z.number().int().min(1).max(100).default(20),
    since: z.number().int().min(0).default(0).describe("Unix timestamp lower bound"),
    after: z.number().int().min(0).default(0).describe("Pagination cursor"),
  })
  .strict();

export const GetCatalogSchema = z
  .object({
    instanceId: InstanceIdSchema,
    jid: z.string().min(1).optional().describe("Business JID; defaults to the connected account"),
    limit: z.number().int().min(1).max(100).default(10),
    cursor: z.string().min(1).optional().describe("Next-page cursor returned by the previous call"),
  })
  .strict();

export const GetCollectionsSchema = z
  .object({
    instanceId: InstanceIdSchema,
    jid: z.string().min(1).optional().describe("Business JID; defaults to the connected account"),
    limit: z.number().int().min(1).max(100).default(51),
  })
  .strict();

const ProductFields = {
  name: z.string().trim().min(1).max(100),
  retailerId: z.string().max(100).optional(),
  url: z.string().url().optional(),
  description: z.string().max(2048),
  price: z.number().finite().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  isHidden: z.boolean().optional(),
  images: CatalogImagesSchema,
};

export const CreateProductSchema = z
  .object({
    instanceId: InstanceIdSchema,
    ...ProductFields,
    originCountryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
  })
  .strict();

export const UpdateProductSchema = z
  .object({
    instanceId: InstanceIdSchema,
    productId: z.string().min(1),
    ...ProductFields,
  })
  .strict();

export const DeleteProductsSchema = z
  .object({
    instanceId: InstanceIdSchema,
    productIds: z.array(z.string().min(1)).min(1).max(100),
  })
  .strict();

export const GetOrderDetailsSchema = z
  .object({
    instanceId: InstanceIdSchema,
    orderId: z.string().min(1),
    tokenBase64: z.string().min(1).describe("Order token supplied by the order message"),
  })
  .strict();
