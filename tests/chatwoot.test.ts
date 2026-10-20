import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Agent } from "undici";
import { InstanceManager } from "../src/services/instance-manager.js";
import { registerEventNotifications } from "../src/notifications/events.js";
import {
  registerEventWebhookHandler,
  type EventWebhookUnsubscribe,
} from "../src/services/event-webhook.js";
import { loadEventWebhookConfig } from "../src/services/event-webhook-config.js";
import {
  isChatwootJidIgnored,
  loadChatwootConfig,
  type EnabledChatwootConfig,
} from "../src/services/chatwoot-config.js";
import {
  ChatwootClient,
  ChatwootRequestError,
  createChatwootTransport,
  type ChatwootRequest,
  type ChatwootTransport,
} from "../src/services/chatwoot-client.js";
import {
  ChatwootService,
  chatwootWebhookAuthorized,
  renderChatwootText,
  type ChatwootRuntime,
} from "../src/services/chatwoot.js";
import type { ChannelEventPayload, NormalizedMessageEvent } from "../src/types/channel.types.js";

const SECRET = "webhook-secret-value";
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function enabledEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    WA_CHATWOOT_ENABLED: "true",
    WA_CHATWOOT_URL: "https://chatwoot.example.com",
    WA_CHATWOOT_TOKEN: "token-token-token",
    WA_CHATWOOT_ACCOUNT_ID: "12",
    WA_CHATWOOT_INBOX_ID: "34",
    WA_CHATWOOT_WEBHOOK_SECRET: SECRET,
    ...overrides,
  };
}

function enabledConfig(overrides: Record<string, string> = {}): EnabledChatwootConfig {
  const config = loadChatwootConfig(enabledEnv(overrides));
  if (!config.enabled) throw new Error("expected Chatwoot to be enabled");
  return config;
}

function messageEvent(overrides: Partial<NormalizedMessageEvent> = {}): NormalizedMessageEvent {
  return {
    instanceId: "inst_0123abcd",
    chatId: "15551234567@s.whatsapp.net",
    chatName: "Ada",
    senderName: "Ada",
    isGroup: false,
    message: {
      id: "m1",
      sender: "15551234567@s.whatsapp.net",
      timestamp: 1_700_000_000,
      type: "text",
      content: "hello",
      mediaUrl: null,
      quotedMessageId: null,
      isFromMe: false,
    },
    ...overrides,
  };
}

function runtime(ids = ["inst_0123abcd"]): ChatwootRuntime & {
  enqueueMessage: ReturnType<typeof vi.fn>;
} {
  return {
    enqueueMessage: vi.fn().mockResolvedValue({ status: "queued", jobId: "job-1" }),
    getInstanceChannel: () => "baileys",
    listInstanceIds: () => ids,
  };
}

function recordingTransport(): { transport: ChatwootTransport; calls: ChatwootRequest[] } {
  const calls: ChatwootRequest[] = [];
  const transport: ChatwootTransport = {
    async request(input) {
      calls.push(input);
      if (input.path.endsWith("/contacts/search")) return { status: 200, body: { payload: [] } };
      if (input.path.endsWith("/contacts") && input.method === "POST") {
        return {
          status: 200,
          body: { payload: { contact: { id: 7 }, contact_inbox: { source_id: "generated" } } },
        };
      }
      if (input.path.endsWith("/contact_inboxes")) return { status: 200, body: { id: 1 } };
      if (input.path.endsWith("/conversations") && input.method === "GET") {
        return { status: 200, body: { payload: [] } };
      }
      if (input.path.endsWith("/conversations") && input.method === "POST") {
        return { status: 200, body: { id: 42 } };
      }
      if (input.path.endsWith("/messages")) return { status: 200, body: { id: 99 } };
      throw new Error(`unexpected ${input.method} ${input.path}`);
    },
  };
  return { transport, calls };
}

function webhookBody(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      event: "message_created",
      id: 50,
      content: "Reply **there**",
      message_type: "outgoing",
      private: false,
      source_id: null,
      conversation: {
        inbox_id: 34,
        contact_inbox: { source_id: "15551234567@s.whatsapp.net" },
      },
      sender: { type: "user", name: "Agent" },
      attachments: [],
      ...overrides,
    }),
  );
}

