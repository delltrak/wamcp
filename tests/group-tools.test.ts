import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GroupParticipant as BaileysGroupParticipant,
  WASocket,
} from "@whiskeysockets/baileys";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import type { ContactStore } from "../src/services/contact-store.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import { MediaService } from "../src/services/media.js";
import { GetGroupInfoSchema, UpdateGroupPictureSchema } from "../src/schemas/group.schema.js";
import { registerGroupTools } from "../src/tools/group.tools.js";

type RegisteredTool = {
  inputSchema: z.ZodType;
  handler: (params: unknown) => Promise<unknown>;
};

type ToolResult = {
  isError?: boolean;
  content: Array<{ text?: string }>;
};

const OWN_PN = "5511999990000@s.whatsapp.net";
const OWN_LID = "1999990000@lid";
const GROUP_JID = "120363000000000000@g.us";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createAdapter(overrides: Record<string, unknown> = {}) {
  const contactStore = { getContacts: vi.fn(() => []) } as unknown as ContactStore;
  const adapter = new BaileysAdapter("group-test", contactStore);
  const sock = {
    user: { id: OWN_PN, lid: OWN_LID },
    signalRepository: {
      lidMapping: {
        getPNForLID: vi.fn(async (lid: string) =>
          lid === OWN_LID ? OWN_PN : "5511888880000@s.whatsapp.net",
        ),
      },
    },
    ...overrides,
  } as unknown as WASocket;
  Object.assign(adapter, { sock, status: "connected" });
  return { adapter, sock };
}

function registerTools(adapter: BaileysAdapter | CloudApiAdapter): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, options: unknown, handler: unknown) => {
      tools.set(name, {
        inputSchema: (options as { inputSchema: z.ZodType }).inputSchema,
        handler: handler as (params: unknown) => Promise<unknown>,
      });
    },
  } as unknown as McpServer;
  const instanceManager = { getAdapter: () => adapter } as unknown as InstanceManager;
  registerGroupTools(server, instanceManager, {} as MessageQueue);
  return tools;
}

async function invoke(tool: RegisteredTool, params: unknown): Promise<ToolResult> {
  return (await tool.handler(tool.inputSchema.parse(params))) as ToolResult;
}

function groupMetadata(participants: BaileysGroupParticipant[]) {
  return {
    id: GROUP_JID,
    subject: "Support group",
    desc: "Customer support",
    owner: OWN_PN,
    creation: 1_700_000_000,
    announce: true,
    restrict: false,
    ephemeralDuration: 86_400,
    participants,
  };
}

