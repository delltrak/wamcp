import { describe, expect, it, vi } from "vitest";
import type { WASocket } from "@whiskeysockets/baileys";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer as RealMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { normalizePrivacySettings } from "../src/channels/baileys/privacy.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import { UpdatePrivacySchema } from "../src/schemas/profile.schema.js";
import { registerProfileTools } from "../src/tools/profile.tools.js";
import type { PrivacyUpdate } from "../src/types/channel.types.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ text?: string }>;
};

type RegisteredTool = {
  inputSchema: z.ZodType;
  handler: (params: unknown) => Promise<unknown>;
};

function registerTools(adapter: BaileysAdapter | CloudApiAdapter) {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, options: unknown, handler: unknown) => {
      tools.set(name, {
        inputSchema: (options as { inputSchema: z.ZodType }).inputSchema,
        handler: handler as (params: unknown) => Promise<unknown>,
      });
    },
  } as unknown as McpServer;
  const instanceManager = {
    getAdapter: () => adapter,
  } as unknown as InstanceManager;

  registerProfileTools(server, instanceManager, {} as MessageQueue);
  return tools;
}

function makeConnectedAdapter() {
  const socket = {
    fetchPrivacySettings: vi.fn(async () => ({
      last: "contact_blacklist",
      online: "match_last_seen",
      profile: "all",
      status: "contact_blacklist",
      readreceipts: "none",
      groupadd: "all",
      calladd: "known",
    })),
    updateLastSeenPrivacy: vi.fn(async () => {}),
    updateOnlinePrivacy: vi.fn(async () => {}),
    updateProfilePicturePrivacy: vi.fn(async () => {}),
    updateStatusPrivacy: vi.fn(async () => {}),
    updateReadReceiptsPrivacy: vi.fn(async () => {}),
    updateGroupsAddPrivacy: vi.fn(async () => {}),
    updateCallPrivacy: vi.fn(async () => {}),
    updateDefaultDisappearingMode: vi.fn(async () => {}),
  } as unknown as WASocket;
  const adapter = new BaileysAdapter("synthetic-instance");
  Object.assign(adapter as unknown as { sock: WASocket | null; status: string }, {
    sock: socket,
    status: "connected",
  });
  return { adapter, socket };
}

async function callTool(tool: RegisteredTool, input: unknown): Promise<ToolResult> {
  const params = tool.inputSchema.parse(input);
  return (await tool.handler(params)) as ToolResult;
}

