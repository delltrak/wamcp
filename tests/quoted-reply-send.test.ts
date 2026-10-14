import { beforeEach, describe, expect, it, vi } from "vitest";

const queueHarness = vi.hoisted(() => ({
  job: undefined as { id: string; data: unknown } | undefined,
  processor: undefined as ((job: { id: string; data: unknown }) => Promise<void>) | undefined,
  quotedMessage: null as Record<string, unknown> | null,
}));

vi.mock("bullmq", () => {
  class FakeQueue {
    constructor(_name: string, _options: unknown) {}

    async add(_name: string, data: unknown) {
      const job = { id: "quoted-reply-job", data: JSON.parse(JSON.stringify(data)) as unknown };
      queueHarness.job = job;
      return job;
    }

    async close() {}
  }

  class FakeWorker {
    constructor(_name: string, processor: (job: { id: string; data: unknown }) => Promise<void>) {
      queueHarness.processor = processor;
    }

    on() {
      return this;
    }

    async close() {}
  }

  class FakeUnrecoverableError extends Error {}

  return { Queue: FakeQueue, UnrecoverableError: FakeUnrecoverableError, Worker: FakeWorker };
});

vi.mock("../src/db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ get: () => queueHarness.quotedMessage }),
      }),
    }),
  },
}));

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateWAMessageFromContent, type WASocket } from "@whiskeysockets/baileys";
import { UnrecoverableError } from "bullmq";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { MessageQueue } from "../src/services/message-queue.js";
import {
  SendImageSchema,
  SendTextSchema,
  SendVideoSchema,
} from "../src/schemas/messaging.schema.js";
import { registerMessagingTools } from "../src/tools/messaging.tools.js";

function createTestRuntime() {
  const sent: Parameters<WASocket["sendMessage"]>[] = [];
  const socket = {
    user: { id: "5511999999999@s.whatsapp.net" },
    sendMessage: vi.fn(async (...args: Parameters<WASocket["sendMessage"]>) => {
      sent.push(args);
      generateWAMessageFromContent(
        args[0],
        { extendedTextMessage: { text: "Mock outgoing message" } },
        { ...args[2], userJid: "5511999999999@s.whatsapp.net" },
      );
      return { key: { id: "outgoing-message-id" } };
    }),
  } as unknown as WASocket;
  const adapter = new BaileysAdapter("instance-1");
  Object.assign(adapter, { sock: socket, status: "connected" });

  const messageQueue = new MessageQueue();
  messageQueue.setAdapterResolver(() => adapter);

  const tools = new Map<string, (params: unknown) => Promise<unknown>>();
  const server = {
    registerTool(name: string, _config: unknown, handler: (params: unknown) => Promise<unknown>) {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  registerMessagingTools(server, { getInstanceChannel: () => adapter } as never, messageQueue);

  return { adapter, messageQueue, sent, tools };
}

describe("quoted outbound messages", () => {
  beforeEach(() => {
    queueHarness.job = undefined;
    queueHarness.processor = undefined;
    queueHarness.quotedMessage = {
      id: "incoming-message-id",
      instanceId: "instance-1",
      chatId: "5511999999999@s.whatsapp.net",
      senderId: "5511888888888@s.whatsapp.net",
      type: "text",
      content: "Original incoming message",
      isFromMe: 0,
      rawData: null,
    };
  });

  it("preserves and resolves a quoted message from the tool through the worker", async () => {
    const { messageQueue, sent, tools } = createTestRuntime();

    const params = SendTextSchema.parse({
      instanceId: "instance-1",
      to: "5511999999999",
      text: "Reply text",
      quotedMessageId: "incoming-message-id",
    });
    await tools.get("wa_send_text")!(params);

    expect(queueHarness.job?.data).toEqual({
      instanceId: "instance-1",
      to: "5511999999999",
      content: {
        type: "text",
        text: "Reply text",
        quotedMessageId: "incoming-message-id",
      },
    });

    await queueHarness.processor!(queueHarness.job!);

    expect(sent[0]?.[2]).toEqual({
      quoted: {
        key: {
          remoteJid: "5511999999999@s.whatsapp.net",
          id: "incoming-message-id",
          fromMe: false,
        },
        message: { conversation: "Original incoming message" },
      },
    });

    await messageQueue.close();
  });

  it("includes the sender participant for a group quote from this account", async () => {
    queueHarness.quotedMessage = {
      id: "incoming-message-id",
      instanceId: "instance-1",
      chatId: "120363000000000000@g.us",
      senderId: "me",
      type: "text",
      content: "My earlier group message",
      isFromMe: 1,
      timestamp: 123456789,
      rawData: null,
    };
    const { messageQueue, sent, tools } = createTestRuntime();

    await tools.get("wa_send_text")!(
      SendTextSchema.parse({
        instanceId: "instance-1",
        to: "120363000000000000@g.us",
        text: "Group reply",
        quotedMessageId: "incoming-message-id",
      }),
    );
    await queueHarness.processor!(queueHarness.job!);

    expect(sent[0]?.[2]).toEqual({
      quoted: {
        key: {
          remoteJid: "120363000000000000@g.us",
          id: "incoming-message-id",
          fromMe: true,
          participant: "5511999999999@s.whatsapp.net",
        },
        message: { conversation: "My earlier group message" },
        messageTimestamp: 123456789,
      },
    });
    await messageQueue.close();
  });

  it.each([
    {
      tool: "wa_send_image",
      params: {
        instanceId: "instance-1",
        to: "5511999999999",
        image: "https://example.test/image.png",
        quotedMessageId: "incoming-message-id",
      },
      parse: SendImageSchema.parse,
    },
    {
      tool: "wa_send_video",
      params: {
        instanceId: "instance-1",
        to: "5511999999999",
        video: "https://example.test/video.mp4",
        quotedMessageId: "incoming-message-id",
      },
      parse: SendVideoSchema.parse,
    },
  ])("uses the same resolved quote path for $tool", async ({ tool, params, parse }) => {
    const { messageQueue, sent, tools } = createTestRuntime();
    await tools.get(tool)!(parse(params));
    await queueHarness.processor!(queueHarness.job!);

    expect(sent[0]?.[2]).toMatchObject({
      quoted: {
        key: {
          remoteJid: "5511999999999@s.whatsapp.net",
          id: "incoming-message-id",
          fromMe: false,
        },
        message: { conversation: "Original incoming message" },
      },
    });
    await messageQueue.close();
  });

  it("returns a clear tool error when the quote is unavailable", async () => {
    queueHarness.quotedMessage = null;
    const { messageQueue, tools } = createTestRuntime();

    const result = (await tools.get("wa_send_text")!(
      SendTextSchema.parse({
        instanceId: "instance-1",
        to: "5511999999999",
        text: "Reply text",
        quotedMessageId: "missing-message-id",
      }),
    )) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Quoted message 'missing-message-id' could not be resolved",
    );
    expect(queueHarness.job).toBeUndefined();
    await messageQueue.close();
  });

  it("marks a quote that disappears after enqueueing as unrecoverable", async () => {
    const { messageQueue, tools } = createTestRuntime();
    await tools.get("wa_send_text")!(
      SendTextSchema.parse({
        instanceId: "instance-1",
        to: "5511999999999",
        text: "Reply text",
        quotedMessageId: "incoming-message-id",
      }),
    );
    queueHarness.quotedMessage = null;

    await expect(queueHarness.processor!(queueHarness.job!)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await messageQueue.close();
  });
});
