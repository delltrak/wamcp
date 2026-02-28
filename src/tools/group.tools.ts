// ============================================================
// WA MCP — Group Management Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { toolSuccess, toolError } from "../types/mcp.types.js";
import {
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
  RevokeInviteSchema,
  JoinGroupSchema,
  ToggleEphemeralSchema,
  HandleJoinRequestSchema,
} from "../schemas/group.schema.js";

export function registerGroupTools(
  server: McpServer,
  instanceManager: InstanceManager,
  _messageQueue: MessageQueue,
): void {
  server.tool(
    "wa_create_group",
    "Create a new WhatsApp group with a name and initial participants.",
    CreateGroupSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const result = await adapter.createGroup(params.name, params.participants);
        return toolSuccess(result);
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_group_add_participants",
    "Add members to a WhatsApp group.",
    AddParticipantsSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyParticipants(params.groupId, params.participants, "add");
        return toolSuccess({ success: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_group_remove_participants",
    "Remove members from a WhatsApp group.",
    RemoveParticipantsSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyParticipants(params.groupId, params.participants, "remove");
        return toolSuccess({ success: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_group_promote",
    "Promote members to group admin.",
    PromoteParticipantSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyParticipants(params.groupId, params.participants, "promote");
        return toolSuccess({ success: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_group_demote",
    "Demote group admins to regular members.",
    DemoteParticipantSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyParticipants(params.groupId, params.participants, "demote");
        return toolSuccess({ success: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_group_update_subject",
    "Change the name/subject of a WhatsApp group.",
    UpdateSubjectSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyGroup(params.groupId, {
          action: "updateSubject",
          value: params.subject,
        });
        return toolSuccess({ success: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_group_update_description",
    "Change the description of a WhatsApp group.",
    UpdateDescriptionSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyGroup(params.groupId, {
          action: "updateDescription",
          value: params.description,
        });
        return toolSuccess({ success: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_group_update_settings",
    "Change group settings (announce: only admins can send, locked: only admins can edit info).",
    UpdateSettingsSchema.shape,
    async (params) => {
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
        return toolSuccess({ success: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_group_leave",
    "Leave a WhatsApp group.",
    LeaveGroupSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyGroup(params.groupId, { action: "leave" });
        return toolSuccess({ success: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_group_get_invite_code",
    "Get the shareable invite link for a WhatsApp group.",
    GetInviteCodeSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const code = await adapter.getGroupInviteCode(params.groupId);
        return toolSuccess({
          groupId: params.groupId,
          inviteCode: code,
          link: `https://chat.whatsapp.com/${code}`,
        });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_group_revoke_invite",
    "Revoke the current invite link for a WhatsApp group, generating a new one.",
    RevokeInviteSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyGroup(params.groupId, { action: "revokeInvite" });
        return toolSuccess({ success: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_group_join",
    "Join a WhatsApp group using an invite code or link.",
    JoinGroupSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const groupId = await adapter.joinGroup(params.inviteCode);
        return toolSuccess({ groupId });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_group_toggle_ephemeral",
    "Enable or disable disappearing messages in a group. Duration is in seconds (0 to disable).",
    ToggleEphemeralSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.modifyGroup(params.groupId, {
          action: "toggleEphemeral",
          value: params.duration,
        });
        return toolSuccess({ success: true, ephemeralDuration: params.duration });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_group_handle_request",
    "Approve or reject a pending join request for a WhatsApp group.",
    HandleJoinRequestSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.handleJoinRequest(params.groupId, params.participantId, params.action);
        return toolSuccess({ success: true, action: params.action });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );
}
