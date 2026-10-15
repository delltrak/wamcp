// ============================================================
// WA MCP — Group Management Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";
import { createRequestLogger } from "../utils/logger.js";
import {
  ListGroupsSchema,
  GetGroupInfoSchema,
  UpdateGroupPictureSchema,
  RemoveGroupPictureSchema,
  CreateGroupSchema,
  AddParticipantsSchema,
  RemoveParticipantsSchema,
  PromoteParticipantSchema,
  DemoteParticipantSchema,
  UpdateSubjectSchema,
  UpdateDescriptionSchema,
  UpdateSettingsSchema,
  LeaveGroupSchema,
  GetInviteCodeSchema,
  GetGroupInviteInfoSchema,
  ListGroupJoinRequestsSchema,
  SendGroupInviteMessageSchema,
  RevokeInviteSchema,
  JoinGroupSchema,
  ToggleEphemeralSchema,
  HandleJoinRequestSchema,
  GroupJoinApprovalModeSchema,
  GroupMemberAddModeSchema,
} from "../schemas/group.schema.js";

export function registerGroupTools(
  server: McpServer,
  instanceManager: InstanceManager,
  _messageQueue: MessageQueue,
): void {
  server.registerTool(
    "wa_list_groups",
    {
      description: "List WhatsApp groups with participant counts and this account's admin role.",
      inputSchema: ListGroupsSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_list_groups", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const groups = await adapter.listGroups();
        log.info({ duration: Date.now() - start, count: groups.length }, "Groups listed");
        return toolSuccess(groups);
      } catch (err) {
        return handleToolError("wa_list_groups", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_get_group_info",
    {
      description: "Get WhatsApp group metadata and participants with their roles.",
      inputSchema: GetGroupInfoSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_get_group_info", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const info = await adapter.getGroupMetadata(params.groupId);
        log.info({ duration: Date.now() - start }, "Group information retrieved");
        return toolSuccess(info);
      } catch (err) {
        return handleToolError("wa_get_group_info", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_get_group_invite_info",
    {
      description:
        "Read group metadata from a WhatsApp invite code or chat.whatsapp.com link before joining. Baileys only.",
      inputSchema: GetGroupInviteInfoSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_get_group_invite_info", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const info = await adapter.getGroupInviteInfo(params.inviteCode);
        log.info({ duration: Date.now() - start }, "Group invite information retrieved");
        return toolSuccess(info);
      } catch (err) {
        return handleToolError("wa_get_group_invite_info", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_group_update_picture",
    {
      description:
        "Set a WhatsApp group picture from an HTTPS URL or base64 image. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
      inputSchema: UpdateGroupPictureSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_group_update_picture", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.updateGroupPicture(params.groupId, params.image);
        log.info({ duration: Date.now() - start }, "Group picture updated");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_group_update_picture", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_group_remove_picture",
    {
      description:
        "Remove the WhatsApp group picture. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
      inputSchema: RemoveGroupPictureSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_group_remove_picture", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.removeGroupPicture(params.groupId);
        log.info({ duration: Date.now() - start }, "Group picture removed");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_group_remove_picture", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_create_group",
    {
      description:
        "Create a new WhatsApp group with a name and initial participants. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
      inputSchema: CreateGroupSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_create_group", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const result = await adapter.createGroup(params.name, params.participants);
        log.info({ duration: Date.now() - start }, "Group created");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_create_group", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_group_add_participants",
    {
      description:
        "Add members to a WhatsApp group. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
      inputSchema: AddParticipantsSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_group_add_participants", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyParticipants(params.groupId, params.participants, "add");
        log.info({ duration: Date.now() - start }, "Participants added");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_group_add_participants", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_group_remove_participants",
    {
      description:
        "Remove members from a WhatsApp group. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
      inputSchema: RemoveParticipantsSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_group_remove_participants", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyParticipants(params.groupId, params.participants, "remove");
        log.info({ duration: Date.now() - start }, "Participants removed");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_group_remove_participants", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_group_promote",
    {
      description:
        "Promote members to group admin. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
      inputSchema: PromoteParticipantSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_group_promote", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyParticipants(params.groupId, params.participants, "promote");
        log.info({ duration: Date.now() - start }, "Participants promoted");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_group_promote", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_group_demote",
    {
      description:
        "Demote group admins to regular members. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
      inputSchema: DemoteParticipantSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_group_demote", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyParticipants(params.groupId, params.participants, "demote");
        log.info({ duration: Date.now() - start }, "Participants demoted");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_group_demote", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_group_update_subject",
    {
      description:
        "Change the name/subject of a WhatsApp group. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
      inputSchema: UpdateSubjectSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_group_update_subject", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyGroup(params.groupId, {
          action: "updateSubject",
          value: params.subject,
        });
        log.info({ duration: Date.now() - start }, "Group subject updated");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_group_update_subject", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_group_update_description",
    {
      description:
        "Change the description of a WhatsApp group. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
      inputSchema: UpdateDescriptionSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_group_update_description", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyGroup(params.groupId, {
          action: "updateDescription",
          value: params.description,
        });
        log.info({ duration: Date.now() - start }, "Group description updated");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_group_update_description", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_group_update_settings",
    {
      description:
        "Change group settings (announce: only admins can send, locked: only admins can edit info). This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
      inputSchema: UpdateSettingsSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_group_update_settings", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        if (params.announce !== undefined) {
          await adapter.modifyGroup(params.groupId, {
            action: "updateSettings",
            value: params.announce ? "announcement" : "not_announcement",
          });
        }
        if (params.locked !== undefined) {
          await adapter.modifyGroup(params.groupId, {
            action: "updateSettings",
            value: params.locked ? "locked" : "unlocked",
          });
        }
        log.info({ duration: Date.now() - start }, "Group settings updated");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_group_update_settings", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_group_leave",
    {
      description:
        "Leave a WhatsApp group. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
      inputSchema: LeaveGroupSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_group_leave", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyGroup(params.groupId, { action: "leave" });
        log.info({ duration: Date.now() - start }, "Left group");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_group_leave", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_group_get_invite_code",
    {
      description: "Get the shareable invite link for a WhatsApp group.",
      inputSchema: GetInviteCodeSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_group_get_invite_code", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const code = await adapter.getGroupInviteCode(params.groupId);
        log.info({ duration: Date.now() - start }, "Invite code retrieved");
        return toolSuccess({
          groupId: params.groupId,
          inviteCode: code,
          link: `https://chat.whatsapp.com/${code}`,
        });
      } catch (err) {
        return handleToolError("wa_group_get_invite_code", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_send_group_invite_message",
    {
      description:
        "Send a WhatsApp group invite card to a contact or group using the current invite code. Baileys only.",
      inputSchema: SendGroupInviteMessageSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_send_group_invite_message", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const result = await adapter.sendGroupInviteMessage(params.to, params.groupId, params.text);
        log.info({ duration: Date.now() - start, to: params.to }, "Group invite message sent");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_send_group_invite_message", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_group_revoke_invite",
    {
      description:
        "Revoke the current invite link for a WhatsApp group, generating a new one. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
      inputSchema: RevokeInviteSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_group_revoke_invite", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyGroup(params.groupId, { action: "revokeInvite" });
        log.info({ duration: Date.now() - start }, "Invite revoked");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_group_revoke_invite", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_group_join",
    {
      description:
        "Join a WhatsApp group using an invite code or link. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
      inputSchema: JoinGroupSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_group_join", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const groupId = await adapter.joinGroup(params.inviteCode);
        log.info({ duration: Date.now() - start }, "Joined group");
        return toolSuccess({ groupId });
      } catch (err) {
        return handleToolError("wa_group_join", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_group_toggle_ephemeral",
    {
      description:
        "Enable or disable disappearing messages in a group. Duration is in seconds (0 to disable). This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
      inputSchema: ToggleEphemeralSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_group_toggle_ephemeral", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyGroup(params.groupId, {
          action: "toggleEphemeral",
          value: params.duration,
        });
        log.info({ duration: Date.now() - start }, "Ephemeral toggled");
        return toolSuccess({ success: true, ephemeralDuration: params.duration });
      } catch (err) {
        return handleToolError("wa_group_toggle_ephemeral", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_group_list_join_requests",
    {
      description: "List pending join requests for a WhatsApp group. Baileys only.",
      inputSchema: ListGroupJoinRequestsSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_group_list_join_requests", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const requests = await adapter.listGroupJoinRequests(params.groupId);
        log.info({ duration: Date.now() - start, count: requests.length }, "Group requests listed");
        return toolSuccess({ groupId: params.groupId, count: requests.length, requests });
      } catch (err) {
        return handleToolError("wa_group_list_join_requests", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_group_handle_request",
    {
      description:
        "Approve or reject a pending join request for a WhatsApp group. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
      inputSchema: HandleJoinRequestSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_group_handle_request", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.handleJoinRequest(params.groupId, params.participantId, params.action);
        log.info({ duration: Date.now() - start, action: params.action }, "Join request handled");
        return toolSuccess({ success: true, action: params.action });
      } catch (err) {
        return handleToolError("wa_group_handle_request", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_group_join_approval_mode",
    {
      description:
        "Turn WhatsApp group join approval on or off. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
      inputSchema: GroupJoinApprovalModeSchema,
    },
    async (params) => {
      try {
        await instanceManager
          .getAdapter(params.instanceId)
          .setGroupJoinApprovalMode(params.groupId, params.mode);
        return toolSuccess({ success: true, groupId: params.groupId, mode: params.mode });
      } catch (err) {
        return handleToolError("wa_group_join_approval_mode", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_group_member_add_mode",
    {
      description:
        "Set whether group admins only or all members can add members. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
      inputSchema: GroupMemberAddModeSchema,
    },
    async (params) => {
      try {
        await instanceManager
          .getAdapter(params.instanceId)
          .setGroupMemberAddMode(params.groupId, params.mode);
        return toolSuccess({ success: true, groupId: params.groupId, mode: params.mode });
      } catch (err) {
        return handleToolError("wa_group_member_add_mode", err, params.instanceId);
      }
    },
  );
}
