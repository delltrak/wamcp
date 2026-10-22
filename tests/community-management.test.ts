import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaileysEventMap, GroupMetadata, WASocket } from "@whiskeysockets/baileys";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { GroupMemberLabelStore } from "../src/services/group-member-label-store.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import { MediaService } from "../src/services/media.js";
import { registerCommunityTools } from "../src/tools/community.tools.js";
import { normalizeEventWebhookPayload } from "../src/services/event-webhook.js";
import { normalizeGroupsUpdate } from "../src/channels/baileys/baileys.events.js";
import {
  CommunityParticipantsSchema,
  CommunitySettingSchema,
  CommunityMembersSchema,
} from "../src/schemas/community.schema.js";
import { handleToolError } from "../src/utils/tool-handler.js";
import {
  InstanceNotFoundError,
  InstanceNotInitializedError,
} from "../src/utils/instance-errors.js";

const PARENT = "120363000000000000@g.us";
const GROUP = "120363000000000001@g.us";
const AVISOS = "120363000000000002@g.us";
const OTHER = "120363000000000003@g.us";
const SELF = "5511999990000@s.whatsapp.net";
const SELF_LID = "1999990000@lid";
const OWNER = "5511999990001@s.whatsapp.net";
const MEMBER = "5511999990002@s.whatsapp.net";
const INSTANCE = "community-management-test";

function metadata(id: string, extra: Partial<GroupMetadata> = {}): GroupMetadata {
  return {
    id,
    subject: "Fixture",
    owner: OWNER,
    participants: [
      { id: SELF_LID, phoneNumber: SELF, admin: "admin" },
      { id: OWNER, admin: "superadmin" },
      { id: MEMBER },
    ],
    ...extra,
  };
}
function fixture() {
  const parent = metadata(PARENT, { isCommunity: true });
  const group = metadata(GROUP, { isCommunity: false, isCommunityAnnounce: false });
  const avisos = metadata(AVISOS, { linkedParent: PARENT, isCommunityAnnounce: true });
  const records = new Map([
    [PARENT, parent],
    [GROUP, group],
    [AVISOS, avisos],
  ]);
  const socket = {
    user: { id: SELF, lid: SELF_LID },
    groupMetadata: vi.fn(async (id: string) => {
      const value = records.get(id);
      if (!value) throw new Error("Group not found");
      return value;
    }),
    communityCreateGroup: vi.fn(async (): Promise<GroupMetadata | null> =>
      metadata(GROUP, { linkedParent: PARENT }),
    ),
    communityUpdateSubject: vi.fn(async () => {}),
    groupUpdateDescription: vi.fn(async () => {}),
    updateProfilePicture: vi.fn(async () => {}),
    removeProfilePicture: vi.fn(async () => {}),
    communityParticipantsUpdate: vi.fn(async (_id: string, ids: string[], _action: string) =>
      ids.map((jid) => ({ jid, status: "200" })),
    ),
    communityRequestParticipantsList: vi.fn(async () => [
      { jid: MEMBER, request_time: "1700000000", invite_code: "DO-NOT-EXPOSE" },
    ]),
    communityRequestParticipantsUpdate: vi.fn(async (_id: string, ids: string[], _action: string) =>
      ids.map((jid) => ({ jid, status: "200" })),
    ),
    communityInviteCode: vi.fn(async (): Promise<string | undefined> => "FixtureCode"),
    communityRevokeInvite: vi.fn(async (): Promise<string | undefined> => "ReplacementCode"),
    groupGetInviteInfo: vi.fn(async () => parent),
    groupAcceptInvite: vi.fn(async (): Promise<string | undefined> => PARENT),
    communityAcceptInviteV4: vi.fn(async () => PARENT),
    communityRevokeInviteV4: vi.fn(async () => true),
    communitySettingUpdate: vi.fn(async () => {}),
    communityMemberAddMode: vi.fn(async () => {}),
    communityJoinApprovalMode: vi.fn(async () => {}),
    communityToggleEphemeral: vi.fn(async () => {}),
    communityLinkGroup: vi.fn(async () => {
      group.linkedParent = PARENT;
    }),
    communityUnlinkGroup: vi.fn(async () => {
      delete group.linkedParent;
    }),
    communityLeave: vi.fn(async () => {}),
    communityFetchLinkedGroups: vi.fn(async () => ({
      communityJid: PARENT,
      isCommunity: true,
      linkedGroups: [{ id: AVISOS, subject: "Avisos" }],
    })),
    groupFetchAllParticipating: vi.fn(async () => ({ [AVISOS]: avisos })),
  };
  const store = { getForGroup: () => [] } as unknown as GroupMemberLabelStore;
  const adapter = new BaileysAdapter(INSTANCE, undefined, store);
  Object.assign(adapter, { sock: socket as unknown as WASocket, status: "connected" });
  return { adapter, socket, parent, group, avisos, records };
}

