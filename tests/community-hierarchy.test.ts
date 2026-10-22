import { extractGroupMetadata } from "@whiskeysockets/baileys/lib/Socket/groups.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupMetadata, WASocket } from "@whiskeysockets/baileys";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { GroupMemberLabelStore } from "../src/services/group-member-label-store.js";
import { registerBusinessTools } from "../src/tools/business.tools.js";

const PARENT = "120363000000000000@g.us";
const ANNOUNCEMENTS = "120363000000000001@g.us";
const REGULAR = "120363000000000002@g.us";
const NOT_JOINED = "120363000000000003@g.us";
const INSTANCE = "community-fixture";

function metadata(id: string, extra: Partial<GroupMetadata> = {}): GroupMetadata {
  return { id, subject: "Fixture", owner: undefined, participants: [], ...extra };
}

function fixture() {
  const parent = metadata(PARENT, { isCommunity: true });
  const linkedGroups: Awaited<ReturnType<WASocket["communityFetchLinkedGroups"]>>["linkedGroups"] =
    [ANNOUNCEMENTS, REGULAR, NOT_JOINED].map((id) => ({
      id,
      subject: "Fixture",
      creation: undefined,
      owner: undefined,
      size: undefined,
    }));
  const known: Record<string, GroupMetadata> = {
    [PARENT]: parent,
    [ANNOUNCEMENTS]: metadata(ANNOUNCEMENTS, {
      linkedParent: PARENT,
      isCommunityAnnounce: true,
    }),
    // An admin-only group must never be mistaken for Avisos.
    [REGULAR]: metadata(REGULAR, {
      linkedParent: PARENT,
      announce: true,
      isCommunityAnnounce: false,
    }),
  };
  const socket = {
    groupMetadata: vi.fn(async () => parent),
    communityMetadata: vi.fn(async () => parent),
    communityFetchAllParticipating: vi.fn(async () => ({ [PARENT]: parent })),
    communityFetchLinkedGroups: vi.fn(async () => ({
      communityJid: PARENT,
      isCommunity: true,
      linkedGroups,
    })),
    groupFetchAllParticipating: vi.fn(async () => known),
  };
  const labelStore = { getForGroup: () => [] } as unknown as GroupMemberLabelStore;
  const adapter = new BaileysAdapter(INSTANCE, undefined, labelStore);
  Object.assign(adapter, { sock: socket as unknown as WASocket, status: "connected" });
  return { adapter, socket, parent, known, linkedGroups };
}

