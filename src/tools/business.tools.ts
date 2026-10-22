// ============================================================
// WA MCP — Business, Community, and Channel Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { ChannelAdapter } from "../channels/channel.interface.js";
import type { InstanceManager } from "../services/instance-manager.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";
import { createRequestLogger } from "../utils/logger.js";
import {
  CreateQuickReplySchema,
  EditQuickReplySchema,
  DeleteQuickReplySchema,
  CreateCommunitySchema,
  ListCommunitiesSchema,
  GetCommunityDetailsSchema,
  LinkCommunityGroupSchema,
  UnlinkCommunityGroupSchema,
  LeaveCommunitySchema,
  CreateNewsletterSchema,
  GetNewsletterMetadataSchema,
  UpdateNewsletterNameSchema,
  UpdateNewsletterDescriptionSchema,
  UpdateNewsletterPictureSchema,
  ReactToNewsletterMessageSchema,
  ListNewsletterMessagesSchema,
  GetCatalogSchema,
  GetCollectionsSchema,
  CreateProductSchema,
  UpdateProductSchema,
  DeleteProductsSchema,
  GetOrderDetailsSchema,
} from "../schemas/business.schema.js";

function registerBusinessTool<S extends z.ZodObject>(
  server: McpServer,
  instanceManager: InstanceManager,
  name: string,
  description: string,
  inputSchema: S,
  action: (adapter: ChannelAdapter, params: z.infer<S>) => Promise<unknown>,
): void {
  server.registerTool(name, { description, inputSchema: inputSchema.shape }, async (rawParams) => {
    const params = rawParams as z.infer<S> & { instanceId: string };
    const log = createRequestLogger(name, params.instanceId);
    const start = Date.now();
    try {
      const result = await action(instanceManager.getAdapter(params.instanceId), params);
      log.info({ duration: Date.now() - start }, "Business operation completed");
      return toolSuccess(result);
    } catch (error) {
      return handleToolError(name, error, params.instanceId);
    }
  });
}

