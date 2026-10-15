import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaileysEventMap, WAMessage, WASocket } from "@whiskeysockets/baileys";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import { registerCallTools } from "../src/tools/call.tools.js";
import { registerGroupTools } from "../src/tools/group.tools.js";
import { registerMessagingTools } from "../src/tools/messaging.tools.js";
import { registerStatusTools } from "../src/tools/status.tools.js";
import { sqlite } from "../src/db/client.js";
import type { ContactStore } from "../src/services/contact-store.js";
import {
  registerEventWebhookHandler,
  type EventWebhookJob,
} from "../src/services/event-webhook.js";
import { loadEventWebhookConfig } from "../src/services/event-webhook-config.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import type {
  ChannelEvent,
  ChannelEventPayload,
  MessageContent,
} from "../src/types/channel.types.js";

const mocks = vi.hoisted(() => ({ getUrlInfo: vi.fn() }));

vi.mock("@whiskeysockets/baileys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@whiskeysockets/baileys")>();
  return { ...actual, getUrlInfo: mocks.getUrlInfo };
});

const ACCOUNT_ID = "5500000000002@s.whatsapp.net";
const CONTACT_ID = "5500000000003@s.whatsapp.net";
const SECOND_CONTACT_ID = "5500000000004@s.whatsapp.net";
const GROUP_ID = "120363000000000001@g.us";
const initialAppStateWritesEnabled = process.env.WA_APP_STATE_WRITES_ENABLED;

type RegisteredTool = {
  inputSchema: z.ZodType;
  handler: (params: unknown) => Promise<unknown>;
};

type ToolResponse = { isError?: boolean; content: Array<{ text?: string }> };

function messageForSend(jid: string, content: unknown): WAMessage {
  const payload = content as Record<string, unknown>;
  let message: WAMessage["message"];
  if (payload.image !== undefined) message = { imageMessage: {} };
  else if (payload.video !== undefined) message = { videoMessage: {} };
  else if (payload.album !== undefined) {
    message = { albumMessage: payload.album as NonNullable<WAMessage["message"]>["albumMessage"] };
  } else if (typeof payload.text === "string") message = { conversation: payload.text };
  else message = {};
  return {
    key: { remoteJid: jid, id: `issue80-${randomUUID()}`, fromMe: true },
    message,
    messageTimestamp: Math.floor(Date.now() / 1000),
  } as WAMessage;
}

