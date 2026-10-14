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

const privacyInstanceId = z.string().min(1).describe("The instance ID");

export const UpdatePrivacySchema = z.discriminatedUnion("setting", [
  z
    .object({
      instanceId: privacyInstanceId,
      setting: z.literal("lastSeen"),
      value: z.enum(["all", "contacts", "contact_blacklist", "none"]),
    })
    .strict(),
  z
    .object({
      instanceId: privacyInstanceId,
      setting: z.literal("online"),
      value: z.enum(["all", "match_last_seen"]),
    })
    .strict(),
  z
    .object({
      instanceId: privacyInstanceId,
      setting: z.literal("profilePic"),
      value: z.enum(["all", "contacts", "contact_blacklist", "none"]),
    })
    .strict(),
  z
    .object({
      instanceId: privacyInstanceId,
      setting: z.literal("status"),
      value: z.enum(["all", "contacts", "contact_blacklist", "none"]),
    })
    .strict(),
  z
    .object({
      instanceId: privacyInstanceId,
      setting: z.literal("readReceipts"),
      value: z.enum(["all", "none"]),
    })
    .strict(),
  z
    .object({
      instanceId: privacyInstanceId,
      setting: z.literal("groupAdd"),
      value: z.enum(["all", "contacts", "contact_blacklist"]),
    })
    .strict(),
  z
    .object({
      instanceId: privacyInstanceId,
      setting: z.literal("calls"),
      value: z.enum(["all", "known"]),
    })
    .strict(),
  z
    .object({
      instanceId: privacyInstanceId,
      setting: z.literal("defaultDisappearingMode"),
      value: z.union([z.literal(0), z.literal(86400), z.literal(604800), z.literal(7776000)]),
    })
    .strict(),
]);

export const GetPrivacySettingsSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    forceRefresh: z.boolean().optional().describe("Refresh privacy settings from WhatsApp"),
  })
  .strict();
