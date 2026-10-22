import { createHmac } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INSTANCE_WEBHOOKS_SCHEMA_SQL } from "../src/db/instance-webhooks-schema.js";
import { db } from "../src/db/client.js";
import { instances } from "../src/db/schema.js";
import { buildHealthBody } from "../src/server/health.js";
import {
  DeleteInstanceWebhookSchema,
  GetInstanceWebhookSchema,
  SetInstanceWebhookSchema,
} from "../src/schemas/instance.schema.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import {
  EventWebhookService,
  processEventWebhookJob,
  createEventWebhookHeaders,
  eventWebhookDestinationIdentity,
  shouldSendEventWebhook,
  registerEventWebhookHandler,
} from "../src/services/event-webhook.js";
import {
  destinationsForInstance,
  eventWebhookHealth,
  getEventWebhookStatus,
  loadEventWebhookConfig,
  bootEventWebhook,
  canonicalWebhookUrl,
} from "../src/services/event-webhook-config.js";
import {
  readInstanceWebhook,
  removeInstanceWebhook,
  setInstanceWebhook,
} from "../src/services/instance-webhook.js";
import {
  getInstanceWebhook,
  INSTANCE_WEBHOOK_SQL,
  touchInstanceWebhookStorage,
} from "../src/services/instance-webhook-store.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import { registerInstanceTools } from "../src/tools/instance.tools.js";
import type { ChannelEventPayload } from "../src/types/channel.types.js";
import { logger } from "../src/utils/logger.js";

const { infoMock, errorMock } = vi.hoisted(() => ({
  infoMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock("../src/utils/logger.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/utils/logger.js")>("../src/utils/logger.js");
  return {
    ...actual,
    createRequestLogger: () => ({ info: infoMock, error: errorMock }),
  };
});

const INSTANCE_A = "inst_aaaaaaaa";
const INSTANCE_B = "inst_bbbbbbbb";
const GLOBAL_URL = "https://hooks.example.test/global";
const INSTANCE_URL = "https://hooks.example.test/instance-a";
const SECOND_URL = "https://hooks.example.test/instance-b";
const AUTH_HEADER = "X-Instance-Token";
const AUTH_SECRET = "instance-auth-secret-120";
const GLOBAL_HMAC = "global-hmac-secret-120";

type EventHandler = Parameters<InstanceManager["onAnyEvent"]>[0];
type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function insertInstance(id: string): void {
  const now = Date.now();
  db.insert(instances).values({ id, name: id, createdAt: now, updatedAt: now }).run();
}

function deleteInstance(id: string): void {
  db.delete(instances).where(eq(instances.id, id)).run();
  touchInstanceWebhookStorage();
}

function globalConfig(overrides: Record<string, string | undefined> = {}) {
  return loadEventWebhookConfig({
    WA_EVENT_WEBHOOK_URL: GLOBAL_URL,
    ...overrides,
  });
}

function incomingMessage(): ChannelEventPayload["message.received"] {
  return {
    instanceId: INSTANCE_A,
    chatId: "5511888888888@s.whatsapp.net",
    message: {
      id: "wamid.instance-webhook",
      sender: "5511888888888@s.whatsapp.net",
      timestamp: 1_700_000_000,
      type: "text",
      content: "hello",
      mediaUrl: null,
      quotedMessageId: null,
      isFromMe: false,
    },
  };
}

function editEvent(): ChannelEventPayload["message.edited"] {
  return {
    instanceId: INSTANCE_A,
    chatId: "5511888888888@s.whatsapp.net",
    messageId: "wamid.instance-webhook",
    newContent: "edited",
    editedAt: 1_700_000_100,
  };
}

function captureHandler(): { manager: InstanceManager; handler: () => EventHandler | undefined } {
  let eventHandler: EventHandler | undefined;
  const manager = {
    onAnyEvent: (handler: EventHandler) => {
      eventHandler = handler;
      return () => undefined;
    },
  } as unknown as InstanceManager;
  return { manager, handler: () => eventHandler };
}

function serialized(mock: ReturnType<typeof vi.fn>): string {
  return mock.mock.calls
    .map((call) =>
      call.map((item) => (item instanceof Error ? item.message : JSON.stringify(item))).join(" "),
    )
    .join("\n");
}

function registerWebhookTools(sync = vi.fn()): Map<string, ToolHandler> {
  vi.stubEnv("WA_INSTANCE_WEBHOOK_TOOLS_ENABLED", "true");
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (_name: string, _config: unknown, handler: ToolHandler) => {
      handlers.set(_name, handler);
    },
  } as unknown as McpServer;
  registerInstanceTools(
    server,
    { getInstanceLifecycleStatuses: () => [] } as unknown as InstanceManager,
    {} as MessageQueue,
    { sync } as unknown as EventWebhookService,
  );
  return handlers;
}

beforeEach(() => {
  deleteInstance(INSTANCE_A);
  deleteInstance(INSTANCE_B);
  insertInstance(INSTANCE_A);
  insertInstance(INSTANCE_B);
});

afterEach(() => {
  deleteInstance(INSTANCE_A);
  deleteInstance(INSTANCE_B);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  infoMock.mockClear();
  errorMock.mockClear();
});

