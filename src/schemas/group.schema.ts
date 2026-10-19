// ============================================================
// WA MCP — Group Management Zod Schemas
// ============================================================

import { z } from "zod";
import { MAX_GROUP_PARTICIPANTS } from "../constants.js";
import { isValidGroupId } from "../utils/group-jid.js";

const GroupIdSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isValidGroupId, "Expected a WhatsApp group ID or a JID ending in @g.us");

export const ListGroupsSchema = z
  .object({ instanceId: z.string().min(1).describe("The instance ID") })
  .strict();

export const GetGroupInfoSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: GroupIdSchema.describe("WhatsApp group JID or bare group ID"),
  })
  .strict();

export const UpdateGroupPictureSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: GroupIdSchema.describe("WhatsApp group JID or bare group ID"),
    image: z.string().min(1).describe("Group picture as an HTTPS URL or base64-encoded image"),
  })
  .strict();

export const RemoveGroupPictureSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: GroupIdSchema.describe("WhatsApp group JID or bare group ID"),
  })
  .strict();

export const CreateGroupSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    name: z.string().min(1).max(100).describe("Group name/subject"),
    participants: z
      .array(z.string().min(5))
      .min(1)
      .describe("Phone numbers or JIDs of initial participants"),
  })
  .strict();

export const CreateGroupFromGroupSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    sourceGroupId: GroupIdSchema.describe("WhatsApp group JID or bare ID to copy members from"),
    name: z.string().trim().min(1).max(100).describe("Name of the new WhatsApp group"),
    includeParticipants: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(MAX_GROUP_PARTICIPANTS)
      .optional()
      .describe("Optional phone numbers or JIDs to keep from the source group"),
    excludeParticipants: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(MAX_GROUP_PARTICIPANTS)
      .optional()
      .describe("Optional phone numbers or JIDs to omit from the new group"),
  })
  .strict();

export const AddParticipantsSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: GroupIdSchema.describe("WhatsApp group JID or bare group ID"),
    participants: z.array(z.string().min(5)).min(1).describe("Phone numbers or JIDs to add"),
  })
  .strict();

export const RemoveParticipantsSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: GroupIdSchema.describe("WhatsApp group JID or bare group ID"),
    participants: z.array(z.string().min(5)).min(1).describe("Phone numbers or JIDs to remove"),
  })
  .strict();

export const PromoteParticipantSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: GroupIdSchema.describe("WhatsApp group JID or bare group ID"),
    participants: z
      .array(z.string().min(5))
      .min(1)
      .describe("Phone numbers or JIDs to promote to admin"),
  })
  .strict();

export const DemoteParticipantSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: GroupIdSchema.describe("WhatsApp group JID or bare group ID"),
    participants: z
      .array(z.string().min(5))
      .min(1)
      .describe("Phone numbers or JIDs to demote from admin"),
  })
  .strict();

export const UpdateSubjectSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: GroupIdSchema.describe("WhatsApp group JID or bare group ID"),
    subject: z.string().min(1).max(100).describe("New group name/subject"),
  })
  .strict();

export const UpdateDescriptionSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: GroupIdSchema.describe("WhatsApp group JID or bare group ID"),
    description: z.string().max(2048).describe("New group description (empty string to clear)"),
  })
  .strict();

export const UpdateSettingsSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: GroupIdSchema.describe("WhatsApp group JID or bare group ID"),
    announce: z.boolean().optional().describe("Only admins can send messages"),
    locked: z.boolean().optional().describe("Only admins can edit group info"),
  })
  .strict();

export const LeaveGroupSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: GroupIdSchema.describe("WhatsApp group JID or bare group ID to leave"),
  })
  .strict();

export const GetInviteCodeSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: GroupIdSchema.describe("WhatsApp group JID or bare group ID"),
  })
  .strict();

export const GetGroupInviteInfoSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    inviteCode: z.string().trim().min(1).describe("Group invite code or chat.whatsapp.com link"),
  })
  .strict();

export const ListGroupJoinRequestsSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: GroupIdSchema.describe("WhatsApp group JID or bare group ID"),
  })
  .strict();

export const SendGroupInviteMessageSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID to send from"),
    to: z.string().min(5).describe("Contact phone number or group JID receiving the invite"),
    groupId: GroupIdSchema.describe("Group JID or bare group ID to invite people to"),
    text: z.string().max(1024).optional().describe("Optional text accompanying the invite card"),
  })
  .strict();

export const RevokeInviteSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: GroupIdSchema.describe("WhatsApp group JID or bare group ID"),
  })
  .strict();

export const JoinGroupSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    inviteCode: z.string().min(1).describe("Group invite code or link"),
  })
  .strict();

export const ToggleEphemeralSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: GroupIdSchema.describe("WhatsApp group JID or bare group ID"),
    duration: z
      .number()
      .int()
      .min(0)
      .describe("Disappearing message duration in seconds (0 to disable)"),
  })
  .strict();

export const HandleJoinRequestSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: GroupIdSchema.describe("WhatsApp group JID or bare group ID"),
    participantId: z.string().min(5).describe("JID of the requester"),
    action: z.enum(["approve", "reject"]).describe("Whether to approve or reject the join request"),
  })
  .strict();

export const GroupJoinApprovalModeSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: GroupIdSchema.describe("WhatsApp group JID or bare group ID"),
    mode: z.enum(["on", "off"]).describe("Require admin approval for join requests"),
  })
  .strict();

export const GroupMemberAddModeSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: GroupIdSchema.describe("WhatsApp group JID or bare group ID"),
    mode: z.enum(["admin_add", "all_member_add"]).describe("Who can add members"),
  })
  .strict();
