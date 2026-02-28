// ============================================================
// WA MCP — Profile Management Zod Schemas
// ============================================================

import { z } from "zod";

export const UpdateProfilePictureSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    image: z.string().min(1).describe("Profile picture as base64-encoded data or URL"),
  })
  .strict();

export const RemoveProfilePictureSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
  })
  .strict();

export const UpdateProfileNameSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    name: z.string().min(1).max(25).describe("New display name (max 25 characters)"),
  })
  .strict();

export const UpdateProfileStatusSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    status: z.string().max(139).describe("New text status/bio (max 139 characters)"),
  })
  .strict();

export const UpdatePrivacySchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    setting: z
      .enum(["lastSeen", "online", "profilePic", "status", "readReceipts", "groupAdd"])
      .describe("Privacy setting to update"),
    value: z
      .enum(["all", "contacts", "contact_blacklist", "none"])
      .describe("New value for the privacy setting"),
  })
  .strict();