describe("per-instance event webhooks", () => {
  it("inherits a standalone HMAC secret without a global URL", () => {
    setInstanceWebhook({ instanceId: INSTANCE_A, url: INSTANCE_URL });
    for (const extra of [{}, { WA_EVENT_WEBHOOKS: "[]" }]) {
      const config = loadEventWebhookConfig({ WA_EVENT_WEBHOOK_SECRET: GLOBAL_HMAC, ...extra });
      expect(config.destinations).toEqual([]);
      const destination = destinationsForInstance(config, INSTANCE_A)[0]!;
      expect(destination.secret).toBe(GLOBAL_HMAC);
      const body = JSON.stringify({ event: "message.received" });
      const headers = createEventWebhookHeaders(body, destination, "1700000000");
      expect(headers.get("x-wa-event-signature")).toBe(
        `sha256=${createHmac("sha256", GLOBAL_HMAC).update(`1700000000.${body}`).digest("hex")}`,
      );
      expect(JSON.stringify(getEventWebhookStatus({}, config))).not.toContain(GLOBAL_HMAC);
    }
  });

  it("keeps the shared JID filter for instance-only delivery", () => {
    setInstanceWebhook({ instanceId: INSTANCE_A, url: INSTANCE_URL });
    const config = loadEventWebhookConfig({
      WA_EVENT_WEBHOOK_IGNORE_JIDS: "5511888888888@s.whatsapp.net",
    });
    const destination = destinationsForInstance(config, INSTANCE_A)[0]!;
    expect(shouldSendEventWebhook("message.received", incomingMessage(), destination)).toBe(false);
  });

  it.each([
    ["url", "http://hooks.example.test/path"],
    ["url", "https://127.0.0.1/path"],
    ["url", "not-a-url"],
    ["auth_header", "Authorization"],
    ["auth_value", "orphan-secret"],
  ])("reports an invalid stored %s consistently with routing", (column, value) => {
    vi.stubEnv("WA_EVENT_WEBHOOK_ALLOW_HTTP", "false");
    setInstanceWebhook({ instanceId: INSTANCE_A, url: INSTANCE_URL });
    db.$client
      .prepare(`UPDATE instance_webhooks SET ${column} = ? WHERE instance_id = ?`)
      .run(value, INSTANCE_A);
    touchInstanceWebhookStorage();
    expect(destinationsForInstance(globalConfig(), INSTANCE_A)).toEqual(
      globalConfig().destinations,
    );
    expect(readInstanceWebhook(INSTANCE_A)).toEqual({ configured: false, invalid: true });
  });

  it.each([
    [false, 0],
    [false, 10],
    [true, 0],
    [true, 10],
  ])("keeps colliding IDs isolated with merge=%s and debounce=%s", async (merge, debounce) => {
    setInstanceWebhook({
      instanceId: INSTANCE_A,
      url: INSTANCE_URL,
      authHeader: AUTH_HEADER,
      authValue: AUTH_SECRET,
    });
    const config = loadEventWebhookConfig({
      WA_EVENT_WEBHOOK_INSTANCE_MERGE_GLOBAL: String(merge),
      WA_WEBHOOK_DEBOUNCE_MS: String(debounce),
      WA_EVENT_WEBHOOKS: JSON.stringify([
        { id: `instance:${INSTANCE_A}`, url: GLOBAL_URL, secret: GLOBAL_HMAC },
      ]),
    });
    const service = new EventWebhookService(config);
    (service as unknown as { rebuildKnownDestinations(): void }).rebuildKnownDestinations();
    const deliver = vi.fn<Parameters<typeof processEventWebhookJob>[3]>(async () => undefined);
    const { manager, handler } = captureHandler();
    const jobs: Parameters<typeof processEventWebhookJob>[0][] = [];
    const unsubscribe = registerEventWebhookHandler(
      manager,
      config,
      async (job) => {
        jobs.push(job);
      },
      undefined,
      (instanceId) => destinationsForInstance(config, instanceId),
    );
    handler()?.("message.received", INSTANCE_A, incomingMessage());
    handler()?.("message.received", INSTANCE_B, { ...incomingMessage(), instanceId: INSTANCE_B });
    await unsubscribe.flush();
    unsubscribe();
    expect(jobs).toHaveLength(merge ? 3 : 2);
    for (const job of jobs)
      await processEventWebhookJob(job, service.destinationMap(), 1000, deliver);
    expect(deliver.mock.calls.map(([destination]) => destination.url).sort()).toEqual(
      (merge ? [GLOBAL_URL, INSTANCE_URL, GLOBAL_URL] : [INSTANCE_URL, GLOBAL_URL]).sort(),
    );
  });

  it("clears worker destinations after removing the final instance webhook", () => {
    setInstanceWebhook({ instanceId: INSTANCE_A, url: INSTANCE_URL });
    const service = new EventWebhookService(loadEventWebhookConfig({}));
    (service as unknown as { rebuildKnownDestinations(): void }).rebuildKnownDestinations();
    expect(service.destinationMap().size).toBe(1);
    removeInstanceWebhook(INSTANCE_A);
    service.start(captureHandler().manager);
    expect(service.destinationMap().size).toBe(0);
  });

  it("rejects pending delivery after instance deletion invalidates the cache", async () => {
    setInstanceWebhook({ instanceId: INSTANCE_A, url: INSTANCE_URL });
    const config = loadEventWebhookConfig({});
    const destination = destinationsForInstance(config, INSTANCE_A)[0]!;
    const service = new EventWebhookService(config);
    expect(service.destinationMap().size).toBe(1);
    deleteInstance(INSTANCE_A);
    const deliver = vi.fn<Parameters<typeof processEventWebhookJob>[3]>(async () => undefined);
    await expect(
      processEventWebhookJob(
        {
          destinationId: destination.id,
          destinationIdentity: eventWebhookDestinationIdentity(destination),
          payload: {},
        },
        service.destinationMap(),
        1000,
        deliver,
      ),
    ).rejects.toThrow(/does not match/);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("routes routine Grok events only to the configured instance with its standalone HMAC", async () => {
    setInstanceWebhook({ instanceId: INSTANCE_A, url: INSTANCE_URL, events: ["newsletter.mute"] });
    const config = loadEventWebhookConfig({
      WA_EVENT_WEBHOOK_PRESET: "grok-bot",
      WA_EVENT_WEBHOOK_SECRET: GLOBAL_HMAC,
      WA_WEBHOOK_DEBOUNCE_MS: "10",
    });
    const { manager, handler } = captureHandler();
    const jobs: Parameters<typeof processEventWebhookJob>[0][] = [];
    const unsubscribe = registerEventWebhookHandler(
      manager,
      config,
      async (job) => {
        jobs.push(job);
      },
      undefined,
      (instanceId) => destinationsForInstance(config, instanceId),
    );
    for (const instanceId of [INSTANCE_A, INSTANCE_B]) {
      handler()?.("newsletter.mute", instanceId, {
        instanceId,
        newsletterId: "123@newsletter",
        chatId: "123@newsletter",
        mute: "on",
        timestamp: 1700000200,
      });
    }
    await unsubscribe.flush();
    unsubscribe();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({
      event: "newsletter.mute",
      instanceId: INSTANCE_A,
      text: "Canal silenciado",
    });
    expect(jobs[0]?.payload).not.toHaveProperty("messages");
    const service = new EventWebhookService(config);
    const deliver = vi.fn<Parameters<typeof processEventWebhookJob>[3]>(async () => undefined);
    await processEventWebhookJob(jobs[0]!, service.destinationMap(), 1000, deliver);
    expect(deliver.mock.calls[0]?.[0].secret).toBe(GLOBAL_HMAC);
    expect(getEventWebhookStatus({}, config).droppedEvents).toEqual([]);
  });

  it("defaults merge to false and rejects an invalid flag", () => {
    expect(loadEventWebhookConfig({}).instanceMergeGlobal).toBe(false);
    expect(globalConfig().instanceMergeGlobal).toBe(false);
    expect(() =>
      loadEventWebhookConfig({ WA_EVENT_WEBHOOK_INSTANCE_MERGE_GLOBAL: "maybe" }),
    ).toThrow(/Invalid WA_EVENT_WEBHOOK_INSTANCE_MERGE_GLOBAL/);
  });

  it("keeps today's global routing when an instance has no stored webhook", () => {
    const config = globalConfig();
    expect(destinationsForInstance(config, INSTANCE_A).map((item) => item.id)).toEqual(["default"]);
    expect(destinationsForInstance(config, INSTANCE_B)).toEqual(config.destinations);
    expect(getEventWebhookStatus({})).toEqual({
      configured: false,
      destinationCount: 0,
      eventCount: 1,
      authConfigured: false,
      warnings: ["not_configured"],
      droppedEvents: [],
    });
  });

  it("replaces global destinations for that instance only", async () => {
    setInstanceWebhook({
      instanceId: INSTANCE_A,
      url: INSTANCE_URL,
      authHeader: AUTH_HEADER,
      authValue: AUTH_SECRET,
      events: ["message.edited"],
    });
    const config = globalConfig({ WA_EVENT_WEBHOOK_SECRET: GLOBAL_HMAC });
    const instanceDestinations = destinationsForInstance(config, INSTANCE_A);
    const otherDestinations = destinationsForInstance(config, INSTANCE_B);

    expect(instanceDestinations.map((item) => item.id)).toEqual([`instance:${INSTANCE_A}`]);
    expect(instanceDestinations[0]).toMatchObject({
      url: INSTANCE_URL,
      events: ["message.edited"],
      debounceMs: 0,
      ignoreFromMe: true,
    });
    expect(instanceDestinations[0]?.secret).toBe(GLOBAL_HMAC);
    expect(instanceDestinations[0]?.headers["x-instance-token"]).toBe(AUTH_SECRET);
    expect(otherDestinations.map((item) => item.id)).toEqual(["default"]);
    expect(otherDestinations[0]?.secret).toBe(GLOBAL_HMAC);

    const { manager, handler } = captureHandler();
    const enqueue = vi.fn(() => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(
      manager,
      config,
      enqueue,
      undefined,
      (instanceId) => destinationsForInstance(config, instanceId),
    );
    handler()?.("message.received", INSTANCE_A, incomingMessage());
    handler()?.("message.edited", INSTANCE_A, editEvent());
    handler()?.("message.received", INSTANCE_B, {
      ...incomingMessage(),
      instanceId: INSTANCE_B,
    });
    handler()?.("message.edited", INSTANCE_B, { ...editEvent(), instanceId: INSTANCE_B });
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));

    expect(enqueue.mock.calls.map((call) => call[0].destinationId)).toEqual([
      `instance:${INSTANCE_A}`,
      "default",
    ]);
    expect(enqueue.mock.calls[0]?.[0].payload).toMatchObject({ event: "message.edited" });
    expect(enqueue.mock.calls[1]?.[0].payload).toMatchObject({ event: "message.received" });
    unsubscribe();
    await unsubscribe.flush();
  });

  it("delivers to the instance and global webhooks when merge is enabled", async () => {
    setInstanceWebhook({ instanceId: INSTANCE_A, url: INSTANCE_URL });
    const config = globalConfig({ WA_EVENT_WEBHOOK_INSTANCE_MERGE_GLOBAL: "true" });
    expect(destinationsForInstance(config, INSTANCE_A).map((item) => item.id)).toEqual([
      "default",
      `instance:${INSTANCE_A}`,
    ]);
    expect(destinationsForInstance(config, INSTANCE_A)[1]?.events).toEqual(["message.received"]);

    const { manager, handler } = captureHandler();
    const enqueue = vi.fn(() => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(
      manager,
      config,
      enqueue,
      undefined,
      (instanceId) => destinationsForInstance(config, instanceId),
    );
    handler()?.("message.received", INSTANCE_A, incomingMessage());
    handler()?.("message.received", INSTANCE_B, {
      ...incomingMessage(),
      instanceId: INSTANCE_B,
    });
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(3));
    expect(enqueue.mock.calls.map((call) => call[0].destinationId)).toEqual([
      "default",
      `instance:${INSTANCE_A}`,
      "default",
    ]);
    unsubscribe();
    await unsubscribe.flush();
  });

  it("sends a duplicate URL once and keeps the instance auth header", () => {
    setInstanceWebhook({
      instanceId: INSTANCE_A,
      url: GLOBAL_URL,
      authHeader: AUTH_HEADER,
      authValue: AUTH_SECRET,
      events: ["message.edited"],
    });
    const config = globalConfig({
      WA_EVENT_WEBHOOK_INSTANCE_MERGE_GLOBAL: "true",
      WA_EVENT_WEBHOOK_SECRET: GLOBAL_HMAC,
    });
    const destinations = destinationsForInstance(config, INSTANCE_A);

    expect(destinations).toHaveLength(1);
    expect(destinations[0]?.id).toBe(`instance:${INSTANCE_A}`);
    expect(destinations[0]?.events).toEqual(["message.edited"]);
    expect(destinations[0]?.headers["x-instance-token"]).toBe(AUTH_SECRET);
    expect(destinations[0]?.secret).toBe(GLOBAL_HMAC);
  });

  it("replaces every global destination and merges without repeating the same URL", () => {
    const config = loadEventWebhookConfig({
      WA_EVENT_WEBHOOKS: JSON.stringify([
        { id: "one", url: GLOBAL_URL },
        { id: "two", url: SECOND_URL },
      ]),
    });
    expect(destinationsForInstance(config, INSTANCE_A).map((item) => item.id)).toEqual([
      "one",
      "two",
    ]);

    setInstanceWebhook({ instanceId: INSTANCE_A, url: GLOBAL_URL });
    expect(destinationsForInstance(config, INSTANCE_A).map((item) => item.id)).toEqual([
      `instance:${INSTANCE_A}`,
    ]);

    const merged = loadEventWebhookConfig({
      WA_EVENT_WEBHOOK_INSTANCE_MERGE_GLOBAL: "true",
      WA_EVENT_WEBHOOKS: JSON.stringify([
        { id: "one", url: GLOBAL_URL },
        { id: "two", url: SECOND_URL },
      ]),
    });
    expect(destinationsForInstance(merged, INSTANCE_A).map((item) => item.id)).toEqual([
      "two",
      `instance:${INSTANCE_A}`,
    ]);
    expect(destinationsForInstance(merged, INSTANCE_B).map((item) => item.id)).toEqual([
      "one",
      "two",
    ]);
  });

  it("inherits global events, preset, and ignoreFromMe when events are omitted", () => {
    const saved = setInstanceWebhook({
      instanceId: INSTANCE_A,
      url: INSTANCE_URL,
      authHeader: AUTH_HEADER,
      authValue: AUTH_SECRET,
    });
    expect(saved.events).toBeNull();
    expect(saved.authConfigured).toBe(true);
    expect(saved).not.toHaveProperty("authValue");

    const config = globalConfig({
      WA_EVENT_WEBHOOK_PRESET: "grok-bot",
      WA_EVENT_WEBHOOK_IGNORE_FROM_ME: "false",
      WA_EVENT_WEBHOOK_EVENTS: "message.received,connection.changed",
    });
    const destination = destinationsForInstance(config, INSTANCE_A)[0];
    expect(destination?.events).toEqual(["message.received", "connection.changed"]);
    expect(destination?.preset).toBe("grok-bot");
    expect(destination?.ignoreFromMe).toBe(false);

    const status = getEventWebhookStatus({
      WA_EVENT_WEBHOOK_PRESET: "grok-bot",
      WA_EVENT_WEBHOOK_EVENTS: "message.received,connection.changed",
      WA_EVENT_WEBHOOK_URL: GLOBAL_URL,
    });
    expect(status.droppedEvents).toEqual(["connection.changed"]);
    expect(status.destinationCount).toBe(2);
    expect(status.authConfigured).toBe(true);
  });

  it("rejects invalid URLs, auth pairs, event lists, and instance ids", () => {
    expect(() =>
      setInstanceWebhook({ instanceId: INSTANCE_A, url: "http://hooks.example.test/hook" }),
    ).toThrow(/Invalid instance webhook URL/);
    expect(() =>
      setInstanceWebhook({ instanceId: INSTANCE_A, url: "https://127.0.0.1/hook" }),
    ).toThrow(/Invalid instance webhook URL/);
    expect(() =>
      setInstanceWebhook({
        instanceId: INSTANCE_A,
        url: "https://user:pass@hooks.example.test/hook",
      }),
    ).toThrow(/Invalid instance webhook URL/);
    expect(() =>
      setInstanceWebhook({
        instanceId: INSTANCE_A,
        url: INSTANCE_URL,
        authHeader: AUTH_HEADER,
      }),
    ).toThrow(/authHeader and authValue must be set together/);
    expect(() =>
      setInstanceWebhook({
        instanceId: INSTANCE_A,
        url: INSTANCE_URL,
        authValue: AUTH_SECRET,
      }),
    ).toThrow(/authHeader and authValue must be set together/);
    expect(() =>
      setInstanceWebhook({ instanceId: INSTANCE_A, url: INSTANCE_URL, events: [" "] }),
    ).toThrow(/at least one event name/);
    expect(() =>
      setInstanceWebhook({ instanceId: INSTANCE_A, url: INSTANCE_URL, events: ["not.an.event"] }),
    ).toThrow(/unsupported event name/);
    expect(() => setInstanceWebhook({ instanceId: "nope", url: INSTANCE_URL })).toThrow(
      /Invalid instance ID/,
    );
    expect(() => setInstanceWebhook({ instanceId: "inst_cccccccc", url: INSTANCE_URL })).toThrow(
      /Instance not found/,
    );
    expect(getInstanceWebhook(INSTANCE_A)).toBeUndefined();

    const unknown = SetInstanceWebhookSchema.safeParse({
      instanceId: INSTANCE_A,
      url: INSTANCE_URL,
      extra: true,
    });
    expect(unknown.success).toBe(false);
    const mismatched = SetInstanceWebhookSchema.safeParse({
      instanceId: INSTANCE_A,
      url: INSTANCE_URL,
      authHeader: AUTH_HEADER,
    });
    expect(mismatched.success).toBe(false);
    expect(
      GetInstanceWebhookSchema.safeParse({ instanceId: INSTANCE_A, extra: true }).success,
    ).toBe(false);
    expect(DeleteInstanceWebhookSchema.safeParse({ instanceId: INSTANCE_A }).success).toBe(true);
  });

  it("allows HTTP only when the shared webhook flag is enabled", () => {
    vi.stubEnv("WA_EVENT_WEBHOOK_ALLOW_HTTP", "true");
    const saved = setInstanceWebhook({
      instanceId: INSTANCE_A,
      url: "http://hooks.example.test/hook",
    });
    expect(saved.endpoint).toBe("http://hooks.example.test");
    expect(getInstanceWebhook(INSTANCE_A)?.url).toBe("http://hooks.example.test/hook");
    expect(() =>
      setInstanceWebhook({ instanceId: INSTANCE_B, url: "http://10.1.1.1/hook" }),
    ).toThrow(/Invalid instance webhook URL/);
  });

  it("omits secrets from tool output, logs, status, and health", async () => {
    const sync = vi.fn();
    const tools = registerWebhookTools(sync);
    const setResult = await tools.get("wa_set_instance_webhook")?.({
      instanceId: INSTANCE_A,
      url: INSTANCE_URL,
      authHeader: AUTH_HEADER,
      authValue: AUTH_SECRET,
    });
    const setText = setResult?.content[0]?.text ?? "";
    const getResult = await tools.get("wa_get_instance_webhook")?.({ instanceId: INSTANCE_A });
    const getText = getResult?.content[0]?.text ?? "";
    const status = getEventWebhookStatus({});
    const health = buildHealthBody({
      uptimeSeconds: 1,
      instances: { total: 1, connected: 0, disconnected: 1 },
      version: "2.0.0",
      webhook: status,
    });

    expect(setResult?.isError).toBeUndefined();
    expect(JSON.parse(setText)).toMatchObject({
      configured: true,
      endpoint: "https://hooks.example.test",
      authHeader: AUTH_HEADER,
      authConfigured: true,
      events: null,
    });
    expect(setText).not.toContain("/instance-a");
    expect(JSON.parse(getText)).toMatchObject({
      authConfigured: true,
      endpoint: "https://hooks.example.test",
    });
    expect(getText).not.toContain("/instance-a");
    expect(setText).not.toContain(AUTH_SECRET);
    expect(getText).not.toContain(AUTH_SECRET);
    expect(serialized(infoMock)).not.toContain(AUTH_SECRET);
    expect(serialized(infoMock)).not.toContain(INSTANCE_URL);
    expect(serialized(infoMock)).not.toContain(AUTH_HEADER);
    expect(errorMock).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledOnce();
    expect(JSON.stringify(status)).not.toContain(AUTH_SECRET);
    expect(JSON.stringify(status)).not.toContain(INSTANCE_URL);
    expect(JSON.stringify(status)).not.toContain(AUTH_HEADER);
    expect(JSON.stringify(eventWebhookHealth(status))).not.toContain(AUTH_SECRET);
    expect(JSON.stringify(health)).not.toContain(INSTANCE_URL);
    expect(status).toMatchObject({
      configured: true,
      destinationCount: 1,
      eventCount: 1,
      authConfigured: true,
      warnings: [],
    });

    const replaced = await tools.get("wa_set_instance_webhook")?.({
      instanceId: INSTANCE_A,
      url: SECOND_URL,
    });
    expect(JSON.parse(replaced?.content[0]?.text ?? "")).toMatchObject({
      endpoint: "https://hooks.example.test",
      authHeader: null,
      authConfigured: false,
      events: null,
    });
    expect(replaced?.content[0]?.text).not.toContain("/instance-b");
    expect(getInstanceWebhook(INSTANCE_A)?.authValue).toBeNull();
  });

  it("returns an error without the secret when validation fails", async () => {
    const sync = vi.fn();
    const tools = registerWebhookTools(sync);
    const result = await tools.get("wa_set_instance_webhook")?.({
      instanceId: INSTANCE_A,
      url: "https://user:pass@hooks.example.test/hook",
      authHeader: AUTH_HEADER,
      authValue: AUTH_SECRET,
    });

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).not.toContain(AUTH_SECRET);
    expect(result?.content[0]?.text).not.toContain("user:pass");
    expect(serialized(errorMock)).not.toContain(AUTH_SECRET);
    expect(sync).not.toHaveBeenCalled();
    expect(getInstanceWebhook(INSTANCE_A)).toBeUndefined();
  });

  it("removes the instance webhook and falls back to the global destinations", async () => {
    setInstanceWebhook({ instanceId: INSTANCE_A, url: INSTANCE_URL });
    const sync = vi.fn();
    const tools = registerWebhookTools(sync);
    const deleted = await tools.get("wa_delete_instance_webhook")?.({ instanceId: INSTANCE_A });
    const config = globalConfig();

    expect(JSON.parse(deleted?.content[0]?.text ?? "")).toEqual({
      instanceId: INSTANCE_A,
      deleted: true,
    });
    expect(sync).toHaveBeenCalledOnce();
    expect(readInstanceWebhook(INSTANCE_A)).toEqual({ configured: false });
    expect(destinationsForInstance(config, INSTANCE_A).map((item) => item.id)).toEqual(["default"]);
    expect(removeInstanceWebhook(INSTANCE_A)).toEqual({ deleted: false });
    expect(serialized(infoMock)).not.toContain(INSTANCE_URL);
  });

  it("deletes the stored webhook when the instance is deleted", () => {
    setInstanceWebhook({
      instanceId: INSTANCE_A,
      url: INSTANCE_URL,
      authValue: AUTH_SECRET,
      authHeader: AUTH_HEADER,
    });
    deleteInstance(INSTANCE_A);
    expect(getInstanceWebhook(INSTANCE_A)).toBeUndefined();
  });

  it("treats a stored instance webhook as configured for the boot check", () => {
    const exit = vi.fn();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const fatal = vi.spyOn(logger, "fatal").mockImplementation(() => undefined);
    setInstanceWebhook({
      instanceId: INSTANCE_A,
      url: INSTANCE_URL,
      authHeader: AUTH_HEADER,
      authValue: AUTH_SECRET,
    });

    const status = bootEventWebhook({ WA_REQUIRE_EVENT_WEBHOOK: "true" }, exit);
    expect(exit).not.toHaveBeenCalled();
    expect(fatal).not.toHaveBeenCalled();
    expect(status.configured).toBe(true);
    expect(status.destinationCount).toBe(1);
    expect(JSON.stringify(status)).not.toContain(AUTH_SECRET);
    expect(JSON.stringify(status)).not.toContain(INSTANCE_URL);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(AUTH_SECRET);

    deleteInstance(INSTANCE_A);
    expect(() => bootEventWebhook({ WA_REQUIRE_EVENT_WEBHOOK: "true" }, exit)).toThrow(
      /not configured/,
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.stringify(fatal.mock.calls)).not.toContain(AUTH_SECRET);
    expect(JSON.stringify(fatal.mock.calls)).not.toContain(INSTANCE_URL);
  });

  it("does not start delivery when no destination exists", () => {
    const onAnyEvent = vi.fn();
    const service = new EventWebhookService(loadEventWebhookConfig({}));
    const manager = { onAnyEvent } as unknown as InstanceManager;
    service.sync();
    service.start(manager);
    service.sync();
    expect(onAnyEvent).not.toHaveBeenCalled();
  });

  it("skips one invalid stored row and keeps global delivery", () => {
    vi.stubEnv("WA_EVENT_WEBHOOK_ALLOW_HTTP", "true");
    setInstanceWebhook({ instanceId: INSTANCE_A, url: "http://hooks.example.test/private-path" });
    vi.stubEnv("WA_EVENT_WEBHOOK_ALLOW_HTTP", "false");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const env = {
      WA_EVENT_WEBHOOK_URL: GLOBAL_URL,
      WA_EVENT_WEBHOOK_ALLOW_HTTP: "false",
    };
    const exit = vi.fn();

    expect(() => getEventWebhookStatus(env)).not.toThrow();
    const status = getEventWebhookStatus(env);
    expect(status).toMatchObject({ configured: true, destinationCount: 1 });
    expect(JSON.stringify(status)).not.toContain("private-path");
    expect(JSON.stringify(status)).not.toContain("hooks.example.test");
    const booted = bootEventWebhook(env, exit);
    expect(exit).not.toHaveBeenCalled();
    expect(booted.destinationCount).toBe(1);

    const config = loadEventWebhookConfig(env);
    expect(destinationsForInstance(config, INSTANCE_A).map((item) => item.id)).toEqual(["default"]);
    expect(destinationsForInstance(config, INSTANCE_B).map((item) => item.id)).toEqual(["default"]);
    expect(JSON.stringify(warn.mock.calls)).toContain("Skipping invalid stored instance webhook");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-path");

    db.$client
      .prepare("UPDATE instance_webhooks SET events = ? WHERE instance_id = ?")
      .run("not-json", INSTANCE_A);
    touchInstanceWebhookStorage();
    expect(() => getEventWebhookStatus(env)).not.toThrow();
    expect(getEventWebhookStatus(env).destinationCount).toBe(1);
  });

  it("rebuilds instance destinations on sync and reuses that cache for delivery", () => {
    setInstanceWebhook({ instanceId: INSTANCE_A, url: INSTANCE_URL });
    const service = new EventWebhookService(globalConfig());
    const internals = service as unknown as {
      rebuildKnownDestinations: () => void;
    };
    internals.rebuildKnownDestinations();
    expect(
      [...service.destinationMap().values()].find((item) => item.id === `instance:${INSTANCE_A}`)
        ?.url,
    ).toBe(INSTANCE_URL);

    db.$client
      .prepare("UPDATE instance_webhooks SET url = ? WHERE instance_id = ?")
      .run("http://hooks.example.test/changed", INSTANCE_A);
    expect(
      [...service.destinationMap().values()].find((item) => item.id === `instance:${INSTANCE_A}`)
        ?.url,
    ).toBe(INSTANCE_URL);
    touchInstanceWebhookStorage();

    internals.rebuildKnownDestinations();
    expect(
      [...service.destinationMap().values()].some((item) => item.id === `instance:${INSTANCE_A}`),
    ).toBe(false);
    expect([...service.destinationMap().values()].some((item) => item.id === "default")).toBe(true);
  });

  it("leaves the instance webhook tools unregistered until the flag is enabled", () => {
    const disabled = new Map<string, ToolHandler>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
        disabled.set(name, handler);
      },
    } as unknown as McpServer;
    registerInstanceTools(
      server,
      { getInstanceLifecycleStatuses: () => [] } as unknown as InstanceManager,
      {} as MessageQueue,
    );
    expect(disabled.has("wa_get_instance_status")).toBe(true);
    expect(disabled.has("wa_set_instance_webhook")).toBe(false);
    expect(disabled.has("wa_get_instance_webhook")).toBe(false);
    expect(disabled.has("wa_delete_instance_webhook")).toBe(false);

    vi.stubEnv("WA_INSTANCE_WEBHOOK_TOOLS_ENABLED", "maybe");
    expect(() =>
      registerInstanceTools(
        server,
        { getInstanceLifecycleStatuses: () => [] } as unknown as InstanceManager,
        {} as MessageQueue,
      ),
    ).toThrow(/Invalid WA_INSTANCE_WEBHOOK_TOOLS_ENABLED/);
  });

  it("restricts instance webhook hosts when an allowlist is set", () => {
    vi.stubEnv("WA_INSTANCE_WEBHOOK_ALLOWED_HOSTS", "hooks.example.test");
    expect(setInstanceWebhook({ instanceId: INSTANCE_A, url: INSTANCE_URL }).endpoint).toBe(
      "https://hooks.example.test",
    );
    expect(() =>
      setInstanceWebhook({ instanceId: INSTANCE_B, url: "https://other.example.test/hook" }),
    ).toThrow(/WA_INSTANCE_WEBHOOK_ALLOWED_HOSTS/);
    vi.stubEnv("WA_INSTANCE_WEBHOOK_ALLOWED_HOSTS", "https://hooks.example.test");
    expect(() => setInstanceWebhook({ instanceId: INSTANCE_B, url: INSTANCE_URL })).toThrow(
      /Invalid WA_INSTANCE_WEBHOOK_ALLOWED_HOSTS/,
    );
  });

  it("warns when a stored webhook replaces the global destinations", () => {
    vi.stubEnv("WA_EVENT_WEBHOOK_URL", GLOBAL_URL);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    setInstanceWebhook({
      instanceId: INSTANCE_A,
      url: INSTANCE_URL,
      authHeader: AUTH_HEADER,
      authValue: AUTH_SECRET,
    });
    expect(JSON.stringify(warn.mock.calls)).toContain(
      "Instance webhook replaces the global event webhook for this instance",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(INSTANCE_URL);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(AUTH_SECRET);

    warn.mockClear();
    vi.stubEnv("WA_EVENT_WEBHOOK_INSTANCE_MERGE_GLOBAL", "true");
    setInstanceWebhook({ instanceId: INSTANCE_A, url: SECOND_URL });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "Instance webhook replaces the global event webhook for this instance",
    );
  });

  it("normalizes the instance URL before duplicate detection", () => {
    setInstanceWebhook({
      instanceId: INSTANCE_A,
      url: "https://Hooks.Example.test/global/",
    });
    expect(getInstanceWebhook(INSTANCE_A)?.url).toBe("https://hooks.example.test/global");
    expect(canonicalWebhookUrl("https://Hooks.Example.test/global/")).toBe(
      "https://hooks.example.test/global",
    );
    const config = globalConfig({
      WA_EVENT_WEBHOOK_INSTANCE_MERGE_GLOBAL: "true",
      WA_EVENT_WEBHOOK_SECRET: GLOBAL_HMAC,
    });
    const destinations = destinationsForInstance(config, INSTANCE_A);
    expect(destinations).toHaveLength(1);
    expect(destinations[0]?.id).toBe(`instance:${INSTANCE_A}`);
    expect(destinations[0]?.secret).toBe(GLOBAL_HMAC);
  });

  it("caches the health read until instance webhook storage changes", () => {
    const env = { WA_EVENT_WEBHOOK_URL: GLOBAL_URL };
    const first = getEventWebhookStatus(env);
    const second = getEventWebhookStatus(env);
    expect(second).toBe(first);
    expect(first.destinationCount).toBe(1);

    setInstanceWebhook({ instanceId: INSTANCE_A, url: INSTANCE_URL });
    const third = getEventWebhookStatus(env);
    expect(third).not.toBe(first);
    expect(third.destinationCount).toBe(2);
    expect(getEventWebhookStatus(env)).toBe(third);
  });

  it("reads instance webhook rows once until storage changes", async () => {
    const config = globalConfig();
    const { manager, handler } = captureHandler();
    const enqueue = vi.fn(() => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(
      manager,
      config,
      enqueue,
      undefined,
      (instanceId) => destinationsForInstance(config, instanceId),
    );
    const prepare = vi.spyOn(db.$client, "prepare");
    const selects = (): number =>
      prepare.mock.calls.filter((call) => {
        const sql = String(call[0]);
        return sql.includes("instance_webhooks") && /^\s*select/i.test(sql);
      }).length;
    const presence = {
      instanceId: INSTANCE_A,
      chatId: "5511888888888@s.whatsapp.net",
      participant: "5511888888888@s.whatsapp.net",
      status: "available" as const,
    };

    for (let index = 0; index < 100; index += 1) {
      handler()?.("presence.updated", INSTANCE_A, presence);
    }
    expect(selects()).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();

    setInstanceWebhook({ instanceId: INSTANCE_A, url: INSTANCE_URL });
    const afterSave = selects();
    for (let index = 0; index < 100; index += 1) {
      handler()?.("presence.updated", INSTANCE_A, presence);
    }
    expect(selects()).toBe(afterSave + 1);

    removeInstanceWebhook(INSTANCE_A);
    const afterDelete = selects();
    for (let index = 0; index < 100; index += 1) {
      handler()?.("presence.updated", INSTANCE_A, presence);
    }
    expect(selects()).toBe(afterDelete + 1);

    unsubscribe();
    await unsubscribe.flush();
  });

  it("returns invalid instead of throwing when the stored webhook row is corrupt", async () => {
    setInstanceWebhook({
      instanceId: INSTANCE_A,
      url: INSTANCE_URL,
      authHeader: AUTH_HEADER,
      authValue: AUTH_SECRET,
    });
    db.$client
      .prepare("UPDATE instance_webhooks SET events = ? WHERE instance_id = ?")
      .run("not-json", INSTANCE_A);
    touchInstanceWebhookStorage();

    expect(readInstanceWebhook(INSTANCE_A)).toEqual({ configured: false, invalid: true });
    const tools = registerWebhookTools();
    const result = await tools.get("wa_get_instance_webhook")?.({ instanceId: INSTANCE_A });
    expect(result?.isError).toBeUndefined();
    expect(JSON.parse(result?.content[0]?.text ?? "")).toEqual({
      configured: false,
      invalid: true,
    });
    expect(result?.content[0]?.text).not.toContain(INSTANCE_URL);
    expect(result?.content[0]?.text).not.toContain(AUTH_SECRET);
    expect(destinationsForInstance(globalConfig(), INSTANCE_A).map((item) => item.id)).toEqual([
      "default",
    ]);
  });

  it("warns once when different global secrets leave an instance webhook unsigned", () => {
    setInstanceWebhook({ instanceId: INSTANCE_A, url: GLOBAL_URL });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const config = loadEventWebhookConfig({
      WA_EVENT_WEBHOOK_INSTANCE_MERGE_GLOBAL: "true",
      WA_EVENT_WEBHOOKS: JSON.stringify([
        { id: "one", url: GLOBAL_URL, secret: "hmac-secret-one-120" },
        { id: "two", url: SECOND_URL, secret: "hmac-secret-two-120" },
      ]),
    });

    const matched = destinationsForInstance(config, INSTANCE_A).find(
      (destination) => destination.id === `instance:${INSTANCE_A}`,
    );
    expect(matched?.secret).toBe("hmac-secret-one-120");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("unsigned");

    setInstanceWebhook({ instanceId: INSTANCE_A, url: INSTANCE_URL });
    warn.mockClear();
    const unsignedDestination = destinationsForInstance(config, INSTANCE_A).find(
      (destination) => destination.id === `instance:${INSTANCE_A}`,
    );
    expect(unsignedDestination?.secret).toBeUndefined();
    destinationsForInstance(config, INSTANCE_A);
    const unsigned = warn.mock.calls.filter((call) => JSON.stringify(call).includes("unsigned"));
    expect(unsigned).toHaveLength(1);
    const text = JSON.stringify(unsigned);
    expect(text).not.toContain("hmac-secret-one-120");
    expect(text).not.toContain("hmac-secret-two-120");
    expect(text).not.toContain(INSTANCE_URL);
    expect(text).not.toContain(GLOBAL_URL);
  });

  it("copies ignoreJids onto the instance destination for the JID filter", () => {
    setInstanceWebhook({ instanceId: INSTANCE_A, url: INSTANCE_URL });
    const config = globalConfig();
    config.destinations[0] = { ...config.destinations[0]!, ignoreJids: ["@g.us"] };
    expect(destinationsForInstance(config, INSTANCE_A)[0]?.ignoreJids).toEqual(["@g.us"]);
  });

  it("keeps instance webhook SQL free of named placeholders", () => {
    expect(INSTANCE_WEBHOOKS_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS instance_webhooks");
    expect(INSTANCE_WEBHOOKS_SCHEMA_SQL).not.toMatch(/@\w+/);
    for (const statement of Object.values(INSTANCE_WEBHOOK_SQL)) {
      expect(statement).not.toMatch(/@\w+/);
    }
    expect(INSTANCE_WEBHOOK_SQL.get).toContain("?");
    expect(INSTANCE_WEBHOOK_SQL.upsert).toContain("?");
    expect(INSTANCE_WEBHOOK_SQL.delete).toContain("?");
  });

  it("leaves the legacy handler on the global destinations", async () => {
    setInstanceWebhook({ instanceId: INSTANCE_A, url: INSTANCE_URL });
    const config = globalConfig();
    const { manager, handler } = captureHandler();
    const enqueue = vi.fn(() => Promise.resolve());
    const unsubscribe = registerEventWebhookHandler(manager, config, enqueue);
    handler()?.("message.received", INSTANCE_A, incomingMessage());
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    expect(enqueue.mock.calls[0]?.[0].destinationId).toBe("default");
    unsubscribe();
    await unsubscribe.flush();
  });
});
