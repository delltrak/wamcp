import { beforeEach, describe, expect, it, vi } from "vitest";

const queueHarness = vi.hoisted(() => ({
  job: undefined as { id: string; data: unknown } | undefined,
  processor: undefined as ((job: { id: string; data: unknown }) => Promise<void>) | undefined,
  addOptions: undefined as Record<string, unknown> | undefined,
  limiter: undefined as { max: number; duration: number } | undefined,
  quotedMessage: null as Record<string, unknown> | null,
}));

const pttHarness = vi.hoisted(() => ({
  preparePttAudio: vi.fn(
    async (
      audio: Uint8Array,
      mimeType?: string,
    ): Promise<{
      audio: Uint8Array;
      mimeType: string;
      seconds?: number;
      waveform?: Uint8Array;
    }> => ({
      audio,
      mimeType: mimeType ?? "audio/ogg; codecs=opus",
      seconds: 3,
      waveform: new Uint8Array(64).fill(73),
    }),
  ),
}));

vi.mock("../src/tts/waveform.js", () => ({
  preparePttAudio: pttHarness.preparePttAudio,
}));

vi.mock("bullmq", () => {
  class FakeQueue {
    constructor(_name: string, _options: unknown) {}

    async add(_name: string, data: unknown, options?: Record<string, unknown>) {
      const job = { id: "quoted-reply-job", data: JSON.parse(JSON.stringify(data)) as unknown };
      queueHarness.job = job;
      queueHarness.addOptions = options;
      return job;
    }

    async close() {}
  }

  class FakeWorker {
    constructor(
      _name: string,
      processor: (job: { id: string; data: unknown }) => Promise<void>,
      options?: { limiter?: { max: number; duration: number } },
    ) {
      queueHarness.processor = processor;
      queueHarness.limiter = options?.limiter;
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
import { registerTtsTools } from "../src/tools/tts.tools.js";
import {
  SendAudioSchema,
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
  const instanceManager = {
    getInstanceChannel: () => "baileys",
    getAdapter: () => adapter,
  };
  registerMessagingTools(server, instanceManager as never, messageQueue);
  registerTtsTools(server, instanceManager as never, messageQueue, {
    assertConfigured() {},
    assertTextWithinLimit() {},
    resolveVoiceId: () => "test-voice",
    synthesize: async () => ({
      audio: Buffer.from("OggS TTS fixture"),
      mimeType: "audio/ogg; codecs=opus",
    }),
    listVoices: async () => [],
  } as never);

  return { adapter, messageQueue, sent, tools };
}

describe("quoted outbound messages", () => {
  beforeEach(() => {
    queueHarness.job = undefined;
    queueHarness.processor = undefined;
    queueHarness.addOptions = undefined;
    queueHarness.limiter = undefined;
    pttHarness.preparePttAudio.mockClear();
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

  it("runs bounded album jobs through the configured Baileys rate limiter", async () => {
    vi.stubEnv("WA_BAILEYS_RATE_LIMIT", "3");
    const { messageQueue, sent } = createTestRuntime();
    await messageQueue.enqueueMediaAlbum("instance-1", "5511999999999", [
      { image: Buffer.from("one").toString("base64") },
      { image: Buffer.from("two").toString("base64") },
    ]);

    expect(queueHarness.limiter).toEqual({ max: 3, duration: 60_000 });
    expect(queueHarness.addOptions).toEqual({ attempts: 1 });
    expect(queueHarness.job?.data).toMatchObject({ kind: "album", images: expect.any(Array) });
    await queueHarness.processor!(queueHarness.job!);
    expect(sent).toHaveLength(3);

    await messageQueue.close();
  });

  it("serializes PTT audio through BullMQ and attaches Uint8Array waveform in the worker", async () => {
    const { messageQueue, sent, tools } = createTestRuntime();
    const audio = Buffer.from("voice note fixture");
    await tools.get("wa_send_audio")!(
      SendAudioSchema.parse({
        instanceId: "instance-1",
        to: "test-recipient@s.whatsapp.net",
        audio: audio.toString("base64"),
        ptt: true,
      }),
    );

    expect(queueHarness.job?.data).toEqual({
      instanceId: "instance-1",
      to: "test-recipient@s.whatsapp.net",
      content: {
        type: "audio",
        audio: audio.toString("base64"),
        ptt: true,
      },
    });
    expect(queueHarness.job?.data).not.toHaveProperty("content.waveform");

    await queueHarness.processor!(queueHarness.job!);

    expect(pttHarness.preparePttAudio).toHaveBeenCalledWith(audio, undefined);
    const payload = sent[0]?.[1] as {
      audio: Buffer;
      ptt: boolean;
      mimetype: string;
      seconds?: number;
      waveform?: Uint8Array;
    };
    expect(payload).toMatchObject({
      audio,
      ptt: true,
      mimetype: "audio/ogg; codecs=opus",
      seconds: 3,
    });
    expect(payload.waveform).toBeInstanceOf(Uint8Array);
    expect(payload.waveform).toHaveLength(64);
    expect([...payload.waveform!]).toEqual(Array(64).fill(73));

    await messageQueue.close();
  });

  it("sends wa_send_voice through the same waveform metadata path", async () => {
    const { messageQueue, sent, tools } = createTestRuntime();
    await tools.get("wa_send_voice")!({
      instanceId: "instance-1",
      to: "test-recipient@s.whatsapp.net",
      text: "A synthesized voice note.",
    });

    expect(queueHarness.job?.data).toMatchObject({
      content: {
        type: "audio",
        ptt: true,
        mimeType: "audio/ogg; codecs=opus",
      },
    });
    await queueHarness.processor!(queueHarness.job!);

    const payload = sent[0]?.[1] as {
      ptt: boolean;
      seconds?: number;
      waveform?: Uint8Array;
    };
    expect(payload.ptt).toBe(true);
    expect(payload.seconds).toBe(3);
    expect(payload.waveform).toBeInstanceOf(Uint8Array);
    expect(payload.waveform).toHaveLength(64);
    expect(pttHarness.preparePttAudio).toHaveBeenCalledTimes(1);

    await messageQueue.close();
  });

  it("continues the PTT send without metadata when waveform preparation fails", async () => {
    const { messageQueue, sent, tools } = createTestRuntime();
    const audio = Buffer.from("voice note fixture");
    pttHarness.preparePttAudio.mockResolvedValueOnce({
      audio,
      mimeType: "audio/ogg; codecs=opus",
    });

    await tools.get("wa_send_audio")!(
      SendAudioSchema.parse({
        instanceId: "instance-1",
        to: "test-recipient@s.whatsapp.net",
        audio: audio.toString("base64"),
        ptt: true,
      }),
    );
    await queueHarness.processor!(queueHarness.job!);

    const payload = sent[0]?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({ audio, ptt: true, mimetype: "audio/ogg; codecs=opus" });
    expect(payload).not.toHaveProperty("seconds");
    expect(payload).not.toHaveProperty("waveform");
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
