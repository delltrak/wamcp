import { z } from "zod";
import { isValidGroupId } from "../utils/group-jid.js";
import { isValidStatusRecipient } from "../utils/validation.js";
import {
  SendTextSchema,
  SendImageSchema,
  SendVideoSchema,
  SendAudioSchema,
  SendDocumentSchema,
} from "./messaging.schema.js";

const instanceId = z.string().min(1).describe("Connected instance ID");
const groupId = z.string().trim().refine(isValidGroupId, "Expected a group ID or @g.us JID");
const participant = z
  .string()
  .trim()
  .refine(isValidStatusRecipient, "Expected an individual phone number or JID");
const participants = z
  .array(participant)
  .min(1)
  .max(100)
  .describe("Individual PN/LID identities; at most 100");
export const CommunityIdSchema = z
  .object({
    instanceId,
    communityId: groupId.describe("Community parent ID, not a subgroup ID"),
  })
  .strict();
export const CommunityCreateGroupSchema = CommunityIdSchema.extend({
  name: z.string().trim().min(1).max(100).describe("New linked group name"),
  participants: z.array(participant).max(100).default([]).describe("Initial members"),
}).strict();
export const CommunityNameSchema = CommunityIdSchema.extend({
  name: z.string().trim().min(1).max(100).describe("New community name"),
}).strict();
export const CommunityDescriptionSchema = CommunityIdSchema.extend({
  description: z.string().max(2048).describe("New description; empty string clears it"),
}).strict();
export const CommunityPictureSchema = CommunityIdSchema.extend({
  image: z
    .string()
    .min(1)
    .nullable()
    .describe("Public HTTPS image URL or base64; null removes the picture"),
}).strict();
export const CommunityMembersSchema = CommunityIdSchema.extend({
  scope: z
    .enum(["community", "announcements", "group"])
    .default("community")
    .describe("Membership scope to read"),
  groupId: groupId.optional().describe("Required only for scope=group"),
})
  .strict()
  .superRefine((value, ctx) => {
    if ((value.scope === "group") !== (value.groupId !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["groupId"],
        message: "Provide groupId only and always for scope=group",
      });
    }
  });
export const CommunityParticipantsSchema = CommunityIdSchema.extend({
  participants,
  action: z
    .enum(["add", "remove", "promote", "demote"])
    .describe("Community membership/admin action"),
  confirmLinkedGroupRemoval: z
    .boolean()
    .default(false)
    .describe("Must be true for remove: WhatsApp also removes these members from linked groups"),
})
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === "remove" && !value.confirmLinkedGroupRemoval) {
      ctx.addIssue({
        code: "custom",
        path: ["confirmLinkedGroupRemoval"],
        message: "Confirm removal from the community AND linked groups",
      });
    }
  });
export const CommunityRequestsSchema = CommunityIdSchema.extend({
  participants,
  action: z.enum(["approve", "reject"]).describe("Action on pending join requests"),
}).strict();
export const CommunityInviteSchema = z
  .object({
    instanceId,
    invite: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .describe("Community invite code or https://chat.whatsapp.com link"),
  })
  .strict();
export const CommunityRevokeMemberInviteSchema = CommunityIdSchema.extend({
  participant: participant.describe("Invited member whose V4 invitation should be revoked"),
}).strict();
// A nested discriminated union keeps the top-level SDK schema an object and validates each setting/value pair.
export const CommunitySettingSchema = CommunityIdSchema.extend({
  change: z
    .discriminatedUnion("setting", [
      z.object({ setting: z.literal("edit_info"), value: z.enum(["admins", "all"]) }).strict(),
      z.object({ setting: z.literal("send_messages"), value: z.enum(["admins", "all"]) }).strict(),
      z.object({ setting: z.literal("add_members"), value: z.enum(["admins", "all"]) }).strict(),
      z.object({ setting: z.literal("join_approval"), value: z.enum(["on", "off"]) }).strict(),
      z
        .object({
          setting: z.literal("disappearing_messages"),
          value: z.union([z.literal(0), z.literal(86400), z.literal(604800), z.literal(7776000)]),
        })
        .strict(),
    ])
    .describe("Exactly one setting change on the community parent; does not bulk-edit subgroups"),
}).strict();
export const CommunityAnnouncementSchema = CommunityIdSchema.extend({
  content: z
    .discriminatedUnion("type", [
      SendTextSchema.omit({ instanceId: true, to: true })
        .extend({ type: z.literal("text") })
        .strict(),
      SendImageSchema.omit({ instanceId: true, to: true })
        .extend({ type: z.literal("image") })
        .strict(),
      SendVideoSchema.omit({ instanceId: true, to: true })
        .extend({ type: z.literal("video") })
        .strict(),
      SendAudioSchema.omit({ instanceId: true, to: true })
        .extend({ type: z.literal("audio") })
        .strict(),
      SendDocumentSchema.omit({ instanceId: true, to: true })
        .extend({ type: z.literal("document") })
        .strict(),
    ])
    .describe("Message to queue to the verified Avisos group"),
}).strict();

export const CommunityInviteV4Schema = CommunityIdSchema.extend({
  inviter: participant.describe("Original invitation sender's individual JID"),
  inviteCode: z.string().trim().min(1).max(512).describe("Code from the V4 invitation"),
  inviteExpiration: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .describe("Invitation expiry as Unix seconds"),
}).strict();
