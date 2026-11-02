import { afterEach, describe, expect, it, vi } from "vitest";
import { BufferJSON, proto, type WASocket } from "@whiskeysockets/baileys";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, eq } from "drizzle-orm";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import {
  createGroupStatusMessage,
  DEFAULT_GROUP_STATUS_TEXT_ARGB,
  groupStatusMetaNode,
  MAX_GROUP_STATUS_CAPTION_LENGTH,
  MAX_GROUP_STATUS_MEDIA_CHARS,
  patchGroupStatusMessage,
} from "../src/channels/baileys/group-status.js";
import { db } from "../src/db/client.js";
import { instances, messages } from "../src/db/schema.js";
import type { NormalizedMessageEvent } from "../src/types/channel.types.js";
import { SendGroupStatusSchema } from "../src/schemas/status.schema.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import { registerStatusTools } from "../src/tools/status.tools.js";

const GROUP_JID = "120363000000000000@g.us";
const OWN_JID = "5500000000001:3@s.whatsapp.net";
const INSTANCE_ID = "synthetic-group-status";

function mediaType(message: proto.IMessage): string {
  if (message.imageMessage) return "image";
  if (message.videoMessage) return message.videoMessage.gifPlayback ? "gif" : "video";
  return "";
}

/** rc14 encodes a participant retry from the cached object and does not call the patch. */
function messageSentOnRetry(
  cached: proto.IMessage,
  participant?: { jid: string; count: number },
): proto.IMessage {
  if (participant) return cached;
  return patchGroupStatusMessage(cached);
}

