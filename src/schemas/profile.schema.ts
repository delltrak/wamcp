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

export const GetProfilePictureSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    jid: z.string().trim().min(5).describe("Contact or group JID"),
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

const PRIVACY_SETTINGS = [
  "lastSeen",
  "online",
  "profilePic",
  "status",
  "readReceipts",
  "groupAdd",
  "calls",
  "defaultDisappearingMode",
] as const;

const privacyValuesBySetting = {
  lastSeen: ["all", "contacts", "contact_blacklist", "none"],
  online: ["all", "match_last_seen"],
  profilePic: ["all", "contacts", "contact_blacklist", "none"],
  status: ["all", "contacts", "contact_blacklist", "none"],
  readReceipts: ["all", "none"],
  groupAdd: ["all", "contacts", "contact_blacklist"],
  calls: ["all", "known"],
  defaultDisappearingMode: [0, 86400, 604800, 7776000],
} as const satisfies Record<(typeof PRIVACY_SETTINGS)[number], readonly (string | number)[]>;

export const UpdatePrivacySchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    setting: z
      .enum(PRIVACY_SETTINGS)
      .describe(
        "Privacy setting: lastSeen, online, profilePic, status (About/profile text visibility), readReceipts, groupAdd, calls, or defaultDisappearingMode",
      ),
    value: z
      .union([z.string(), z.number()])
      .describe(
        'Allowed values depend on setting: lastSeen/profilePic/status use "all", "contacts", "contact_blacklist", or "none"; online uses "all" or "match_last_seen"; readReceipts uses "all" or "none"; groupAdd uses "all", "contacts", or "contact_blacklist"; calls uses "all" or "known"; defaultDisappearingMode uses 0, 86400, 604800, or 7776000 seconds.',
      ),
  })
  .strict()
  .superRefine(({ setting, value }, context) => {
    if (!privacyValuesBySetting[setting].some((allowedValue) => allowedValue === value)) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: `Invalid value for privacy setting ${setting}`,
      });
    }
  });

export const GetPrivacySettingsSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    forceRefresh: z.boolean().optional().describe("Refresh privacy settings from WhatsApp"),
  })
  .strict();
