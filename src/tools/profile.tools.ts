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
import type { PrivacyUpdate } from "../types/channel.types.js";
import {
  UpdateProfilePictureSchema,
  RemoveProfilePictureSchema,
  UpdateProfileNameSchema,
  UpdateProfileStatusSchema,
  UpdatePrivacySchema,
  GetPrivacySettingsSchema,
} from "../schemas/profile.schema.js";

const mediaService = new MediaService();

const PRIVACY_VALUES = ["all", "contacts", "contact_blacklist", "none"] as const;
const ONLINE_VALUES = ["all", "match_last_seen"] as const;
const READ_RECEIPTS_VALUES = ["all", "none"] as const;
const GROUP_ADD_VALUES = ["all", "contacts", "contact_blacklist"] as const;
const CALL_VALUES = ["all", "known"] as const;
const DEFAULT_DISAPPEARING_DURATIONS = [0, 86400, 604800, 7776000] as const;

function isOneOf<T extends string | number>(value: unknown, allowed: readonly T[]): value is T {
  return allowed.some((candidate) => candidate === value);
}

function toPrivacyUpdate(setting: PrivacyUpdate["setting"], value: string | number): PrivacyUpdate {
  switch (setting) {
    case "lastSeen":
    case "profilePic":
    case "status":
      if (isOneOf(value, PRIVACY_VALUES)) return { setting, value };
      break;
    case "online":
      if (isOneOf(value, ONLINE_VALUES)) return { setting, value };
      break;
    case "readReceipts":
      if (isOneOf(value, READ_RECEIPTS_VALUES)) return { setting, value };
      break;
    case "groupAdd":
      if (isOneOf(value, GROUP_ADD_VALUES)) return { setting, value };
      break;
    case "calls":
      if (isOneOf(value, CALL_VALUES)) return { setting, value };
      break;
    case "defaultDisappearingMode":
      if (isOneOf(value, DEFAULT_DISAPPEARING_DURATIONS)) return { setting, value };
      break;
  }

  throw new Error(`Invalid value for privacy setting ${setting}`);
}

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
    "wa_get_privacy_settings",
    {
      description:
        "Read normalized account privacy settings for a Baileys instance. Reads refresh from WhatsApp by default; pass forceRefresh=false to use cached settings. The status setting is About/profile text visibility.",
      inputSchema: GetPrivacySettingsSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_get_privacy_settings", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const settings = await adapter.getPrivacySettings(params.forceRefresh ?? true);
        log.info({ duration: Date.now() - start }, "Privacy settings read");
        return toolSuccess(settings);
      } catch (err) {
        return handleToolError("wa_get_privacy_settings", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_update_privacy",
    {
      description:
        "Update Baileys account privacy settings: lastSeen, online, profilePic, status (About/profile text visibility), readReceipts, groupAdd, calls, or defaultDisappearingMode.",
      inputSchema: UpdatePrivacySchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_update_privacy", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const update = toPrivacyUpdate(params.setting, params.value);
        await adapter.updatePrivacy(update);
        log.info({ duration: Date.now() - start }, "Privacy setting updated");
        return toolSuccess({ success: true, setting: params.setting, value: params.value });
      } catch (err) {
        return handleToolError("wa_update_privacy", err, params.instanceId);
      }
    },
  );
}
