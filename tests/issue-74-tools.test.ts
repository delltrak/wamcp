import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proto, type BinaryNode, type WASocket } from "@whiskeysockets/baileys";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import { MediaService } from "../src/services/media.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import { registerBusinessTools } from "../src/tools/business.tools.js";
import { registerChatTools } from "../src/tools/chat.tools.js";
import { registerContactTools } from "../src/tools/contact.tools.js";
import { registerGroupTools } from "../src/tools/group.tools.js";
import { registerMessagingTools } from "../src/tools/messaging.tools.js";
import { registerNewsletterTools } from "../src/tools/newsletter.tools.js";

type RegisteredTool = {
  inputSchema: z.ZodType;
  handler: (params: unknown) => Promise<unknown>;
};

type ToolResult = { isError?: boolean; content: Array<{ text?: string }> };

const INSTANCE_ID = "synthetic-issue-74";
const CONTACT_JID = "5511999990000@s.whatsapp.net";
const COMMUNITY_JID = "120363000000000000@g.us";
const GROUP_JID = "120363000000000001@g.us";
const NEWSLETTER_JID = "123456789012345@newsletter";
const initialAppStateWritesEnabled = process.env.WA_APP_STATE_WRITES_ENABLED;

function makeNewsletterFetchResponse(): BinaryNode {
  return {
    tag: "iq",
    attrs: { id: "newsletter-query-id", type: "result" },
    content: [
      {
        tag: "messages",
        attrs: {},
        content: [
          {
            tag: "message",
            attrs: {
              id: "message-newest",
              server_id: "102",
              t: "1700000060",
              type: "text",
            },
            content: [
              {
                tag: "plaintext",
                attrs: {},
                content: proto.Message.encode({
                  extendedTextMessage: { text: "Newest channel update" },
                }).finish(),
              },
              { tag: "views_count", attrs: { count: "42" } },
              {
                tag: "reactions",
                attrs: {},
                content: [
                  { tag: "reaction", attrs: { code: "👍", count: "3" } },
                  { tag: "reaction", attrs: { code: "❤️", count: "5" } },
                ],
              },
            ],
          },
          {
            tag: "message",
            attrs: {
              id: "message-oldest",
              server_id: "101",
              t: "1700000000",
              type: "image",
            },
            content: [
              {
                tag: "plaintext",
                attrs: {},
                content: proto.Message.encode({
                  imageMessage: { caption: "Older image caption" },
                }).finish(),
              },
              { tag: "views_count", attrs: { count: "7" } },
            ],
          },
        ],
      },
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (initialAppStateWritesEnabled === undefined) delete process.env.WA_APP_STATE_WRITES_ENABLED;
  else process.env.WA_APP_STATE_WRITES_ENABLED = initialAppStateWritesEnabled;
});

beforeEach(() => {
  process.env.WA_APP_STATE_WRITES_ENABLED = "true";
});

function makeSocket(overrides: Record<string, unknown> = {}) {
  const socket = {
    user: { id: CONTACT_JID },
    sendMessage: vi.fn(async () => ({
      key: { id: "synthetic-message-id", remoteJid: CONTACT_JID, fromMe: true },
      message: { videoMessage: { ptv: true } },
      messageTimestamp: 1_700_000_000,
    })),
    addOrEditQuickReply: vi.fn(async () => undefined),
    removeQuickReply: vi.fn(async () => undefined),
    fetchBlocklist: vi.fn(async () => [CONTACT_JID, undefined, "5511888888888@s.whatsapp.net"]),
    fetchStatus: vi.fn(async () => [{ id: CONTACT_JID, status: "Available" }]),
    communityCreate: vi.fn(async () => ({ id: COMMUNITY_JID, subject: "Community" })),
    communityFetchAllParticipating: vi.fn(async () => ({
      [COMMUNITY_JID]: { id: COMMUNITY_JID, subject: "Community" },
    })),
    communityMetadata: vi.fn(async () => ({ id: COMMUNITY_JID, subject: "Community details" })),
    communityLinkGroup: vi.fn(async () => undefined),
    communityUnlinkGroup: vi.fn(async () => undefined),
    communityLeave: vi.fn(async () => undefined),
    groupMetadata: vi.fn(async () => ({
      id: GROUP_JID,
      subject: "Group",
      participants: [{ id: CONTACT_JID, admin: "admin" }],
    })),
    groupFetchAllParticipating: vi.fn(async () => ({
      [GROUP_JID]: {
        id: GROUP_JID,
        subject: "Group",
        participants: [{ id: CONTACT_JID, admin: "admin" }],
      },
    })),
    groupInviteCode: vi.fn(async () => "AbCdEfGh"),
    groupCreate: vi.fn(async () => ({ id: GROUP_JID })),
    groupUpdateSubject: vi.fn(async () => undefined),
    groupUpdateDescription: vi.fn(async () => undefined),
    groupSettingUpdate: vi.fn(async () => undefined),
    groupLeave: vi.fn(async () => undefined),
    groupRevokeInvite: vi.fn(async () => undefined),
    groupParticipantsUpdate: vi.fn(async () => undefined),
    groupAcceptInvite: vi.fn(async () => GROUP_JID),
    groupRequestParticipantsUpdate: vi.fn(async () => undefined),
    updateProfilePicture: vi.fn(async () => undefined),
    removeProfilePicture: vi.fn(async () => undefined),
    groupJoinApprovalMode: vi.fn(async () => undefined),
    groupMemberAddMode: vi.fn(async () => undefined),
    newsletterCreate: vi.fn(async () => ({ id: NEWSLETTER_JID, name: "Channel" })),
    newsletterMetadata: vi.fn(async () => ({ id: NEWSLETTER_JID, name: "Channel metadata" })),
    newsletterUpdateName: vi.fn(async () => undefined),
    newsletterUpdateDescription: vi.fn(async () => undefined),
    newsletterUpdatePicture: vi.fn(async () => undefined),
    newsletterReactMessage: vi.fn(async () => undefined),
    newsletterFetchMessages: vi.fn(async () => makeNewsletterFetchResponse()),
    generateMessageTag: vi.fn(() => "newsletter-query-id"),
    query: vi.fn(async () => makeNewsletterFetchResponse()),
    getCatalog: vi.fn(async () => ({ products: [{ id: "product-1" }], nextPageCursor: "next" })),
    getCollections: vi.fn(async () => ({ collections: [{ id: "collection-1", name: "Set" }] })),
    productCreate: vi.fn(async () => ({ id: "product-created", name: "Item" })),
    productUpdate: vi.fn(async () => ({ id: "product-1", name: "Updated item" })),
    productDelete: vi.fn(async (productIds: string[]) => ({ deleted: productIds.length })),
    getOrderDetails: vi.fn(async () => ({ price: { currency: "USD", total: 10 }, products: [] })),
    ...overrides,
  } as unknown as WASocket;
  return socket;
}

function makeAdapter(socket = makeSocket()): BaileysAdapter {
  const adapter = new BaileysAdapter(INSTANCE_ID);
  Object.assign(adapter, { sock: socket, status: "connected" });
  return adapter;
}

function registerTools(adapter: BaileysAdapter | CloudApiAdapter) {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, options: unknown, handler: unknown) => {
      const schema = (options as { inputSchema: unknown }).inputSchema;
      const inputSchema =
        typeof schema === "object" && schema !== null && "parse" in schema
          ? (schema as z.ZodType)
          : z.object(schema as Record<string, z.ZodType>);
      tools.set(name, {
        inputSchema,
        handler: handler as (params: unknown) => Promise<unknown>,
      });
    },
  } as unknown as McpServer;
  const instanceManager = {
    getAdapter: () => adapter,
    getInstanceChannel: () => "baileys",
  } as unknown as InstanceManager;
  const messageQueue = {
    enqueueMessage: async (_instanceId: string, to: string, content: unknown) =>
      adapter.sendMessage(to, content as Parameters<BaileysAdapter["sendMessage"]>[1]),
  } as unknown as MessageQueue;

  registerChatTools(server, instanceManager, messageQueue);
  registerContactTools(server, instanceManager, messageQueue);
  registerGroupTools(server, instanceManager, messageQueue);
  registerNewsletterTools(server, instanceManager, messageQueue);
  registerBusinessTools(server, instanceManager);
  registerMessagingTools(server, instanceManager, messageQueue);
  return tools;
}

