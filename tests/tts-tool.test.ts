import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import type { TtsConfig } from "../src/tts/config.js";
import type { TtsProvider } from "../src/tts/provider.js";
import { TtsService } from "../src/tts/service.js";
import { registerTtsTools } from "../src/tools/tts.tools.js";

type SendVoiceParams = {
  instanceId: string;
  to: string;
  text: string;
  voiceId?: string;
  modelId?: string;
  languageCode?: string;
  quotedMessageId?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speed?: number;
  useSpeakerBoost?: boolean;
};

type ToolHandler = (params: SendVoiceParams) => Promise<unknown>;

const config: TtsConfig = {
  enabled: true,
  provider: "elevenlabs",
  apiKey: "unit-test-only-placeholder",
  defaultVoiceId: "test-voice-id",
  modelId: "eleven_v3",
  outputFormat: "opus_48000_64",
  maxChars: 5000,
  concurrency: 2,
  baseUrl: "https://api.elevenlabs.io",
  timeoutMs: 5000,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TTS MCP tools", () => {
  it("queues generated audio as a quoted PTT note with best-effort recording presence", async () => {
    const audio = Buffer.from("OggS-generated-audio");
    const provider: TtsProvider = {
      synthesize: vi.fn(async () => ({ audio, mimeType: "audio/ogg; codecs=opus" })),
    };
    const service = new TtsService({ config, provider });
    const sendPresence = vi.fn(async () => {});
    const adapter = { sendPresence };
    const getInstanceChannel = vi.fn(() => "baileys");
    const getAdapter = vi.fn(() => adapter);
    const instanceManager = { getInstanceChannel, getAdapter } as unknown as InstanceManager;
    const enqueueMessage = vi.fn(async () => ({ status: "queued" as const, jobId: "job-123" }));
    const messageQueue = { enqueueMessage } as unknown as MessageQueue;
    const handlers = new Map<string, ToolHandler>();
    const server = {
      registerTool: (name: string, _options: unknown, callback: unknown) => {
        handlers.set(name, callback as ToolHandler);
      },
    } as unknown as McpServer;

    registerTtsTools(server, instanceManager, messageQueue, service);
    const handler = handlers.get("wa_send_voice");
    expect(handler).toBeDefined();
    const result = await handler!({
      instanceId: "test-instance",
      to: "0000000000000",
      text: "Hello there",
      quotedMessageId: "quoted-message",
      stability: 0.4,
    });

    expect(result).toMatchObject({
      content: [
        {
          text: JSON.stringify({
            status: "queued",
            jobId: "job-123",
            ptt: true,
            mimeType: "audio/ogg; codecs=opus",
          }),
        },
      ],
    });
    expect(sendPresence.mock.calls).toEqual([
      ["0000000000000", "recording"],
      ["0000000000000", "paused"],
    ]);
    expect(enqueueMessage).toHaveBeenCalledWith(
      "test-instance",
      "0000000000000",
      {
        type: "audio",
        audio: audio.toString("base64"),
        ptt: true,
        mimeType: "audio/ogg; codecs=opus",
        quotedMessageId: "quoted-message",
      },
      "baileys",
    );
    expect(provider.synthesize).toHaveBeenCalledWith(
      "Hello there",
      expect.objectContaining({
        voiceId: "test-voice-id",
        voiceSettings: { stability: 0.4 },
      }),
    );
  });

  it("clears presence and returns a clear error for disabled synthesis", async () => {
    const disabledService = new TtsService({ config: { ...config, enabled: false } });
    const sendPresence = vi.fn(async () => {});
    const instanceManager = {
      getInstanceChannel: vi.fn(() => "baileys"),
      getAdapter: vi.fn(() => ({ sendPresence })),
    } as unknown as InstanceManager;
    const enqueueMessage = vi.fn();
    const handlers = new Map<string, ToolHandler>();
    const server = {
      registerTool: (name: string, _options: unknown, callback: unknown) => {
        handlers.set(name, callback as ToolHandler);
      },
    } as unknown as McpServer;

    registerTtsTools(
      server,
      instanceManager,
      { enqueueMessage } as unknown as MessageQueue,
      disabledService,
    );
    const result = (await handlers.get("wa_send_voice")!({
      instanceId: "test-instance",
      to: "5511999999999",
      text: "Hello",
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/TTS is disabled/i);
    expect(sendPresence).not.toHaveBeenCalled();
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  it("returns a base64 preview without accessing a WhatsApp instance", async () => {
    const audio = Buffer.from("OggS-preview");
    const service = new TtsService({
      config,
      provider: { synthesize: vi.fn(async () => ({ audio, mimeType: "audio/ogg; codecs=opus" })) },
    });
    const instanceManager = {} as InstanceManager;
    const messageQueue = {} as MessageQueue;
    const handlers = new Map<string, ToolHandler>();
    const server = {
      registerTool: (name: string, _options: unknown, callback: unknown) => {
        handlers.set(name, callback as ToolHandler);
      },
    } as unknown as McpServer;

    registerTtsTools(server, instanceManager, messageQueue, service);
    const preview = await handlers.get("wa_tts_preview")!({
      text: "Preview text",
    } as SendVoiceParams);
    expect(preview).toMatchObject({
      content: [
        {
          text: JSON.stringify({
            audio: audio.toString("base64"),
            mimeType: "audio/ogg; codecs=opus",
          }),
        },
      ],
    });
  });
});
