import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GroupParticipant as BaileysGroupParticipant,
  WASocket,
} from "@whiskeysockets/baileys";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import type { ContactStore } from "../src/services/contact-store.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import { registerGroupTools } from "../src/tools/group.tools.js";

type RegisteredTool = {
  inputSchema: z.ZodType;
  handler: (params: unknown) => Promise<unknown>;
};

type ToolResult = { isError?: boolean; content: Array<{ text?: string }> };

const INSTANCE_ID = "synthetic-group-copy";
const SOURCE_GROUP_ID = "120363000000000001@g.us";
const CREATED_GROUP_ID = "120363000000000002@g.us";
const OWN_PN = "5511888000001@s.whatsapp.net";
const OWN_LID = "1888000001@lid";
const MEMBER_ONE_PN = "5511888000002@s.whatsapp.net";
const MEMBER_ONE_LID = "1888000002@lid";
const MEMBER_TWO_PN = "5511888000003@s.whatsapp.net";
const initialAppStateWritesEnabled = process.env.WA_APP_STATE_WRITES_ENABLED;
const initialGroupWritesEnabled = process.env.WA_GROUP_WRITES_ENABLED;

beforeEach(() => {
  process.env.WA_APP_STATE_WRITES_ENABLED = "false";
  process.env.WA_GROUP_WRITES_ENABLED = "true";
});

afterEach(() => {
  vi.restoreAllMocks();
  if (initialAppStateWritesEnabled === undefined) delete process.env.WA_APP_STATE_WRITES_ENABLED;
  else process.env.WA_APP_STATE_WRITES_ENABLED = initialAppStateWritesEnabled;
  if (initialGroupWritesEnabled === undefined) delete process.env.WA_GROUP_WRITES_ENABLED;
  else process.env.WA_GROUP_WRITES_ENABLED = initialGroupWritesEnabled;
});

function participant(
  id: string,
  fields: Partial<BaileysGroupParticipant> = {},
): BaileysGroupParticipant {
  return { id, ...fields } as BaileysGroupParticipant;
}

function createAdapter(
  sourceParticipants: BaileysGroupParticipant[],
  options: {
    groupMetadataError?: Error;
    createdParticipants?: BaileysGroupParticipant[];
  } = {},
) {
  const contactStore = { getContacts: vi.fn(() => []) } as unknown as ContactStore;
  const adapter = new BaileysAdapter(INSTANCE_ID, contactStore);
  const pnByLid = new Map([
    [OWN_LID, OWN_PN],
    [MEMBER_ONE_LID, MEMBER_ONE_PN],
  ]);
  const lidByPn = new Map([...pnByLid].map(([lid, pn]) => [pn, lid]));
  const groupMetadata = vi.fn(async () => {
    if (options.groupMetadataError) throw options.groupMetadataError;
    return {
      id: SOURCE_GROUP_ID,
      subject: "Synthetic source",
      participants: sourceParticipants,
    };
  });
  const groupCreate = vi.fn(async (_name: string, jids: string[]) => ({
    id: CREATED_GROUP_ID,
    subject: "Synthetic destination",
    participants: options.createdParticipants ?? jids.map((id) => participant(id)),
  }));
  const sock = {
    user: { id: OWN_PN, lid: OWN_LID },
    signalRepository: {
      lidMapping: {
        getPNForLID: vi.fn(async (lid: string) => pnByLid.get(lid) ?? null),
        getLIDForPN: vi.fn(async (pn: string) => lidByPn.get(pn) ?? null),
      },
    },
    groupMetadata,
    groupCreate,
  } as unknown as WASocket;
  Object.assign(adapter, { sock, status: "connected" });
  return { adapter, sock, groupMetadata, groupCreate };
}

function registerTool(adapter: BaileysAdapter): RegisteredTool {
  let registeredTool: RegisteredTool | undefined;
  const server = {
    registerTool: (name: string, options: unknown, handler: unknown) => {
      if (name !== "wa_create_group_from_group") return;
      registeredTool = {
        inputSchema: (options as { inputSchema: z.ZodType }).inputSchema,
        handler: handler as (params: unknown) => Promise<unknown>,
      };
    },
  } as unknown as McpServer;
  const instanceManager = { getAdapter: () => adapter } as unknown as InstanceManager;
  registerGroupTools(server, instanceManager, {} as MessageQueue);
  if (!registeredTool) throw new Error("Create group from group tool was not registered");
  return registeredTool;
}

async function invoke(tool: RegisteredTool, params: unknown): Promise<ToolResult> {
  return (await tool.handler(tool.inputSchema.parse(params))) as ToolResult;
}

