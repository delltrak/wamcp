import { afterEach, describe, expect, it, vi } from "vitest";
import { CALL_AUDIO_PREFIX, CALL_VIDEO_PREFIX, type WASocket } from "@whiskeysockets/baileys";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import { registerCallTools } from "../src/tools/call.tools.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { MessageQueue } from "../src/services/message-queue.js";

type RegisteredTool = {
  inputSchema: z.ZodType;
  handler: (params: unknown) => Promise<unknown>;
};

type ToolResponse = { isError?: boolean; content: Array<{ text?: string }> };

function textOf(response: ToolResponse): string {
  return response.content.map((item) => item.text ?? "").join("");
}

describe("wa_create_call_link", () => {
  const initialAppStateWritesEnabled = process.env.WA_APP_STATE_WRITES_ENABLED;

  afterEach(() => {
    vi.restoreAllMocks();
    if (initialAppStateWritesEnabled === undefined) delete process.env.WA_APP_STATE_WRITES_ENABLED;
    else process.env.WA_APP_STATE_WRITES_ENABLED = initialAppStateWritesEnabled;
  });

  function createFixture(
    createCallLink: (...args: unknown[]) => Promise<string | undefined> = vi.fn(
      async () => "token-audio",
    ),
  ) {
    delete process.env.WA_APP_STATE_WRITES_ENABLED;
    vi.stubEnv("WA_CALL_LINK_MIN_INTERVAL_MS", "0");
    const appPatch = vi.fn();
    const socket = { createCallLink, appPatch } as unknown as WASocket;
    const adapter = new BaileysAdapter("call-link-instance");
    const internals = adapter as unknown as { sock: WASocket; status: "connected" };
    internals.sock = socket;
    internals.status = "connected";

    const tools = new Map<string, RegisteredTool>();
    const server = {
      registerTool: (name: string, options: unknown, handler: unknown) => {
        tools.set(name, {
          inputSchema: (options as { inputSchema: z.ZodType }).inputSchema,
          handler: handler as (params: unknown) => Promise<unknown>,
        });
      },
    } as unknown as McpServer;
    registerCallTools(
      server,
      { getAdapter: () => adapter } as unknown as InstanceManager,
      {} as MessageQueue,
    );

    const tool = tools.get("wa_create_call_link");
    if (!tool) throw new Error("Missing registered tool wa_create_call_link");

    return {
      adapter,
      appPatch,
      createCallLink,
      tool,
      invoke: async (input: Record<string, unknown>) => {
        const params = tool.inputSchema.parse({ instanceId: "call-link-instance", ...input });
        return (await tool.handler(params)) as ToolResponse;
      },
    };
  }

  it("returns the audio token and voice URL without an app-state write", async () => {
    const createCallLink = vi.fn(async () => "audio-token");
    const { invoke, appPatch } = createFixture(createCallLink);

    const response = await invoke({ type: "audio" });

    expect(response.isError).toBeUndefined();
    expect(JSON.parse(textOf(response))).toEqual({
      type: "audio",
      token: "audio-token",
      link: `${CALL_AUDIO_PREFIX}audio-token`,
    });
    expect(createCallLink).toHaveBeenCalledTimes(1);
    expect(createCallLink).toHaveBeenCalledWith("audio", undefined);
    expect(appPatch).not.toHaveBeenCalled();
    expect(process.env.WA_APP_STATE_WRITES_ENABLED).toBeUndefined();
  });

  it("returns the video token and forwards startTime", async () => {
    const createCallLink = vi.fn(async () => "video-token");
    const { invoke } = createFixture(createCallLink);

    const startTime = Math.floor(Date.now() / 1000) + 3600;
    const response = await invoke({ type: "video", startTime });

    expect(JSON.parse(textOf(response))).toEqual({
      type: "video",
      token: "video-token",
      link: `${CALL_VIDEO_PREFIX}video-token`,
      startTime,
    });
    expect(createCallLink).toHaveBeenCalledWith("video", { startTime });
  });

  it("rejects a startTime more than 60 seconds in the past", async () => {
    const { adapter, createCallLink, tool } = createFixture();
    const past = Math.floor(Date.now() / 1000) - 120;
    expect(
      tool.inputSchema.safeParse({
        instanceId: "call-link-instance",
        type: "audio",
        startTime: past,
      }).success,
    ).toBe(false);
    await expect(adapter.createCallLink("audio", past)).rejects.toThrow("60 seconds");
    expect(createCallLink).not.toHaveBeenCalled();
  });

  it("spaces call link creation for one instance", async () => {
    vi.stubEnv("WA_CALL_LINK_MIN_INTERVAL_MS", "40");
    const createCallLink = vi.fn(async () => "spaced-token");
    const socket = { createCallLink } as unknown as WASocket;
    const adapter = new BaileysAdapter("call-link-spaced");
    const internals = adapter as unknown as { sock: WASocket; status: "connected" };
    internals.sock = socket;
    internals.status = "connected";
    const started = Date.now();
    await adapter.createCallLink("audio");
    await adapter.createCallLink("audio");
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(createCallLink).toHaveBeenCalledTimes(2);
  });

  it("rejects a missing token and an unsupported type before calling the socket", async () => {
    const missing = createFixture(vi.fn(async () => undefined));
    const missingResponse = await missing.invoke({ type: "audio" });
    expect(missingResponse.isError).toBe(true);
    expect(textOf(missingResponse)).toContain("no call link token");

    const blank = createFixture(vi.fn(async () => "  "));
    const blankResponse = await blank.invoke({ type: "video" });
    expect(blankResponse.isError).toBe(true);
    expect(textOf(blankResponse)).toContain("no call link token");

    const { tool, createCallLink } = createFixture();
    expect(
      tool.inputSchema.safeParse({ instanceId: "call-link-instance", type: "voice" }).success,
    ).toBe(false);
    expect(createCallLink).not.toHaveBeenCalled();
  });

  it("reports a disconnected instance without calling createCallLink", async () => {
    const createCallLink = vi.fn(async () => "unused");
    const adapter = new BaileysAdapter("disconnected-instance");
    const tools = new Map<string, RegisteredTool>();
    const server = {
      registerTool: (name: string, options: unknown, handler: unknown) => {
        tools.set(name, {
          inputSchema: (options as { inputSchema: z.ZodType }).inputSchema,
          handler: handler as (params: unknown) => Promise<unknown>,
        });
      },
    } as unknown as McpServer;
    registerCallTools(
      server,
      { getAdapter: () => adapter } as unknown as InstanceManager,
      {} as MessageQueue,
    );
    const tool = tools.get("wa_create_call_link");
    if (!tool) throw new Error("Missing registered tool wa_create_call_link");
    const params = tool.inputSchema.parse({
      instanceId: "disconnected-instance",
      type: "audio",
    });

    const response = (await tool.handler(params)) as ToolResponse;

    expect(response.isError).toBe(true);
    expect(textOf(response)).toContain("not connected");
    expect(createCallLink).not.toHaveBeenCalled();
  });

  it("keeps call link creation unsupported on Cloud API", async () => {
    const cloud = new CloudApiAdapter("cloud-instance");
    await expect(cloud.createCallLink("video", 1_700_000_000)).rejects.toThrow(
      "Call link creation is not supported on Cloud API",
    );

    const tools = new Map<string, RegisteredTool>();
    const server = {
      registerTool: (name: string, options: unknown, handler: unknown) => {
        tools.set(name, {
          inputSchema: (options as { inputSchema: z.ZodType }).inputSchema,
          handler: handler as (params: unknown) => Promise<unknown>,
        });
      },
    } as unknown as McpServer;
    registerCallTools(
      server,
      { getAdapter: () => cloud } as unknown as InstanceManager,
      {} as MessageQueue,
    );
    const tool = tools.get("wa_create_call_link");
    if (!tool) throw new Error("Missing registered tool wa_create_call_link");
    const params = tool.inputSchema.parse({ instanceId: "cloud-instance", type: "audio" });

    const response = (await tool.handler(params)) as ToolResponse;

    expect(response.isError).toBe(true);
    expect(textOf(response)).toContain("not supported");
    expect(textOf(response)).toContain("Call link creation is not supported on Cloud API");
  });
});
