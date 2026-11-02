import { afterEach, describe, expect, it, vi } from "vitest";
import { proto, type WASocket } from "@whiskeysockets/baileys";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import {
  createGroupStatusMessage,
  DEFAULT_GROUP_STATUS_TEXT_ARGB,
  groupStatusMetaNode,
  patchGroupStatusMessage,
} from "../src/channels/baileys/group-status.js";
import { SendGroupStatusSchema } from "../src/schemas/status.schema.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import { registerStatusTools } from "../src/tools/status.tools.js";

const GROUP_JID = "120363000000000000@g.us";
const OWN_JID = "5500000000001:3@s.whatsapp.net";

function mediaType(message: proto.IMessage): string {
  if (message.imageMessage) return "image";
  if (message.videoMessage) return message.videoMessage.gifPlayback ? "gif" : "video";
  return "";
}

function connectedAdapter() {
  vi.stubEnv("WA_GROUP_STATUS_ENABLED", "true");
  const relayMessage = vi.fn(async () => undefined);
  const sendPresenceUpdate = vi.fn(async () => undefined);
  const sock = {
    user: { id: OWN_JID },
    relayMessage,
    sendPresenceUpdate,
    waUploadToServer: vi.fn(),
  } as unknown as WASocket;
  const adapter = new BaileysAdapter("synthetic-group-status");
  Object.assign(adapter, { sock, status: "connected" });
  return { adapter, relayMessage };
}

describe("group status wire format", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("relays text to the group and wraps it only in the send hook", async () => {
    const { adapter, relayMessage } = connectedAdapter();
    const result = await adapter.sendGroupStatus({
      groupId: "120363000000000000",
      type: "text",
      text: "Synthetic group status",
      backgroundColor: "#FF5733",
      font: 2,
    });

    expect(result.groupId).toBe(GROUP_JID);
    expect(result.messageId).toEqual(expect.any(String));
    expect(relayMessage).toHaveBeenCalledTimes(1);
    const [jid, message, options] = relayMessage.mock.calls[0]!;
    expect(jid).toBe(GROUP_JID);
    expect(options).toEqual({
      messageId: result.messageId,
      additionalNodes: [groupStatusMetaNode()],
    });
    expect(groupStatusMetaNode()).toEqual({
      tag: "meta",
      attrs: { is_group_status: "true", origin: "group_status" },
    });

    const inner = message as proto.IMessage;
    expect(inner.groupStatusMessageV2).toBeFalsy();
    expect(inner.extendedTextMessage?.text).toBe("Synthetic group status");
    expect(inner.extendedTextMessage?.contextInfo?.isGroupStatus).toBe(true);
    expect(inner.extendedTextMessage?.backgroundArgb).toBe(0xffff5733);
    expect(inner.extendedTextMessage?.textArgb).toBe(DEFAULT_GROUP_STATUS_TEXT_ARGB);
    expect(inner.extendedTextMessage?.font).toBe(2);
    expect(mediaType(inner)).toBe("");

    const wrapped = patchGroupStatusMessage(inner);
    expect(wrapped.extendedTextMessage).toBeFalsy();
    expect(wrapped.groupStatusMessageV2?.message?.extendedTextMessage?.text).toBe(
      "Synthetic group status",
    );
    expect(wrapped.groupStatusMessageV2?.message?.extendedTextMessage?.contextInfo?.isGroupStatus).toBe(
      true,
    );
    expect(wrapped.groupStatusMessageV2?.message?.messageContextInfo).toBeFalsy();
    expect(wrapped.messageContextInfo?.messageSecret).toHaveLength(32);
    expect(patchGroupStatusMessage(inner)).toBe(inner);
    expect(patchGroupStatusMessage(wrapped).groupStatusMessageV2).toBeTruthy();
  });

  it("uses the default text color, background, and SYSTEM_BOLD font", async () => {
    const { adapter, relayMessage } = connectedAdapter();
    await adapter.sendGroupStatus({
      groupId: GROUP_JID,
      type: "text",
      text: "Defaults",
    });
    const inner = relayMessage.mock.calls[0]![1] as proto.IMessage;
    expect(inner.extendedTextMessage?.backgroundArgb).toBe(0xff233e4f);
    expect(inner.extendedTextMessage?.font).toBe(6);
    expect(inner.extendedTextMessage?.textArgb).toBe(DEFAULT_GROUP_STATUS_TEXT_ARGB);
  });

  it("keeps image and video at the top level so rc14 can set mediatype", async () => {
    const secret = Buffer.alloc(32, 9);
    const upload = vi.fn();
    const resolveMedia = vi.fn((input: string) => Buffer.from(input, "base64"));
    const cases = [
      {
        type: "image" as const,
        media: "aW1hZ2U",
        caption: "still",
        node: "imageMessage" as const,
        expectedType: "image",
      },
      {
        type: "video" as const,
        media: "dmlkZW8",
        caption: "clip",
        node: "videoMessage" as const,
        expectedType: "video",
      },
    ];

    for (const entry of cases) {
      const generate = vi.fn(async () => ({
        key: { id: `${entry.type}-id` },
        message: {
          [entry.node]: {
            caption: entry.caption,
            mimetype: entry.type === "image" ? "image/jpeg" : "video/mp4",
            url: "https://mmg.whatsapp.net/synthetic",
          },
          messageContextInfo: { messageSecret: secret },
        },
      }));
      const { message, messageId } = await createGroupStatusMessage(
        GROUP_JID,
        { groupId: GROUP_JID, type: entry.type, media: entry.media, caption: entry.caption },
        {
          userJid: OWN_JID,
          upload,
          resolveMedia,
          generate: generate as never,
        },
      );

      expect(messageId).toBe(`${entry.type}-id`);
      expect(mediaType(message)).toBe(entry.expectedType);
      expect(message[entry.node]?.contextInfo?.isGroupStatus).toBe(true);
      expect(resolveMedia).toHaveBeenCalledWith(entry.media);
      const wrapped = patchGroupStatusMessage(message);
      expect(mediaType(wrapped)).toBe("");
      expect(wrapped.groupStatusMessageV2?.message?.[entry.node]?.contextInfo?.isGroupStatus).toBe(
        true,
      );
      expect(Buffer.from(wrapped.messageContextInfo?.messageSecret ?? [])).toEqual(secret);
      expect(wrapped.groupStatusMessageV2?.message?.messageContextInfo).toBeFalsy();
    }
  });

  it("leaves unmarked messages untouched", () => {
    const message = proto.Message.create({ conversation: "ordinary" });
    expect(patchGroupStatusMessage(message)).toBe(message);
  });

  it("stays disabled unless WA_GROUP_STATUS_ENABLED=true", async () => {
    vi.stubEnv("WA_GROUP_STATUS_ENABLED", undefined);
    const adapter = new BaileysAdapter("synthetic-group-status-off");
    await expect(
      adapter.sendGroupStatus({ groupId: GROUP_JID, type: "text", text: "no" }),
    ).rejects.toThrow("WA_GROUP_STATUS_ENABLED=true");
  });

  it("rejects a non-HTTPS media URL before relaying", async () => {
    const { adapter, relayMessage } = connectedAdapter();
    await expect(
      adapter.sendGroupStatus({
        groupId: GROUP_JID,
        type: "image",
        media: "http://example.com/synthetic.jpg",
      }),
    ).rejects.toThrow("Media URLs must use HTTPS");
    expect(relayMessage).not.toHaveBeenCalled();
  });

  it("is unsupported on Cloud API", async () => {
    await expect(
      new CloudApiAdapter("synthetic-cloud").sendGroupStatus({
        groupId: GROUP_JID,
        type: "text",
        text: "no",
      }),
    ).rejects.toThrow("Group status is not supported on Cloud API");
  });
});

