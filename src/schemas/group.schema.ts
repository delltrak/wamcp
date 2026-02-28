// ============================================================
// WA MCP — Group Management Zod Schemas
// ============================================================

import { z } from "zod";

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

export const AddParticipantsSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: z.string().min(5).describe("Group JID"),
    participants: z.array(z.string().min(5)).min(1).describe("Phone numbers or JIDs to add"),
  })
  .strict();

export const RemoveParticipantsSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: z.string().min(5).describe("Group JID"),
    participants: z.array(z.string().min(5)).min(1).describe("Phone numbers or JIDs to remove"),
  })
  .strict();

export const PromoteParticipantSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: z.string().min(5).describe("Group JID"),
    participants: z
      .array(z.string().min(5))
      .min(1)
      .describe("Phone numbers or JIDs to promote to admin"),
  })
  .strict();

export const DemoteParticipantSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: z.string().min(5).describe("Group JID"),
    participants: z
      .array(z.string().min(5))
      .min(1)
      .describe("Phone numbers or JIDs to demote from admin"),
  })
  .strict();

export const UpdateSubjectSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: z.string().min(5).describe("Group JID"),
    subject: z.string().min(1).max(100).describe("New group name/subject"),
  })
  .strict();

export const UpdateDescriptionSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: z.string().min(5).describe("Group JID"),
    description: z.string().max(2048).describe("New group description (empty string to clear)"),
  })
  .strict();

export const UpdateSettingsSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: z.string().min(5).describe("Group JID"),
    announce: z.boolean().optional().describe("Only admins can send messages"),
    locked: z.boolean().optional().describe("Only admins can edit group info"),
  })
  .strict();

export const LeaveGroupSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: z.string().min(5).describe("Group JID to leave"),
  })
  .strict();

export const GetInviteCodeSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: z.string().min(5).describe("Group JID"),
  })
  .strict();

export const RevokeInviteSchema = z
  .object({
    instanceId: z.string().min(1).describe("The instance ID"),
    groupId: z.string().min(5).describe("Group JID"),
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
    groupId: z.string().min(5).describe("Group JID"),
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
    groupId: z.string().min(5).describe("Group JID"),
    participantId: z.string().min(5).describe("JID of the requester"),
    action: z.enum(["approve", "reject"]).describe("Whether to approve or reject the join request"),
  })
  .strict();
