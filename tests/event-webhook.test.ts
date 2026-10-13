import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceManager } from "../src/services/instance-manager.js";
import {
  createEventWebhookHeaders,
  createPinnedWebhookConnectionOptions,
  eventWebhookDestinationIdentity,
  eventWebhookJobOptions,
  normalizeGrokBotWebhookPayload,
  normalizeEventWebhookPayload,
  postEventWebhook,
  processEventWebhookJob,
  registerEventWebhookHandler,
  shouldSendEventWebhook,
  type EventWebhookJob,
} from "../src/services/event-webhook.js";
import { loadEventWebhookConfig } from "../src/services/event-webhook-config.js";
import type { ChannelEventPayload } from "../src/types/channel.types.js";
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
      WA_EVENT_WEBHOOK_EVENTS: "message.received, message.edited, message.received",
      WA_EVENT_WEBHOOK_IGNORE_FROM_ME: "false",
      WA_EVENT_WEBHOOK_TIMEOUT_MS: "2500",
      WA_EVENT_WEBHOOK_RETRY_ATTEMPTS: "4",
      WA_EVENT_WEBHOOK_RETRY_DELAY_MS: "300",
      WA_EVENT_WEBHOOK_HEADERS: '{"X-Api-Key":"json-value","X-Trace":"test"}',
      WA_EVENT_WEBHOOK_AUTH_HEADER: "X-Api-Key",
      WA_EVENT_WEBHOOK_AUTH_VALUE: "header-secret",
      WA_EVENT_WEBHOOK_SECRET: "hmac-secret",
    });

    expect(config.events).toEqual(["message.received", "message.edited"]);
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
      backoff: { type: "exponential", delay: 300 },
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

  it("batches without dropping messages and flushes on the configured window", async () => {
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