async function connectedAdapter(options?: {
  instanceId?: string;
  minIntervalMs?: number;
  storeInstance?: boolean;
}) {
  const instanceId = options?.instanceId ?? INSTANCE_ID;
  vi.stubEnv("WA_GROUP_STATUS_ENABLED", "true");
  vi.stubEnv("WA_GROUP_STATUS_MIN_INTERVAL_MS", String(options?.minIntervalMs ?? 0));
  if (options?.storeInstance !== false) {
    const now = Date.now();
    await db
      .insert(instances)
      .values({ id: instanceId, name: "test", createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .run();
  }
  const relayMessage = vi.fn(async () => undefined);
  const addRecentMessage = vi.fn();
  const sendPresenceUpdate = vi.fn(async () => undefined);
  const sock = {
    user: { id: OWN_JID },
    relayMessage,
    sendPresenceUpdate,
    waUploadToServer: vi.fn(),
    messageRetryManager: { addRecentMessage },
  } as unknown as WASocket;
  const adapter = new BaileysAdapter(instanceId);
  Object.assign(adapter, { sock, status: "connected" });
  return { adapter, relayMessage, addRecentMessage, instanceId };
}

describe("group status wire format", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(instances).where(eq(instances.id, INSTANCE_ID)).run();
    await db.delete(instances).where(eq(instances.id, `${INSTANCE_ID}-spaced`)).run();
    await db.delete(instances).where(eq(instances.id, `${INSTANCE_ID}-unsaved`)).run();
  });

  it("relays text to the group and wraps it only in the send hook", async () => {
    const { adapter, relayMessage, addRecentMessage } = await connectedAdapter();
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
    const wrappedAgain = patchGroupStatusMessage(inner);
    expect(wrappedAgain.groupStatusMessageV2?.message?.extendedTextMessage?.text).toBe(
      "Synthetic group status",
    );
    expect(Buffer.from(wrappedAgain.messageContextInfo?.messageSecret ?? [])).toEqual(
      Buffer.from(wrapped.messageContextInfo?.messageSecret ?? []),
    );
    expect(patchGroupStatusMessage(wrapped)).toBe(wrapped);

    expect(addRecentMessage).toHaveBeenCalledWith(GROUP_JID, result.messageId, expect.any(Object));
    const cached = addRecentMessage.mock.calls[0]![2] as proto.IMessage;
    expect(cached.groupStatusMessageV2?.message?.extendedTextMessage?.text).toBe(
      "Synthetic group status",
    );
    expect(cached.extendedTextMessage).toBeFalsy();
    const participantRetry = messageSentOnRetry(cached, {
      jid: "5500000000002:0@s.whatsapp.net",
      count: 1,
    });
    expect(participantRetry.groupStatusMessageV2).toBeTruthy();
    expect(messageSentOnRetry(inner, { jid: "5500000000002:0@s.whatsapp.net", count: 1 })).toBe(
      inner,
    );
    expect(messageSentOnRetry(inner).groupStatusMessageV2).toBeTruthy();

    const stored = await db
      .select({ rawData: messages.rawData })
      .from(messages)
      .where(and(eq(messages.instanceId, INSTANCE_ID), eq(messages.id, result.messageId)))
      .get();
    const parsed = JSON.parse(stored?.rawData ?? "null", BufferJSON.reviver) as {
      message?: proto.IMessage;
    };
    expect(parsed.message?.groupStatusMessageV2?.message?.extendedTextMessage?.text).toBe(
      "Synthetic group status",
    );
  });

  it("uses the default text color, background, and SYSTEM_BOLD font", async () => {
    const { adapter, relayMessage } = await connectedAdapter();
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
    const { adapter, relayMessage } = await connectedAdapter();
    await expect(
      adapter.sendGroupStatus({
        groupId: GROUP_JID,
        type: "image",
        media: "http://example.com/synthetic.jpg",
      }),
    ).rejects.toThrow("Media URLs must use HTTPS");
    expect(relayMessage).not.toHaveBeenCalled();
  });

  it("treats a second save as an update and a missing instance as a failure", async () => {
    const { adapter } = await connectedAdapter();
    const persist = (
      adapter as unknown as {
        persistMessage: (
          event: NormalizedMessageEvent,
          source?: unknown,
          full?: boolean,
        ) => Promise<"inserted" | "updated" | "failed">;
      }
    ).persistMessage.bind(adapter);
    const event: NormalizedMessageEvent = {
      instanceId: INSTANCE_ID,
      chatId: GROUP_JID,
      message: {
        id: "persist-outcome",
        sender: "me",
        timestamp: 1,
        type: "text",
        content: "stored",
        mediaUrl: null,
        quotedMessageId: null,
        isFromMe: true,
      },
    };
    expect(await persist(event)).toBe("inserted");
    expect(await persist(event)).toBe("updated");

    const missing = new BaileysAdapter("group-status-missing-instance");
    const persistMissing = (
      missing as unknown as {
        persistMessage: (event: NormalizedMessageEvent) => Promise<"inserted" | "updated" | "failed">;
      }
    ).persistMessage.bind(missing);
    expect(await persistMissing({ ...event, instanceId: "group-status-missing-instance" })).toBe(
      "failed",
    );
  });

  it("returns success with a warning when the local retry copy is not stored", async () => {
    const { adapter, relayMessage } = await connectedAdapter({
      instanceId: `${INSTANCE_ID}-unsaved`,
      storeInstance: false,
    });
    const result = await adapter.sendGroupStatus({
      groupId: GROUP_JID,
      type: "text",
      text: "Sent anyway",
    });
    expect(relayMessage).toHaveBeenCalledTimes(1);
    expect(result.messageId).toEqual(expect.any(String));
    expect(result.warning).toContain("local retry copy");
  });

  it("rejects video unless WA_GROUP_STATUS_VIDEO_ENABLED=true", async () => {
    const { adapter, relayMessage } = await connectedAdapter();
    await expect(
      adapter.sendGroupStatus({
        groupId: GROUP_JID,
        type: "video",
        media: "https://example.com/synthetic.mp4",
      }),
    ).rejects.toThrow("WA_GROUP_STATUS_VIDEO_ENABLED=true");
    expect(relayMessage).not.toHaveBeenCalled();
  });

  it("spaces a second post by WA_GROUP_STATUS_MIN_INTERVAL_MS", async () => {
    const { adapter } = await connectedAdapter({
      instanceId: `${INSTANCE_ID}-spaced`,
      minIntervalMs: 40,
    });
    const started = Date.now();
    await adapter.sendGroupStatus({ groupId: GROUP_JID, type: "text", text: "one" });
    await adapter.sendGroupStatus({ groupId: GROUP_JID, type: "text", text: "two" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  it("rejects an oversized caption or media string before upload", async () => {
    await expect(
      createGroupStatusMessage(
        GROUP_JID,
        {
          groupId: GROUP_JID,
          type: "image",
          media: "https://example.com/synthetic.jpg",
          caption: "x".repeat(MAX_GROUP_STATUS_CAPTION_LENGTH + 1),
        },
        {
          userJid: OWN_JID,
          upload: vi.fn(),
          resolveMedia: () => Buffer.from("img"),
          generate: vi.fn() as never,
        },
      ),
    ).rejects.toThrow("caption exceeds");
    await expect(
      createGroupStatusMessage(
        GROUP_JID,
        {
          groupId: GROUP_JID,
          type: "image",
          media: "a".repeat(MAX_GROUP_STATUS_MEDIA_CHARS + 1),
        },
        {
          userJid: OWN_JID,
          upload: vi.fn(),
          resolveMedia: () => Buffer.from("img"),
          generate: vi.fn() as never,
        },
      ),
    ).rejects.toThrow("media exceeds");
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
  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(instances).where(eq(instances.id, INSTANCE_ID)).run();
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
    const fontOnly = SendGroupStatusSchema.safeParse({
      instanceId: "i",
      groupId: GROUP_JID,
      type: "image",
      media: "https://example.com/synthetic.jpg",
      font: 6,
    });
    expect(fontOnly.success).toBe(false);
    if (!fontOnly.success) {
      expect(fontOnly.error.issues.map((issue) => issue.path[0])).toEqual(["font"]);
    }
    const backgroundOnly = SendGroupStatusSchema.safeParse({
      instanceId: "i",
      groupId: GROUP_JID,
      type: "image",
      media: "https://example.com/synthetic.jpg",
      backgroundColor: "#112233",
    });
    expect(backgroundOnly.success).toBe(false);
    if (!backgroundOnly.success) {
      expect(backgroundOnly.error.issues.map((issue) => issue.path[0])).toEqual(["backgroundColor"]);
    }
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
    const { adapter } = await connectedAdapter();
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