function responseData(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("wa_create_group_from_group", () => {
  it("applies include and exclude filters across PN and LID identities", async () => {
    const { adapter, groupCreate, groupMetadata } = createAdapter(
      [
        participant(MEMBER_ONE_LID, { phoneNumber: MEMBER_ONE_PN }),
        participant(MEMBER_ONE_PN),
        participant(MEMBER_TWO_PN),
        participant(OWN_LID, { phoneNumber: OWN_PN }),
      ],
      { createdParticipants: [participant(MEMBER_TWO_PN)] },
    );
    const result = await invoke(registerTool(adapter), {
      instanceId: INSTANCE_ID,
      sourceGroupId: SOURCE_GROUP_ID,
      name: "Synthetic destination",
      includeParticipants: [MEMBER_ONE_PN, MEMBER_TWO_PN],
      excludeParticipants: [MEMBER_ONE_LID],
    });

    expect(groupMetadata).toHaveBeenCalledWith(SOURCE_GROUP_ID);
    expect(groupCreate).toHaveBeenCalledWith("Synthetic destination", [MEMBER_TWO_PN]);
    expect(result.isError).not.toBe(true);
    expect(responseData(result)).toEqual({
      groupId: CREATED_GROUP_ID,
      addedCount: 1,
      failedParticipants: [],
    });
  });

  it("removes the connected account and deduplicates source member identities", async () => {
    const { adapter, groupCreate } = createAdapter([
      participant(MEMBER_ONE_LID, { phoneNumber: MEMBER_ONE_PN }),
      participant(MEMBER_ONE_PN),
      participant(MEMBER_TWO_PN),
      participant(OWN_LID, { phoneNumber: OWN_PN }),
      participant(OWN_PN),
    ]);

    const result = await invoke(registerTool(adapter), {
      instanceId: INSTANCE_ID,
      sourceGroupId: SOURCE_GROUP_ID,
      name: "Synthetic destination",
    });

    expect(groupCreate).toHaveBeenCalledOnce();
    expect(groupCreate).toHaveBeenCalledWith("Synthetic destination", [
      MEMBER_ONE_PN,
      MEMBER_TWO_PN,
    ]);
    expect(result.isError).not.toBe(true);
    expect(responseData(result)).toMatchObject({ addedCount: 2, failedParticipants: [] });
  });

  it("blocks creation while group writes are disabled", async () => {
    delete process.env.WA_APP_STATE_WRITES_ENABLED;
    delete process.env.WA_GROUP_WRITES_ENABLED;
    const { adapter, groupMetadata, groupCreate } = createAdapter([participant(MEMBER_ONE_PN)]);

    const result = await invoke(registerTool(adapter), {
      instanceId: INSTANCE_ID,
      sourceGroupId: SOURCE_GROUP_ID,
      name: "Synthetic destination",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("WA_GROUP_WRITES_ENABLED=true");
    expect(groupMetadata).not.toHaveBeenCalled();
    expect(groupCreate).not.toHaveBeenCalled();
  });

  it("returns a clear error when the source group cannot be found", async () => {
    const { adapter, groupMetadata, groupCreate } = createAdapter([], {
      groupMetadataError: new Error("Group not found"),
    });

    const result = await invoke(registerTool(adapter), {
      instanceId: INSTANCE_ID,
      sourceGroupId: SOURCE_GROUP_ID,
      name: "Synthetic destination",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Source group does not exist");
    expect(groupMetadata).toHaveBeenCalledOnce();
    expect(groupCreate).not.toHaveBeenCalled();
  });

  it("rejects a selection with no resulting participants", async () => {
    const { adapter, groupCreate } = createAdapter([participant(MEMBER_ONE_PN)]);

    const result = await invoke(registerTool(adapter), {
      instanceId: INSTANCE_ID,
      sourceGroupId: SOURCE_GROUP_ID,
      name: "Synthetic destination",
      excludeParticipants: [MEMBER_ONE_PN],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("no source participants remain");
    expect(groupCreate).not.toHaveBeenCalled();
  });

  it("reports requested participants missing from Baileys' returned metadata", async () => {
    const { adapter } = createAdapter([participant(MEMBER_ONE_PN), participant(MEMBER_TWO_PN)], {
      createdParticipants: [participant(MEMBER_ONE_PN)],
    });

    const result = await invoke(registerTool(adapter), {
      instanceId: INSTANCE_ID,
      sourceGroupId: SOURCE_GROUP_ID,
      name: "Synthetic destination",
    });

    expect(responseData(result)).toEqual({
      groupId: CREATED_GROUP_ID,
      addedCount: 1,
      failedParticipants: [MEMBER_TWO_PN],
    });
  });

  it("enforces WhatsApp's member limit including the connected account", async () => {
    const members = Array.from({ length: 1024 }, (_, index) =>
      participant(`551100${String(index).padStart(8, "0")}@s.whatsapp.net`),
    );
    const { adapter, groupCreate } = createAdapter(members);

    const result = await invoke(registerTool(adapter), {
      instanceId: INSTANCE_ID,
      sourceGroupId: SOURCE_GROUP_ID,
      name: "Synthetic destination",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("more than 1023 participants");
    expect(groupCreate).not.toHaveBeenCalled();
  });
});
