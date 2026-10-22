import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { baileysSupportsNativeGroupMentionAll } from "../src/channels/baileys/native-mention-all.js";
import { SendGroupMentionAllSchema } from "../src/schemas/messaging.schema.js";
import { registerMessagingTools } from "../src/tools/messaging.tools.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import { MAX_GROUP_MENTION_PARTICIPANTS, planGroupMentionAll } from "../src/utils/group-mention.js";

const GROUP_ID = "120363000000000001@g.us";

describe("group @all planning", () => {
  it("uses the native mention without participant JIDs", () => {
    expect(
      planGroupMentionAll({
        text: "Update",
        nativeSupported: true,
        participants: [],
      }),
    ).toEqual({ mode: "native", text: "Update @all" });
    expect(
      planGroupMentionAll({
        text: "Hello @all there",
        nativeSupported: true,
        participants: Array.from(
          { length: MAX_GROUP_MENTION_PARTICIPANTS + 1 },
          (_, index) => `${index}@s.whatsapp.net`,
        ),
      }),
    ).toEqual({ mode: "native", text: "Hello @all there" });
  });

  it("falls back to unique participant JIDs when native @all is unavailable", () => {
    expect(
      planGroupMentionAll({
        text: "Update",
        nativeSupported: false,
        participants: [
          "5500000000003@s.whatsapp.net",
          "5500000000003@s.whatsapp.net",
          "5500000000004@s.whatsapp.net",
          "",
        ],
      }),
    ).toEqual({
      mode: "participants",
      text: "Update @all",
      mentions: ["5500000000003@s.whatsapp.net", "5500000000004@s.whatsapp.net"],
    });
  });

  it("rejects an empty or oversized participant fallback", () => {
    expect(() =>
      planGroupMentionAll({ text: "Update", nativeSupported: false, participants: ["", ""] }),
    ).toThrow("Cannot mention all: the group has no participants");
    expect(() =>
      planGroupMentionAll({
        text: "Update",
        nativeSupported: false,
        participants: Array.from(
          { length: MAX_GROUP_MENTION_PARTICIPANTS + 1 },
          (_, index) => `${index}@s.whatsapp.net`,
        ),
      }),
    ).toThrow(
      `Cannot mention all: the group has more than ${MAX_GROUP_MENTION_PARTICIPANTS} participants`,
    );
  });

  it("detects native @all in the installed Baileys build", async () => {
    await expect(baileysSupportsNativeGroupMentionAll()).resolves.toBe(true);
  });
});

describe("wa_send_group_mention_all cloud rejection", () => {
  it("does not queue a participant mention on Cloud API", async () => {
    const tools = new Map<
      string,
      {
        inputSchema: z.ZodType;
        handler: (
          params: unknown,
        ) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
      }
    >();
    const server = {
      registerTool: (name: string, options: unknown, handler: unknown) => {
        tools.set(name, {
          inputSchema: (options as { inputSchema: z.ZodType }).inputSchema,
          handler: handler as (params: unknown) => Promise<{
            isError?: boolean;
            content: Array<{ text?: string }>;
          }>,
        });
      },
    } as unknown as McpServer;
    const enqueueMessage = vi.fn();
    registerMessagingTools(
      server,
      {
        getInstanceChannel: () => "cloud",
        getAdapter: () => {
          throw new Error("Cloud @all must fail before resolving an adapter");
        },
      } as unknown as InstanceManager,
      { enqueueMessage } as unknown as MessageQueue,
    );

    const tool = tools.get("wa_send_group_mention_all");
    const result = await tool?.handler(
      tool.inputSchema.parse({ instanceId: "cloud-instance", groupId: GROUP_ID, text: "Update" }),
    );
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain(
      "Group @all mentions are not supported on Cloud API",
    );
    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(
      SendGroupMentionAllSchema.parse({ instanceId: "i", groupId: GROUP_ID, text: "Hi" }).text,
    ).toBe("Hi");
  });
});