beforeEach(() => {
  vi.stubEnv("WA_GROUP_WRITES_ENABLED", "true");
  vi.stubEnv("WA_APP_STATE_WRITES_ENABLED", "false");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const mutations: Array<[string, (a: BaileysAdapter) => Promise<unknown>]> = [
  ["create child", (a) => a.createCommunityGroup(PARENT, "New", [])],
  ["name", (a) => a.updateCommunityName(PARENT, "New")],
  ["description", (a) => a.updateCommunityDescription(PARENT, "")],
  ["picture", (a) => a.updateCommunityPicture(PARENT, null)],
  ["members", (a) => a.updateCommunityParticipants(PARENT, [MEMBER], "remove", true)],
  ["requests", (a) => a.handleCommunityJoinRequests(PARENT, [MEMBER], "approve")],
  ["reset invite", (a) => a.getCommunityInviteCode(PARENT, true)],
  ["revoke member invite", (a) => a.revokeCommunityMemberInvite(PARENT, MEMBER)],
  ["settings", (a) => a.updateCommunitySetting(PARENT, { setting: "edit_info", value: "admins" })],
  ["link", (a) => a.linkGroupToCommunity(GROUP, PARENT)],
  ["unlink", (a) => a.unlinkGroupFromCommunity(GROUP, PARENT)],
  ["leave", (a) => a.leaveCommunity(PARENT)],
  ["join", (a) => a.joinCommunity("FixtureCode")],
  [
    "join v4",
    (a) =>
      a.joinCommunityV4({
        communityId: PARENT,
        inviter: OWNER,
        inviteCode: "FixtureCode",
        inviteExpiration: 4102444800,
      }),
  ],
  ["announcement", (a) => a.resolveCommunityAnnouncementGroup(PARENT, true)],
];

describe("community management", () => {
  it.each(mutations)(
    "blocks %s before querying the server when writes are disabled",
    async (_name, run) => {
      vi.stubEnv("WA_GROUP_WRITES_ENABLED", "false");
      const { adapter, socket } = fixture();
      await expect(run(adapter)).rejects.toThrow("writes are disabled");
      expect(socket.groupMetadata).not.toHaveBeenCalled();
      expect(socket.groupGetInviteInfo).not.toHaveBeenCalled();
    },
  );
  it.each(mutations.filter(([name]) => !["leave", "join", "join v4"].includes(name)))(
    "rejects %s for a non-admin",
    async (_name, run) => {
      const { adapter, parent, avisos } = fixture();
      parent.participants[0]!.admin = null;
      avisos.participants[0]!.admin = null;
      await expect(run(adapter)).rejects.toThrow("admin");
    },
  );
  it("uses PN/LID admin identities to edit name, clear description and prepare/remove photos", async () => {
    const { adapter, socket } = fixture();
    const prepare = vi
      .spyOn(MediaService.prototype, "prepareGroupProfilePicture")
      .mockResolvedValue(Buffer.from("jpeg"));
    await adapter.updateCommunityName(PARENT, "Renamed");
    await adapter.updateCommunityDescription(PARENT, "");
    await adapter.updateCommunityPicture(PARENT, "aW1hZ2U=");
    await adapter.updateCommunityPicture(PARENT, null);
    expect(socket.communityUpdateSubject).toHaveBeenCalledWith(PARENT, "Renamed");
    expect(socket.groupUpdateDescription).toHaveBeenCalledWith(PARENT, "");
    expect(prepare).toHaveBeenCalledWith("aW1hZ2U=");
    expect(socket.updateProfilePicture).toHaveBeenCalledWith(PARENT, Buffer.from("jpeg"));
    expect(socket.removeProfilePicture).toHaveBeenCalledWith(PARENT);
  });
  it("creates directly under the parent and exposes an unknown result without retrying", async () => {
    const { adapter, socket } = fixture();
    expect(await adapter.createCommunityGroup(PARENT, "New", [MEMBER])).toMatchObject({
      status: "created",
      group: { linkedParent: PARENT },
      retrySafe: false,
    });
    socket.communityCreateGroup.mockResolvedValue(null);
    expect(await adapter.createCommunityGroup(PARENT, "New", [])).toMatchObject({
      status: "unknown",
      group: null,
      retrySafe: false,
    });
    expect(socket.communityCreateGroup).toHaveBeenCalledTimes(2);
  });
  it("retains the created group ID if local enrichment fails", async () => {
    const { adapter, socket } = fixture();
    Object.assign(adapter, {
      groupMemberLabelStore: {
        getForGroup: () => {
          throw new Error("local database failure");
        },
      },
    });
    expect(await adapter.createCommunityGroup(PARENT, "New", [])).toEqual({
      status: "created",
      groupId: GROUP,
      group: null,
      retrySafe: false,
    });
    expect(socket.communityCreateGroup).toHaveBeenCalledOnce();
  });
  it("reports mixed and missing acknowledgements without leaking protocol content", async () => {
    const { adapter, socket } = fixture();
    socket.communityParticipantsUpdate.mockResolvedValue([
      { jid: MEMBER, status: "403", content: { invite: "SECRET" } } as never,
    ]);
    const result = await adapter.updateCommunityParticipants(PARENT, [MEMBER, OWNER], "add");
    expect(result).toEqual({
      status: "partial",
      results: [
        { participant: MEMBER, returnedJid: MEMBER, status: "403", success: false },
        { participant: OWNER, returnedJid: null, status: null, success: null },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    socket.communityParticipantsUpdate.mockResolvedValue([]);
    expect((await adapter.updateCommunityParticipants(PARENT, [MEMBER], "add")).status).toBe(
      "unknown",
    );
  });
  it("requires confirmation of cascading removal and protects the owner", async () => {
    const { adapter, socket } = fixture();
    await expect(adapter.updateCommunityParticipants(PARENT, [MEMBER], "remove")).rejects.toThrow(
      "linked groups",
    );
    await expect(
      adapter.updateCommunityParticipants(PARENT, [OWNER], "remove", true),
    ).rejects.toThrow("owner/superadmin");
    await expect(adapter.updateCommunityParticipants(PARENT, [OWNER], "demote")).rejects.toThrow(
      "owner/superadmin",
    );
    expect(socket.communityParticipantsUpdate).not.toHaveBeenCalled();
    expect(
      (await adapter.updateCommunityParticipants(PARENT, [MEMBER, MEMBER], "remove", true)).status,
    ).toBe("success");
    expect(socket.communityParticipantsUpdate).toHaveBeenCalledWith(PARENT, [MEMBER], "remove");
  });
  it("returns scoped members and refuses unrelated groups", async () => {
    const { adapter, group } = fixture();
    expect((await adapter.getCommunityMembers(PARENT, "community")).jid).toBe(PARENT);
    expect((await adapter.getCommunityMembers(PARENT, "announcements")).jid).toBe(AVISOS);
    await expect(adapter.getCommunityMembers(PARENT, "group", GROUP)).rejects.toThrow("not linked");
    group.linkedParent = PARENT;
    expect((await adapter.getCommunityMembers(PARENT, "group", GROUP)).jid).toBe(GROUP);
  });
  it("lists sanitized requests and preserves approval/rejection failures", async () => {
    const { adapter, socket } = fixture();
    expect(await adapter.listCommunityJoinRequests(PARENT)).toEqual([
      { participant: MEMBER, requestedAt: "1700000000" },
    ]);
    socket.communityRequestParticipantsUpdate.mockResolvedValue([{ jid: MEMBER, status: "404" }]);
    expect((await adapter.handleCommunityJoinRequests(PARENT, [MEMBER], "reject")).status).toBe(
      "failed",
    );
  });
  it("supports invite reads with writes off but not resets", async () => {
    vi.stubEnv("WA_GROUP_WRITES_ENABLED", "false");
    const { adapter } = fixture();
    expect(await adapter.getCommunityInviteCode(PARENT)).toBe("FixtureCode");
    expect(
      (await adapter.getCommunityInviteInfo("https://chat.whatsapp.com/FixtureCode")).jid,
    ).toBe(PARENT);
    await expect(adapter.getCommunityInviteCode(PARENT, true)).rejects.toThrow(
      "writes are disabled",
    );
  });
  it("does not report missing invitation results as success", async () => {
    const { adapter, socket } = fixture();
    socket.communityRevokeInvite.mockResolvedValue(undefined);
    await expect(adapter.getCommunityInviteCode(PARENT, true)).rejects.toThrow(
      "may have been reset",
    );
    socket.groupAcceptInvite.mockResolvedValue(undefined);
    expect(await adapter.joinCommunity("FixtureCode")).toEqual({
      communityId: null,
      status: "unknown",
      retrySafe: false,
    });
    socket.groupGetInviteInfo.mockResolvedValue(metadata(GROUP));
    await expect(adapter.joinCommunity("FixtureCode")).rejects.toThrow("could not be verified");
    expect(socket.groupAcceptInvite).toHaveBeenCalledOnce();
    await expect(adapter.getCommunityInviteInfo("https://evil.example/invite")).rejects.toThrow();
  });
  it("only reports joined when membership is confirmed, not merely an invitation acknowledgement", async () => {
    const { adapter, parent, socket } = fixture();
    expect((await adapter.joinCommunity("FixtureCode")).status).toBe("joined");
    parent.participants = [];
    expect(await adapter.joinCommunity("FixtureCode")).toEqual({
      communityId: PARENT,
      status: "unknown",
      retrySafe: false,
    });
    expect(socket.groupAcceptInvite).toHaveBeenCalledTimes(2);
  });
  it("accepts V4 invitations only before expiry and for the verified parent", async () => {
    const { adapter, socket } = fixture();
    const invite = {
      communityId: PARENT,
      inviter: OWNER,
      inviteCode: "FixtureCode",
      inviteExpiration: 4102444800,
    };
    expect((await adapter.joinCommunityV4(invite)).status).toBe("joined");
    expect(socket.communityAcceptInviteV4).toHaveBeenCalledWith(OWNER, {
      groupJid: PARENT,
      inviteCode: "FixtureCode",
      inviteExpiration: 4102444800,
    });
    await expect(adapter.joinCommunityV4({ ...invite, inviteExpiration: 1 })).rejects.toThrow(
      "expired",
    );
    await expect(adapter.joinCommunityV4({ ...invite, communityId: OTHER })).rejects.toThrow(
      "different community",
    );
    expect(socket.communityAcceptInviteV4).toHaveBeenCalledOnce();
  });
  it("rejects unsafe links/unlinks and never unlinks Avisos", async () => {
    const { adapter, group, socket } = fixture();
    await adapter.linkGroupToCommunity(GROUP, PARENT);
    await expect(adapter.linkGroupToCommunity(GROUP, PARENT)).rejects.toThrow("unlinked ordinary");
    await expect(adapter.unlinkGroupFromCommunity(AVISOS, PARENT)).rejects.toThrow("Avisos cannot");
    group.linkedParent = OTHER;
    await expect(adapter.unlinkGroupFromCommunity(GROUP, PARENT)).rejects.toThrow(
      "ordinary subgroup",
    );
    group.linkedParent = PARENT;
    await adapter.unlinkGroupFromCommunity(GROUP, PARENT);
    expect(socket.communityUnlinkGroup).toHaveBeenCalledOnce();
  });
  it("applies exactly one setting using the community API", async () => {
    const { adapter, socket } = fixture();
    await adapter.updateCommunitySetting(PARENT, { setting: "edit_info", value: "admins" });
    await adapter.updateCommunitySetting(PARENT, { setting: "send_messages", value: "all" });
    await adapter.updateCommunitySetting(PARENT, { setting: "add_members", value: "all" });
    await adapter.updateCommunitySetting(PARENT, { setting: "join_approval", value: "on" });
    await adapter.updateCommunitySetting(PARENT, {
      setting: "disappearing_messages",
      value: 86400,
    });
    expect(socket.communitySettingUpdate.mock.calls).toEqual([
      [PARENT, "locked"],
      [PARENT, "not_announcement"],
    ]);
    expect(socket.communityMemberAddMode).toHaveBeenCalledWith(PARENT, "all_member_add");
    expect(socket.communityJoinApprovalMode).toHaveBeenCalledWith(PARENT, "on");
    expect(socket.communityToggleEphemeral).toHaveBeenCalledWith(PARENT, 86400);
  });
  it("rejects invalid setting/value pairs, member scope and unconfirmed removal", () => {
    const base = { instanceId: INSTANCE, communityId: PARENT };
    expect(
      CommunitySettingSchema.safeParse({
        ...base,
        change: { setting: "join_approval", value: "all" },
      }).success,
    ).toBe(false);
    expect(
      CommunitySettingSchema.safeParse({
        ...base,
        change: { setting: "disappearing_messages", value: 99 },
      }).success,
    ).toBe(false);
    expect(CommunityMembersSchema.safeParse({ ...base, scope: "group" }).success).toBe(false);
    expect(
      CommunityMembersSchema.safeParse({ ...base, scope: "community", groupId: GROUP }).success,
    ).toBe(false);
    expect(
      CommunityParticipantsSchema.safeParse({ ...base, action: "remove", participants: [MEMBER] })
        .success,
    ).toBe(false);
  });
  it("keeps unrelated not-found errors distinct from instance lifecycle errors", () => {
    expect(
      JSON.stringify(handleToolError("test", new Error("Group not found"), INSTANCE)),
    ).not.toContain("wa_create_instance");
    expect(
      JSON.stringify(handleToolError("test", new InstanceNotFoundError(INSTANCE), INSTANCE)),
    ).toContain("wa_create_instance");
    expect(
      JSON.stringify(handleToolError("test", new InstanceNotInitializedError(INSTANCE), INSTANCE)),
    ).toContain("wa_connect_instance");
  });
  it("forwards hierarchy and membership events to webhooks without invitation secrets", () => {
    const [event] = normalizeGroupsUpdate(INSTANCE, [
      { id: PARENT, isCommunity: true, inviteCode: "SECRET", subject: "Updated" },
    ]);
    const body = normalizeEventWebhookPayload("group.updated", INSTANCE, event!);
    expect(body).toMatchObject({ groupChanges: { isCommunity: true, subject: "Updated" } });
    expect(JSON.stringify(body)).not.toContain("SECRET");
    expect(
      normalizeEventWebhookPayload("group.participants_changed", INSTANCE, {
        instanceId: INSTANCE,
        groupId: PARENT,
        action: "promote",
        participants: [MEMBER],
      }),
    ).toMatchObject({ participants: [MEMBER], type: "promote" });
  });
  it("emits one group snapshot per batch and forwards join requests", async () => {
    const { adapter, socket, parent } = fixture();
    let processEvents: ((events: Partial<BaileysEventMap>) => Promise<void>) | undefined;
    Object.assign(socket, {
      ev: {
        on: vi.fn(),
        process: (handler: typeof processEvents) => {
          processEvents = handler;
        },
      },
    });
    (adapter as unknown as { bindEvents(sock: WASocket): void }).bindEvents(
      socket as unknown as WASocket,
    );
    const updated = vi.fn();
    const requested = vi.fn();
    adapter.on("group.updated", updated);
    adapter.on("group.join_request", requested);
    await processEvents!({
      "groups.upsert": [parent],
      "groups.update": [{ id: PARENT, subject: "New", inviteCode: "SECRET" }],
      "group.join-request": {
        id: PARENT,
        author: SELF,
        participant: MEMBER,
        action: "created",
        method: "invite_link",
      },
    });
    await processEvents!({ "groups.update": [{ id: PARENT, subject: "New" }] });
    expect(updated).toHaveBeenCalledOnce();
    expect(JSON.stringify(updated.mock.calls)).not.toContain("SECRET");
    expect(requested).toHaveBeenCalledWith({
      instanceId: INSTANCE,
      groupId: PARENT,
      participant: MEMBER,
      action: "created",
      method: "invite_link",
    });
  });
  it("registers strict community tools and routes announcement media to the queue over MCP", async () => {
    const { adapter } = fixture();
    const enqueue = vi.fn(async () => ({ status: "queued", jobId: "synthetic-job", to: AVISOS }));
    const server = new McpServer({ name: "community", version: "1" });
    registerCommunityTools(
      server,
      { getAdapter: () => adapter } as unknown as InstanceManager,
      { enqueueCommunityAnnouncement: enqueue } as unknown as MessageQueue,
    );
    const client = new Client({ name: "test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(16);
      for (const tool of listed.tools) expect(tool.inputSchema.additionalProperties).toBe(false);
      const invalid = await client.callTool({
        name: "wa_community_update_settings",
        arguments: {
          instanceId: INSTANCE,
          communityId: PARENT,
          change: { setting: "edit_info", value: "on" },
        },
      });
      expect(invalid.isError).toBe(true);
      const sent = await client.callTool({
        name: "wa_community_send_announcement",
        arguments: {
          instanceId: INSTANCE,
          communityId: PARENT,
          content: {
            type: "image",
            image: "aW1hZ2U=",
            caption: "Notice",
            quotedMessageId: "original",
          },
        },
      });
      expect(sent.isError).not.toBe(true);
      expect(enqueue).toHaveBeenCalledWith(INSTANCE, PARENT, {
        type: "image",
        image: "aW1hZ2U=",
        caption: "Notice",
        quotedMessageId: "original",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("rejects new management operations on Cloud API", async () => {
    const cloud = new CloudApiAdapter(INSTANCE);
    await expect(cloud.updateCommunityName(PARENT, "New")).rejects.toThrow(
      "not supported on Cloud API",
    );
    await expect(cloud.getCommunityMembers(PARENT, "community")).rejects.toThrow(
      "not supported on Cloud API",
    );
    await expect(cloud.resolveCommunityAnnouncementGroup(PARENT, true)).rejects.toThrow(
      "not supported on Cloud API",
    );
  });
});