describe("Chatwoot configuration", () => {
  it("stays disabled unless WA_CHATWOOT_ENABLED is true", () => {
    expect(loadChatwootConfig({}).enabled).toBe(false);
    expect(loadChatwootConfig({ WA_CHATWOOT_ENABLED: "false" }).enabled).toBe(false);
    expect(loadChatwootConfig({ WA_CHATWOOT_URL: "http://127.0.0.1" }).enabled).toBe(false);
  });

  it("requires the API inbox settings and a webhook secret when enabled", () => {
    expect(enabledConfig()).toMatchObject({
      enabled: true,
      url: "https://chatwoot.example.com",
      accountId: "12",
      inboxId: "34",
    });
    expect(() => loadChatwootConfig({ WA_CHATWOOT_ENABLED: "yes" })).toThrow(
      "Invalid WA_CHATWOOT_ENABLED",
    );
    expect(() => loadChatwootConfig(enabledEnv({ WA_CHATWOOT_TOKEN: "" }))).toThrow(
      "WA_CHATWOOT_TOKEN",
    );
    expect(() => loadChatwootConfig(enabledEnv({ WA_CHATWOOT_ACCOUNT_ID: "" }))).toThrow(
      "WA_CHATWOOT_ACCOUNT_ID",
    );
    expect(() => loadChatwootConfig(enabledEnv({ WA_CHATWOOT_INBOX_ID: "0" }))).toThrow(
      "WA_CHATWOOT_INBOX_ID",
    );
    expect(() => loadChatwootConfig(enabledEnv({ WA_CHATWOOT_WEBHOOK_SECRET: "short" }))).toThrow(
      "WA_CHATWOOT_WEBHOOK_SECRET",
    );
    expect(() =>
      loadChatwootConfig(enabledEnv({ WA_CHATWOOT_URL: "http://chatwoot.example.com" })),
    ).toThrow("WA_CHATWOOT_ALLOW_HTTP");
    expect(() => loadChatwootConfig(enabledEnv({ WA_CHATWOOT_URL: "https://10.1.1.1" }))).toThrow(
      "WA_CHATWOOT_ALLOW_PRIVATE_URL",
    );
    expect(() => loadChatwootConfig(enabledEnv({ WA_CHATWOOT_IGNORE_JIDS: "*" }))).toThrow(
      "WA_CHATWOOT_IGNORE_JIDS",
    );
  });

  it("filters exact JIDs, suffixes, and wildcards without touching event webhook settings", () => {
    expect(isChatwootJidIgnored("status@broadcast", [])).toBe(true);
    expect(isChatwootJidIgnored("15550001111@newsletter", [])).toBe(true);
    expect(isChatwootJidIgnored("120363000000000001@g.us", ["@g.us"])).toBe(true);
    expect(isChatwootJidIgnored("15551234567@s.whatsapp.net", ["15551234567@s.whatsapp.net"])).toBe(
      true,
    );
    expect(isChatwootJidIgnored("abc@lid", ["*@lid"])).toBe(true);
    expect(isChatwootJidIgnored("15551234567@s.whatsapp.net", ["@g.us"])).toBe(false);

    const webhook = loadEventWebhookConfig({
      ...enabledEnv(),
      WA_EVENT_WEBHOOK_URL: "https://hooks.example.test/receive",
      WA_EVENT_WEBHOOK_EVENTS: "message.received",
    });
    expect(webhook.destinations).toHaveLength(1);
    expect(webhook.destinations[0]?.url).toBe("https://hooks.example.test/receive");
  });
});

