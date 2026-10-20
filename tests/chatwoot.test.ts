import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
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
  isChatwootNewsletterSource,
  loadChatwootConfig,
  parseChatwootSourceId,
  type EnabledChatwootConfig,
} from "../src/services/chatwoot-config.js";
import {
  ChatwootClient,
  ChatwootRequestError,
  createChatwootTransport,
  fetchPinnedResource,
  type ChatwootRequest,
  type ChatwootTransport,
} from "../src/services/chatwoot-client.js";
import {
  CHATWOOT_REPLY_DRAIN_TIMEOUT_MS,
  CHATWOOT_SIGNATURE_WINDOW_SECONDS,
  ChatwootService,
  MAX_REPLY_ATTACHMENT_BYTES,
  authorizeChatwootWebhook,
  handleChatwootHttpRequest,
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

function legacyConfig(overrides: Record<string, string> = {}): EnabledChatwootConfig {
  return enabledConfig({ WA_CHATWOOT_ALLOW_LEGACY_SECRET: "true", ...overrides });
}

async function waitQueued(
  queue: { enqueueMessage: { mock: { calls: unknown[][] } } },
  times = 1,
): Promise<void> {
  await vi.waitFor(() => expect(queue.enqueueMessage.mock.calls.length).toBe(times));
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

function privateNotes(calls: ChatwootRequest[], conversationId: number): string[] {
  return calls.flatMap((call) => {
    if (call.method !== "POST") return [];
    if (call.path !== `/api/v1/accounts/12/conversations/${conversationId}/messages`) return [];
    const body = call.body;
    if (typeof body !== "object" || body === null) return [];
    const note = body as { private?: unknown; content?: unknown; source_id?: unknown };
    if (note.private !== true || typeof note.content !== "string") return [];
    return [note.content];
  });
}

function signedWebhook(
  body: Buffer,
  nowSeconds = 1_700_000_000,
  deliveryId = "delivery-1",
): {
  rawBody: Buffer;
  signature: string;
  timestamp: string;
  deliveryId: string;
  nowSeconds: number;
} {
  const timestamp = String(nowSeconds);
  const signature = `sha256=${createHmac("sha256", SECRET).update(`${timestamp}.`).update(body).digest("hex")}`;
  return { rawBody: body, signature, timestamp, deliveryId, nowSeconds };
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
    const service = new ChatwootService(legacyConfig(), queue);
    const body = webhookBody();
    const denied = await service.handleWebhook({
      rawBody: body,
      headerSecret: "wrong-secret-value",
    });
    expect(denied.status).toBe(401);
    expect(queue.enqueueMessage).not.toHaveBeenCalled();

    const accepted = await service.handleWebhook({ rawBody: body, headerSecret: SECRET });
    expect(accepted).toEqual({ status: 202, body: { status: "accepted" } });
    await waitQueued(queue);
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

  it("accepts the Chatwoot signature and ignores echoes, private notes, and filtered JIDs", async () => {
    const body = webhookBody();
    const signed = signedWebhook(body);
    expect(authorizeChatwootWebhook({ secret: SECRET, ...signed }).ok).toBe(true);
    expect(
      authorizeChatwootWebhook({
        secret: SECRET,
        ...signed,
        signature: "sha256=00",
      }).ok,
    ).toBe(false);
    expect(
      authorizeChatwootWebhook({
        secret: SECRET,
        ...signed,
        nowSeconds: signed.nowSeconds + 301,
      }).ok,
    ).toBe(false);
    expect(
      authorizeChatwootWebhook({
        secret: SECRET,
        rawBody: body,
        signature: signed.signature,
        timestamp: signed.timestamp,
        querySecret: SECRET,
        nowSeconds: signed.nowSeconds + 301,
      }).ok,
    ).toBe(false);

    const queue = runtime();
    const service = new ChatwootService(
      legacyConfig({ WA_CHATWOOT_IGNORE_JIDS: "15559999999@s.whatsapp.net" }),
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
    const service = new ChatwootService(legacyConfig(), ambiguous);
    const result = await service.handleWebhook({ rawBody: webhookBody(), headerSecret: SECRET });
    expect(result.status).toBe(422);
    expect(ambiguous.enqueueMessage).not.toHaveBeenCalled();
  });

  it("routes a multi-instance reply from the encoded source id", async () => {
    const queue = runtime(["inst_0123abcd", "inst_89abcdef"]);
    const service = new ChatwootService(legacyConfig(), queue);
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
    await waitQueued(queue);
    expect(queue.enqueueMessage).toHaveBeenCalledWith(
      "inst_89abcdef",
      "15551234567@s.whatsapp.net",
      expect.objectContaining({ type: "text" }),
      "baileys",
    );
  });

  it("requires the configured inbox and ignores agent-edited chat attributes", async () => {
    const queue = runtime(["inst_0123abcd", "inst_89abcdef"]);
    const service = new ChatwootService(legacyConfig(), queue);
    const missingInbox = await service.handleWebhook({
      rawBody: webhookBody({
        conversation: { contact_inbox: { source_id: "15551234567@s.whatsapp.net" } },
      }),
      headerSecret: SECRET,
    });
    expect(missingInbox.body).toMatchObject({ reason: "inbox" });

    const edited = await service.handleWebhook({
      rawBody: webhookBody({
        id: 77,
        conversation: {
          inbox_id: 34,
          additional_attributes: {
            wamcp_chat_id: "15550000000@s.whatsapp.net",
            wamcp_instance_id: "inst_89abcdef",
          },
          contact_inbox: { source_id: "inst_0123abcd|15551234567@s.whatsapp.net" },
        },
      }),
      headerSecret: SECRET,
    });
    expect(edited.status).toBe(202);
    await waitQueued(queue);
    expect(queue.enqueueMessage).toHaveBeenCalledWith(
      "inst_0123abcd",
      "15551234567@s.whatsapp.net",
      expect.objectContaining({ type: "text" }),
      "baileys",
    );
  });

  it("deduplicates X-Chatwoot-Delivery and sends attachment bytes", async () => {
    const queue = runtime();
    const fetchAttachment = vi.fn(async () => ({
      data: Buffer.from("png-bytes"),
      contentType: "image/png",
    }));
    const service = new ChatwootService(enabledConfig(), queue, undefined, fetchAttachment);
    const body = webhookBody({
      id: 80,
      content: "see this",
      attachments: [{ file_type: "image", data_url: "https://files.example.com/a.png" }],
    });
    const first = await service.handleWebhook(signedWebhook(body, 1_700_000_100, "delivery-80"));
    expect(first.status).toBe(202);
    await waitQueued(queue);
    expect(fetchAttachment).toHaveBeenCalledWith(
      "https://files.example.com/a.png",
      16 * 1024 * 1024,
    );
    expect(queue.enqueueMessage).toHaveBeenCalledWith(
      "inst_0123abcd",
      "15551234567@s.whatsapp.net",
      {
        type: "image",
        image: Buffer.from("png-bytes").toString("base64"),
        caption: "see this",
      },
      "baileys",
    );

    const replay = webhookBody({ id: 81, content: "again" });
    const second = await service.handleWebhook(
      signedWebhook(replay, 1_700_000_100, "delivery-80"),
    );
    expect(second.body).toMatchObject({ reason: "duplicate" });
    expect(queue.enqueueMessage).toHaveBeenCalledTimes(1);
  });

  it("does not queue an attachment URL when the pinned download fails", async () => {
    const queue = runtime();
    let downloaded = false;
    const service = new ChatwootService(enabledConfig(), queue, undefined, async () => {
      downloaded = true;
      throw new Error("blocked");
    });
    const result = await service.handleWebhook(
      signedWebhook(
        webhookBody({
          id: 82,
          content: "",
          attachments: [{ file_type: "image", data_url: "https://localtest.me/secret" }],
        }),
        1_700_000_300,
        "delivery-82",
      ),
    );
    expect(result).toEqual({ status: 202, body: { status: "accepted" } });
    await vi.waitFor(() => expect(downloaded).toBe(true));
    expect(queue.enqueueMessage).not.toHaveBeenCalled();
  });

  it("reads the Chatwoot signature headers from the HTTP request", async () => {
    const queue = runtime();
    const service = new ChatwootService(enabledConfig(), queue);
    const body = webhookBody({ id: 90 });
    const signed = signedWebhook(body, Math.floor(Date.now() / 1000), "delivery-http");
    const req = Readable.from([body]) as Readable & IncomingMessage;
    req.headers = {
      "x-chatwoot-signature": signed.signature,
      "x-chatwoot-timestamp": signed.timestamp,
      "x-chatwoot-delivery": signed.deliveryId,
      "x-hub-signature-256": "sha256=deadbeef",
    };
    req.url = "/chatwoot/webhook";
    req.method = "POST";
    const chunks: string[] = [];
    let statusCode = 0;
    const res = {
      writeHead(status: number) {
        statusCode = status;
      },
      end(payload?: string) {
        if (payload) chunks.push(payload);
      },
    } as unknown as ServerResponse;
    await handleChatwootHttpRequest(req, res, service);
    expect(statusCode).toBe(202);
    expect(JSON.parse(chunks.join(""))).toEqual({ status: "accepted" });
    await waitQueued(queue);
  });

  it("rejects legacy secrets unless WA_CHATWOOT_ALLOW_LEGACY_SECRET is true", async () => {
    expect(enabledConfig().allowLegacySecret).toBe(false);
    expect(enabledConfig().blockGroupReplies).toBe(false);
    const queue = runtime();
    const service = new ChatwootService(enabledConfig(), queue);
    const header = await service.handleWebhook({ rawBody: webhookBody(), headerSecret: SECRET });
    const query = await service.handleWebhook({
      rawBody: webhookBody({ id: 91 }),
      querySecret: SECRET,
    });
    expect(header.status).toBe(401);
    expect(query.status).toBe(401);
    expect(queue.enqueueMessage).not.toHaveBeenCalled();

    const allowed = new ChatwootService(legacyConfig(), queue);
    const accepted = await allowed.handleWebhook({ rawBody: webhookBody({ id: 92 }), headerSecret: SECRET });
    expect(accepted.status).toBe(202);
  });

  it("reserves the message id before a slow send and answers before attachments download", async () => {
    let releaseEnqueue: () => void = () => undefined;
    const enqueueGate = new Promise<void>((resolve) => {
      releaseEnqueue = resolve;
    });
    const queue = runtime();
    queue.enqueueMessage.mockImplementation(() =>
      enqueueGate.then(() => ({ status: "queued", jobId: "job-1" })),
    );
    const service = new ChatwootService(enabledConfig(), queue);
    const now = 1_700_000_500;
    const firstBody = webhookBody({ id: 60, content: "one" });
    const secondBody = webhookBody({
      id: 60,
      content: "two",
      attachments: [{ file_type: "image", data_url: "https://files.example.com/a.png" }],
    });
    const results = await Promise.all([
      service.handleWebhook(signedWebhook(firstBody, now, "delivery-a")),
      service.handleWebhook(signedWebhook(secondBody, now, "delivery-b")),
    ]);
    expect(results.map((result) => result.body)).toEqual([
      { status: "accepted" },
      { status: "ignored", reason: "duplicate" },
    ]);
    await waitQueued(queue);
    expect(queue.enqueueMessage).toHaveBeenCalledTimes(1);
    releaseEnqueue();
    await enqueueGate;

    queue.enqueueMessage.mockReset();
    queue.enqueueMessage.mockRejectedValueOnce(new Error("queue down"));
    queue.enqueueMessage.mockResolvedValue({ status: "queued", jobId: "job-2" });
    const failed = await service.handleWebhook(
      signedWebhook(webhookBody({ id: 61, content: "retry me" }), now, "delivery-fail"),
    );
    expect(failed.status).toBe(202);
    await vi.waitFor(() => expect(queue.enqueueMessage).toHaveBeenCalledTimes(1));
    const retried = await service.handleWebhook(
      signedWebhook(webhookBody({ id: 61, content: "retry me" }), now + 1, "delivery-retry"),
    );
    expect(retried.status).toBe(202);
    await waitQueued(queue, 2);
  });

  it("returns 202 before a hanging attachment download", async () => {
    let releaseDownload: (value: { data: Buffer; contentType: string }) => void = () => undefined;
    const download = new Promise<{ data: Buffer; contentType: string }>((resolve) => {
      releaseDownload = resolve;
    });
    const queue = runtime();
    const fetchAttachment = vi.fn(() => download);
    const service = new ChatwootService(enabledConfig(), queue, undefined, fetchAttachment);
    const pending = service.handleWebhook(
      signedWebhook(
        webhookBody({
          id: 70,
          content: "later",
          attachments: [{ file_type: "image", data_url: "https://files.example.com/late.png" }],
        }),
        1_700_000_700,
        "delivery-late",
      ),
    );
    const result = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("webhook waited on the attachment")), 50);
      }),
    ]);
    expect(result).toEqual({ status: 202, body: { status: "accepted" } });
    expect(queue.enqueueMessage).not.toHaveBeenCalled();
    releaseDownload({ data: Buffer.from("late"), contentType: "image/png" });
    await waitQueued(queue);
  });

  it("rejects source ids that are not JIDs and accepts both pinned formats", () => {
    expect(parseChatwootSourceId("garbage").chatId).toBe("");
    expect(parseChatwootSourceId("../../etc").chatId).toBe("");
    expect(parseChatwootSourceId("+15551234567").chatId).toBe("");
    expect(parseChatwootSourceId("nope|15551234567@s.whatsapp.net").chatId).toBe("");
    expect(parseChatwootSourceId("inst_zzzzzzzz|15551234567@s.whatsapp.net").chatId).toBe("");
    expect(parseChatwootSourceId("inst_0123abcd|not-a-jid").chatId).toBe("");
    expect(
      parseChatwootSourceId("inst_0123abcd|15551234567@s.whatsapp.net", "inst_0123abcd"),
    ).toEqual({
      instanceId: "inst_0123abcd",
      chatId: "15551234567@s.whatsapp.net",
    });
    expect(parseChatwootSourceId("15551234567@s.whatsapp.net", "inst_0123abcd")).toEqual({
      instanceId: "inst_0123abcd",
      chatId: "15551234567@s.whatsapp.net",
    });
    expect(
      parseChatwootSourceId("inst_89abcdef|15551234567@s.whatsapp.net", "inst_0123abcd").chatId,
    ).toBe("");
    expect(parseChatwootSourceId("123456789012345@lid")).toEqual({
      chatId: "123456789012345@lid",
    });
    expect(parseChatwootSourceId("inst_0123abcd|123456789012345@lid")).toEqual({
      instanceId: "inst_0123abcd",
      chatId: "123456789012345@lid",
    });
    expect(parseChatwootSourceId("123456789012345@lid", "inst_0123abcd")).toEqual({
      instanceId: "inst_0123abcd",
      chatId: "123456789012345@lid",
    });
    expect(parseChatwootSourceId("1234@lid").chatId).toBe("");
    expect(parseChatwootSourceId("inst_0123abcd|abc@lid").chatId).toBe("");
  });

  it("does not enqueue an invalid destination or a group when group replies are blocked", async () => {
    const queue = runtime();
    const service = new ChatwootService(legacyConfig(), queue);
    const invalid = await service.handleWebhook({
      rawBody: webhookBody({
        id: 93,
        conversation: {
          inbox_id: 34,
          contact_inbox: { source_id: "inst_zzzzzzzz|15551234567@s.whatsapp.net" },
        },
      }),
      headerSecret: SECRET,
    });
    expect(invalid.status).toBe(422);
    expect(queue.enqueueMessage).not.toHaveBeenCalled();

    const blocked = new ChatwootService(
      legacyConfig({ WA_CHATWOOT_BLOCK_GROUP_REPLIES: "true" }),
      queue,
    );
    const group = await blocked.handleWebhook({
      rawBody: webhookBody({
        id: 94,
        conversation: {
          inbox_id: 34,
          contact_inbox: { source_id: "120363000000000001@g.us" },
        },
      }),
      headerSecret: SECRET,
    });
    expect(group.body).toMatchObject({ reason: "group" });
    expect(queue.enqueueMessage).not.toHaveBeenCalled();
  });

  it("queues replies to LID chats in both source id formats", async () => {
    const queue = runtime();
    const service = new ChatwootService(legacyConfig(), queue);
    const bare = await service.handleWebhook({
      rawBody: webhookBody({
        id: 101,
        conversation: {
          inbox_id: 34,
          contact_inbox: { source_id: "123456789012345@lid" },
        },
      }),
      headerSecret: SECRET,
    });
    expect(bare.status).toBe(202);
    await waitQueued(queue);
    expect(queue.enqueueMessage).toHaveBeenCalledWith(
      "inst_0123abcd",
      "123456789012345@lid",
      expect.objectContaining({ type: "text" }),
      "baileys",
    );

    const encoded = await service.handleWebhook({
      rawBody: webhookBody({
        id: 102,
        conversation: {
          inbox_id: 34,
          contact_inbox: { source_id: "inst_0123abcd|123456789012345@lid" },
        },
      }),
      headerSecret: SECRET,
    });
    expect(encoded.status).toBe(202);
    await waitQueued(queue, 2);
    expect(queue.enqueueMessage).toHaveBeenLastCalledWith(
      "inst_0123abcd",
      "123456789012345@lid",
      expect.objectContaining({ type: "text" }),
      "baileys",
    );
  });

  it("returns 422 before accepting a reply for an instance that does not exist", async () => {
    const queue = runtime(["inst_89abcdef"]);
    const service = new ChatwootService(legacyConfig(), queue);
    const missing = await service.handleWebhook({
      rawBody: webhookBody({
        id: 103,
        conversation: {
          inbox_id: 34,
          contact_inbox: { source_id: "inst_0123abcd|15551234567@s.whatsapp.net" },
        },
      }),
      headerSecret: SECRET,
    });
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ error: "Chatwoot reply instance does not exist" });
    expect(queue.enqueueMessage).not.toHaveBeenCalled();
  });

  it("posts a private note when the queue or a download fails after 202", async () => {
    const queue = runtime();
    queue.enqueueMessage.mockRejectedValueOnce(new Error("queue down"));
    const recorded = recordingTransport();
    const service = new ChatwootService(enabledConfig(), queue, recorded.transport);
    const now = 1_700_000_900;
    const failed = await service.handleWebhook(
      signedWebhook(
        webhookBody({
          id: 120,
          content: "send me",
          conversation: {
            id: 77,
            inbox_id: 34,
            contact_inbox: { source_id: "15551234567@s.whatsapp.net" },
          },
        }),
        now,
        "delivery-queue-fail",
      ),
    );
    expect(failed.status).toBe(202);
    await vi.waitFor(() => {
      expect(privateNotes(recorded.calls, 77).join(" ")).toContain("was not sent");
    });
    expect(privateNotes(recorded.calls, 77).join(" ")).toContain("queue");
    expect(JSON.stringify(recorded.calls)).not.toContain("token-token-token");

    const fetchAttachment = vi.fn(async () => {
      throw new Error("download failed");
    });
    const downloads = recordingTransport();
    const downloader = new ChatwootService(
      enabledConfig(),
      runtime(),
      downloads.transport,
      fetchAttachment,
    );
    const downloaded = await downloader.handleWebhook(
      signedWebhook(
        webhookBody({
          id: 121,
          content: "",
          attachments: [{ file_type: "image", data_url: "https://files.example.com/a.png" }],
          conversation: {
            id: 78,
            inbox_id: 34,
            contact_inbox: { source_id: "15551234567@s.whatsapp.net" },
          },
        }),
        now,
        "delivery-download-fail",
      ),
    );
    expect(downloaded.status).toBe(202);
    await vi.waitFor(() => expect(fetchAttachment).toHaveBeenCalled());
    await vi.waitFor(() => {
      expect(privateNotes(downloads.calls, 78).join(" ")).toContain("could not be downloaded");
    });
    expect(downloads.calls.some((call) => call.path.includes("/conversations/78/messages"))).toBe(
      true,
    );
  });

  it("reports an attachment that exceeds the 16 MB reply budget", async () => {
    const queue = runtime();
    const recorded = recordingTransport();
    const fetchAttachment = vi.fn(async () => ({
      data: Buffer.alloc(MAX_REPLY_ATTACHMENT_BYTES),
      contentType: "image/png",
    }));
    const service = new ChatwootService(
      enabledConfig(),
      queue,
      recorded.transport,
      fetchAttachment,
    );
    const result = await service.handleWebhook(
      signedWebhook(
        webhookBody({
          id: 130,
          content: "caption",
          attachments: [
            { file_type: "image", data_url: "https://files.example.com/big.png" },
            { file_type: "image", data_url: "https://files.example.com/next.png" },
          ],
          conversation: {
            id: 79,
            inbox_id: 34,
            contact_inbox: { source_id: "15551234567@s.whatsapp.net" },
          },
        }),
        1_700_001_000,
        "delivery-budget",
      ),
    );
    expect(result.status).toBe(202);
    await waitQueued(queue);
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      const note = privateNotes(recorded.calls, 79).join(" ");
      expect(note).toContain("16 MB");
      expect(note).toContain("budget");
    });
  });

  it("ignores newsletter destinations with 200 instead of 422", async () => {
    const queue = runtime();
    const service = new ChatwootService(legacyConfig(), queue);
    expect(isChatwootNewsletterSource("inst_0123abcd|not-a-jid@newsletter")).toBe(true);
    const valid = await service.handleWebhook({
      rawBody: webhookBody({
        id: 110,
        conversation: {
          inbox_id: 34,
          contact_inbox: { source_id: "123456789012345@newsletter" },
        },
      }),
      headerSecret: SECRET,
    });
    expect(valid.status).toBe(200);
    expect(valid.body).toMatchObject({ status: "ignored", reason: "newsletter" });

    const odd = await service.handleWebhook({
      rawBody: webhookBody({
        id: 111,
        conversation: {
          inbox_id: 34,
          contact_inbox: { source_id: "inst_0123abcd|not-a-jid@newsletter" },
        },
      }),
      headerSecret: SECRET,
    });
    expect(odd.status).toBe(200);
    expect(odd.body).toMatchObject({ reason: "newsletter" });
    expect(queue.enqueueMessage).not.toHaveBeenCalled();
  });

  it("drops expired deliveries from the front and keeps a newer id in the same map", async () => {
    const queue = runtime();
    const service = new ChatwootService(enabledConfig(), queue);
    const start = 1_700_002_000;
    const first = await service.handleWebhook(
      signedWebhook(webhookBody({ id: 201 }), start, "old-delivery"),
    );
    expect(first.status).toBe(202);
    const later = await service.handleWebhook(
      signedWebhook(webhookBody({ id: 202 }), start + 10, "new-delivery"),
    );
    expect(later.status).toBe(202);
    const now = start + CHATWOOT_SIGNATURE_WINDOW_SECONDS + 1;
    const replayOld = await service.handleWebhook(
      signedWebhook(webhookBody({ id: 203 }), now, "old-delivery"),
    );
    expect(replayOld.status).toBe(202);
    const replayNew = await service.handleWebhook(
      signedWebhook(webhookBody({ id: 204 }), now, "new-delivery"),
    );
    expect(replayNew.body).toMatchObject({ reason: "duplicate" });
  });

  it("waits for background replies on stop and times out when they stall", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = runtime();
    queue.enqueueMessage.mockImplementation(() =>
      gate.then(() => ({ status: "queued", jobId: "job-drain" })),
    );
    const service = new ChatwootService(enabledConfig(), queue);
    const accepted = await service.handleWebhook(
      signedWebhook(webhookBody({ id: 150 }), 1_700_001_200, "delivery-drain"),
    );
    expect(accepted.status).toBe(202);
    await vi.waitFor(() => expect(queue.enqueueMessage).toHaveBeenCalledTimes(1));

    vi.useFakeTimers();
    try {
      const stopping = service.stop();
      let done = false;
      void stopping.then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(CHATWOOT_REPLY_DRAIN_TIMEOUT_MS - 1);
      expect(done).toBe(false);
      release();
      await stopping;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    let stalledCalled = false;
    const stalled = runtime();
    stalled.enqueueMessage.mockImplementation(
      () =>
        new Promise(() => {
          stalledCalled = true;
        }),
    );
    const hanging = new ChatwootService(enabledConfig(), stalled);
    const hung = await hanging.handleWebhook(
      signedWebhook(webhookBody({ id: 151 }), 1_700_001_300, "delivery-hang"),
    );
    expect(hung.status).toBe(202);
    await vi.waitFor(() => expect(stalledCalled).toBe(true));
    vi.useFakeTimers();
    try {
      const stopping = hanging.stop();
      let done = false;
      void stopping.then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(CHATWOOT_REPLY_DRAIN_TIMEOUT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still recognizes a delivery id after thousands of newer deliveries in the same window", async () => {
    const queue = runtime();
    const service = new ChatwootService(enabledConfig(), queue);
    const now = 1_700_000_800;
    for (let index = 0; index <= 2001; index += 1) {
      const body = webhookBody({ id: 1_000 + index, content: `m${index}` });
      const result = await service.handleWebhook(signedWebhook(body, now, `delivery-${index}`));
      expect(result.status).toBe(202);
    }
    const replay = await service.handleWebhook(
      signedWebhook(webhookBody({ id: 9_999, content: "replay" }), now, "delivery-0"),
    );
    expect(replay.body).toMatchObject({ reason: "duplicate" });
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

  it("downloads attachments only after DNS pinning and refuses redirects", async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("file-bytes"), { status: 200 }));
    const downloaded = await fetchPinnedResource(
      new URL("https://cdn.example.com/a.png"),
      enabledConfig(),
      1024,
      {
        fetchImpl: fetchImpl as typeof fetch,
        resolveDns: async () => [{ address: "1.1.1.1", family: 4 }],
      },
    );
    expect(downloaded.data).toEqual(Buffer.from("file-bytes"));
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        redirect: "error",
        dispatcher: expect.any(Agent),
        headers: { accept: "*/*" },
      }),
    );

    const sameOrigin = vi.fn(
      async () =>
        new Response(Buffer.from("blob"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    await fetchPinnedResource(
      new URL("https://chatwoot.example.com/rails/active_storage/blobs/a"),
      enabledConfig(),
      1024,
      {
        fetchImpl: sameOrigin as typeof fetch,
        resolveDns: async () => [{ address: "1.1.1.1", family: 4 }],
      },
    );
    expect(sameOrigin).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({ api_access_token: "token-token-token" }),
      }),
    );

    const blocked = vi.fn(async () => new Response("nope"));
    await expect(
      fetchPinnedResource(new URL("https://localtest.me/secret"), enabledConfig(), 1024, {
        fetchImpl: blocked as typeof fetch,
        resolveDns: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
    ).rejects.toBeInstanceOf(ChatwootRequestError);
    await expect(
      fetchPinnedResource(new URL("https://cdn.example.com/big"), enabledConfig(), 4, {
        fetchImpl: (async () => new Response(Buffer.from("too-big"))) as typeof fetch,
        resolveDns: async () => [{ address: "1.1.1.1", family: 4 }],
      }),
    ).rejects.toBeInstanceOf(ChatwootRequestError);
    expect(blocked).not.toHaveBeenCalled();
  });

  it("allows a private address only for the configured Chatwoot origin", async () => {
    const config = enabledConfig({ WA_CHATWOOT_ALLOW_PRIVATE_URL: "true" });
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("blob"), { status: 200 }));
    await expect(
      fetchPinnedResource(new URL("https://chatwoot.example.com/rails/active_storage/a"), config, 1024, {
        fetchImpl: fetchImpl as typeof fetch,
        resolveDns: async () => [{ address: "10.1.1.1", family: 4 }],
      }),
    ).resolves.toMatchObject({ data: Buffer.from("blob") });

    const other = vi.fn(async () => new Response(Buffer.from("nope")));
    await expect(
      fetchPinnedResource(new URL("https://files.example.com/a.png"), config, 1024, {
        fetchImpl: other as typeof fetch,
        resolveDns: async () => [{ address: "10.1.1.1", family: 4 }],
      }),
    ).rejects.toBeInstanceOf(ChatwootRequestError);
    expect(other).not.toHaveBeenCalled();
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
