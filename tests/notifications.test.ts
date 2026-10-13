import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import { registerEventNotifications } from "../src/notifications/events.js";
import type { ChannelEventPayload } from "../src/types/channel.types.js";

const ENV_KEYS = [
  "WA_TRANSCRIPTION_ENABLED",
  "WA_TRANSCRIPTION_API_KEY",
  "WA_TRANSCRIPTION_BASE_URL",
  "WA_TRANSCRIPTION_MODEL",
  "WA_TRANSCRIPTION_LANGUAGE",
  "WA_TRANSCRIPTION_MAX_MB",
  "WA_TRANSCRIPTION_TIMEOUT_MS",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

type EventHandler = Parameters<InstanceManager["onAnyEvent"]>[0];

function audioEvent(): ChannelEventPayload["message.received"] {
  return {
    instanceId: "inst_1234abcd",
    chatId: "5511888888888@s.whatsapp.net",
    message: {
      id: "audio-message-id",
      sender: "5511888888888@s.whatsapp.net",
      timestamp: 1_700_000_000,
      type: "audio",
      content: null,
      mediaUrl: null,
      quotedMessageId: null,
      isFromMe: false,
    },
  };
}

describe("audio message notifications", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.unstubAllGlobals();
  });

  it("adds transcription asynchronously without waiting in the event handler", async () => {
    process.env.WA_TRANSCRIPTION_ENABLED = "true";
    process.env.WA_TRANSCRIPTION_API_KEY = "unit-test-key";

    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ text: "recognized words" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    let resolveDownload!: (result: { data: Buffer; mimeType: string }) => void;
    const pendingDownload = new Promise<{ data: Buffer; mimeType: string }>((resolve) => {
      resolveDownload = resolve;
    });
    const adapter = { downloadMessageAudio: vi.fn(() => pendingDownload) };
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
      },
      getAdapter: () => adapter,
    } as unknown as InstanceManager;
    const notification = vi.fn().mockResolvedValue(undefined);
    const server = {
      server: {
        notification,
        sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as McpServer;

    registerEventNotifications(server, instanceManager);
    const returned = eventHandler!("message.received", "inst_1234abcd", audioEvent());

    expect(returned).toBeUndefined();
    expect(adapter.downloadMessageAudio).toHaveBeenCalledWith(
      "audio-message-id",
      16 * 1024 * 1024,
      60_000,
    );
    expect(notification).not.toHaveBeenCalled();

    resolveDownload({ data: Buffer.from("audio"), mimeType: "audio/ogg" });
    await vi.waitFor(() => expect(notification).toHaveBeenCalledTimes(1));

    const sent = notification.mock.calls[0]?.[0] as {
      params: { message: { transcription?: string } };
    };
    expect(sent.params.message.transcription).toBe("recognized words");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards audio without a transcription when transcription is not configured", () => {
    const notification = vi.fn().mockResolvedValue(undefined);
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
      },
    } as unknown as InstanceManager;
    const server = {
      server: {
        notification,
        sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as McpServer;

    registerEventNotifications(server, instanceManager);
    eventHandler!("message.received", "inst_1234abcd", audioEvent());

    expect(notification).toHaveBeenCalledTimes(1);
    const sent = notification.mock.calls[0]?.[0] as {
      params: { message: { transcription?: string } };
    };
    expect(sent.params.message.transcription).toBeUndefined();
  });

  it("forwards the original event when media download fails", async () => {
    process.env.WA_TRANSCRIPTION_ENABLED = "true";
    process.env.WA_TRANSCRIPTION_API_KEY = "unit-test-key";

    const adapter = {
      downloadMessageAudio: vi.fn().mockRejectedValue(new Error("media unavailable")),
    };
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
      },
      getAdapter: () => adapter,
    } as unknown as InstanceManager;
    const notification = vi.fn().mockResolvedValue(undefined);
    const server = {
      server: {
        notification,
        sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as McpServer;

    registerEventNotifications(server, instanceManager);
    eventHandler!("message.received", "inst_1234abcd", audioEvent());
    await vi.waitFor(() => expect(notification).toHaveBeenCalledTimes(1));

    const sent = notification.mock.calls[0]?.[0] as {
      params: { message: { transcription?: string } };
    };
    expect(sent.params.message.transcription).toBeUndefined();
    expect(adapter.downloadMessageAudio).toHaveBeenCalledOnce();
  });
});