export function registerBusinessTools(server: McpServer, instanceManager: InstanceManager): void {
  registerBusinessTool(
    server,
    instanceManager,
    "wa_create_quick_reply",
    "Create a Business quick reply. This writes WhatsApp app state and is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
    CreateQuickReplySchema,
    (adapter, params) => adapter.createQuickReply(params),
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_edit_quick_reply",
    "Edit a Business quick reply by its sync timestamp. This writes WhatsApp app state and is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
    EditQuickReplySchema,
    (adapter, params) => adapter.editQuickReply(params),
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_delete_quick_reply",
    "Delete a Business quick reply by its sync timestamp. This writes WhatsApp app state and is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
    DeleteQuickReplySchema,
    (adapter, params) => adapter.deleteQuickReply(params.timestamp),
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_create_community",
    "Create a WhatsApp community. This server operation is blocked unless WA_GROUP_WRITES_ENABLED=true or WA_APP_STATE_WRITES_ENABLED=true. Cloud API does not support communities.",
    CreateCommunitySchema,
    async (adapter, params) => {
      const community = await adapter.createCommunity(params.name, params.description);
      return { communityId: community?.jid ?? null, community };
    },
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_list_communities",
    "List communities for the connected Baileys account using an IQ query.",
    ListCommunitiesSchema,
    async (adapter) => {
      const communities = await adapter.listCommunities();
      return { count: Object.keys(communities).length, communities: Object.values(communities) };
    },
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_get_community_details",
    "Get community metadata through a Baileys w:g2 IQ query.",
    GetCommunityDetailsSchema,
    (adapter, params) => adapter.getCommunityMetadata(params.communityId),
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_community_link_group",
    "Link an existing group to a community. This server operation is blocked unless WA_GROUP_WRITES_ENABLED=true or WA_APP_STATE_WRITES_ENABLED=true.",
    LinkCommunityGroupSchema,
    async (adapter, params) => {
      await adapter.linkGroupToCommunity(params.groupId, params.communityId);
      return { success: true, groupId: params.groupId, communityId: params.communityId };
    },
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_community_unlink_group",
    "Unlink a group from a community. This server operation is blocked unless WA_GROUP_WRITES_ENABLED=true or WA_APP_STATE_WRITES_ENABLED=true.",
    UnlinkCommunityGroupSchema,
    async (adapter, params) => {
      await adapter.unlinkGroupFromCommunity(params.groupId, params.communityId);
      return { success: true, groupId: params.groupId, communityId: params.communityId };
    },
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_leave_community",
    "Leave a WhatsApp community. This server operation is blocked unless WA_GROUP_WRITES_ENABLED=true or WA_APP_STATE_WRITES_ENABLED=true.",
    LeaveCommunitySchema,
    async (adapter, params) => {
      await adapter.leaveCommunity(params.communityId);
      return { success: true, communityId: params.communityId };
    },
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_create_newsletter",
    "Create a WhatsApp Channel. This server operation is blocked unless WA_GROUP_WRITES_ENABLED=true or WA_APP_STATE_WRITES_ENABLED=true.",
    CreateNewsletterSchema,
    (adapter, params) => adapter.createNewsletter(params.name, params.description),
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_get_newsletter_metadata",
    "Get WhatsApp Channel metadata by its JID or invite code.",
    GetNewsletterMetadataSchema,
    (adapter, params) => adapter.getNewsletterMetadata(params.type, params.key),
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_newsletter_update_name",
    "Update a WhatsApp Channel name. This server operation is blocked unless WA_GROUP_WRITES_ENABLED=true or WA_APP_STATE_WRITES_ENABLED=true.",
    UpdateNewsletterNameSchema,
    async (adapter, params) => {
      await adapter.updateNewsletterName(params.jid, params.name);
      return { success: true, jid: params.jid, name: params.name };
    },
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_newsletter_update_description",
    "Update a WhatsApp Channel description. This server operation is blocked unless WA_GROUP_WRITES_ENABLED=true or WA_APP_STATE_WRITES_ENABLED=true.",
    UpdateNewsletterDescriptionSchema,
    async (adapter, params) => {
      await adapter.updateNewsletterDescription(params.jid, params.description);
      return { success: true, jid: params.jid };
    },
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_newsletter_update_picture",
    "Update a WhatsApp Channel picture from an HTTPS URL or base64 image; input is size-limited, URL-validated, and converted to JPEG. This server operation is blocked unless WA_GROUP_WRITES_ENABLED=true or WA_APP_STATE_WRITES_ENABLED=true.",
    UpdateNewsletterPictureSchema,
    async (adapter, params) => {
      await adapter.updateNewsletterPicture(params.jid, params.image);
      return { success: true, jid: params.jid };
    },
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_newsletter_react",
    "Add or remove a reaction on a WhatsApp Channel post. This server operation is blocked unless WA_GROUP_WRITES_ENABLED=true or WA_APP_STATE_WRITES_ENABLED=true.",
    ReactToNewsletterMessageSchema,
    async (adapter, params) => {
      await adapter.reactToNewsletterMessage(params.jid, params.serverId, params.reaction);
      return { success: true, jid: params.jid, serverId: params.serverId };
    },
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_newsletter_list_posts",
    "Fetch WhatsApp Channel posts with count, optional Unix timestamp lower bound, and server-ID cursor. Returns parsed post content and pagination IDs.",
    ListNewsletterMessagesSchema,
    (adapter, params) =>
      adapter.fetchNewsletterMessages(params.jid, params.count, params.since, params.after),
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_get_catalog",
    "List products in the connected WhatsApp Business catalog, with cursor pagination.",
    GetCatalogSchema,
    (adapter, params) =>
      adapter.getCatalog({ jid: params.jid, limit: params.limit, cursor: params.cursor }),
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_get_catalog_collections",
    "List collections in the connected WhatsApp Business catalog.",
    GetCollectionsSchema,
    (adapter, params) => adapter.getCollections(params.jid, params.limit),
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_create_catalog_product",
    "Create a WhatsApp Business catalog product. Product image URLs must be public HTTPS URLs; images are fetched with size limits before upload. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
    CreateProductSchema,
    (adapter, params) => {
      const { instanceId: _instanceId, ...input } = params;
      return adapter.createProduct(input);
    },
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_update_catalog_product",
    "Replace the fields and images for a WhatsApp Business catalog product. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
    UpdateProductSchema,
    (adapter, params) => {
      const { instanceId: _instanceId, productId, ...input } = params;
      return adapter.updateProduct(productId, input);
    },
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_delete_catalog_products",
    "Delete one or more products from the WhatsApp Business catalog. This account/server change is blocked unless WA_APP_STATE_WRITES_ENABLED=true.",
    DeleteProductsSchema,
    (adapter, params) => adapter.deleteProducts(params.productIds),
  );

  registerBusinessTool(
    server,
    instanceManager,
    "wa_get_order_details",
    "Read WhatsApp Business order details using the order ID and token from an order message.",
    GetOrderDetailsSchema,
    (adapter, params) => adapter.getOrderDetails(params.orderId, params.tokenBase64),
  );
}
