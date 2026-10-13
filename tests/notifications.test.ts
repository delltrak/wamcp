import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import { TranscriptionService } from "../src/services/transcription.js";
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
  "TRANSCRIPTION_CONCURRENCY",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

type EventHandler = Parameters<InstanceManager["onAnyEvent"]>[0];

function audioEvent(messageId = "audio-message-id"): ChannelEventPayload["message.received"] {
  return {
    instanceId: "inst_1234abcd",
    chatId: "5511888888888@s.whatsapp.net",
    message: {
      id: messageId,
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
    vi.restoreAllMocks();
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

  it("limits concurrent incoming audio downloads and transcriptions", async () => {
    process.env.WA_TRANSCRIPTION_ENABLED = "true";
    process.env.WA_TRANSCRIPTION_API_KEY = "unit-test-key";
    process.env.TRANSCRIPTION_CONCURRENCY = "2";

    const downloadResolvers: Array<(result: { data: Buffer; mimeType: string }) => void> = [];
    const adapter = {
      downloadMessageAudio: vi.fn(
        () =>
          new Promise<{ data: Buffer; mimeType: string }>((resolve) => {
            downloadResolvers.push(resolve);
          }),
      ),
    };
    const transcriptionResolvers: Array<() => void> = [];
    let activeTranscriptions = 0;
    let maxActiveTranscriptions = 0;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          activeTranscriptions++;
          maxActiveTranscriptions = Math.max(maxActiveTranscriptions, activeTranscriptions);
          transcriptionResolvers.push(() => {
            activeTranscriptions--;
            resolve(new Response(JSON.stringify({ text: "recognized words" }), { status: 200 }));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

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
    const eventCount = 4;
    for (let index = 0; index < eventCount; index++) {
      eventHandler!("message.received", "inst_1234abcd", audioEvent(`audio-${index}`));
    }

    expect(adapter.downloadMessageAudio).toHaveBeenCalledTimes(2);
    downloadResolvers[0]!({ data: Buffer.from("audio"), mimeType: "audio/ogg" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(adapter.downloadMessageAudio).toHaveBeenCalledTimes(2);

    transcriptionResolvers[0]!();
    await vi.waitFor(() => expect(adapter.downloadMessageAudio).toHaveBeenCalledTimes(3));
    downloadResolvers[1]!({ data: Buffer.from("audio"), mimeType: "audio/ogg" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(adapter.downloadMessageAudio).toHaveBeenCalledTimes(3);

    transcriptionResolvers[1]!();
    await vi.waitFor(() => expect(adapter.downloadMessageAudio).toHaveBeenCalledTimes(4));
    downloadResolvers[2]!({ data: Buffer.from("audio"), mimeType: "audio/ogg" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    downloadResolvers[3]!({ data: Buffer.from("audio"), mimeType: "audio/ogg" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    transcriptionResolvers[2]!();
    transcriptionResolvers[3]!();

    await vi.waitFor(() => expect(notification).toHaveBeenCalledTimes(eventCount));
    expect(maxActiveTranscriptions).toBeLessThanOrEqual(2);
    expect(maxActiveTranscriptions).toBeGreaterThan(0);
  });

  it("shares audio transcription and the concurrency limit across registrations", async () => {
    process.env.WA_TRANSCRIPTION_ENABLED = "true";
    process.env.WA_TRANSCRIPTION_API_KEY = "unit-test-key";
    process.env.TRANSCRIPTION_CONCURRENCY = "1";
    const transcribe = vi.spyOn(TranscriptionService.prototype, "transcribe");

    const downloadResolvers: Array<(result: { data: Buffer; mimeType: string }) => void> = [];
    let activeJobs = 0;
    let maxActiveJobs = 0;
    const adapter = {
      downloadMessageAudio: vi.fn(
        () =>
          new Promise<{ data: Buffer; mimeType: string }>((resolve) => {
            activeJobs++;
            maxActiveJobs = Math.max(maxActiveJobs, activeJobs);
            downloadResolvers.push(resolve);
          }),
      ),
    };
    const transcriptionResolvers: Array<() => void> = [];
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          transcriptionResolvers.push(() => {
            activeJobs--;
            resolve(new Response(JSON.stringify({ text: "recognized words" }), { status: 200 }));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const eventHandlers = new Set<EventHandler>();
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandlers.add(handler);
        return () => eventHandlers.delete(handler);
      },
      getAdapter: () => adapter,
    } as unknown as InstanceManager;
    const notifications = [
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(undefined),
    ];
    const removeRegistrations = notifications.map((notification) => {
      const server = {
        server: {
          notification,
          sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as McpServer;
      return registerEventNotifications(server, instanceManager);
    });
    const events = [audioEvent("audio-1"), audioEvent("audio-2")];

    for (const event of events) {
      for (const eventHandler of eventHandlers) {
        eventHandler("message.received", "inst_1234abcd", event);
      }
    }

    await vi.waitFor(() => expect(adapter.downloadMessageAudio).toHaveBeenCalledTimes(1));
    expect(activeJobs).toBe(1);
    expect(maxActiveJobs).toBe(1);
    downloadResolvers[0]!({ data: Buffer.from("audio-1"), mimeType: "audio/ogg" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(adapter.downloadMessageAudio).toHaveBeenCalledTimes(1);
    transcriptionResolvers[0]!();

    await vi.waitFor(() => expect(adapter.downloadMessageAudio).toHaveBeenCalledTimes(2));
    expect(maxActiveJobs).toBe(1);
    downloadResolvers[1]!({ data: Buffer.from("audio-2"), mimeType: "audio/ogg" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    transcriptionResolvers[1]!();

    await vi.waitFor(() => {
      for (const notification of notifications) {
        expect(notification).toHaveBeenCalledTimes(events.length);
      }
    });
    expect(adapter.downloadMessageAudio).toHaveBeenCalledTimes(events.length);
    expect(transcribe).toHaveBeenCalledTimes(events.length);
    expect(fetchMock).toHaveBeenCalledTimes(events.length);
    expect(maxActiveJobs).toBe(1);

    for (const notification of notifications) {
      const transcriptions = notification.mock.calls.map(([input]) => {
        const params = (input as { params: { message: { id: string; transcription?: string } } })
          .params;
        return [params.message.id, params.message.transcription];
      });
      expect(transcriptions).toEqual([
        ["audio-1", "recognized words"],
        ["audio-2", "recognized words"],
      ]);
    }

    for (const removeRegistration of removeRegistrations) removeRegistration();
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