beforeEach(() => {
  vi.stubEnv("WA_GROUP_WRITES_ENABLED", "false");
  vi.stubEnv("WA_APP_STATE_WRITES_ENABLED", "false");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("community hierarchy", () => {
  it("discovers communities from the native standard group parser without treating Avisos as a parent", async () => {
    const { adapter, socket } = fixture();
    const parse = (id: string, marker: string) =>
      extractGroupMetadata({
        tag: "result",
        attrs: {},
        content: [
          {
            tag: "group",
            attrs: { id, subject: "Fixture" },
            content: [{ tag: marker, attrs: {} }],
          },
        ],
      });
    socket.groupFetchAllParticipating.mockResolvedValue({
      [PARENT]: parse(PARENT, "parent"),
      [ANNOUNCEMENTS]: parse(ANNOUNCEMENTS, "default_sub_group"),
      [REGULAR]: parse(REGULAR, "announcement"),
    });
    expect(Object.keys(await adapter.listCommunities())).toEqual([PARENT]);
    expect(socket.communityFetchAllParticipating).not.toHaveBeenCalled();
  });

  it("reads the hierarchy with writes disabled, retaining non-participating groups and unknowns", async () => {
    const { adapter, socket } = fixture();
    const result = await adapter.getCommunityHierarchy(PARENT.split("@")[0]!);
    expect(socket.groupMetadata).toHaveBeenCalledWith(PARENT);
    expect(socket.communityFetchLinkedGroups).toHaveBeenCalledWith(PARENT);
    expect(socket.groupFetchAllParticipating).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      community: { jid: PARENT, isCommunity: true },
      groups: [
        { jid: ANNOUNCEMENTS, isCommunityAnnounce: true },
        { jid: REGULAR, isCommunityAnnounce: false },
        { jid: NOT_JOINED, isCommunityAnnounce: null, size: null, creation: null },
      ],
      announcementGroupJid: ANNOUNCEMENTS,
      announcementResolution: "identified",
      visibility: "server_visible",
      unresolvedGroupJids: [NOT_JOINED],
      omittedGroupCount: 0,
    });
  });

  it("preserves community fields through existing detail, list, and group reads", async () => {
    const { adapter, parent } = fixture();
    Object.assign(parent, {
      isCommunityAnnounce: false,
      joinApprovalMode: true,
      memberAddMode: false,
    });
    for (const result of [
      await adapter.getCommunityMetadata(PARENT),
      (await adapter.listCommunities())[PARENT],
      await adapter.getGroupMetadata(PARENT),
    ]) {
      expect(result).toMatchObject({
        isCommunity: true,
        isCommunityAnnounce: false,
        linkedParent: null,
        joinApprovalMode: true,
        memberAddMode: false,
      });
    }
    delete parent.isCommunity;
    expect(await adapter.getGroupMetadata(PARENT)).toMatchObject({ isCommunity: null });
  });

  it.each([false, undefined])("rejects an unverified parent marker (%s)", async (isCommunity) => {
    const { adapter, parent, socket } = fixture();
    parent.isCommunity = isCommunity;
    await expect(adapter.getCommunityHierarchy(PARENT)).rejects.toThrow("could not be verified");
    expect(socket.communityFetchLinkedGroups).not.toHaveBeenCalled();
  });

  it("rejects a subgroup without silently switching to its parent", async () => {
    const { adapter, parent, socket } = fixture();
    parent.linkedParent = REGULAR;
    await expect(adapter.getCommunityHierarchy(PARENT)).rejects.toThrow("could not be verified");
    expect(socket.communityFetchLinkedGroups).not.toHaveBeenCalled();
  });

  it("rejects a mismatched parent returned by WhatsApp", async () => {
    const { adapter, socket } = fixture();
    socket.communityFetchLinkedGroups.mockResolvedValue({
      communityJid: REGULAR,
      isCommunity: true,
      linkedGroups: [],
    });
    await expect(adapter.getCommunityHierarchy(PARENT)).rejects.toThrow("different community");
    expect(socket.groupFetchAllParticipating).not.toHaveBeenCalled();
  });

  it("does not infer Avisos from a name, announce flag, or conflicting parent", async () => {
    const { adapter, known, linkedGroups } = fixture();
    known[ANNOUNCEMENTS]!.linkedParent = NOT_JOINED;
    linkedGroups[1]!.subject = "Avisos";
    const result = await adapter.getCommunityHierarchy(PARENT);
    expect(result.announcementGroupJid).toBeNull();
    expect(result.announcementResolution).toBe("unavailable");
    expect(result.unresolvedGroupJids).toEqual([ANNOUNCEMENTS, NOT_JOINED]);
  });

  it("returns no send destination when multiple announcement groups are reported", async () => {
    const { adapter, known } = fixture();
    known[REGULAR]!.isCommunityAnnounce = true;
    const result = await adapter.getCommunityHierarchy(PARENT);
    expect(result.announcementGroupJid).toBeNull();
    expect(result.announcementResolution).toBe("ambiguous");
  });

  it("deduplicates IDs and reports unusable entries instead of creating invalid destinations", async () => {
    const { adapter, linkedGroups } = fixture();
    linkedGroups.push(
      { ...linkedGroups[0]! },
      { ...linkedGroups[0]!, id: undefined },
      { ...linkedGroups[0]!, id: "123@newsletter" },
      { ...linkedGroups[0]!, id: PARENT },
    );
    const result = await adapter.getCommunityHierarchy(PARENT);
    expect(result.groups).toHaveLength(3);
    expect(result.omittedGroupCount).toBe(3);
  });

  it("distinguishes an empty visible list from an upstream failure", async () => {
    const { adapter, linkedGroups, socket } = fixture();
    linkedGroups.length = 0;
    expect(await adapter.getCommunityHierarchy(PARENT)).toMatchObject({
      groups: [],
      announcementGroupJid: null,
      announcementResolution: "unavailable",
    });
    socket.communityFetchLinkedGroups.mockRejectedValue(new Error("Permission denied"));
    await expect(adapter.getCommunityHierarchy(PARENT)).rejects.toThrow("Permission denied");
  });

  it("rejects invalid IDs before making socket queries", async () => {
    const { adapter, socket } = fixture();
    await expect(adapter.getCommunityHierarchy("123@s.whatsapp.net")).rejects.toThrow("Invalid");
    expect(socket.groupMetadata).not.toHaveBeenCalled();
  });

  it("explicitly rejects Cloud API", async () => {
    await expect(new CloudApiAdapter(INSTANCE).getCommunityHierarchy(PARENT)).rejects.toThrow(
      "not supported on Cloud API",
    );
  });

  it("advertises and enforces strict inputs over the actual MCP transport", async () => {
    const { adapter, socket } = fixture();
    const server = new McpServer({ name: "community-test", version: "1.0.0" });
    registerBusinessTools(server, { getAdapter: () => adapter } as unknown as InstanceManager);
    const client = new Client({ name: "community-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      expect(
        tools.find((tool) => tool.name === "wa_get_community_hierarchy")?.inputSchema,
      ).toMatchObject({ additionalProperties: false });
      const invalid = await client.callTool({
        name: "wa_get_community_hierarchy",
        arguments: { instanceId: INSTANCE, communityId: PARENT, unexpected: true },
      });
      expect(invalid.isError).toBe(true);
      expect(socket.groupMetadata).not.toHaveBeenCalled();
      const result = await client.callTool({
        name: "wa_get_community_hierarchy",
        arguments: { instanceId: INSTANCE, communityId: PARENT },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining(ANNOUNCEMENTS) }),
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