describe("wa_send_group_status", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects incomplete and unknown fields", () => {
    expect(SendGroupStatusSchema.safeParse({ instanceId: "i", groupId: GROUP_JID }).success).toBe(
      false,
    );
    expect(
      SendGroupStatusSchema.safeParse({
        instanceId: "i",
        groupId: GROUP_JID,
        type: "text",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      SendGroupStatusSchema.safeParse({
        instanceId: "i",
        groupId: GROUP_JID,
        type: "text",
        text: "hello",
        font: 5,
      }).success,
    ).toBe(false);
    expect(
      SendGroupStatusSchema.safeParse({
        instanceId: "i",
        groupId: GROUP_JID,
        type: "image",
        media: "https://example.com/synthetic.jpg",
        backgroundColor: "#112233",
      }).success,
    ).toBe(false);
    expect(
      SendGroupStatusSchema.safeParse({
        instanceId: "i",
        groupId: "not a group",
        type: "text",
        text: "hello",
      }).success,
    ).toBe(false);
    expect(
      SendGroupStatusSchema.safeParse({
        instanceId: "i",
        groupId: GROUP_JID,
        type: "video",
        media: "https://example.com/synthetic.mp4",
        font: 0,
      }).success,
    ).toBe(false);
    expect(
      SendGroupStatusSchema.safeParse({
        instanceId: "i",
        groupId: GROUP_JID,
        type: "text",
        text: "hello",
        font: 0,
      }).success,
    ).toBe(true);
    expect(
      SendGroupStatusSchema.safeParse({
        instanceId: "i",
        groupId: GROUP_JID,
        type: "video",
        media: "https://example.com/synthetic.mp4",
      }).success,
    ).toBe(true);
  });

  it("returns the stanza id from the tool and the disabled error from the flag", async () => {
    const { adapter } = connectedAdapter();
    const handlers = new Map<string, (params: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>>();
    const server = {
      registerTool(
        name: string,
        _config: unknown,
        handler: (params: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>,
      ) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    registerStatusTools(server, { getAdapter: () => adapter } as unknown as InstanceManager, {} as MessageQueue);
    const send = handlers.get("wa_send_group_status");
    if (!send) throw new Error("wa_send_group_status was not registered");

    const ok = await send({
      instanceId: "synthetic-group-status",
      groupId: GROUP_JID,
      type: "text",
      text: "From the tool",
    });
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(ok.content[0]!.text)).toMatchObject({
      success: true,
      groupId: GROUP_JID,
    });

    vi.stubEnv("WA_GROUP_STATUS_ENABLED", "false");
    const disabledAdapter = new BaileysAdapter("synthetic-group-status-disabled");
    const disabledHandlers = new Map<
      string,
      (params: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>
    >();
    const disabledServer = {
      registerTool(
        name: string,
        _config: unknown,
        handler: (params: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>,
      ) {
        disabledHandlers.set(name, handler);
      },
    } as unknown as McpServer;
    registerStatusTools(
      disabledServer,
      { getAdapter: () => disabledAdapter } as unknown as InstanceManager,
      {} as MessageQueue,
    );
    const disabled = await disabledHandlers.get("wa_send_group_status")!({
      instanceId: "synthetic-group-status-disabled",
      groupId: GROUP_JID,
      type: "text",
      text: "blocked",
    });
    expect(disabled.isError).toBe(true);
    expect(disabled.content[0]?.text).toContain("WA_GROUP_STATUS_ENABLED=true");
  });
});
