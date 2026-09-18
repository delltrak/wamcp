// ============================================================
// WA MCP — Profile Management Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";
import { createRequestLogger } from "../utils/logger.js";
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
  server.registerTool(
    "wa_update_profile_picture",
    {
      description:
        "Change the profile picture for a WhatsApp instance. Image can be provided as base64-encoded data or a URL.",
      inputSchema: UpdateProfilePictureSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_update_profile_picture", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const buffer = await mediaService.getMediaBuffer(params.image);
        await adapter.updateProfilePicture(buffer);
        log.info({ duration: Date.now() - start }, "Profile picture updated");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_update_profile_picture", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_remove_profile_picture",
    {
      description: "Remove the profile picture for a WhatsApp instance.",
      inputSchema: RemoveProfilePictureSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_remove_profile_picture", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.removeProfilePicture();
        log.info({ duration: Date.now() - start }, "Profile picture removed");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_remove_profile_picture", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_update_profile_name",
    {
      description: "Change the display name for a WhatsApp instance (max 25 characters).",
      inputSchema: UpdateProfileNameSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_update_profile_name", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.updateProfileName(params.name);
        log.info({ duration: Date.now() - start }, "Profile name updated");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_update_profile_name", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_update_profile_status",
    {
      description: "Change the text status/bio for a WhatsApp instance (max 139 characters).",
      inputSchema: UpdateProfileStatusSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_update_profile_status", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.updateProfileStatus(params.status);
        log.info({ duration: Date.now() - start }, "Profile status updated");
        return toolSuccess({ success: true });
      } catch (err) {
        return handleToolError("wa_update_profile_status", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_update_privacy",
    {
      description:
        "Update privacy settings (lastSeen, online, profilePic, status, readReceipts, groupAdd).",
      inputSchema: UpdatePrivacySchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_update_privacy", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.updatePrivacy(params.setting, params.value);
        log.info({ duration: Date.now() - start }, "Privacy setting updated");
        return toolSuccess({ success: true, setting: params.setting, value: params.value });
      } catch (err) {
        return handleToolError("wa_update_privacy", err, params.instanceId);
      }
    },
  );
}
