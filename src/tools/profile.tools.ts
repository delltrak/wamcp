// ============================================================
// WA MCP — Profile Management Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { toolSuccess, toolError } from "../types/mcp.types.js";
import { MediaService } from "../services/media.js";
import {
  UpdateProfilePictureSchema,
  RemoveProfilePictureSchema,
  UpdateProfileNameSchema,
  UpdateProfileStatusSchema,
  UpdatePrivacySchema,
} from "../schemas/profile.schema.js";

const mediaService = new MediaService();

export function registerProfileTools(
  server: McpServer,
  instanceManager: InstanceManager,
  _messageQueue: MessageQueue,
): void {
  server.tool(
    "wa_update_profile_picture",
    "Change the profile picture for a WhatsApp instance. Image can be provided as base64-encoded data or a URL.",
    UpdateProfilePictureSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const buffer = await mediaService.getMediaBuffer(params.image);
        await adapter.updateProfilePicture(buffer);
        return toolSuccess({ success: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_remove_profile_picture",
    "Remove the profile picture for a WhatsApp instance.",
    RemoveProfilePictureSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.removeProfilePicture();
        return toolSuccess({ success: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_update_profile_name",
    "Change the display name for a WhatsApp instance (max 25 characters).",
    UpdateProfileNameSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.updateProfileName(params.name);
        return toolSuccess({ success: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_update_profile_status",
    "Change the text status/bio for a WhatsApp instance (max 139 characters).",
    UpdateProfileStatusSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.updateProfileStatus(params.status);
        return toolSuccess({ success: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_update_privacy",
    "Update privacy settings (lastSeen, online, profilePic, status, readReceipts, groupAdd).",
    UpdatePrivacySchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.updatePrivacy(params.setting, params.value);
        return toolSuccess({ success: true, setting: params.setting, value: params.value });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );
}