describe("Baileys privacy tools", () => {
  it("calls the matching Baileys update method with each accepted value", async () => {
    const { adapter, socket } = makeConnectedAdapter();
    const tools = registerTools(adapter);
    const updateTool = tools.get("wa_update_privacy");
    expect(updateTool).toBeDefined();

    const updates: PrivacyUpdate[] = [
      { setting: "lastSeen", value: "none" },
      { setting: "online", value: "match_last_seen" },
      { setting: "profilePic", value: "contact_blacklist" },
      { setting: "status", value: "contacts" },
      { setting: "readReceipts", value: "none" },
      { setting: "groupAdd", value: "contact_blacklist" },
      { setting: "calls", value: "known" },
      { setting: "defaultDisappearingMode", value: 0 },
      { setting: "defaultDisappearingMode", value: 86400 },
      { setting: "defaultDisappearingMode", value: 604800 },
      { setting: "defaultDisappearingMode", value: 7776000 },
    ];

    for (const update of updates) {
      const result = await callTool(updateTool!, { instanceId: "synthetic-instance", ...update });
      expect(result.isError).toBeUndefined();
    }

    expect(socket.updateLastSeenPrivacy).toHaveBeenCalledWith("none");
    expect(socket.updateOnlinePrivacy).toHaveBeenCalledWith("match_last_seen");
    expect(socket.updateProfilePicturePrivacy).toHaveBeenCalledWith("contact_blacklist");
    expect(socket.updateStatusPrivacy).toHaveBeenCalledWith("contacts");
    expect(socket.updateReadReceiptsPrivacy).toHaveBeenCalledWith("none");
    expect(socket.updateGroupsAddPrivacy).toHaveBeenCalledWith("contact_blacklist");
    expect(socket.updateCallPrivacy).toHaveBeenCalledWith("known");
    expect(socket.updateDefaultDisappearingMode).toHaveBeenNthCalledWith(1, 0);
    expect(socket.updateDefaultDisappearingMode).toHaveBeenNthCalledWith(2, 86400);
    expect(socket.updateDefaultDisappearingMode).toHaveBeenNthCalledWith(3, 604800);
    expect(socket.updateDefaultDisappearingMode).toHaveBeenNthCalledWith(4, 7776000);
  });

  it("normalizes the Baileys privacy dictionary and forwards forceRefresh", async () => {
    const { adapter, socket } = makeConnectedAdapter();
    const tools = registerTools(adapter);
    const getTool = tools.get("wa_get_privacy_settings");

    const result = await callTool(getTool!, { instanceId: "synthetic-instance" });

    expect(socket.fetchPrivacySettings).toHaveBeenCalledWith(true);
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
      lastSeen: "contact_blacklist",
      online: "match_last_seen",
      profilePic: "all",
      status: "contact_blacklist",
      readReceipts: "none",
      groupAdd: "all",
      calls: "known",
    });

    await adapter.getPrivacySettings();
    expect(socket.fetchPrivacySettings).toHaveBeenLastCalledWith(true);
  });

  it("preserves unknown Baileys values and uses defaults only for missing keys", () => {
    expect(
      normalizePrivacySettings({
        last: "future-value",
        online: "new-online-mode",
        status: "new-about-mode",
      }),
    ).toEqual({
      lastSeen: "future-value",
      online: "new-online-mode",
      profilePic: "contacts",
      status: "new-about-mode",
      readReceipts: "all",
      groupAdd: "contacts",
      calls: "all",
    });
  });

  it("rejects values outside each setting's enum and disappearing durations", () => {
    for (const input of [
      { instanceId: "synthetic-instance", setting: "online", value: "contacts" },
      { instanceId: "synthetic-instance", setting: "readReceipts", value: "contacts" },
      { instanceId: "synthetic-instance", setting: "groupAdd", value: "none" },
      { instanceId: "synthetic-instance", setting: "calls", value: "contacts" },
      { instanceId: "synthetic-instance", setting: "calls", value: "none" },
      { instanceId: "synthetic-instance", setting: "defaultDisappearingMode", value: 3600 },
    ]) {
      expect(UpdatePrivacySchema.safeParse(input).success).toBe(false);
    }
  });

  it("advertises the privacy fields and validates combinations over the MCP transport", async () => {
    const { adapter, socket } = makeConnectedAdapter();
    const server = new RealMcpServer({ name: "privacy-test", version: "1.0.0" });
    const instanceManager = {
      getAdapter: () => adapter,
    } as unknown as InstanceManager;
    registerProfileTools(server, instanceManager, {} as MessageQueue);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "privacy-test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const { tools } = await client.listTools();
      const privacyTool = tools.find((tool) => tool.name === "wa_update_privacy");
      expect(privacyTool).toBeDefined();
      expect(privacyTool?.inputSchema.properties).toHaveProperty("instanceId");
      expect(privacyTool?.inputSchema.properties).toHaveProperty("setting");
      expect(privacyTool?.inputSchema.properties).toHaveProperty("value");
      expect(privacyTool?.inputSchema.properties?.setting).toMatchObject({
        enum: [
          "lastSeen",
          "online",
          "profilePic",
          "status",
          "readReceipts",
          "groupAdd",
          "calls",
          "defaultDisappearingMode",
        ],
      });

      const invalid = await client.callTool({
        name: "wa_update_privacy",
        arguments: { instanceId: "synthetic-instance", setting: "calls", value: "none" },
      });
      expect(invalid.isError).toBe(true);
      expect(socket.updateCallPrivacy).not.toHaveBeenCalled();

      const valid = await client.callTool({
        name: "wa_update_privacy",
        arguments: { instanceId: "synthetic-instance", setting: "calls", value: "known" },
      });
      expect(valid.isError).toBeUndefined();
      expect(socket.updateCallPrivacy).toHaveBeenCalledWith("known");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns clear errors when disconnected or used on Cloud API", async () => {
    const disconnectedTools = registerTools(new BaileysAdapter("synthetic-instance"));
    const disconnectedRead = await callTool(disconnectedTools.get("wa_get_privacy_settings")!, {
      instanceId: "synthetic-instance",
    });
    const disconnectedUpdate = await callTool(disconnectedTools.get("wa_update_privacy")!, {
      instanceId: "synthetic-instance",
      setting: "calls",
      value: "known",
    });
    expect(disconnectedRead.isError).toBe(true);
    expect(disconnectedRead.content[0]?.text).toContain("is not connected");
    expect(disconnectedUpdate.isError).toBe(true);
    expect(disconnectedUpdate.content[0]?.text).toContain("is not connected");

    const cloudTools = registerTools(new CloudApiAdapter("synthetic-instance"));
    const cloudRead = await callTool(cloudTools.get("wa_get_privacy_settings")!, {
      instanceId: "synthetic-instance",
    });
    const cloudUpdate = await callTool(cloudTools.get("wa_update_privacy")!, {
      instanceId: "synthetic-instance",
      setting: "lastSeen",
      value: "contacts",
    });
    expect(cloudRead.isError).toBe(true);
    expect(cloudRead.content[0]?.text).toContain("not supported on the Cloud API");
    expect(cloudUpdate.isError).toBe(true);
    expect(cloudUpdate.content[0]?.text).toContain("not supported on the Cloud API");
  });
});
