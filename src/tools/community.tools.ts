import { InstanceNotFoundError, InstanceNotInitializedError } from "../utils/instance-errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";
import * as schemas from "../schemas/community.schema.js";

export function registerCommunityTools(
  server: McpServer,
  manager: InstanceManager,
  queue: MessageQueue,
): void {
  function register<S extends z.ZodObject>(
    name: string,
    description: string,
    input: S,
    readOnly: boolean,
    action: (p: z.infer<S> & { instanceId: string }) => Promise<unknown>,
  ): void {
    const schema: z.ZodObject = input;
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (raw) => {
        const p = raw as z.infer<S> & { instanceId: string };
        try {
          return toolSuccess(await action(p));
        } catch (error) {
          if (
            error instanceof InstanceNotFoundError ||
            error instanceof InstanceNotInitializedError
          ) {
            return handleToolError(name, error, p.instanceId);
          }
          // Never log raw provider objects: they can contain protocol nodes and invitations.
          let message = error instanceof Error ? error.message : "Community operation failed";
          const safeLocalError =
            message.startsWith("Community management is not supported on Cloud API") ||
            message.startsWith("WhatsApp group, community, and Channel writes are disabled.") ||
            message === "Only a community admin can perform this operation" ||
            message.startsWith("The invitation may have been reset,") ||
            message.startsWith("The community invitation is expired");
          if (
            (name.includes("invite") || name.startsWith("wa_community_join")) &&
            !safeLocalError
          ) {
            message =
              "Community invitation operation failed; verify the invitation, permissions and connection before retrying";
          }
          message = message.replace(
            /https?:\/\/chat\.whatsapp\.com\/[^\s]+/gi,
            "[invitation redacted]",
          );
          return handleToolError(name, new Error(message), p.instanceId);
        }
      },
    );
  }
  register(
    "wa_community_join_v4",
    "Accept a community V4 invitation using its sender, code and unexpired Unix-second expiration. Verify community identity and membership; never automatically retry an unknown result. Requires group-write gate; Baileys only.",
    schemas.CommunityInviteV4Schema,
    false,
    (p) =>
      manager.getAdapter(p.instanceId).joinCommunityV4({
        communityId: p.communityId,
        inviter: p.inviter,
        inviteCode: p.inviteCode,
        inviteExpiration: p.inviteExpiration,
      }),
  );
  const writes = " Baileys only; requires a community admin and the group-write gate.";
  register(
    "wa_community_create_group",
    "Create a group already linked to a community. A null result may mean creation succeeded; never automatically retry." +
      writes,
    schemas.CommunityCreateGroupSchema,
    false,
    (p) =>
      manager.getAdapter(p.instanceId).createCommunityGroup(p.communityId, p.name, p.participants),
  );
  register(
    "wa_community_update_name",
    "Rename a community." + writes,
    schemas.CommunityNameSchema,
    false,
    async (p) => {
      await manager.getAdapter(p.instanceId).updateCommunityName(p.communityId, p.name);
      return { success: true };
    },
  );
  register(
    "wa_community_update_description",
    "Update or clear a community description." + writes,
    schemas.CommunityDescriptionSchema,
    false,
    async (p) => {
      await manager
        .getAdapter(p.instanceId)
        .updateCommunityDescription(p.communityId, p.description);
      return { success: true };
    },
  );
  register(
    "wa_community_update_picture",
    "Set a community picture, or remove it with image=null." + writes,
    schemas.CommunityPictureSchema,
    false,
    async (p) => {
      await manager.getAdapter(p.instanceId).updateCommunityPicture(p.communityId, p.image);
      return { success: true };
    },
  );
  register(
    "wa_community_list_members",
    "List visible members and roles in the community, Avisos, or a verified linked group. Counts reflect returned participants, not a guarantee of a complete roster. Baileys only.",
    schemas.CommunityMembersSchema,
    true,
    async (p) => ({
      communityId: p.communityId,
      scope: p.scope,
      metadata: await manager
        .getAdapter(p.instanceId)
        .getCommunityMembers(p.communityId, p.scope, p.groupId),
    }),
  );
  register(
    "wa_community_update_participants",
    "Add/remove members or promote/demote admins. Removal also affects linked groups and requires confirmLinkedGroupRemoval=true. Returns per-member outcomes; missing acknowledgements are unknown." +
      writes,
    schemas.CommunityParticipantsSchema,
    false,
    (p) =>
      manager
        .getAdapter(p.instanceId)
        .updateCommunityParticipants(
          p.communityId,
          p.participants,
          p.action,
          p.confirmLinkedGroupRemoval,
        ),
  );
  register(
    "wa_community_list_join_requests",
    "List pending community membership requests. Read-only; community admin required. Baileys only.",
    schemas.CommunityIdSchema,
    true,
    (p) => manager.getAdapter(p.instanceId).listCommunityJoinRequests(p.communityId),
  );
  register(
    "wa_community_handle_join_requests",
    "Approve or reject membership requests with per-member outcomes." + writes,
    schemas.CommunityRequestsSchema,
    false,
    (p) =>
      manager
        .getAdapter(p.instanceId)
        .handleCommunityJoinRequests(p.communityId, p.participants, p.action),
  );
  register(
    "wa_community_get_invite",
    "Read the community invitation code/link. Treat the result as private access-bearing data. Admin required; no write gate.",
    schemas.CommunityIdSchema,
    true,
    async (p) => {
      const code = await manager.getAdapter(p.instanceId).getCommunityInviteCode(p.communityId);
      return { code, link: `https://chat.whatsapp.com/${code}` };
    },
  );
  register(
    "wa_community_reset_invite",
    "Revoke the old community invitation and return its replacement. Treat the result as private access-bearing data." +
      writes,
    schemas.CommunityIdSchema,
    false,
    async (p) => {
      const code = await manager
        .getAdapter(p.instanceId)
        .getCommunityInviteCode(p.communityId, true);
      return { code, link: `https://chat.whatsapp.com/${code}` };
    },
  );
  register(
    "wa_community_get_invite_info",
    "Inspect a community invitation without joining. Baileys only. Do not log/share the supplied invite.",
    schemas.CommunityInviteSchema,
    true,
    (p) => manager.getAdapter(p.instanceId).getCommunityInviteInfo(p.invite),
  );
  register(
    "wa_community_join",
    "Join via a verified community invitation. Requires the group-write gate. A missing ID is an unknown result; inspect membership before retrying. Baileys only.",
    schemas.CommunityInviteSchema,
    false,
    (p) => manager.getAdapter(p.instanceId).joinCommunity(p.invite),
  );
  register(
    "wa_community_revoke_member_invite",
    "Revoke one member's V4 community invitation." + writes,
    schemas.CommunityRevokeMemberInviteSchema,
    false,
    async (p) => {
      await manager
        .getAdapter(p.instanceId)
        .revokeCommunityMemberInvite(p.communityId, p.participant);
      return { success: true };
    },
  );
  register(
    "wa_community_update_settings",
    "Change one parent-community setting. Does not modify each linked group's settings." + writes,
    schemas.CommunitySettingSchema,
    false,
    async (p) => {
      await manager.getAdapter(p.instanceId).updateCommunitySetting(p.communityId, p.change);
      return { success: true };
    },
  );
  register(
    "wa_community_send_announcement",
    "Queue text, image, video, audio or document to verified Avisos. Requires Avisos admin and group-write gate. Destination/permission rechecked by the queue worker. For history/download/reactions, resolve the JID with wa_get_community_hierarchy and use the existing message tools.",
    schemas.CommunityAnnouncementSchema,
    false,
    (p) => queue.enqueueCommunityAnnouncement(p.instanceId, p.communityId, p.content),
  );
}