describe("Chatwoot inbound sync", () => {
  it("creates a contact and conversation, then posts the WhatsApp message", async () => {
    const { transport, calls } = recordingTransport();
    const client = new ChatwootClient(enabledConfig(), transport);
    await client.syncMessage({
      instanceId: "inst_0123abcd",
      chatId: "15551234567@s.whatsapp.net",
      chatName: "Ada",
      senderName: "Ada",
      isGroup: false,
      messageId: "m1",
      isFromMe: false,
      text: "hello",
    });
    await client.syncMessage({
      instanceId: "inst_0123abcd",
      chatId: "15551234567@s.whatsapp.net",
      chatName: "Ada",
      senderName: "Ada",
      isGroup: false,
      messageId: "m2",
      isFromMe: true,
      text: "sent from the phone",
    });

    const messages = calls.filter((call) => call.path.endsWith("/messages"));
    expect(messages).toHaveLength(2);
    expect(messages[0]?.body).toMatchObject({
      content: "hello",
      message_type: "incoming",
      source_id: "WAID:m1",
    });
    expect(messages[1]?.body).toMatchObject({
      message_type: "outgoing",
      source_id: "WAID:m2",
    });
    expect(calls.filter((call) => call.path.endsWith("/contacts/search"))).toHaveLength(1);
    const contact = calls.find((call) => call.path.endsWith("/contacts") && call.method === "POST");
    expect(contact?.body).toMatchObject({
      phone_number: "+15551234567",
      identifier: "inst_0123abcd|15551234567@s.whatsapp.net",
    });
  });

  it("skips filtered chats and does not call Chatwoot again for the same message", async () => {
    const { transport, calls } = recordingTransport();
    const service = new ChatwootService(
      enabledConfig({ WA_CHATWOOT_IGNORE_JIDS: "@g.us" }),
      runtime(),
      transport,
    );
    const group = messageEvent({
      chatId: "120363000000000001@g.us",
      isGroup: true,
      senderName: "Ada",
      message: { ...messageEvent().message, content: "group" },
    });
    await service.forwardReceived("inst_0123abcd", group);
    expect(calls).toHaveLength(0);

    const direct = messageEvent();
    await service.forwardReceived("inst_0123abcd", direct);
    await service.forwardReceived("inst_0123abcd", direct);
    expect(calls.filter((call) => call.path.endsWith("/messages"))).toHaveLength(1);
    expect(renderChatwootText({ ...group, chatId: "120363000000000001@g.us" })).toBe("Ada: group");
  });

  it("keeps going when Chatwoot rejects the message", async () => {
    const transport: ChatwootTransport = {
      request: () => {
        throw new ChatwootRequestError(503);
      },
    };
    const service = new ChatwootService(enabledConfig(), runtime(), transport);
    await expect(service.forwardReceived("inst_0123abcd", messageEvent())).rejects.toBeInstanceOf(
      ChatwootRequestError,
    );
    await expect(service.forwardReceived("inst_0123abcd", messageEvent())).rejects.toBeInstanceOf(
      ChatwootRequestError,
    );
  });
});

describe("Chatwoot agent replies", () => {
  it("queues an agent reply only when the webhook secret matches", async () => {
    const queue = runtime();
    const service = new ChatwootService(enabledConfig(), queue);
    const body = webhookBody();
    const denied = await service.handleWebhook({
      rawBody: body,
      headerSecret: "wrong-secret-value",
    });
    expect(denied.status).toBe(401);
    expect(queue.enqueueMessage).not.toHaveBeenCalled();

    const accepted = await service.handleWebhook({ rawBody: body, headerSecret: SECRET });
    expect(accepted).toEqual({ status: 202, body: { status: "accepted" } });
    expect(queue.enqueueMessage).toHaveBeenCalledWith(
      "inst_0123abcd",
      "15551234567@s.whatsapp.net",
      { type: "text", text: "Reply *there*" },
      "baileys",
    );

    const duplicate = await service.handleWebhook({ rawBody: body, querySecret: SECRET });
    expect(duplicate.body).toMatchObject({ status: "ignored", reason: "duplicate" });
    expect(queue.enqueueMessage).toHaveBeenCalledTimes(1);
  });

  it("accepts an HMAC signature and ignores echoes, private notes, and filtered JIDs", async () => {
    const body = webhookBody();
    const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    expect(chatwootWebhookAuthorized({ secret: SECRET, rawBody: body, signature })).toBe(true);
    expect(
      chatwootWebhookAuthorized({ secret: SECRET, rawBody: body, signature: "sha256=00" }),
    ).toBe(false);

    const queue = runtime();
    const service = new ChatwootService(
      enabledConfig({ WA_CHATWOOT_IGNORE_JIDS: "15559999999@s.whatsapp.net" }),
      queue,
    );
    const echo = await service.handleWebhook({
      rawBody: webhookBody({ source_id: "WAID:m1" }),
      headerSecret: SECRET,
    });
    expect(echo.body).toMatchObject({ reason: "echo" });

    const filtered = await service.handleWebhook({
      rawBody: webhookBody({
        id: 51,
        conversation: {
          inbox_id: 34,
          contact_inbox: { source_id: "15559999999@s.whatsapp.net" },
        },
      }),
      headerSecret: SECRET,
    });
    expect(filtered.body).toMatchObject({ reason: "jid_filter" });
    expect(queue.enqueueMessage).not.toHaveBeenCalled();
  });

  it("does not send when the integration is off or the instance cannot be chosen", async () => {
    const disabled = new ChatwootService({ enabled: false }, runtime());
    expect(
      (await disabled.handleWebhook({ rawBody: webhookBody(), headerSecret: SECRET })).status,
    ).toBe(404);

    const ambiguous = runtime(["inst_0123abcd", "inst_89abcdef"]);
    const service = new ChatwootService(enabledConfig(), ambiguous);
    const result = await service.handleWebhook({ rawBody: webhookBody(), headerSecret: SECRET });
    expect(result.status).toBe(422);
    expect(ambiguous.enqueueMessage).not.toHaveBeenCalled();
  });

  it("routes a multi-instance reply from the encoded source id", async () => {
    const queue = runtime(["inst_0123abcd", "inst_89abcdef"]);
    const service = new ChatwootService(enabledConfig(), queue);
    const result = await service.handleWebhook({
      rawBody: webhookBody({
        conversation: {
          inbox_id: 34,
          contact_inbox: { source_id: "inst_89abcdef|15551234567@s.whatsapp.net" },
        },
      }),
      headerSecret: SECRET,
    });
    expect(result.status).toBe(202);
    expect(queue.enqueueMessage).toHaveBeenCalledWith(
      "inst_89abcdef",
      "15551234567@s.whatsapp.net",
      expect.objectContaining({ type: "text" }),
      "baileys",
    );
  });
});

