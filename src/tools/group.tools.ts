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

  server.tool(
    "wa_group_add_participants",
    "Add members to a WhatsApp group.",
    AddParticipantsSchema.shape,
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

  server.tool(
    "wa_group_remove_participants",
    "Remove members from a WhatsApp group.",
    RemoveParticipantsSchema.shape,
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

  server.tool(
    "wa_group_promote",
    "Promote members to group admin.",
    PromoteParticipantSchema.shape,
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

  server.tool(
    "wa_group_demote",
    "Demote group admins to regular members.",
    DemoteParticipantSchema.shape,
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

  server.tool(
    "wa_group_update_subject",
    "Change the name/subject of a WhatsApp group.",
    UpdateSubjectSchema.shape,
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

  server.tool(
    "wa_group_update_description",
    "Change the description of a WhatsApp group.",
    UpdateDescriptionSchema.shape,
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

  server.tool(
    "wa_group_update_settings",
    "Change group settings (announce: only admins can send, locked: only admins can edit info).",
    UpdateSettingsSchema.shape,
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

  server.tool(
    "wa_group_leave",
    "Leave a WhatsApp group.",
    LeaveGroupSchema.shape,
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

  server.tool(
    "wa_group_get_invite_code",
    "Get the shareable invite link for a WhatsApp group.",
    GetInviteCodeSchema.shape,
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

  server.tool(
    "wa_group_revoke_invite",
    "Revoke the current invite link for a WhatsApp group, generating a new one.",
    RevokeInviteSchema.shape,
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

  server.tool(
    "wa_group_join",
    "Join a WhatsApp group using an invite code or link.",
    JoinGroupSchema.shape,
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

  server.tool(
    "wa_group_toggle_ephemeral",
    "Enable or disable disappearing messages in a group. Duration is in seconds (0 to disable).",
    ToggleEphemeralSchema.shape,
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

  server.tool(
    "wa_group_handle_request",
    "Approve or reject a pending join request for a WhatsApp group.",
    HandleJoinRequestSchema.shape,
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
}
