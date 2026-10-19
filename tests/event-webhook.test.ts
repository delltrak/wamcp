import { createHmac } from "node:crypto";
import { UnrecoverableError } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceManager } from "../src/services/instance-manager.js";
import { TranscriptionService } from "../src/services/transcription.js";
import {
  calculateEventWebhookBackoff,
  createEventWebhookHeaders,
  createPinnedWebhookConnectionOptions,
  EventWebhookRetryableError,
  eventWebhookBackoffStrategy,
  eventWebhookDestinationIdentity,
  eventWebhookFailureLogData,
  eventWebhookJobOptions,
  normalizeGrokBotWebhookPayload,
  normalizeEventWebhookPayload,
  parseEventWebhookRetryAfter,
  postEventWebhook,
  processEventWebhookJob,
  registerEventWebhookHandler,
  shouldSendEventWebhook,
  type EventWebhookJob,
} from "../src/services/event-webhook.js";
import { loadEventWebhookConfig } from "../src/services/event-webhook-config.js";
import type { ChannelEventPayload } from "../src/types/channel.types.js";
import { logger } from "../src/utils/logger.js";
import { createShutdownHandler, installShutdownHandlers } from "../src/utils/shutdown.js";
import { isNonPublicIp } from "../src/utils/validation.js";

type EventHandler = Parameters<InstanceManager["onAnyEvent"]>[0];

function incomingMessage(isFromMe = false): ChannelEventPayload["message.received"] {
  return {
    instanceId: "inst_1234abcd",
    chatId: "5511888888888@s.whatsapp.net",
    message: {
      id: "wamid.abc123",
      sender: "5511888888888@s.whatsapp.net",
      timestamp: 1_700_000_000,
      type: "text",
      content: "hello",
      mediaUrl: null,
      quotedMessageId: null,
      isFromMe,
    },
  };
}