describe("issue 80 feature completion", () => {
  const activeInstanceIds = new Set<string>();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUrlInfo.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const instanceId of activeInstanceIds) {
      sqlite.prepare("DELETE FROM instances WHERE id = ?").run(instanceId);
    }
    activeInstanceIds.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (initialAppStateWritesEnabled === undefined) delete process.env.WA_APP_STATE_WRITES_ENABLED;
    else process.env.WA_APP_STATE_WRITES_ENABLED = initialAppStateWritesEnabled;
  });

  function createFixture(extraSocket: Record<string, unknown> = {}) {
    const instanceId = `issue-80-${randomUUID()}`;
    activeInstanceIds.add(instanceId);
    sqlite
      .prepare(
        "INSERT INTO instances (id, name, channel, status, created_at, updated_at) VALUES (?, ?, 'baileys', 'connected', 1, 1)",
      )
      .run(instanceId, "Issue 80 simulated instance");

    let processEvents: ((events: Partial<BaileysEventMap>) => Promise<void> | void) | undefined;
    const socket = {
      user: { id: ACCOUNT_ID },
      sendMessage: vi.fn(async (jid: string, content: unknown) => messageForSend(jid, content)),
      readMessages: vi.fn(async () => undefined),
      sendPresenceUpdate: vi.fn(async () => undefined),
      presenceSubscribe: vi.fn(async () => undefined),
      groupMetadata: vi.fn(async () => ({
        id: GROUP_ID,
        subject: "Planning group",
        participants: [{ id: ACCOUNT_ID }, { id: CONTACT_ID }, { id: SECOND_CONTACT_ID }],
      })),
      groupJoinApprovalMode: vi.fn(async () => undefined),
      groupRequestParticipantsUpdate: vi.fn(async () => []),
      rejectCall: vi.fn(async () => undefined),
      chatModify: vi.fn(),
      appPatch: vi.fn(),
      waUploadToServer: vi.fn(async () => ({})),
      ev: {
        on: vi.fn(),
        process: vi.fn((handler: (events: Partial<BaileysEventMap>) => Promise<void> | void) => {
          processEvents = handler;
          return vi.fn();
        }),
      },
      ...extraSocket,
    } as unknown as WASocket;

    const adapter = new BaileysAdapter(instanceId, {
      getContacts: vi.fn(() => []),
      handleHistorySync: vi.fn(async () => undefined),
    } as unknown as ContactStore);
    const internals = adapter as unknown as {
      sock: WASocket;
      status: "connected";
      bindEvents: (sock: WASocket) => void;
    };
    internals.sock = socket;
    internals.status = "connected";
    internals.bindEvents(socket);

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
      getInstanceChannel: () => "baileys",
    } as unknown as InstanceManager;
    const queue = {
      enqueueMessage: vi.fn(async (_id: string, to: string, content: MessageContent) =>
        adapter.sendMessage(to, content),
      ),
      enqueueMediaAlbum: vi.fn(
        async (_id: string, to: string, images: Array<{ image: string; caption?: string }>) =>
          adapter.sendMediaAlbum(to, images),
      ),
    } as unknown as MessageQueue;
    registerMessagingTools(server, instanceManager, queue);
    registerGroupTools(server, instanceManager, queue);
    registerStatusTools(server, instanceManager, queue);
    registerCallTools(server, instanceManager, queue);

    return {
      instanceId,
      adapter,
      socket,
      queue,
      tools,
      processEvents: (events: Partial<BaileysEventMap>) => {
        if (!processEvents) throw new Error("Baileys event processor was not registered");
        return processEvents(events);
      },
      invoke: async (name: string, input: Record<string, unknown> = {}) => {
        const tool = tools.get(name);
        if (!tool) throw new Error(`Missing registered tool ${name}`);
        const params = tool.inputSchema.parse({ instanceId, ...input });
        return (await tool.handler(params)) as ToolResponse;
      },
    };
  }

  it("subscribes per chat, throttles presence, expands @all and supports send-time mentions", async () => {
    const { adapter, socket, queue, invoke } = createFixture();
    await invoke("wa_send_presence", { chatId: CONTACT_ID, status: "typing" });
    await invoke("wa_send_presence", { chatId: CONTACT_ID, status: "paused" });
    await invoke("wa_send_presence", { chatId: GROUP_ID, status: "recording" });
    await invoke("wa_subscribe_presence", { chatId: CONTACT_ID });
    await invoke("wa_subscribe_presence", { chatId: CONTACT_ID });
    expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(1, "composing", CONTACT_ID);
    expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(2, "recording", GROUP_ID);
    expect(socket.sendPresenceUpdate).toHaveBeenCalledTimes(2);
    expect(socket.presenceSubscribe).toHaveBeenCalledWith(CONTACT_ID);
    expect(socket.presenceSubscribe).toHaveBeenCalledTimes(1);

    await invoke("wa_send_text", { to: GROUP_ID, text: "Hi there", mentions: [CONTACT_ID] });
    expect(socket.sendMessage).toHaveBeenLastCalledWith(
      GROUP_ID,
      { text: "Hi there", mentions: [CONTACT_ID] },
      {},
    );
    vi.mocked(socket.sendMessage).mockClear();
    vi.mocked(queue.enqueueMessage).mockClear();
    const all = await invoke("wa_send_group_mention_all", { groupId: GROUP_ID, text: "Update" });
    expect(all.isError).not.toBe(true);
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    expect(queue.enqueueMessage).toHaveBeenCalledTimes(1);
    expect(socket.sendMessage).toHaveBeenLastCalledWith(
      GROUP_ID,
      {
        text: "Update @all",
        mentions: [ACCOUNT_ID, CONTACT_ID, SECOND_CONTACT_ID],
        mentionAll: true,
      },
      {},
    );
    await adapter.sendMessage(GROUP_ID, {
      type: "image",
      image: Buffer.from("image").toString("base64"),
      caption: "Photo",
      mentions: [CONTACT_ID],
    });
    expect(socket.sendMessage).toHaveBeenLastCalledWith(
      GROUP_ID,
      expect.objectContaining({ caption: "Photo", mentions: [CONTACT_ID] }),
      {},
    );
    await invoke("wa_send_ptv", {
      to: GROUP_ID,
      video: Buffer.from("video").toString("base64"),
      caption: "Round video",
      mentions: [CONTACT_ID],
    });
    expect(socket.sendMessage).toHaveBeenLastCalledWith(
      GROUP_ID,
      expect.objectContaining({ caption: "Round video", ptv: true, mentions: [CONTACT_ID] }),
      {},
    );
    await adapter.sendMessage(GROUP_ID, {
      type: "video",
      video: Buffer.from("video").toString("base64"),
      caption: "Looping video",
      gifPlayback: true,
      mentions: [CONTACT_ID],
    });
    expect(socket.sendMessage).toHaveBeenLastCalledWith(
      GROUP_ID,
      expect.objectContaining({
        caption: "Looping video",
        gifPlayback: true,
        mentions: [CONTACT_ID],
      }),
      {},
    );
    expect(socket.chatModify).not.toHaveBeenCalled();
    expect(socket.appPatch).not.toHaveBeenCalled();
  });

  it("uses readable Baileys fallbacks and native Cloud API buttons and lists", async () => {
    const { adapter, socket, invoke } = createFixture();
    await invoke("wa_send_buttons", {
      to: CONTACT_ID,
      text: "Choose",
      buttons: [
        { id: "yes", text: "Yes" },
        { id: "no", text: "No" },
      ],
    });
    expect(socket.sendMessage).toHaveBeenLastCalledWith(
      CONTACT_ID,
      { text: "Choose\n\n1. Yes (reply with yes)\n2. No (reply with no)" },
      {},
    );
    await adapter.sendMessage(CONTACT_ID, {
      type: "list",
      text: "Pick one",
      buttonText: "Open",
      sections: [{ title: "Options", rows: [{ id: "a", title: "Alpha" }] }],
    });
    expect(socket.sendMessage).toHaveBeenLastCalledWith(
      CONTACT_ID,
      { text: "Pick one\n\nOptions\n  1. Alpha (reply with a)\n\nOpen" },
      {},
    );

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: "cloud-message" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const cloud = new CloudApiAdapter("cloud-instance");
    await cloud.setCredentials({ accessToken: "simulated", phoneNumberId: "123" });
    await cloud.sendMessage(CONTACT_ID, {
      type: "buttons",
      text: "Choose",
      buttons: [{ id: "yes", text: "Yes" }],
    });
    await cloud.sendMessage(CONTACT_ID, {
      type: "list",
      text: "Pick one",
      buttonText: "Open",
      sections: [{ title: "Options", rows: [{ id: "a", title: "Alpha" }] }],
    });
    const body = (index: number) =>
      JSON.parse(String(fetchMock.mock.calls[index]?.[1]?.body)) as Record<string, unknown>;
    expect(body(0)).toMatchObject({ type: "interactive", interactive: { type: "button" } });
    expect(body(1)).toMatchObject({ type: "interactive", interactive: { type: "list" } });
  });

  it("generates preview metadata and thumbnails for custom link previews", async () => {
    const { adapter, socket } = createFixture();
    mocks.getUrlInfo.mockResolvedValue({
      "canonical-url": "https://example.test/article",
      "matched-text": "https://example.test/article",
      title: "Generated title",
      description: "Generated description",
      jpegThumbnail: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
    });
    const result = await adapter.sendLinkPreview(
      CONTACT_ID,
      "Read this",
      "https://example.test/article",
      { title: "Custom title" },
    );
    expect(result.messageId).toContain("issue80-");
    expect(mocks.getUrlInfo).toHaveBeenCalledWith(
      "https://example.test/article",
      expect.objectContaining({ thumbnailWidth: 192, uploadImage: expect.any(Function) }),
    );
    expect(socket.sendMessage).toHaveBeenCalledWith(CONTACT_ID, {
      text: "Read this\nhttps://example.test/article",
      linkPreview: expect.objectContaining({
        title: "Custom title",
        description: "Generated description",
        jpegThumbnail: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
      }),
    });
    await expect(
      adapter.sendLinkPreview(CONTACT_ID, "Unsafe", "javascript:alert(1)"),
    ).rejects.toThrow("Link preview URL must use HTTP or HTTPS");
  });

  it("stores group receipts, status viewers, reactions and reaction removals", async () => {
    const lid = "7700000000000@lid";
    const { adapter, processEvents } = createFixture({
      signalRepository: {
        lidMapping: {
          getPNForLID: vi.fn(async (value: string) =>
            value === lid ? SECOND_CONTACT_ID : undefined,
          ),
        },
      },
    });
    const updates: ChannelEventPayload["message.updated"][] = [];
    const reactionEvents: ChannelEventPayload["message.reaction"][] = [];
    adapter.on("message.updated", (event) => updates.push(event));
    adapter.on("message.reaction", (event) => reactionEvents.push(event));
    await processEvents({
      "messages.update": [
        {
          key: { remoteJid: GROUP_ID, id: "receipt-2", participant: CONTACT_ID },
          update: { status: 2 },
        },
        {
          key: { remoteJid: GROUP_ID, id: "receipt-3", participant: CONTACT_ID },
          update: { status: 3 },
        },
        {
          key: { remoteJid: GROUP_ID, id: "receipt-4", participant: CONTACT_ID },
          update: { status: 4 },
        },
        {
          key: { remoteJid: GROUP_ID, id: "receipt-5", participant: CONTACT_ID },
          update: { status: 5 },
        },
      ],
      "message-receipt.update": [
        {
          key: { remoteJid: GROUP_ID, id: "group-message" },
          receipt: { userJid: CONTACT_ID, readTimestamp: 1_700_000_000 },
        },
        {
          key: { remoteJid: "status@broadcast", id: "story-message" },
          receipt: { userJid: CONTACT_ID, readTimestamp: 1_700_000_001 },
        },
        {
          key: { remoteJid: "status@broadcast", id: "story-message" },
          receipt: { userJid: SECOND_CONTACT_ID, playedTimestamp: 1_700_000_002 },
        },
      ],
      "messages.reaction": [
        {
          key: { remoteJid: GROUP_ID, id: "group-message" },
          reaction: {
            key: { remoteJid: GROUP_ID, participant: CONTACT_ID },
            text: "👍",
            senderTimestampMs: 1_700_000_010_000,
          },
        },
        {
          key: { remoteJid: GROUP_ID, id: "group-message" },
          reaction: {
            key: { remoteJid: GROUP_ID, fromMe: true },
            text: "👀",
            senderTimestampMs: 1_700_000_010_001,
          },
        },
        {
          key: { remoteJid: GROUP_ID, id: "group-message" },
          reaction: {
            key: { remoteJid: GROUP_ID, participant: lid },
            text: "❤️",
            senderTimestampMs: 1_700_000_010_002,
          },
        },
        {
          key: { remoteJid: CONTACT_ID, id: "direct-message" },
          reaction: {
            key: { remoteJid: SECOND_CONTACT_ID, participant: CONTACT_ID },
            text: "✨",
            senderTimestampMs: 1_700_000_010_003,
          },
        },
      ],
    });
    expect(await adapter.getMessageReceipts(GROUP_ID, "receipt-2")).toEqual([]);
    expect(await adapter.getMessageReceipts(GROUP_ID, "receipt-3")).toMatchObject([
      { participant: CONTACT_ID, status: "delivered" },
    ]);
    expect(await adapter.getMessageReceipts(GROUP_ID, "receipt-4")).toMatchObject([
      { participant: CONTACT_ID, status: "read" },
    ]);
    expect(await adapter.getMessageReceipts(GROUP_ID, "receipt-5")).toMatchObject([
      { participant: CONTACT_ID, status: "played" },
    ]);
    expect(updates.map((event) => [event.messageId, event.status])).toEqual([
      ["receipt-2", "sent"],
      ["receipt-3", "delivered"],
      ["receipt-4", "read"],
      ["receipt-5", "played"],
    ]);
    expect(await adapter.getMessageReceipts(GROUP_ID, "group-message")).toEqual([
      { participant: CONTACT_ID, status: "read", timestamp: 1_700_000_000_000 },
    ]);
    expect(await adapter.getStatusViewers("story-message")).toEqual([
      CONTACT_ID,
      SECOND_CONTACT_ID,
    ]);
    expect(await adapter.getMessageReactions(GROUP_ID, "group-message")).toEqual([
      { participant: ACCOUNT_ID, emoji: "👀", timestamp: 1_700_000_010_001 },
      { participant: CONTACT_ID, emoji: "👍", timestamp: 1_700_000_010_000 },
      { participant: SECOND_CONTACT_ID, emoji: "❤️", timestamp: 1_700_000_010_002 },
    ]);
    expect(reactionEvents.map((event) => event.reactedBy)).toEqual([
      CONTACT_ID,
      ACCOUNT_ID,
      SECOND_CONTACT_ID,
      SECOND_CONTACT_ID,
    ]);
    expect(await adapter.getMessageReactions(CONTACT_ID, "direct-message")).toEqual([
      { participant: SECOND_CONTACT_ID, emoji: "✨", timestamp: 1_700_000_010_003 },
    ]);

    await processEvents({
      "messages.reaction": [
        {
          key: { remoteJid: GROUP_ID, id: "group-message" },
          reaction: {
            key: { remoteJid: GROUP_ID, participant: CONTACT_ID },
            text: "",
            senderTimestampMs: 1_700_000_011_000,
          },
        },
      ],
    });
    expect(await adapter.getMessageReactions(GROUP_ID, "group-message")).toEqual([
      { participant: ACCOUNT_ID, emoji: "👀", timestamp: 1_700_000_010_001 },
      { participant: SECOND_CONTACT_ID, emoji: "❤️", timestamp: 1_700_000_010_002 },
    ]);
  });

  it("limits mark-read batches and debounces per-chat presence updates", async () => {
    const { adapter, socket } = createFixture();
    await expect(
      adapter.markRead(
        CONTACT_ID,
        Array.from({ length: 101 }, (_, index) => `message-${index}`),
      ),
    ).rejects.toThrow("at most 100 message IDs");

    await adapter.markRead(CONTACT_ID, ["same-message", "same-message"]);
    expect(socket.readMessages).toHaveBeenCalledWith([
      { remoteJid: CONTACT_ID, id: "same-message" },
    ]);

    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(5_000)
      .mockReturnValueOnce(6_000)
      .mockReturnValueOnce(7_000);
    await adapter.sendPresence(CONTACT_ID, "typing");
    await adapter.sendPresence(CONTACT_ID, "paused");
    await adapter.sendPresence(CONTACT_ID, "paused");
    expect(socket.sendPresenceUpdate).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it("caps unique presence subscriptions per adapter", async () => {
    const { adapter, socket } = createFixture();
    for (let index = 0; index < 100; index += 1) {
      await adapter.subscribePresence(`${String(index).padStart(13, "0")}@s.whatsapp.net`);
    }
    await expect(adapter.subscribePresence("9999999999999@s.whatsapp.net")).rejects.toThrow(
      "limited to 100 chats",
    );
    expect(socket.presenceSubscribe).toHaveBeenCalledTimes(100);
  });

  it("queues album sends and rejects an album larger than the bounded tool limit", async () => {
    const { adapter, queue, socket, invoke } = createFixture();
    const images = [
      { image: Buffer.from("one").toString("base64") },
      { image: Buffer.from("two").toString("base64") },
    ];
    await invoke("wa_send_media_album", { to: CONTACT_ID, images });
    expect(queue.enqueueMediaAlbum).toHaveBeenCalledWith(expect.any(String), CONTACT_ID, images);
    expect(socket.sendMessage).toHaveBeenCalledTimes(3);

    await expect(
      invoke("wa_send_media_album", {
        to: CONTACT_ID,
        images: Array.from({ length: 11 }, () => ({ image: "aW1hZ2U=" })),
      }),
    ).rejects.toThrow();
  });

  it("validates album media before sending the parent message", async () => {
    const { adapter, socket } = createFixture();
    await expect(
      adapter.sendMediaAlbum(CONTACT_ID, [
        { image: "https://127.0.0.1/private-image" },
        { image: Buffer.from("image").toString("base64") },
      ]),
    ).rejects.toThrow();
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });

  it("sends albums and private replies using regular message sends", async () => {
    const { adapter, socket, instanceId } = createFixture();
    const album = await adapter.sendMediaAlbum(CONTACT_ID, [
      { image: Buffer.from("one").toString("base64"), caption: "One" },
      { image: Buffer.from("two").toString("base64") },
    ]);
    expect(album.messageId).toContain("issue80-");
    expect(socket.sendMessage).toHaveBeenCalledTimes(3);
    expect(socket.sendMessage.mock.calls[0]?.[1]).toEqual({ album: { expectedImageCount: 2 } });
    expect(socket.sendMessage.mock.calls[1]?.[1]).toMatchObject({
      image: expect.any(Buffer),
      caption: "One",
      albumParentKey: expect.any(Object),
    });
    const albumRows = sqlite
      .prepare("SELECT type FROM messages WHERE instance_id = ? ORDER BY rowid")
      .all(instanceId) as Array<{ type: string }>;
    expect(albumRows.map((row) => row.type)).toEqual(["album", "image", "image"]);

    sqlite
      .prepare(
        "INSERT INTO messages (id, instance_id, chat_id, sender_id, type, is_from_me, status, timestamp) VALUES (?, ?, ?, ?, 'text', 0, 'received', 1)",
      )
      .run("group-message", instanceId, GROUP_ID, CONTACT_ID);
    await adapter.replyPrivatelyToGroupMessage(GROUP_ID, "group-message", "Thanks");
    expect(socket.sendMessage).toHaveBeenLastCalledWith(CONTACT_ID, { text: "Thanks" });
    expect(socket.chatModify).not.toHaveBeenCalled();
    expect(socket.appPatch).not.toHaveBeenCalled();
  });

  it("keeps automatic call rejection disabled when its setting is unset", async () => {
    vi.stubEnv("WA_AUTO_REJECT_CALLS", undefined);
    const defaultFixture = createFixture();
    await defaultFixture.processEvents({
      call: [
        {
          chatId: CONTACT_ID,
          from: CONTACT_ID,
          id: "call-default-off",
          date: new Date(1_700_000_000_000),
          isVideo: false,
          isGroup: false,
          status: "offer",
          offline: false,
        },
      ],
    });
    expect(defaultFixture.socket.rejectCall).not.toHaveBeenCalled();
  });

  it("auto-rejects direct call offers only when enabled and keeps call details in webhooks", async () => {
    vi.stubEnv("WA_AUTO_REJECT_CALLS", "true");
    const { adapter, socket, processEvents } = createFixture();
    const emitted: ChannelEventPayload["call.received"][] = [];
    adapter.on("call.received", (event) => emitted.push(event));
    await processEvents({
      call: [
        {
          chatId: CONTACT_ID,
          from: CONTACT_ID,
          id: "call-80",
          date: new Date(1_700_000_000_000),
          isVideo: true,
          isGroup: false,
          status: "offer",
          offline: false,
        },
      ],
    });
    await processEvents({
      call: [
        {
          chatId: CONTACT_ID,
          from: CONTACT_ID,
          id: "call-rejected",
          date: new Date(1_700_000_001_000),
          isVideo: false,
          isGroup: false,
          status: "reject",
          offline: false,
        },
        {
          chatId: CONTACT_ID,
          from: CONTACT_ID,
          id: "call-timeout",
          date: new Date(1_700_000_002_000),
          isVideo: false,
          isGroup: false,
          status: "timeout",
          offline: false,
        },
      ],
    });
    expect(socket.rejectCall).toHaveBeenCalledWith("call-80", CONTACT_ID);
    expect(emitted.map((event) => event.status)).toEqual(["offer", "reject", "timeout"]);
    expect(emitted[0]).toMatchObject({
      chatId: CONTACT_ID,
      callerId: CONTACT_ID,
      callId: "call-80",
      isVideo: true,
      status: "offer",
      timestamp: 1_700_000_000_000,
    });

    const handlers: Array<
      (event: ChannelEvent, instanceId: string, payload: ChannelEventPayload[ChannelEvent]) => void
    > = [];
    const instanceManager = {
      onAnyEvent: (
        handler: (
          event: ChannelEvent,
          instanceId: string,
          payload: ChannelEventPayload[ChannelEvent],
        ) => void,
      ) => {
        handlers.push(handler);
        return () => undefined;
      },
    } as unknown as InstanceManager;
    const config = loadEventWebhookConfig({
      WA_EVENT_WEBHOOK_URL: "https://hooks.example.test/receive",
      WA_EVENT_WEBHOOK_EVENTS: "call.received",
      WA_EVENT_WEBHOOK_IGNORE_FROM_ME: "false",
    });
    const jobs: EventWebhookJob[] = [];
    const unsubscribe = registerEventWebhookHandler(instanceManager, config, async (job) => {
      jobs.push(job);
    });
    for (const event of emitted) {
      handlers[0]?.("call.received", "instance", event);
      await unsubscribe.flush();
    }
    expect(jobs.map((job) => job.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "call.received",
          chat: CONTACT_ID,
          sender: CONTACT_ID,
          type: "offer",
          callId: "call-80",
          callStatus: "offer",
          isVideo: true,
          isGroup: false,
          timestamp: 1_700_000_000_000,
        }),
        expect.objectContaining({ callId: "call-rejected", callStatus: "reject" }),
        expect.objectContaining({ callId: "call-timeout", callStatus: "timeout" }),
      ]),
    );
    await adapter.rejectCall("call-80", CONTACT_ID);
  });

  it("keeps Cloud API unsupported operations explicit", async () => {
    const cloud = new CloudApiAdapter("cloud-instance");
    await expect(cloud.subscribePresence(CONTACT_ID)).rejects.toThrow(
      "Subscribing to contact presence is not supported on Cloud API",
    );
    await expect(
      cloud.sendMessage(GROUP_ID, { type: "text", text: "Hello", mentions: [CONTACT_ID] }),
    ).rejects.toThrow("Participant mentions are not supported by this Cloud API adapter");
    await expect(cloud.sendMediaAlbum(CONTACT_ID, [])).rejects.toThrow(
      "Grouped media albums are not supported on Cloud API",
    );
    await expect(cloud.getMessageReceipts(GROUP_ID, "message")).rejects.toThrow(
      "Participant-level message receipts are not available on Cloud API",
    );
    await expect(cloud.getStatusViewers("story")).rejects.toThrow(
      "Status story viewers are not available on Cloud API",
    );
    await expect(cloud.getMessageReactions(GROUP_ID, "message")).rejects.toThrow(
      "Message reaction history is not available on Cloud API",
    );
    await expect(cloud.replyPrivatelyToGroupMessage(GROUP_ID, "message", "Reply")).rejects.toThrow(
      "Private replies to group messages are not supported on Cloud API",
    );
    await expect(cloud.sendGroupInviteMessage(CONTACT_ID, GROUP_ID)).rejects.toThrow(
      "Group invite messages are not supported on Cloud API",
    );
    await expect(
      cloud.sendLinkPreview(CONTACT_ID, "Read", "https://example.test", {
        title: "Preview",
      }),
    ).rejects.toThrow("Custom link preview metadata and thumbnails are not supported on Cloud API");
    await expect(cloud.rejectCall("call-80", CONTACT_ID)).rejects.toThrow(
      "Call rejection is not supported on Cloud API",
    );
  });

  it("keeps group join approval and request changes gated with the flag unset", async () => {
    vi.stubEnv("WA_APP_STATE_WRITES_ENABLED", undefined);
    const { adapter, socket } = createFixture();
    await expect(adapter.setGroupJoinApprovalMode(GROUP_ID, "on")).rejects.toThrow(
      "WhatsApp account, server, and app-state writes are disabled",
    );
    await expect(adapter.handleJoinRequest(GROUP_ID, CONTACT_ID, "approve")).rejects.toThrow(
      "WhatsApp account, server, and app-state writes are disabled",
    );
    expect(socket.groupJoinApprovalMode).not.toHaveBeenCalled();
    expect(socket.groupRequestParticipantsUpdate).not.toHaveBeenCalled();
  });
});