describe("Chatwoot transport", () => {
  it("pins a public address and blocks private or metadata answers", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const transport = createChatwootTransport(enabledConfig(), {
      fetchImpl: fetchImpl as typeof fetch,
      resolveDns: async () => [{ address: "1.1.1.1", family: 4 }],
    });
    await expect(
      transport.request({
        method: "GET",
        path: "/api/v1/accounts/12/contacts/search",
        query: { q: "a" },
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        redirect: "error",
        dispatcher: expect.any(Agent),
        headers: expect.objectContaining({ api_access_token: "token-token-token" }),
      }),
    );

    const blocked = createChatwootTransport(enabledConfig(), {
      fetchImpl: fetchImpl as typeof fetch,
      resolveDns: async () => [{ address: "10.1.1.1", family: 4 }],
    });
    await expect(
      blocked.request({ method: "GET", path: "/api/v1/accounts/12" }),
    ).rejects.toBeInstanceOf(ChatwootRequestError);

    const metadata = createChatwootTransport(
      enabledConfig({
        WA_CHATWOOT_ALLOW_PRIVATE_URL: "true",
        WA_CHATWOOT_URL: "https://chat.example.com",
      }),
      {
        fetchImpl: fetchImpl as typeof fetch,
        resolveDns: async () => [{ address: "169.254.169.254", family: 4 }],
      },
    );
    await expect(
      metadata.request({ method: "GET", path: "/api/v1/accounts/12" }),
    ).rejects.toBeInstanceOf(ChatwootRequestError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("Chatwoot and event webhooks", () => {
  it("still delivers the event webhook when Chatwoot sync fails", async () => {
    const instanceManager = new InstanceManager();
    const instance = await instanceManager.createInstance("chatwoot isolation");
    cleanups.push(() => instanceManager.deleteInstance(instance.id));

    const service = new ChatwootService(enabledConfig(), runtime([instance.id]), {
      request: () => {
        throw new ChatwootRequestError(500);
      },
    });
    service.start(instanceManager);
    cleanups.push(() => service.stop());

    const notification = vi.fn().mockResolvedValue(undefined);
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const server = { server: { notification, sendLoggingMessage } } as unknown as McpServer;
    cleanups.push(registerEventNotifications(server, instanceManager));

    const enqueue = vi.fn().mockResolvedValue(undefined);
    const unsubscribeWebhook: EventWebhookUnsubscribe = registerEventWebhookHandler(
      instanceManager,
      loadEventWebhookConfig({
        WA_EVENT_WEBHOOK_URL: "https://hooks.example.test/receive",
        WA_EVENT_WEBHOOK_EVENTS: "message.received",
      }),
      enqueue,
    );
    cleanups.push(() => {
      unsubscribeWebhook();
      return unsubscribeWebhook.flush();
    });

    const payload: ChannelEventPayload["message.received"] = messageEvent({
      instanceId: instance.id,
    });
    const adapter = instanceManager.ensureAdapter(instance.id) as unknown as {
      emit: (
        event: "message.received",
        eventPayload: ChannelEventPayload["message.received"],
      ) => void;
    };
    adapter.emit("message.received", payload);

    await vi.waitFor(() => {
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ event: "message.received", instanceId: instance.id }),
        }),
      );
    });
    expect(notification).toHaveBeenCalled();
  });
});