function configuredWebhook(overrides: Record<string, string | undefined> = {}) {
  return loadEventWebhookConfig({
    WA_EVENT_WEBHOOK_URL: "https://hooks.example.test/receive",
    ...overrides,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("outgoing event webhook config", () => {
  it("uses safe defaults and remains disabled without a destination URL", () => {
    const config = loadEventWebhookConfig({});

    expect(config.destinations).toEqual([]);
    expect(config.events).toEqual(["message.received"]);
    expect(config.ignoreFromMe).toBe(true);
    expect(config.timeoutMs).toBe(10_000);
    expect(config.retryAttempts).toBe(5);
    expect(config.retryDelayMs).toBe(1_000);
    expect(config.messageDebounceMs).toBe(0);
    expect(config.messageDebounceMaxMs).toBe(30_000);
  });

  it("clamps the maximum wait to the debounce window and warns on invalid values", () => {
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const clamped = loadEventWebhookConfig({
      WA_WEBHOOK_DEBOUNCE_MS: "2000",
      WA_WEBHOOK_DEBOUNCE_MAX_MS: "500",
    });
    expect(clamped.messageDebounceMs).toBe(2_000);
    expect(clamped.messageDebounceMaxMs).toBe(2_000);
    expect(warning).toHaveBeenCalledOnce();

    const invalid = loadEventWebhookConfig({
      WA_WEBHOOK_DEBOUNCE_MS: "not-a-number",
      WA_WEBHOOK_DEBOUNCE_MAX_MS: "-1",
    });
    expect(invalid.messageDebounceMs).toBe(0);
    expect(invalid.messageDebounceMaxMs).toBe(30_000);
    expect(warning).toHaveBeenCalledTimes(3);
  });

  it.each([
    "0.0.0.0",
    "10.0.0.8",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:10.0.0.8",
    "fc00::1",
    "fe80::1",
    "ff02::1",
  ])("blocks non-public address %s", (address) => {
    expect(isNonPublicIp(address)).toBe(true);
  });

  it("uses a deployment-specific queue prefix unless an explicit prefix is configured", () => {
    const first = loadEventWebhookConfig({ HOSTNAME: "deployment-a" }).queuePrefix;
    const second = loadEventWebhookConfig({ HOSTNAME: "deployment-b" }).queuePrefix;
    const configured = loadEventWebhookConfig({
      HOSTNAME: "deployment-a",
      WA_EVENT_WEBHOOK_QUEUE_PREFIX: "production-webhooks",
    }).queuePrefix;

    expect(first).not.toBe(second);
    expect(configured).toBe("production-webhooks");
    expect(() =>
      loadEventWebhookConfig({ WA_EVENT_WEBHOOK_QUEUE_PREFIX: "invalid:prefix" }),
    ).toThrow("Invalid WA_EVENT_WEBHOOK_QUEUE_PREFIX");
  });

  it("parses filters, timeouts, retries, JSON headers, and auth header settings", () => {
    const config = configuredWebhook({
      WA_EVENT_WEBHOOK_EVENTS: "message.received, event.response, message.edited, message.received",
      WA_EVENT_WEBHOOK_IGNORE_FROM_ME: "false",
      WA_EVENT_WEBHOOK_TIMEOUT_MS: "2500",
      WA_EVENT_WEBHOOK_RETRY_ATTEMPTS: "4",
      WA_EVENT_WEBHOOK_RETRY_DELAY_MS: "300",
      WA_EVENT_WEBHOOK_HEADERS: '{"X-Api-Key":"json-value","X-Trace":"test"}',
      WA_EVENT_WEBHOOK_AUTH_HEADER: "X-Api-Key",
      WA_EVENT_WEBHOOK_AUTH_VALUE: "header-secret",
      WA_EVENT_WEBHOOK_SECRET: "hmac-secret",
    });

    expect(config.events).toEqual(["message.received", "event.response", "message.edited"]);
    expect(config.ignoreFromMe).toBe(false);
    expect(config.timeoutMs).toBe(2500);
    expect(config.retryAttempts).toBe(4);
    expect(config.retryDelayMs).toBe(300);
    expect(config.destinations[0]).toMatchObject({
      id: "default",
      headers: { "x-api-key": "header-secret", "x-trace": "test" },
      secret: "hmac-secret",
    });
    expect(eventWebhookJobOptions(config)).toMatchObject({
      attempts: 4,
      backoff: { type: "wa-event-webhook", delay: 300 },
    });
  });

  it("requires HTTPS unless HTTP is explicitly allowed and rejects private destinations", () => {
    expect(() =>
      loadEventWebhookConfig({ WA_EVENT_WEBHOOK_URL: "http://hooks.example.test" }),
    ).toThrow("Invalid WA_EVENT_WEBHOOK_URL");
    expect(
      loadEventWebhookConfig({
        WA_EVENT_WEBHOOK_URL: "http://hooks.example.test/receive",
        WA_EVENT_WEBHOOK_ALLOW_HTTP: "true",
      }).destinations,
    ).toHaveLength(1);
    expect(() =>
      loadEventWebhookConfig({
        WA_EVENT_WEBHOOK_URL: "https://127.0.0.1/receive",
      }),
    ).toThrow("Invalid WA_EVENT_WEBHOOK_URL");
    expect(() =>
      loadEventWebhookConfig({
        WA_EVENT_WEBHOOK_URL: "https://[::ffff:127.0.0.1]/receive",
      }),
    ).toThrow("Invalid WA_EVENT_WEBHOOK_URL");
    expect(() =>
      loadEventWebhookConfig({
        WA_EVENT_WEBHOOK_URL: "https://receiver.localhost/receive",
      }),
    ).toThrow("Invalid WA_EVENT_WEBHOOK_URL");
  });

  it("rejects malformed header and event configuration without echoing values", () => {
    const headerSecret = "never-echo-this-header";
    expect(() =>
      configuredWebhook({ WA_EVENT_WEBHOOK_HEADERS: `{"Authorization":"${headerSecret}"` }),
    ).toThrow("Invalid WA_EVENT_WEBHOOK_HEADERS");
    expect(() => configuredWebhook({ WA_EVENT_WEBHOOK_EVENTS: "unknown.event" })).toThrow(
      "Invalid WA_EVENT_WEBHOOK_EVENTS",
    );
    expect(() =>
      configuredWebhook({
        WA_EVENT_WEBHOOK_AUTH_HEADER: "Authorization",
        WA_EVENT_WEBHOOK_AUTH_VALUE: undefined,
      }),
    ).toThrow("must be configured together");
  });

  it("loads multiple destinations with independent presets, secrets, events and allowlists", () => {
    const config = loadEventWebhookConfig({
      WA_EVENT_WEBHOOKS: JSON.stringify([
        {
          id: "owner",
          url: "https://hooks.example.test/owner",
          preset: "grok-bot",
          authHeader: "X-Owner-Key",
          authEnv: "OWNER_ROUTINE_KEY",
          secretEnv: "OWNER_HMAC_SECRET",
          chatAllowlist: ["chat-1"],
          senderAllowlist: ["sender-1"],
          debounceMs: 2_000,
        },
        {
          id: "audit",
          url: "https://hooks.example.test/audit",
          headers: { "X-Audit": "enabled" },
          events: ["message.edited"],
        },
      ]),
      OWNER_ROUTINE_KEY: "routine-secret",
      OWNER_HMAC_SECRET: "hmac-secret",
    });

    expect(config.destinations).toHaveLength(2);
    expect(config.destinations[0]).toMatchObject({
      id: "owner",
      preset: "grok-bot",
      headers: { "x-owner-key": "routine-secret" },
      secret: "hmac-secret",
      events: ["message.received"],
      chatAllowlist: ["chat-1"],
      senderAllowlist: ["sender-1"],
      debounceMs: 2_000,
    });
    expect(config.destinations[1]).toMatchObject({
      id: "audit",
      events: ["message.edited"],
      headers: { "x-audit": "enabled" },
      ignoreFromMe: true,
      debounceMs: 0,
    });
  });

  it("keeps the legacy single destination variables working with the Grok Bot preset", () => {
    const config = configuredWebhook({
      WA_EVENT_WEBHOOK_PRESET: "grok-bot",
      WA_EVENT_WEBHOOK_AUTH_VALUE: "routine-secret",
    });

    expect(config.destinations[0]).toMatchObject({
      id: "default",
      preset: "grok-bot",
      headers: { "x-grok-bot-key": "routine-secret" },
      events: ["message.received"],
      ignoreFromMe: true,
    });
  });
});

describe("outgoing event webhook events", () => {
  it("filters unconfigured events and ignores self-sent messages by default", () => {
    const config = configuredWebhook();
    expect(shouldSendEventWebhook("message.received", incomingMessage(), config)).toBe(true);
    expect(shouldSendEventWebhook("message.received", incomingMessage(true), config)).toBe(false);
    expect(
      shouldSendEventWebhook(
        "message.edited",
        {
          instanceId: "inst_1234abcd",
          chatId: "chat",
          messageId: "message",
          newContent: "updated",
          editedAt: 1,
        },
        config,
      ),
    ).toBe(false);

    const includeSelf = configuredWebhook({ WA_EVENT_WEBHOOK_IGNORE_FROM_ME: "false" });
    expect(shouldSendEventWebhook("message.received", incomingMessage(true), includeSelf)).toBe(
      true,
    );
  });

  it("sends lifecycle events when chat and sender allowlists are configured", () => {
    const destination = loadEventWebhookConfig({
      WA_EVENT_WEBHOOKS: JSON.stringify([
        {
          id: "lifecycle",
          url: "https://hooks.example.test/lifecycle",
          events: ["instance.disconnected"],
          chatAllowlist: ["allowed-chat"],
          senderAllowlist: ["allowed-sender"],
        },
      ]),
    }).destinations[0]!;
    const disconnected: ChannelEventPayload["instance.disconnected"] = {
      instanceId: "inst_1234abcd",
      reason: "logged out",
      statusCode: 401,
      loggedOut: true,
      willReconnect: false,
      disconnectedAt: 1_800_000_123_000,
    };

    expect(shouldSendEventWebhook("instance.disconnected", disconnected, destination)).toBe(true);
    expect(
      shouldSendEventWebhook("message.received", incomingMessage(), {
        ...destination,
        events: ["message.received"],
      }),
    ).toBe(false);
  });

  it("normalizes message.received to the documented JSON fields", () => {
    expect(
      normalizeEventWebhookPayload("message.received", "inst_1234abcd", incomingMessage()),
    ).toEqual({
      event: "message.received",
      instanceId: "inst_1234abcd",
      chat: "5511888888888@s.whatsapp.net",
      sender: "5511888888888@s.whatsapp.net",
      type: "text",
      text: "hello",
      timestamp: 1_700_000_000,
      isForwarded: false,
    });
  });

  it("normalizes decrypted event responses with their status and participant", () => {
    const response: ChannelEventPayload["event.response"] = {
      instanceId: "inst_1234abcd",
      chatId: "5511888888888@g.us",
      eventMessageId: "event_123",
      participant: "5511777777777@s.whatsapp.net",
      responseMessageId: "response_123",
      status: "GOING",
      timestamp: 1_800_000_123_000,
      extraGuestCount: 1,
    };

    expect(normalizeEventWebhookPayload("event.response", "inst_1234abcd", response)).toEqual({
      event: "event.response",
      instanceId: "inst_1234abcd",
      chat: "5511888888888@g.us",
      sender: "5511777777777@s.whatsapp.net",
      type: "event.response",
      text: null,
      timestamp: 1_800_000_123_000,
      eventMessageId: "event_123",
      responseMessageId: "response_123",
      participant: "5511777777777@s.whatsapp.net",
      status: "GOING",
      extraGuestCount: 1,
    });
  });

  it("includes the forwarded flag in generic and Grok Bot webhook payloads", () => {
    const forwarded = {
      ...incomingMessage(),
      message: { ...incomingMessage().message, isForwarded: true },
    };

    expect(
      normalizeEventWebhookPayload("message.received", "inst_1234abcd", forwarded).isForwarded,
    ).toBe(true);
    expect(normalizeGrokBotWebhookPayload("inst_1234abcd", forwarded).isForwarded).toBe(true);
  });

  it("adds media MIME type, filename, caption, and known size to webhook payloads", () => {
    const mediaMessage: ChannelEventPayload["message.received"] = {
      ...incomingMessage(),
      message: {
        ...incomingMessage().message,
        type: "document",
        content: "Quarterly report",
        mediaUrl: "cloud-media-123",
        mediaMimetype: "application/pdf",
        mimeType: "application/pdf",
        mediaFileName: "report.pdf",
        fileName: "report.pdf",
        mediaSize: 4096,
        size: 4096,
        mediaCaption: "Quarterly report",
        caption: "Quarterly report",
      },
    };

    expect(
      normalizeEventWebhookPayload("message.received", "inst_1234abcd", mediaMessage),
    ).toMatchObject({
      type: "document",
      mimeType: "application/pdf",
      fileName: "report.pdf",
      caption: "Quarterly report",
      size: 4096,
    });
    expect(normalizeGrokBotWebhookPayload("inst_1234abcd", mediaMessage)).toMatchObject({
      type: "document",
      mimeType: "application/pdf",
      fileName: "report.pdf",
      caption: "Quarterly report",
      size: 4096,
    });
  });

  it("filters Grok Bot self messages, statuses, broadcasts and allowlists", () => {
    const destination = loadEventWebhookConfig({
      WA_EVENT_WEBHOOKS: JSON.stringify([
        {
          id: "grok",
          url: "https://hooks.example.test/grok",
          preset: "grok-bot",
          chatAllowlist: ["allowed-chat"],
          senderAllowlist: ["allowed-sender"],
        },
      ]),
    }).destinations[0];
    const allowedMessage = {
      ...incomingMessage(),
      chatId: "allowed-chat",
      message: { ...incomingMessage().message, sender: "allowed-sender" },
    };

    expect(shouldSendEventWebhook("message.received", allowedMessage, destination)).toBe(true);
    expect(
      shouldSendEventWebhook(
        "message.received",
        { ...allowedMessage, message: { ...allowedMessage.message, isFromMe: true } },
        destination,
      ),
    ).toBe(false);
    expect(
      shouldSendEventWebhook(
        "message.received",
        { ...allowedMessage, chatId: "status@broadcast" },
        destination,
      ),
    ).toBe(false);
    expect(
      shouldSendEventWebhook(
        "message.received",
        { ...allowedMessage, chatId: "1234567890@broadcast" },
        destination,
      ),
    ).toBe(false);
    expect(
      shouldSendEventWebhook(
        "message.received",
        { ...allowedMessage, chatId: "other-chat" },
        destination,
      ),
    ).toBe(false);
    expect(
      shouldSendEventWebhook(
        "message.received",
        { ...allowedMessage, message: { ...allowedMessage.message, sender: "other-sender" } },
        destination,
      ),
    ).toBe(false);
    expect(
      shouldSendEventWebhook(
        "message.edited",
        {
          instanceId: "inst_1234abcd",
          chatId: "allowed-chat",
          messageId: "message",
          newContent: "updated",
          editedAt: 1,
        },
        destination,
      ),
    ).toBe(false);
  });

  it("normalizes a lean Grok Bot body with names and media metadata only", () => {
    const incoming = incomingMessage();
    const grokMessage = {
      ...incoming,
      chatName: null,
      senderName: "Alex",
      message: {
        ...incoming.message,
        type: "image" as const,
        content: "caption",
        mediaUrl: "cloud-media-123",
      },
    };

    expect(normalizeGrokBotWebhookPayload("inst_1234abcd", grokMessage)).toEqual({
      instanceId: "inst_1234abcd",
      chatId: "5511888888888@s.whatsapp.net",
      chatName: "Alex",
      senderId: "5511888888888@s.whatsapp.net",
      senderName: "Alex",
      isGroup: false,
      type: "image",
      text: "caption",
      timestamp: 1_700_000_000,
      messageId: "wamid.abc123",
      isForwarded: false,
      media: { id: "cloud-media-123" },
    });

    const binaryUrl = {
      ...grokMessage,
      message: { ...grokMessage.message, mediaUrl: "data:application/octet-stream;base64,AAAA" },
    };
    expect(normalizeGrokBotWebhookPayload("inst_1234abcd", binaryUrl)).not.toHaveProperty("media");
  });

  it("does not let queue failures escape the channel event handler", async () => {
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
        return () => {
          eventHandler = undefined;
        };
      },
    } as unknown as InstanceManager;
    const failureMessage = "failed https://hooks.example.test/?token=hidden bearer hidden";
    const enqueue = vi.fn<(_: EventWebhookJob) => Promise<unknown>>(() =>
      Promise.reject(new Error(failureMessage)),
    );
    const warning = vi.fn();
    registerEventWebhookHandler(instanceManager, configuredWebhook(), enqueue, warning);

    expect(eventHandler?.("message.received", "inst_1234abcd", incomingMessage())).toBeUndefined();
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    expect(warning).toHaveBeenCalledWith();
  });

  it("delivers each event to its configured destination using its selected payload", async () => {
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
        return () => {
          eventHandler = undefined;
        };
      },
    } as unknown as InstanceManager;
    const config = loadEventWebhookConfig({
      WA_EVENT_WEBHOOKS: JSON.stringify([
        { id: "grok", url: "https://hooks.example.test/grok", preset: "grok-bot" },
        { id: "legacy", url: "https://hooks.example.test/legacy" },
      ]),
    });
    const enqueue = vi.fn<(_: EventWebhookJob) => Promise<unknown>>(() => Promise.resolve());
    registerEventWebhookHandler(instanceManager, config, enqueue);

    eventHandler?.("message.received", "inst_1234abcd", incomingMessage());
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationId: "grok",
        payload: expect.objectContaining({
          chatId: "5511888888888@s.whatsapp.net",
          messageId: "wamid.abc123",
        }),
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationId: "legacy",
        payload: expect.objectContaining({
          event: "message.received",
          chat: "5511888888888@s.whatsapp.net",
        }),
      }),
    );
  });

  it("warns when per-chat batching overrides destination debounce", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
        return () => {
          eventHandler = undefined;
        };
      },
    } as unknown as InstanceManager;
    const events = ["message.received", "message.edited"] as const;
    const config = loadEventWebhookConfig({
      WA_WEBHOOK_DEBOUNCE_MS: "100",
      WA_WEBHOOK_DEBOUNCE_MAX_MS: "1000",
      WA_EVENT_WEBHOOKS: JSON.stringify([
        {
          id: "owner",
          url: "https://hooks.example.test/owner",
          events,
          debounceMs: 1_000,
        },
        {
          id: "audit",
          url: "https://hooks.example.test/audit",
          events,
          debounceMs: 2_000,
        },
        {
          id: "immediate",
          url: "https://hooks.example.test/immediate",
          events,
        },
      ]),
    });
    const enqueue = vi.fn<(_: EventWebhookJob) => Promise<unknown>>(() => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(instanceManager, config, enqueue);

    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(
      { destinationId: "owner", debounceMs: 1_000 },
      "Destination debounce is ignored while per-chat batching is enabled",
    );
    expect(warning).toHaveBeenCalledWith(
      { destinationId: "audit", debounceMs: 2_000 },
      "Destination debounce is ignored while per-chat batching is enabled",
    );

    eventHandler?.("message.edited", "inst_1234abcd", {
      instanceId: "inst_1234abcd",
      chatId: "5511888888888@s.whatsapp.net",
      messageId: "wamid.edited",
      newContent: "edited",
      editedAt: 1_700_000_001,
    });
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(enqueue.mock.calls.map(([job]) => job.destinationId)).toEqual([
      "owner",
      "audit",
      "immediate",
    ]);

    eventHandler?.("message.received", "inst_1234abcd", incomingMessage());
    expect(enqueue).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(enqueue).toHaveBeenCalledTimes(6);
    expect(enqueue.mock.calls.slice(3).map(([job]) => job.destinationId)).toEqual([
      "owner",
      "audit",
      "immediate",
    ]);
    expect(enqueue.mock.calls.slice(3).map(([job]) => job.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messages: [expect.objectContaining({ text: "hello" })] }),
      ]),
    );

    unsubscribe();
    await unsubscribe.flush();
  });

  it("batches without dropping messages and flushes on the configured window", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
        return () => {
          eventHandler = undefined;
        };
      },
    } as unknown as InstanceManager;
    const config = loadEventWebhookConfig({
      WA_WEBHOOK_DEBOUNCE_MS: "0",
      WA_EVENT_WEBHOOKS: JSON.stringify([
        {
          id: "grok",
          url: "https://hooks.example.test/grok",
          preset: "grok-bot",
          debounceMs: 1_000,
        },
      ]),
    });
    const enqueue = vi.fn<(_: EventWebhookJob) => Promise<unknown>>(() => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(instanceManager, config, enqueue);

    eventHandler?.("message.received", "inst_1234abcd", incomingMessage());
    eventHandler?.("message.received", "inst_1234abcd", {
      ...incomingMessage(),
      message: { ...incomingMessage().message, id: "wamid.second", content: "second" },
    });
    expect(enqueue).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    expect(warning).not.toHaveBeenCalled();
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      destinationId: "grok",
      payload: {
        messages: [
          { messageId: "wamid.abc123", text: "hello" },
          { messageId: "wamid.second", text: "second" },
        ],
      },
    });
    unsubscribe();
    await unsubscribe.flush();
  });

  it("batches incoming messages per chat and keeps the last message at the top level", async () => {
    vi.useFakeTimers();
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
        return () => {
          eventHandler = undefined;
        };
      },
    } as unknown as InstanceManager;
    const config = configuredWebhook({
      WA_WEBHOOK_DEBOUNCE_MS: "500",
      WA_WEBHOOK_DEBOUNCE_MAX_MS: "2000",
    });
    const enqueue = vi.fn<(_: EventWebhookJob) => Promise<unknown>>(() => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(instanceManager, config, enqueue);

    for (const [index, text] of ["first", "second", "third"].entries()) {
      eventHandler?.("message.received", "inst_1234abcd", {
        ...incomingMessage(),
        message: { ...incomingMessage().message, id: `message-${index}`, content: text },
      });
      if (index < 2) await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(500);

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]?.[0].payload).toMatchObject({
      event: "message.received",
      text: "third",
      messages: [{ text: "first" }, { text: "second" }, { text: "third" }],
    });

    unsubscribe();
    await unsubscribe.flush();
  });

  it("restarts the debounce window when another message arrives", async () => {
    vi.useFakeTimers();
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
        return () => undefined;
      },
    } as unknown as InstanceManager;
    const config = configuredWebhook({ WA_WEBHOOK_DEBOUNCE_MS: "500" });
    const enqueue = vi.fn<(_: EventWebhookJob) => Promise<unknown>>(() => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(instanceManager, config, enqueue);

    eventHandler?.("message.received", "inst_1234abcd", incomingMessage());
    await vi.advanceTimersByTimeAsync(400);
    eventHandler?.("message.received", "inst_1234abcd", {
      ...incomingMessage(),
      message: { ...incomingMessage().message, id: "message-two", content: "second" },
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(enqueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]?.[0].payload).toMatchObject({
      messages: [{ text: "hello" }, { text: "second" }],
    });

    unsubscribe();
    await unsubscribe.flush();
  });

  it("flushes at the maximum wait even when new messages keep restarting the window", async () => {
    vi.useFakeTimers();
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
        return () => undefined;
      },
    } as unknown as InstanceManager;
    const config = configuredWebhook({
      WA_WEBHOOK_DEBOUNCE_MS: "1000",
      WA_WEBHOOK_DEBOUNCE_MAX_MS: "2500",
    });
    const enqueue = vi.fn<(_: EventWebhookJob) => Promise<unknown>>(() => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(instanceManager, config, enqueue);

    for (let index = 0; index < 4; index += 1) {
      eventHandler?.("message.received", "inst_1234abcd", {
        ...incomingMessage(),
        message: { ...incomingMessage().message, id: `message-${index}`, content: `${index}` },
      });
      if (index < 3) await vi.advanceTimersByTimeAsync(800);
    }
    await vi.advanceTimersByTimeAsync(99);
    expect(enqueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]?.[0].payload).toMatchObject({
      messages: Array.from({ length: 4 }, (_, index) => ({ text: `${index}` })),
    });

    unsubscribe();
    await unsubscribe.flush();
  });

  it("keeps different chats in separate batches", async () => {
    vi.useFakeTimers();
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
        return () => undefined;
      },
    } as unknown as InstanceManager;
    const config = configuredWebhook({ WA_WEBHOOK_DEBOUNCE_MS: "250" });
    const enqueue = vi.fn<(_: EventWebhookJob) => Promise<unknown>>(() => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(instanceManager, config, enqueue);

    eventHandler?.("message.received", "inst_1234abcd", incomingMessage());
    eventHandler?.("message.received", "inst_1234abcd", {
      ...incomingMessage(),
      chatId: "5511999999999@s.whatsapp.net",
      message: { ...incomingMessage().message, id: "other-chat-message" },
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(enqueue).toHaveBeenCalledTimes(2);
    const chats = enqueue.mock.calls.map(([job]) => (job.payload as { chat: string }).chat);
    expect(chats).toEqual(["5511888888888@s.whatsapp.net", "5511999999999@s.whatsapp.net"]);

    unsubscribe();
    await unsubscribe.flush();
  });

  it("delivers non-message events immediately while message batches wait", async () => {
    vi.useFakeTimers();
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
        return () => undefined;
      },
    } as unknown as InstanceManager;
    const config = configuredWebhook({
      WA_EVENT_WEBHOOK_EVENTS: "message.received,connection.changed",
      WA_WEBHOOK_DEBOUNCE_MS: "500",
    });
    const enqueue = vi.fn<(_: EventWebhookJob) => Promise<unknown>>(() => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(instanceManager, config, enqueue);

    eventHandler?.("message.received", "inst_1234abcd", incomingMessage());
    eventHandler?.("connection.changed", "inst_1234abcd", {
      instanceId: "inst_1234abcd",
      status: "open",
    });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]?.[0].payload).toMatchObject({ type: "open" });

    await vi.advanceTimersByTimeAsync(500);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[1]?.[0].payload).toMatchObject({ messages: [expect.any(Object)] });

    unsubscribe();
    await unsubscribe.flush();
  });

  it("keeps disabled batching at one unchanged payload per incoming message", () => {
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
        return () => undefined;
      },
    } as unknown as InstanceManager;
    const config = configuredWebhook();
    const enqueue = vi.fn<(_: EventWebhookJob) => Promise<unknown>>(() => Promise.resolve());
    registerEventWebhookHandler(instanceManager, config, enqueue);
    const first = incomingMessage();
    const second = {
      ...incomingMessage(),
      message: { ...incomingMessage().message, id: "message-two", content: "second" },
    };

    eventHandler?.("message.received", "inst_1234abcd", first);
    eventHandler?.("message.received", "inst_1234abcd", second);

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls.map(([job]) => job.payload)).toEqual([
      normalizeEventWebhookPayload("message.received", "inst_1234abcd", first),
      normalizeEventWebhookPayload("message.received", "inst_1234abcd", second),
    ]);
  });

  it("caps per-chat batches at 25 messages and includes a single-message batch on shutdown", async () => {
    vi.useFakeTimers();
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
        return () => undefined;
      },
    } as unknown as InstanceManager;
    const config = configuredWebhook({
      WA_WEBHOOK_DEBOUNCE_MS: "30000",
      WA_WEBHOOK_DEBOUNCE_MAX_MS: "30000",
    });
    const enqueue = vi.fn<(_: EventWebhookJob) => Promise<unknown>>(() => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(instanceManager, config, enqueue);

    for (let index = 0; index < 26; index += 1) {
      eventHandler?.("message.received", "inst_1234abcd", {
        ...incomingMessage(),
        message: { ...incomingMessage().message, content: `${index}` },
      });
    }

    expect(enqueue).toHaveBeenCalledOnce();
    const firstBatch = enqueue.mock.calls[0]?.[0].payload as {
      text: string | null;
      messages: { text: string | null }[];
    };
    expect(firstBatch.text).toBe("24");
    expect(firstBatch.messages.map((message) => message.text)).toEqual(
      Array.from({ length: 25 }, (_, index) => `${index}`),
    );
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await unsubscribe.flush();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[1]?.[0].payload).toMatchObject({
      text: "25",
      messages: [{ text: "25" }],
    });
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
  });

  it("waits for voice transcription and keeps message arrival order", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_TRANSCRIPTION_ENABLED", "true");
    vi.stubEnv("WA_TRANSCRIPTION_API_KEY", "unit-test-key");
    let resolveTranscription!: (result: { text: string }) => void;
    vi.spyOn(TranscriptionService.prototype, "transcribe").mockImplementation(
      () => new Promise((resolve) => (resolveTranscription = resolve)),
    );
    const adapter = {
      downloadMessageAudio: vi.fn().mockResolvedValue({
        data: Buffer.from("audio"),
        mimeType: "audio/ogg",
      }),
    };
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
        return () => undefined;
      },
      getAdapter: () => adapter,
    } as unknown as InstanceManager;
    const config = configuredWebhook({ WA_WEBHOOK_DEBOUNCE_MS: "500" });
    const enqueue = vi.fn<(_: EventWebhookJob) => Promise<unknown>>(() => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(instanceManager, config, enqueue);

    const voice = {
      ...incomingMessage(),
      message: { ...incomingMessage().message, id: "voice", type: "audio" as const, content: null },
    };
    const laterText = {
      ...incomingMessage(),
      message: { ...incomingMessage().message, id: "text-after-voice", content: "after" },
    };
    eventHandler?.("message.received", "inst_1234abcd", voice);
    eventHandler?.("message.received", "inst_1234abcd", laterText);
    await vi.advanceTimersByTimeAsync(500);
    expect(enqueue).not.toHaveBeenCalled();

    resolveTranscription({ text: "recognized voice" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]?.[0].payload).toMatchObject({
      text: "after",
      messages: [{ text: null, transcription: "recognized voice" }, { text: "after" }],
    });
    expect(adapter.downloadMessageAudio).toHaveBeenCalledOnce();

    unsubscribe();
    await unsubscribe.flush();
  });

  it("bounds a pending transcription by the maximum batch wait", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WA_TRANSCRIPTION_ENABLED", "true");
    vi.stubEnv("WA_TRANSCRIPTION_API_KEY", "unit-test-key");
    let resolveTranscription!: (result: { text: string }) => void;
    vi.spyOn(TranscriptionService.prototype, "transcribe").mockImplementation(
      () => new Promise((resolve) => (resolveTranscription = resolve)),
    );
    const adapter = {
      downloadMessageAudio: vi.fn().mockResolvedValue({
        data: Buffer.from("audio"),
        mimeType: "audio/ogg",
      }),
    };
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
        return () => undefined;
      },
      getAdapter: () => adapter,
    } as unknown as InstanceManager;
    const config = configuredWebhook({
      WA_WEBHOOK_DEBOUNCE_MS: "500",
      WA_WEBHOOK_DEBOUNCE_MAX_MS: "700",
    });
    const enqueue = vi.fn<(_: EventWebhookJob) => Promise<unknown>>(() => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(instanceManager, config, enqueue);
    const voice = {
      ...incomingMessage(),
      message: { ...incomingMessage().message, type: "audio" as const, content: null },
    };

    eventHandler?.("message.received", "inst_1234abcd", voice);
    await vi.advanceTimersByTimeAsync(700);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]?.[0].payload).toMatchObject({
      messages: [{ text: null }],
    });
    expect(enqueue.mock.calls[0]?.[0].payload).not.toHaveProperty("transcription");

    resolveTranscription({ text: "arrived after the cap" });
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    expect(enqueue).toHaveBeenCalledOnce();

    unsubscribe();
    await unsubscribe.flush();
  });

  it("signs the serialized batched payload with the existing HMAC scheme", async () => {
    vi.useFakeTimers();
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
        return () => undefined;
      },
    } as unknown as InstanceManager;
    const config = configuredWebhook({
      WA_EVENT_WEBHOOK_SECRET: "batch-signing-secret",
      WA_WEBHOOK_DEBOUNCE_MS: "100",
    });
    const enqueue = vi.fn<(_: EventWebhookJob) => Promise<unknown>>(() => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(instanceManager, config, enqueue);
    eventHandler?.("message.received", "inst_1234abcd", incomingMessage());
    await vi.advanceTimersByTimeAsync(100);

    const payload = enqueue.mock.calls[0]?.[0].payload;
    expect(payload).toBeDefined();
    const body = JSON.stringify(payload);
    const timestamp = "1234567890";
    const headers = createEventWebhookHeaders(body, config.destinations[0]!, timestamp);
    const expected = createHmac("sha256", "batch-signing-secret")
      .update(`${timestamp}.${body}`)
      .digest("hex");
    expect(headers.get("x-wa-event-signature")).toBe(`sha256=${expected}`);

    unsubscribe();
    await unsubscribe.flush();
  });

  it("flushes a bounded batch at 25 messages and retains the overflow message", async () => {
    vi.useFakeTimers();
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
        return () => {
          eventHandler = undefined;
        };
      },
    } as unknown as InstanceManager;
    const config = loadEventWebhookConfig({
      WA_EVENT_WEBHOOKS: JSON.stringify([
        {
          id: "grok",
          url: "https://hooks.example.test/grok",
          preset: "grok-bot",
          debounceMs: 30_000,
        },
      ]),
    });
    const enqueue = vi.fn<(_: EventWebhookJob) => Promise<unknown>>(() => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(instanceManager, config, enqueue);

    for (let index = 0; index < 26; index += 1) {
      eventHandler?.("message.received", "inst_1234abcd", {
        ...incomingMessage(),
        message: { ...incomingMessage().message, id: `message-${index}` },
      });
    }
    expect(enqueue).toHaveBeenCalledOnce();
    const firstBatch = enqueue.mock.calls[0]?.[0].payload as {
      messages: { messageId: string }[];
    };
    expect(firstBatch.messages.map((message) => message.messageId)).toEqual(
      Array.from({ length: 25 }, (_, index) => `message-${index}`),
    );

    unsubscribe();
    await unsubscribe.flush();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[1]?.[0].payload).toMatchObject({ messageId: "message-25" });
  });

  it("flushes buffered webhook events before a shutdown handler exits", async () => {
    let eventHandler: EventHandler | undefined;
    const instanceManager = {
      onAnyEvent: (handler: EventHandler) => {
        eventHandler = handler;
        return () => {
          eventHandler = undefined;
        };
      },
    } as unknown as InstanceManager;
    const config = configuredWebhook({ WA_EVENT_WEBHOOK_DEBOUNCE_MS: "30000" });
    const enqueue = vi.fn<(_: EventWebhookJob) => Promise<unknown>>(() => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(instanceManager, config, enqueue);
    let resolveExited: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    const exit = vi.fn(() => resolveExited?.());
    const removeShutdownHandlers = installShutdownHandlers(
      async () => {
        unsubscribe();
        await unsubscribe.flush();
      },
      { exit, timeoutMs: 500 },
    );

    eventHandler?.("message.received", "inst_1234abcd", incomingMessage());
    expect(enqueue).not.toHaveBeenCalled();

    process.emit("SIGTERM");
    await exited;
    removeShutdownHandlers();

    expect(enqueue).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits with an error when shutdown cleanup exceeds its timeout", async () => {
    const exit = vi.fn();
    const onError = vi.fn();
    const shutdown = createShutdownHandler(() => new Promise<void>(() => undefined), {
      exit,
      onError,
      timeoutMs: 1,
    });

    await shutdown("SIGINT");

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Shutdown exceeded 1 ms" }),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("outgoing event webhook delivery", () => {
  const resolvePublicDns = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

  it.each([
    [
      "network error",
      new TypeError("fetch failed", { cause: Object.assign(new Error(), { code: "ECONNRESET" }) }),
    ],
    ["timeout", new DOMException("The operation timed out", "TimeoutError")],
  ])("classifies %s as retryable", async (_label, failure) => {
    const fetchRequest = vi.fn<typeof fetch>(async () => {
      throw failure;
    });

    await expect(
      postEventWebhook(
        configuredWebhook().destinations[0]!,
        {},
        1_000,
        fetchRequest,
        resolvePublicDns,
      ),
    ).rejects.toBeInstanceOf(EventWebhookRetryableError);
  });

  it("retries transient DNS lookup errors", async () => {
    const fetchRequest = vi.fn<typeof fetch>();
    const resolveDns = vi.fn(async () => {
      throw Object.assign(new Error("temporary DNS failure"), { code: "EAI_AGAIN" });
    });

    await expect(
      postEventWebhook(configuredWebhook().destinations[0]!, {}, 1_000, fetchRequest, resolveDns),
    ).rejects.toBeInstanceOf(EventWebhookRetryableError);
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it("does not retry unclassified DNS lookup errors", async () => {
    const fetchRequest = vi.fn<typeof fetch>();
    const resolveDns = vi.fn(async () => {
      throw new Error("resolver misconfigured");
    });

    await expect(
      postEventWebhook(configuredWebhook().destinations[0]!, {}, 1_000, fetchRequest, resolveDns),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it.each([429, 500, 503])("classifies HTTP %i as retryable", async (status) => {
    const fetchRequest = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status })));

    await expect(
      postEventWebhook(
        configuredWebhook().destinations[0]!,
        {},
        1_000,
        fetchRequest,
        resolvePublicDns,
      ),
    ).rejects.toBeInstanceOf(EventWebhookRetryableError);
  });

  it.each([400, 401, 404])("classifies HTTP %i as permanent", async (status) => {
    const fetchRequest = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status })));

    await expect(
      postEventWebhook(
        configuredWebhook().destinations[0]!,
        {},
        1_000,
        fetchRequest,
        resolvePublicDns,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("uses a capped Retry-After header as a minimum retry delay", async () => {
    const fetchRequest = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 429, headers: { "retry-after": "999" } })),
    );

    await expect(
      postEventWebhook(
        configuredWebhook().destinations[0]!,
        {},
        1_000,
        fetchRequest,
        resolvePublicDns,
      ),
    ).rejects.toMatchObject({ retryAfterMs: 300_000 });
  });

  it("parses Retry-After seconds and HTTP dates, and ignores invalid or past values", () => {
    const now = Date.parse("2025-01-01T00:00:00.000Z");

    expect(parseEventWebhookRetryAfter("12", now)).toBe(12_000);
    expect(parseEventWebhookRetryAfter(new Date(now + 45_000).toUTCString(), now)).toBe(45_000);
    expect(parseEventWebhookRetryAfter(new Date(now - 1_000).toUTCString(), now)).toBe(0);
    expect(parseEventWebhookRetryAfter("999", now)).toBe(300_000);
    expect(parseEventWebhookRetryAfter("not a date", now)).toBeUndefined();
  });

  it("applies exponential backoff with bounded jitter and a capped Retry-After floor", () => {
    expect(calculateEventWebhookBackoff(1, 1_000, undefined, 0)).toBe(800);
    expect(calculateEventWebhookBackoff(1, 1_000, undefined, 1)).toBe(1_000);
    expect(calculateEventWebhookBackoff(4, 1_000, undefined, 0)).toBe(6_400);
    expect(calculateEventWebhookBackoff(4, 1_000, undefined, 1)).toBe(8_000);
    expect(calculateEventWebhookBackoff(1, 1_000, 30_000, 0)).toBe(30_000);
    expect(calculateEventWebhookBackoff(100, 1_000, 600_000, 1)).toBe(300_000);
    expect(eventWebhookBackoffStrategy(1_000)(1, "wa-event-webhook", new Error())).toBe(-1);
  });

  it("signs timestamp plus exact request body with HMAC-SHA256", () => {
    const destination = {
      id: "default",
      url: "https://hooks.example.test/receive",
      headers: { authorization: "Bearer hidden" },
      secret: "hmac-secret",
    };
    const body = '{"event":"message.received"}';
    const timestamp = "1700000000";
    const signature = createHmac("sha256", destination.secret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    const headers = createEventWebhookHeaders(body, destination, timestamp);

    expect(headers.get("x-wa-event-timestamp")).toBe(timestamp);
    expect(headers.get("x-wa-event-signature")).toBe(`sha256=${signature}`);
    expect(headers.get("authorization")).toBe("Bearer hidden");
  });

  it("uses POST, a timeout, no redirects, and hides sensitive request data on failure", async () => {
    const url = "https://hooks.example.test/receive?token=query-secret";
    const authValue = "header-secret";
    const hmacSecret = "hmac-secret";
    const destination = {
      id: "default",
      url,
      headers: { authorization: `Bearer ${authValue}` },
      secret: hmacSecret,
    };
    const fetchRequest = vi.fn<typeof fetch>(() =>
      Promise.reject(new Error(`${url} ${authValue} ${hmacSecret}`)),
    );
    const resolveDns = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

    const failure = postEventWebhook(
      destination,
      normalizeEventWebhookPayload("message.received", "inst_1234abcd", incomingMessage()),
      1_000,
      fetchRequest,
      resolveDns,
    );
    await expect(failure).rejects.toThrow("Event webhook delivery failed");

    const [requestUrl, request] = fetchRequest.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(request.headers);
    expect(requestUrl).toBe(url);
    expect(request.method).toBe("POST");
    expect(request.redirect).toBe("error");
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(headers.get("authorization")).toBe(`Bearer ${authValue}`);
    expect(headers.get("x-wa-event-signature")).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(headers.get("x-wa-event-timestamp")).toMatch(/^\d+$/);

    try {
      await failure;
    } catch (error) {
      const message = String(error);
      expect(message).not.toContain("query-secret");
      expect(message).not.toContain(authValue);
      expect(message).not.toContain(hmacSecret);
    }
  });

  it("keeps HTTP status and safe network diagnostics for failed-attempt logs", async () => {
    const destination = {
      id: "default",
      url: "https://hooks.example.test:8443/receive/provider-path-secret?token=query-secret",
      headers: { authorization: "Bearer header-secret" },
      secret: "hmac-secret",
    };
    const resolveDns = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const httpFailure = postEventWebhook(
      destination,
      {},
      1_000,
      vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 503 }))),
      resolveDns,
    );
    await expect(httpFailure).rejects.toMatchObject({
      httpStatus: 503,
      errorName: "HttpError",
      errorMessage: "HTTP 503",
    });

    const networkError = Object.assign(
      new Error(
        `connect ECONNREFUSED ${destination.url} path=/receive/provider-path-secret ${destination.headers.authorization} ${destination.secret}`,
      ),
      { code: "ECONNREFUSED" },
    );
    const networkFailure = postEventWebhook(
      destination,
      {},
      1_000,
      vi.fn<typeof fetch>(() =>
        Promise.reject(new TypeError(`fetch failed ${destination.url}`, { cause: networkError })),
      ),
      resolveDns,
    );
    let failure: unknown;
    try {
      await networkFailure;
    } catch (error) {
      failure = error;
    }
    const logData = eventWebhookFailureLogData(2, failure, destination);
    expect(logData).toMatchObject({
      attempt: 2,
      destinationId: "default",
      endpoint: "https://hooks.example.test:8443",
      httpStatus: null,
      errorName: "Error",
      errorCode: "ECONNREFUSED",
    });
    const serialized = JSON.stringify(logData);
    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("header-secret");
    expect(serialized).not.toContain("hmac-secret");
    expect(serialized).not.toContain("token=");
    expect(serialized).not.toContain("/receive/provider-path-secret");
    expect(serialized).not.toContain("provider-path-secret");
  });

  it("rejects a hostname that resolves to a private address before sending", async () => {
    const fetchRequest = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    const resolveDns = vi.fn(async () => [{ address: "10.0.0.8", family: 4 }]);

    await expect(
      postEventWebhook(configuredWebhook().destinations[0]!, {}, 1_000, fetchRequest, resolveDns),
    ).rejects.toThrow("Event webhook delivery failed");

    expect(resolveDns).toHaveBeenCalledWith("hooks.example.test");
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it("rejects mixed public and private DNS answers", async () => {
    const fetchRequest = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    const resolveDns = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ]);

    await expect(
      postEventWebhook(configuredWebhook().destinations[0]!, {}, 1_000, fetchRequest, resolveDns),
    ).rejects.toThrow("Event webhook delivery failed");

    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it("uses a validated public address while keeping the hostname for HTTPS", async () => {
    const destination = configuredWebhook().destinations[0]!;
    const fetchRequest = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    const resolveDns = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

    await postEventWebhook(destination, {}, 1_000, fetchRequest, resolveDns);

    const [requestUrl, request] = fetchRequest.mock.calls[0] as [
      string,
      RequestInit & { dispatcher?: unknown },
    ];
    expect(requestUrl).toBe(destination.url);
    expect(request.dispatcher).toBeDefined();

    const connection = createPinnedWebhookConnectionOptions(
      "hooks.example.test",
      "93.184.216.34",
      4,
      "https:",
    );
    expect(connection.servername).toBe("hooks.example.test");
    const lookupResult = await new Promise<unknown>((resolve, reject) => {
      connection.lookup?.("hooks.example.test", { all: true }, (error, address) => {
        if (error) reject(error);
        else resolve(address);
      });
    });
    expect(lookupResult).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it.each([200, 503])("cancels the response body after status %i", async (status) => {
    const cancel = vi.fn();
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("response"));
      },
      cancel,
    });
    const fetchRequest = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(responseBody, { status })),
    );
    const resolveDns = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const delivery = postEventWebhook(
      configuredWebhook().destinations[0]!,
      {},
      1_000,
      fetchRequest,
      resolveDns,
    );

    if (status >= 400) await expect(delivery).rejects.toThrow("Event webhook delivery failed");
    else await expect(delivery).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects queued jobs when the destination configuration differs", async () => {
    const destination = configuredWebhook().destinations[0]!;
    const delivery = vi.fn<typeof postEventWebhook>(() => Promise.resolve());
    const job: EventWebhookJob = {
      destinationId: destination.id,
      destinationIdentity: `${eventWebhookDestinationIdentity(destination)}-other`,
      payload: {},
    };

    await expect(
      processEventWebhookJob(job, new Map([[destination.id, destination]]), 1_000, delivery),
    ).rejects.toThrow("Event webhook destination does not match this service configuration");
    expect(delivery).not.toHaveBeenCalled();
  });
});