async function invoke(
  tools: Map<string, RegisteredTool>,
  name: string,
  params: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Tool ${name} was not registered`);
  return (await tool.handler(
    tool.inputSchema.parse({ instanceId: INSTANCE_ID, ...params }),
  )) as ToolResult;
}

function resultData(result: ToolResult): unknown {
  return JSON.parse(result.content[0]?.text ?? "null");
}

const CATALOG_PRODUCT_INPUT = {
  name: "Item",
  retailerId: "item-1",
  url: "https://shop.example/item-1",
  description: "Generic item",
  price: 10,
  currency: "USD",
  images: [Buffer.from("image").toString("base64")],
};

const GATED_WRITE_CASES = [
  {
    toolName: "wa_set_disappearing_messages",
    params: { chatId: CONTACT_JID, duration: 86400 },
    run: (adapter: BaileysAdapter) => adapter.setDisappearingMessages(CONTACT_JID, 86400),
    socketMethod: "sendMessage",
  },
  {
    toolName: "wa_group_update_picture",
    params: { groupId: GROUP_JID, image: "aW1hZ2U=" },
    run: (adapter: BaileysAdapter) => adapter.updateGroupPicture(GROUP_JID, "aW1hZ2U="),
    socketMethod: "updateProfilePicture",
  },
  {
    toolName: "wa_group_remove_picture",
    params: { groupId: GROUP_JID },
    run: (adapter: BaileysAdapter) => adapter.removeGroupPicture(GROUP_JID),
    socketMethod: "removeProfilePicture",
  },
  {
    toolName: "wa_create_group",
    params: { name: "Group", participants: [CONTACT_JID] },
    run: (adapter: BaileysAdapter) => adapter.createGroup("Group", [CONTACT_JID]),
    socketMethod: "groupCreate",
  },
  {
    toolName: "wa_group_add_participants",
    params: { groupId: GROUP_JID, participants: [CONTACT_JID] },
    run: (adapter: BaileysAdapter) => adapter.modifyParticipants(GROUP_JID, [CONTACT_JID], "add"),
    socketMethod: "groupParticipantsUpdate",
  },
  {
    toolName: "wa_group_remove_participants",
    params: { groupId: GROUP_JID, participants: [CONTACT_JID] },
    run: (adapter: BaileysAdapter) =>
      adapter.modifyParticipants(GROUP_JID, [CONTACT_JID], "remove"),
    socketMethod: "groupParticipantsUpdate",
  },
  {
    toolName: "wa_group_promote",
    params: { groupId: GROUP_JID, participants: [CONTACT_JID] },
    run: (adapter: BaileysAdapter) =>
      adapter.modifyParticipants(GROUP_JID, [CONTACT_JID], "promote"),
    socketMethod: "groupParticipantsUpdate",
  },
  {
    toolName: "wa_group_demote",
    params: { groupId: GROUP_JID, participants: [CONTACT_JID] },
    run: (adapter: BaileysAdapter) =>
      adapter.modifyParticipants(GROUP_JID, [CONTACT_JID], "demote"),
    socketMethod: "groupParticipantsUpdate",
  },
  {
    toolName: "wa_group_update_subject",
    params: { groupId: GROUP_JID, subject: "Updated group" },
    run: (adapter: BaileysAdapter) =>
      adapter.modifyGroup(GROUP_JID, { action: "updateSubject", value: "Updated group" }),
    socketMethod: "groupUpdateSubject",
  },
  {
    toolName: "wa_group_update_description",
    params: { groupId: GROUP_JID, description: "Updated description" },
    run: (adapter: BaileysAdapter) =>
      adapter.modifyGroup(GROUP_JID, {
        action: "updateDescription",
        value: "Updated description",
      }),
    socketMethod: "groupUpdateDescription",
  },
  {
    toolName: "wa_group_update_settings",
    params: { groupId: GROUP_JID, announce: true, locked: true },
    run: (adapter: BaileysAdapter) =>
      adapter.modifyGroup(GROUP_JID, { action: "updateSettings", value: "announcement" }),
    socketMethod: "groupSettingUpdate",
  },
  {
    toolName: "wa_group_leave",
    params: { groupId: GROUP_JID },
    run: (adapter: BaileysAdapter) => adapter.modifyGroup(GROUP_JID, { action: "leave" }),
    socketMethod: "groupLeave",
  },
  {
    toolName: "wa_group_revoke_invite",
    params: { groupId: GROUP_JID },
    run: (adapter: BaileysAdapter) => adapter.modifyGroup(GROUP_JID, { action: "revokeInvite" }),
    socketMethod: "groupRevokeInvite",
  },
  {
    toolName: "wa_group_join",
    params: { inviteCode: "AbCdEfGh" },
    run: (adapter: BaileysAdapter) => adapter.joinGroup("AbCdEfGh"),
    socketMethod: "groupAcceptInvite",
  },
  {
    toolName: "wa_group_toggle_ephemeral",
    params: { groupId: GROUP_JID, duration: 86400 },
    run: (adapter: BaileysAdapter) =>
      adapter.modifyGroup(GROUP_JID, { action: "toggleEphemeral", value: 86400 }),
    socketMethod: "sendMessage",
  },
  {
    toolName: "wa_group_handle_request",
    params: { groupId: GROUP_JID, participantId: CONTACT_JID, action: "approve" },
    run: (adapter: BaileysAdapter) => adapter.handleJoinRequest(GROUP_JID, CONTACT_JID, "approve"),
    socketMethod: "groupRequestParticipantsUpdate",
  },
  {
    toolName: "wa_group_handle_request",
    params: { groupId: GROUP_JID, participantId: CONTACT_JID, action: "reject" },
    run: (adapter: BaileysAdapter) => adapter.handleJoinRequest(GROUP_JID, CONTACT_JID, "reject"),
    socketMethod: "groupRequestParticipantsUpdate",
  },
  {
    toolName: "wa_create_community",
    params: { name: "Community", description: "About" },
    run: (adapter: BaileysAdapter) => adapter.createCommunity("Community", "About"),
    socketMethod: "communityCreate",
  },
  {
    toolName: "wa_community_link_group",
    params: { groupId: GROUP_JID, communityId: COMMUNITY_JID },
    run: (adapter: BaileysAdapter) => adapter.linkGroupToCommunity(GROUP_JID, COMMUNITY_JID),
    socketMethod: "communityLinkGroup",
  },
  {
    toolName: "wa_community_unlink_group",
    params: { groupId: GROUP_JID, communityId: COMMUNITY_JID },
    run: (adapter: BaileysAdapter) => adapter.unlinkGroupFromCommunity(GROUP_JID, COMMUNITY_JID),
    socketMethod: "communityUnlinkGroup",
  },
  {
    toolName: "wa_leave_community",
    params: { communityId: COMMUNITY_JID },
    run: (adapter: BaileysAdapter) => adapter.leaveCommunity(COMMUNITY_JID),
    socketMethod: "communityLeave",
  },
  {
    toolName: "wa_create_newsletter",
    params: { name: "Channel", description: "Bio" },
    run: (adapter: BaileysAdapter) => adapter.createNewsletter("Channel", "Bio"),
    socketMethod: "newsletterCreate",
  },
  {
    toolName: "wa_newsletter_update_name",
    params: { jid: NEWSLETTER_JID, name: "Updated" },
    run: (adapter: BaileysAdapter) => adapter.updateNewsletterName(NEWSLETTER_JID, "Updated"),
    socketMethod: "newsletterUpdateName",
  },
  {
    toolName: "wa_newsletter_update_description",
    params: { jid: NEWSLETTER_JID, description: "Updated description" },
    run: (adapter: BaileysAdapter) =>
      adapter.updateNewsletterDescription(NEWSLETTER_JID, "Updated description"),
    socketMethod: "newsletterUpdateDescription",
  },
  {
    toolName: "wa_newsletter_update_picture",
    params: { jid: NEWSLETTER_JID, image: "aW1hZ2U=" },
    run: (adapter: BaileysAdapter) => adapter.updateNewsletterPicture(NEWSLETTER_JID, "aW1hZ2U="),
    socketMethod: "newsletterUpdatePicture",
  },
  {
    toolName: "wa_newsletter_react",
    params: { jid: NEWSLETTER_JID, serverId: "102", reaction: "👍" },
    run: (adapter: BaileysAdapter) => adapter.reactToNewsletterMessage(NEWSLETTER_JID, "102", "👍"),
    socketMethod: "newsletterReactMessage",
  },
  {
    toolName: "wa_create_catalog_product",
    params: CATALOG_PRODUCT_INPUT,
    run: (adapter: BaileysAdapter) => adapter.createProduct(CATALOG_PRODUCT_INPUT),
    socketMethod: "productCreate",
  },
  {
    toolName: "wa_update_catalog_product",
    params: { productId: "product-1", ...CATALOG_PRODUCT_INPUT },
    run: (adapter: BaileysAdapter) => adapter.updateProduct("product-1", CATALOG_PRODUCT_INPUT),
    socketMethod: "productUpdate",
  },
  {
    toolName: "wa_delete_catalog_products",
    params: { productIds: ["product-1"] },
    run: (adapter: BaileysAdapter) => adapter.deleteProducts(["product-1"]),
    socketMethod: "productDelete",
  },
  {
    toolName: "wa_group_join_approval_mode",
    params: { groupId: GROUP_JID, mode: "on" },
    run: (adapter: BaileysAdapter) => adapter.setGroupJoinApprovalMode(GROUP_JID, "on"),
    socketMethod: "groupJoinApprovalMode",
  },
  {
    toolName: "wa_group_member_add_mode",
    params: { groupId: GROUP_JID, mode: "admin_add" },
    run: (adapter: BaileysAdapter) => adapter.setGroupMemberAddMode(GROUP_JID, "admin_add"),
    socketMethod: "groupMemberAddMode",
  },
] as const;

describe("issue #74 tools", () => {
  it("sets private disappearing-message durations with sendMessage protocol updates", async () => {
    const socket = makeSocket();
    const tools = registerTools(makeAdapter(socket));

    for (const [duration, protocolValue] of [
      [0, false],
      [86400, 86400],
      [604800, 604800],
      [7776000, 7776000],
    ] as const) {
      const result = await invoke(tools, "wa_set_disappearing_messages", {
        chatId: CONTACT_JID,
        duration,
      });
      expect(result.isError).toBeUndefined();
      expect(socket.sendMessage).toHaveBeenLastCalledWith(CONTACT_JID, {
        disappearingMessagesInChat: protocolValue,
      });
    }
  });

  it("lists blocked contacts and reads a contact About through mocked reads", async () => {
    const socket = makeSocket();
    const tools = registerTools(makeAdapter(socket));

    expect(resultData(await invoke(tools, "wa_list_blocked_contacts"))).toEqual({
      count: 2,
      blocked: [CONTACT_JID, "5511888888888@s.whatsapp.net"],
    });
    expect(resultData(await invoke(tools, "wa_get_contact_about", { jid: CONTACT_JID }))).toEqual({
      jid: CONTACT_JID,
      about: "Available",
    });
    expect(socket.fetchBlocklist).toHaveBeenCalledOnce();
    expect(socket.fetchStatus).toHaveBeenCalledWith(CONTACT_JID);
  });

  it("rejects malformed business identifiers and tokens before socket access", async () => {
    const socket = makeSocket();
    const tools = registerTools(makeAdapter(socket));

    expect(
      (await invoke(tools, "wa_get_newsletter_metadata", { type: "jid", key: "bad" })).isError,
    ).toBe(true);
    await expect(
      invoke(tools, "wa_newsletter_react", {
        jid: NEWSLETTER_JID,
        serverId: "post-1",
        reaction: "👍",
      }),
    ).rejects.toThrow();
    await expect(
      invoke(tools, "wa_newsletter_list_posts", { jid: NEWSLETTER_JID, after: 2.5 }),
    ).rejects.toThrow();
    await expect(invoke(tools, "wa_get_catalog", { jid: "not-a-jid" })).rejects.toThrow();
    await expect(
      invoke(tools, "wa_get_order_details", { orderId: "order-1", tokenBase64: "not a token" }),
    ).rejects.toThrow();

    expect(socket.newsletterMetadata).not.toHaveBeenCalled();
    expect(socket.newsletterReactMessage).not.toHaveBeenCalled();
    expect(socket.newsletterFetchMessages).not.toHaveBeenCalled();
    expect(socket.query).not.toHaveBeenCalled();
    expect(socket.getCatalog).not.toHaveBeenCalled();
    expect(socket.getOrderDetails).not.toHaveBeenCalled();
  });

  it("creates, lists, details, links, unlinks, and leaves communities", async () => {
    const socket = makeSocket();
    const tools = registerTools(makeAdapter(socket));

    expect(
      resultData(
        await invoke(tools, "wa_create_community", { name: "Community", description: "About" }),
      ),
    ).toMatchObject({ communityId: COMMUNITY_JID });
    expect(resultData(await invoke(tools, "wa_list_communities"))).toMatchObject({ count: 1 });
    expect(
      resultData(await invoke(tools, "wa_get_community_details", { communityId: COMMUNITY_JID })),
    ).toMatchObject({ subject: "Community details" });
    await invoke(tools, "wa_community_link_group", {
      groupId: GROUP_JID,
      communityId: COMMUNITY_JID,
    });
    await invoke(tools, "wa_community_unlink_group", {
      groupId: GROUP_JID,
      communityId: COMMUNITY_JID,
    });
    await invoke(tools, "wa_leave_community", { communityId: COMMUNITY_JID });

    expect(socket.communityCreate).toHaveBeenCalledWith("Community", "About");
    expect(socket.communityFetchAllParticipating).toHaveBeenCalledOnce();
    expect(socket.communityMetadata).toHaveBeenCalledWith(COMMUNITY_JID);
    expect(socket.communityLinkGroup).toHaveBeenCalledWith(GROUP_JID, COMMUNITY_JID);
    expect(socket.communityUnlinkGroup).toHaveBeenCalledWith(GROUP_JID, COMMUNITY_JID);
    expect(socket.communityLeave).toHaveBeenCalledWith(COMMUNITY_JID);
  });

  it("creates and updates Channels, reacts, and fetches posts", async () => {
    const socket = makeSocket();
    const tools = registerTools(makeAdapter(socket));
    vi.spyOn(MediaService.prototype, "prepareGroupProfilePicture").mockResolvedValue(
      Buffer.from("jpeg"),
    );

    expect(
      resultData(
        await invoke(tools, "wa_create_newsletter", { name: "Channel", description: "Bio" }),
      ),
    ).toMatchObject({ id: NEWSLETTER_JID });
    expect(
      resultData(
        await invoke(tools, "wa_get_newsletter_metadata", { type: "jid", key: NEWSLETTER_JID }),
      ),
    ).toMatchObject({ name: "Channel metadata" });
    await invoke(tools, "wa_newsletter_update_name", { jid: NEWSLETTER_JID, name: "Updated" });
    await invoke(tools, "wa_newsletter_update_description", {
      jid: NEWSLETTER_JID,
      description: "Updated description",
    });
    await invoke(tools, "wa_newsletter_update_picture", {
      jid: NEWSLETTER_JID,
      image: "aW1hZ2U=",
    });
    await invoke(tools, "wa_newsletter_react", {
      jid: NEWSLETTER_JID,
      serverId: "102",
      reaction: "👍",
    });
    expect(
      resultData(await invoke(tools, "wa_newsletter_list_posts", { jid: NEWSLETTER_JID })),
    ).toMatchObject({
      posts: [
        { id: "message-newest", serverId: "102", text: "Newest channel update" },
        { id: "message-oldest", serverId: "101", text: "Older image caption" },
      ],
      pagination: { after: 102 },
    });

    expect(socket.newsletterCreate).toHaveBeenCalledWith("Channel", "Bio");
    expect(socket.newsletterMetadata).toHaveBeenCalledWith("jid", NEWSLETTER_JID);
    expect(socket.newsletterUpdateName).toHaveBeenCalledWith(NEWSLETTER_JID, "Updated");
    expect(socket.newsletterUpdateDescription).toHaveBeenCalledWith(
      NEWSLETTER_JID,
      "Updated description",
    );
    expect(socket.newsletterUpdatePicture).toHaveBeenCalledWith(
      NEWSLETTER_JID,
      Buffer.from("jpeg"),
    );
    expect(socket.newsletterReactMessage).toHaveBeenCalledWith(NEWSLETTER_JID, "102", "👍");
    expect(socket.newsletterFetchMessages).toHaveBeenCalledWith(NEWSLETTER_JID, 20, 0, 0);
  });

  it("parses Channel posts from a BinaryNode IQ into JSON-safe content and cursors", async () => {
    const socket = makeSocket();
    const tools = registerTools(makeAdapter(socket));

    const postsPage = resultData(
      await invoke(tools, "wa_newsletter_list_posts", {
        jid: NEWSLETTER_JID,
        since: 1_699_999_000,
        after: 101,
      }),
    ) as {
      posts: Array<Record<string, unknown>>;
      pagination: Record<string, unknown>;
    };

    expect(postsPage.posts).toEqual([
      {
        id: "message-newest",
        serverId: "102",
        timestamp: 1_700_000_060,
        type: "text",
        text: "Newest channel update",
        views: 42,
        reactions: [
          { code: "👍", count: 3 },
          { code: "❤️", count: 5 },
        ],
      },
      {
        id: "message-oldest",
        serverId: "101",
        timestamp: 1_700_000_000,
        type: "image",
        text: "Older image caption",
        views: 7,
        reactions: [],
      },
    ]);
    expect(postsPage.pagination).toEqual({
      oldestServerId: "101",
      newestServerId: "102",
      after: 102,
    });
    expect(JSON.stringify(postsPage)).not.toContain('"tag":"iq"');
    expect(JSON.stringify(postsPage)).not.toContain('"type":"Buffer"');
    expect(socket.newsletterFetchMessages).toHaveBeenCalledWith(
      NEWSLETTER_JID,
      20,
      1_699_999_000,
      101,
    );
  });

  it("sets group join approval and member-add modes", async () => {
    const socket = makeSocket();
    const tools = registerTools(makeAdapter(socket));

    await invoke(tools, "wa_group_join_approval_mode", { groupId: GROUP_JID, mode: "on" });
    await invoke(tools, "wa_group_member_add_mode", { groupId: GROUP_JID, mode: "admin_add" });
    expect(socket.groupJoinApprovalMode).toHaveBeenCalledWith(GROUP_JID, "on");
    expect(socket.groupMemberAddMode).toHaveBeenCalledWith(GROUP_JID, "admin_add");
  });

  it("lists catalog products and collections, edits products, and reads order details", async () => {
    const socket = makeSocket();
    const tools = registerTools(makeAdapter(socket));
    const image = Buffer.from("image").toString("base64");
    const product = {
      name: "Item",
      description: "Generic item",
      price: 10,
      currency: "USD",
      images: [image],
    };

    expect(resultData(await invoke(tools, "wa_get_catalog"))).toMatchObject({
      products: [{ id: "product-1" }],
      nextPageCursor: "next",
    });
    expect(resultData(await invoke(tools, "wa_get_catalog_collections"))).toMatchObject({
      collections: [{ id: "collection-1" }],
    });
    await invoke(tools, "wa_create_catalog_product", product);
    await invoke(tools, "wa_update_catalog_product", { productId: "product-1", ...product });
    expect(
      resultData(await invoke(tools, "wa_delete_catalog_products", { productIds: ["product-1"] })),
    ).toEqual({ deleted: 1 });
    expect(
      resultData(
        await invoke(tools, "wa_get_order_details", {
          orderId: "order-1",
          tokenBase64: "dG9rZW4=",
        }),
      ),
    ).toMatchObject({ price: { total: 10 } });

    expect(socket.getCatalog).toHaveBeenCalledWith({
      jid: undefined,
      limit: 10,
      cursor: undefined,
    });
    expect(socket.getCollections).toHaveBeenCalledWith(undefined, 51);
    expect(socket.productCreate).toHaveBeenCalledWith(
      expect.objectContaining({ images: [Buffer.from("image")], originCountryCode: undefined }),
    );
    expect(socket.productUpdate).toHaveBeenCalledWith(
      "product-1",
      expect.objectContaining({ images: [Buffer.from("image")] }),
    );
    expect(socket.productDelete).toHaveBeenCalledWith(["product-1"]);
    expect(socket.getOrderDetails).toHaveBeenCalledWith("order-1", "dG9rZW4=");
  });

  it("creates, edits, and deletes quick replies when app-state writes are enabled", async () => {
    const previous = process.env.WA_APP_STATE_WRITES_ENABLED;
    process.env.WA_APP_STATE_WRITES_ENABLED = "true";
    try {
      const socket = makeSocket();
      const tools = registerTools(makeAdapter(socket));
      await invoke(tools, "wa_create_quick_reply", { shortcut: "hours", message: "Open 9–5" });
      await invoke(tools, "wa_edit_quick_reply", {
        timestamp: "1700000000",
        shortcut: "hours",
        message: "Open 10–6",
      });
      await invoke(tools, "wa_delete_quick_reply", { timestamp: "1700000000" });

      expect(socket.addOrEditQuickReply).toHaveBeenNthCalledWith(1, {
        shortcut: "hours",
        message: "Open 9–5",
      });
      expect(socket.addOrEditQuickReply).toHaveBeenNthCalledWith(2, {
        shortcut: "hours",
        message: "Open 10–6",
        timestamp: "1700000000",
      });
      expect(socket.removeQuickReply).toHaveBeenCalledWith("1700000000");
    } finally {
      if (previous === undefined) delete process.env.WA_APP_STATE_WRITES_ENABLED;
      else process.env.WA_APP_STATE_WRITES_ENABLED = previous;
    }
  });

  it.each(GATED_WRITE_CASES)(
    "blocks $toolName before socket access when account/server writes are disabled",
    async ({ toolName, params, run, socketMethod }) => {
      const previous = process.env.WA_APP_STATE_WRITES_ENABLED;
      delete process.env.WA_APP_STATE_WRITES_ENABLED;
      try {
        vi.spyOn(MediaService.prototype, "prepareGroupProfilePicture").mockResolvedValue(
          Buffer.from("jpeg"),
        );
        vi.spyOn(MediaService.prototype, "getMediaBuffer").mockResolvedValue(Buffer.from("image"));

        const socket = makeSocket();
        const adapter = makeAdapter(socket);
        await expect(run(adapter)).rejects.toThrow(
          "WhatsApp account, server, and app-state writes are disabled",
        );
        expect(socket[socketMethod]).not.toHaveBeenCalled();

        const result = await invoke(registerTools(adapter), toolName, params);
        expect(result.isError).toBe(true);
        expect(socket[socketMethod]).not.toHaveBeenCalled();
        if (toolName === "wa_group_update_picture" || toolName === "wa_group_remove_picture") {
          expect(socket.groupMetadata).not.toHaveBeenCalled();
          expect(MediaService.prototype.prepareGroupProfilePicture).not.toHaveBeenCalled();
        }
        if (toolName === "wa_newsletter_update_picture") {
          expect(MediaService.prototype.prepareGroupProfilePicture).not.toHaveBeenCalled();
        }
        if (toolName === "wa_create_catalog_product" || toolName === "wa_update_catalog_product") {
          expect(MediaService.prototype.getMediaBuffer).not.toHaveBeenCalled();
        }
      } finally {
        if (previous === undefined) delete process.env.WA_APP_STATE_WRITES_ENABLED;
        else process.env.WA_APP_STATE_WRITES_ENABLED = previous;
      }
    },
  );

  it("allows all new account/server writes through when enabled", async () => {
    const previous = process.env.WA_APP_STATE_WRITES_ENABLED;
    process.env.WA_APP_STATE_WRITES_ENABLED = "true";
    try {
      vi.spyOn(MediaService.prototype, "prepareGroupProfilePicture").mockResolvedValue(
        Buffer.from("jpeg"),
      );
      vi.spyOn(MediaService.prototype, "getMediaBuffer").mockResolvedValue(Buffer.from("image"));
      const socket = makeSocket();
      const tools = registerTools(makeAdapter(socket));

      for (const { toolName, params, socketMethod } of GATED_WRITE_CASES) {
        vi.clearAllMocks();
        const result = await invoke(tools, toolName, params);
        expect(result.isError).toBeUndefined();
        expect(socket[socketMethod]).toHaveBeenCalled();
      }
    } finally {
      if (previous === undefined) delete process.env.WA_APP_STATE_WRITES_ENABLED;
      else process.env.WA_APP_STATE_WRITES_ENABLED = previous;
    }
  });

  it.each([
    ["wa_create_quick_reply", "createQuickReply", { shortcut: "hours", message: "Open" }],
    [
      "wa_edit_quick_reply",
      "editQuickReply",
      { timestamp: "1700000000", shortcut: "hours", message: "Open" },
    ],
    ["wa_delete_quick_reply", "deleteQuickReply", { timestamp: "1700000000" }],
  ] as const)(
    "blocks gated tool %s before calling any socket method",
    async (toolName, method, params) => {
      const previous = process.env.WA_APP_STATE_WRITES_ENABLED;
      delete process.env.WA_APP_STATE_WRITES_ENABLED;
      try {
        const socket = makeSocket();
        const adapter = makeAdapter(socket);
        await expect(adapter[method](params as never)).rejects.toThrow(
          "WhatsApp account, server, and app-state writes are disabled",
        );
        expect(socket.addOrEditQuickReply).not.toHaveBeenCalled();
        expect(socket.removeQuickReply).not.toHaveBeenCalled();

        const tools = registerTools(adapter);
        const result = await invoke(tools, toolName, params as Record<string, unknown>);
        expect(result.isError).toBe(true);
        expect(socket.addOrEditQuickReply).not.toHaveBeenCalled();
        expect(socket.removeQuickReply).not.toHaveBeenCalled();
      } finally {
        if (previous === undefined) delete process.env.WA_APP_STATE_WRITES_ENABLED;
        else process.env.WA_APP_STATE_WRITES_ENABLED = previous;
      }
    },
  );

  it("keeps group reads available when account/server writes are disabled", async () => {
    const previous = process.env.WA_APP_STATE_WRITES_ENABLED;
    delete process.env.WA_APP_STATE_WRITES_ENABLED;
    try {
      const socket = makeSocket();
      const adapter = makeAdapter(socket);

      await expect(adapter.listGroups()).resolves.toMatchObject([{ jid: GROUP_JID }]);
      await expect(adapter.getGroupMetadata(GROUP_JID)).resolves.toMatchObject({
        jid: GROUP_JID,
        subject: "Group",
      });
      await expect(adapter.getGroupInviteCode(GROUP_JID)).resolves.toBe("AbCdEfGh");

      expect(socket.groupFetchAllParticipating).toHaveBeenCalledOnce();
      expect(socket.groupMetadata).toHaveBeenCalledOnce();
      expect(socket.groupInviteCode).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) delete process.env.WA_APP_STATE_WRITES_ENABLED;
      else process.env.WA_APP_STATE_WRITES_ENABLED = previous;
    }
  });

  it("sends PTV using the existing queued video path and Baileys ptv flag", async () => {
    const socket = makeSocket();
    const adapter = makeAdapter(socket);
    const tools = registerTools(adapter);
    const internal = adapter as unknown as { persistOutgoingMessage: (...args: unknown[]) => void };
    vi.spyOn(internal, "persistOutgoingMessage").mockImplementation(() => undefined);

    const result = await invoke(tools, "wa_send_ptv", {
      to: CONTACT_JID,
      video: "aW1hZ2U=",
      caption: "Generic clip",
    });

    expect(result.isError).toBeUndefined();
    expect(socket.sendMessage).toHaveBeenCalledWith(
      CONTACT_JID,
      { video: Buffer.from("image"), caption: "Generic clip", ptv: true },
      {},
    );
  });

  it("returns clear unsupported-operation errors on Cloud API", async () => {
    const adapter = new CloudApiAdapter(INSTANCE_ID);
    await expect(adapter.setDisappearingMessages(CONTACT_JID, 86400)).rejects.toThrow(
      "not supported on Cloud API",
    );
    await expect(adapter.getContactAbout(CONTACT_JID)).rejects.toThrow("Baileys instances");
    await expect(adapter.listCommunities()).rejects.toThrow("Baileys instances");
    await expect(
      adapter.sendMessage(CONTACT_JID, { type: "video", video: "YQ==", ptv: true }),
    ).rejects.toThrow("Video notes (PTV) are not supported on Cloud API");
  });
});