describe("WhatsApp group tools", () => {
  it("lists groups in stable name order and detects own PN and LID admin roles", async () => {
    const groupFetchAllParticipating = vi.fn(async () => ({
      "z-group@g.us": {
        id: "z-group@g.us",
        subject: "Zulu",
        desc: null,
        participants: [{ id: OWN_PN, admin: "admin" }],
      },
      "a-group@g.us": {
        id: "a-group@g.us",
        subject: "alpha",
        desc: "First group",
        participants: [
          { id: OWN_LID, admin: "superadmin" },
          { id: "5511888880000@s.whatsapp.net" },
        ],
      },
      "m-group@g.us": {
        id: "m-group@g.us",
        subject: "Mike",
        desc: null,
        participants: [{ id: "5511777770000@s.whatsapp.net" }],
      },
    }));
    const { adapter } = createAdapter({ groupFetchAllParticipating });
    const tool = registerTools(adapter).get("wa_list_groups");
    if (!tool) throw new Error("List groups tool was not registered");
    const response = await invoke(tool, { instanceId: "group-test" });
    const groups = JSON.parse(response.content[0]?.text ?? "[]") as Array<{
      subject: string;
      jid: string;
      description: string | null;
      participantCount: number;
      isAdmin: boolean;
      isSuperAdmin: boolean;
    }>;

    expect(groups.map((group) => group.subject)).toEqual(["alpha", "Mike", "Zulu"]);
    expect(groups[0]).toMatchObject({
      jid: "a-group@g.us",
      description: "First group",
      participantCount: 2,
      isAdmin: true,
      isSuperAdmin: true,
    });
    expect(groups[2]).toMatchObject({ isAdmin: true, isSuperAdmin: false });
    expect(groups[1]).toMatchObject({ isAdmin: false, isSuperAdmin: false });
    expect(groupFetchAllParticipating).toHaveBeenCalledOnce();
  });

  it("returns metadata, participant roles, and phone numbers resolved from LIDs", async () => {
    const metadata = groupMetadata([
      { id: OWN_PN, admin: "admin" },
      { id: "1999990000@lid", admin: "superadmin" },
      { id: "5511888880000@s.whatsapp.net" },
    ]);
    const groupMetadataCall = vi.fn(async () => metadata);
    const { adapter } = createAdapter({ groupMetadata: groupMetadataCall });

    const tool = registerTools(adapter).get("wa_get_group_info");
    if (!tool) throw new Error("Get group info tool was not registered");
    const response = await invoke(tool, {
      instanceId: "group-test",
      groupId: "120363000000000000",
    });
    const result = JSON.parse(response.content[0]?.text ?? "{}") as Awaited<
      ReturnType<BaileysAdapter["getGroupMetadata"]>
    >;

    expect(groupMetadataCall).toHaveBeenCalledWith(GROUP_JID);
    expect(result).toMatchObject({
      jid: GROUP_JID,
      subject: "Support group",
      description: "Customer support",
      owner: OWN_PN,
      ownerJid: OWN_PN,
      creation: 1_700_000_000,
      createdAt: 1_700_000_000,
      announce: true,
      restrict: false,
      ephemeralDuration: 86_400,
      size: 3,
      participantCount: 3,
    });
    expect(result.participants).toEqual([
      {
        jid: OWN_PN,
        role: "admin",
        phone: "5511999990000",
        isAdmin: true,
        isSuperAdmin: false,
      },
      {
        jid: "1999990000@lid",
        role: "superadmin",
        phone: "5511999990000",
        isAdmin: true,
        isSuperAdmin: true,
      },
      {
        jid: "5511888880000@s.whatsapp.net",
        role: "member",
        phone: "5511888880000",
        isAdmin: false,
        isSuperAdmin: false,
      },
    ]);
  });

  it("updates the picture from URL and base64 input using the converted JPEG", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
    const preparePicture = vi
      .spyOn(MediaService.prototype, "prepareGroupProfilePicture")
      .mockResolvedValue(jpeg);
    const updateProfilePicture = vi.fn(async () => undefined);
    const { adapter } = createAdapter({
      groupMetadata: vi.fn(async () => groupMetadata([{ id: OWN_PN, admin: "admin" }])),
      updateProfilePicture,
    });
    const tools = registerTools(adapter);
    const updateTool = tools.get("wa_group_update_picture");
    if (!updateTool) throw new Error("Group picture tool was not registered");

    for (const image of [
      "https://example.com/group.png",
      Buffer.from("image").toString("base64"),
    ]) {
      const result = await invoke(updateTool, {
        instanceId: "group-test",
        groupId: "120363000000000000",
        image,
      });
      expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({ success: true });
    }

    expect(preparePicture.mock.calls.map(([image]) => image)).toEqual([
      "https://example.com/group.png",
      Buffer.from("image").toString("base64"),
    ]);
    expect(updateProfilePicture).toHaveBeenNthCalledWith(1, GROUP_JID, jpeg);
    expect(updateProfilePicture).toHaveBeenNthCalledWith(2, GROUP_JID, jpeg);
  });

  it("matches an own LID to PN-addressed participants through alternate identities", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
    vi.spyOn(MediaService.prototype, "prepareGroupProfilePicture").mockResolvedValue(jpeg);
    const getPNForLID = vi.fn(async (_lid: string) => null);
    const updateProfilePicture = vi.fn(async () => undefined);
    const participant: BaileysGroupParticipant = {
      id: OWN_PN,
      phoneNumber: OWN_PN,
      lid: OWN_LID,
      admin: "admin",
    };
    const metadata = groupMetadata([participant]);
    const { adapter } = createAdapter({
      user: { id: OWN_LID, lid: OWN_LID },
      signalRepository: { lidMapping: { getPNForLID } },
      groupFetchAllParticipating: vi.fn(async () => ({ [GROUP_JID]: metadata })),
      groupMetadata: vi.fn(async () => metadata),
      updateProfilePicture,
    });

    await expect(adapter.listGroups()).resolves.toMatchObject([{ isAdmin: true }]);
    await expect(adapter.updateGroupPicture(GROUP_JID, "aW1hZ2U=")).resolves.toBeUndefined();

    expect(getPNForLID).toHaveBeenCalledWith(OWN_LID);
    expect(updateProfilePicture).toHaveBeenCalledWith(GROUP_JID, jpeg);
  });

  it("matches an own PN to LID participants through phoneNumber", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
    vi.spyOn(MediaService.prototype, "prepareGroupProfilePicture").mockResolvedValue(jpeg);
    const getPNForLID = vi.fn(async (_lid: string) => null);
    const updateProfilePicture = vi.fn(async () => undefined);
    const metadata = groupMetadata([{ id: OWN_LID, phoneNumber: OWN_PN, admin: "admin" }]);
    const { adapter } = createAdapter({
      user: { id: OWN_PN },
      signalRepository: { lidMapping: { getPNForLID } },
      groupFetchAllParticipating: vi.fn(async () => ({ [GROUP_JID]: metadata })),
      groupMetadata: vi.fn(async () => metadata),
      updateProfilePicture,
    });

    await expect(adapter.listGroups()).resolves.toMatchObject([{ isAdmin: true }]);
    await expect(adapter.getGroupMetadata(GROUP_JID)).resolves.toMatchObject({
      participants: [{ phone: "5511999990000" }],
    });
    await expect(adapter.updateGroupPicture(GROUP_JID, "aW1hZ2U=")).resolves.toBeUndefined();

    expect(getPNForLID).not.toHaveBeenCalled();
    expect(updateProfilePicture).toHaveBeenCalledWith(GROUP_JID, jpeg);
  });

  it("removes the group picture and reports a clear non-admin error", async () => {
    const removeProfilePicture = vi.fn(async () => undefined);
    const { adapter } = createAdapter({
      groupMetadata: vi.fn(async () => groupMetadata([{ id: OWN_PN, admin: "superadmin" }])),
      removeProfilePicture,
    });
    const tools = registerTools(adapter);
    const removeTool = tools.get("wa_group_remove_picture");
    if (!removeTool) throw new Error("Remove group picture tool was not registered");

    const result = await invoke(removeTool, { instanceId: "group-test", groupId: GROUP_JID });
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({ success: true });
    expect(removeProfilePicture).toHaveBeenCalledWith(GROUP_JID);

    const nonAdminUpdatePicture = vi.fn(async () => undefined);
    const nonAdmin = createAdapter({
      groupMetadata: vi.fn(async () => groupMetadata([{ id: OWN_PN }])),
      updateProfilePicture: nonAdminUpdatePicture,
    });
    await expect(nonAdmin.adapter.updateGroupPicture(GROUP_JID, "aW1hZ2U=")).rejects.toThrow(
      "Only a group admin can update this group's picture",
    );
    expect(nonAdminUpdatePicture).not.toHaveBeenCalled();
  });

  it("rejects invalid group IDs and maps missing groups to a clear error", async () => {
    expect(
      GetGroupInfoSchema.safeParse({
        instanceId: "group-test",
        groupId: "5511999990000@s.whatsapp.net",
      }).success,
    ).toBe(false);
    expect(
      UpdateGroupPictureSchema.safeParse({
        instanceId: "group-test",
        groupId: "120363000000000000@newsletter",
        image: "aW1hZ2U=",
      }).success,
    ).toBe(false);

    const groupMetadataCall = vi.fn(async () => {
      throw Object.assign(new Error("item-not-found"), { output: { statusCode: 404 } });
    });
    const { adapter } = createAdapter({ groupMetadata: groupMetadataCall });
    await expect(adapter.removeGroupPicture(GROUP_JID)).rejects.toThrow("Group not found");
    expect(groupMetadataCall).toHaveBeenCalledWith(GROUP_JID);
  });

  it("returns clear unsupported-operation errors on Cloud API", async () => {
    const adapter = new CloudApiAdapter("cloud-groups-test");
    await expect(adapter.listGroups()).rejects.toThrow(
      "Listing groups is not supported on Cloud API",
    );
    await expect(adapter.getGroupMetadata(GROUP_JID)).rejects.toThrow(
      "Group metadata is not supported on Cloud API",
    );
    await expect(adapter.updateGroupPicture(GROUP_JID, "aW1hZ2U=")).rejects.toThrow(
      "Updating a group picture is not supported on Cloud API",
    );
    await expect(adapter.removeGroupPicture(GROUP_JID)).rejects.toThrow(
      "Removing a group picture is not supported on Cloud API",
    );
  });
});
