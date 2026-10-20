import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.js";
import { instances } from "../src/db/schema.js";
import { buildHealthBody } from "../src/server/health.js";
import {
  DeleteInstanceWebhookSchema,
  GetInstanceWebhookSchema,
  SetInstanceWebhookSchema,
} from "../src/schemas/instance.schema.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import { EventWebhookService, registerEventWebhookHandler } from "../src/services/event-webhook.js";
import {
  destinationsForInstance,
  eventWebhookHealth,
  getEventWebhookStatus,
  loadEventWebhookConfig,
  bootEventWebhook,
} from "../src/services/event-webhook-config.js";
import {
  readInstanceWebhook,
  removeInstanceWebhook,
  setInstanceWebhook,
} from "../src/services/instance-webhook.js";
import { getInstanceWebhook } from "../src/services/instance-webhook-store.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import { registerInstanceTools } from "../src/tools/instance.tools.js";
import type { ChannelEventPayload } from "../src/types/channel.types.js";
import { logger } from "../src/utils/logger.js";

const { infoMock, errorMock } = vi.hoisted(() => ({
  infoMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock("../src/utils/logger.js", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/logger.js")>(
    "../src/utils/logger.js",
  );
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
      call
        .map((item) => (item instanceof Error ? item.message : JSON.stringify(item)))
        .join(" "),
    )
    .join("\n");
}

function registerWebhookTools(sync = vi.fn()): Map<string, ToolHandler> {
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
  it("defaults merge to false and rejects an invalid flag", () => {
    expect(loadEventWebhookConfig({}).instanceMergeGlobal).toBe(false);
    expect(globalConfig().instanceMergeGlobal).toBe(false);
    expect(() =>
      loadEventWebhookConfig({ WA_EVENT_WEBHOOK_INSTANCE_MERGE_GLOBAL: "maybe" }),
    ).toThrow(/Invalid WA_EVENT_WEBHOOK_INSTANCE_MERGE_GLOBAL/);
  });

  it("keeps today's global routing when an instance has no stored webhook", () => {
    const config = globalConfig();
    expect(destinationsForInstance(config, INSTANCE_A).map((item) => item.id)).toEqual([
      "default",
    ]);
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
    expect(instanceDestinations[0]?.secret).toBeUndefined();
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
    const config = globalConfig({ WA_EVENT_WEBHOOK_INSTANCE_MERGE_GLOBAL: "true" });
    const destinations = destinationsForInstance(config, INSTANCE_A);

    expect(destinations).toHaveLength(1);
    expect(destinations[0]?.id).toBe(`instance:${INSTANCE_A}`);
    expect(destinations[0]?.events).toEqual(["message.edited"]);
    expect(destinations[0]?.headers["x-instance-token"]).toBe(AUTH_SECRET);
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
    expect(() => setInstanceWebhook({ instanceId: INSTANCE_A, url: "http://hooks.example.test/hook" })).toThrow(
      /Invalid instance webhook URL/,
    );
    expect(() => setInstanceWebhook({ instanceId: INSTANCE_A, url: "https://127.0.0.1/hook" })).toThrow(
      /Invalid instance webhook URL/,
    );
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
    expect(GetInstanceWebhookSchema.safeParse({ instanceId: INSTANCE_A, extra: true }).success).toBe(
      false,
    );
    expect(DeleteInstanceWebhookSchema.safeParse({ instanceId: INSTANCE_A }).success).toBe(true);
  });

  it("allows HTTP only when the shared webhook flag is enabled", () => {
    vi.stubEnv("WA_EVENT_WEBHOOK_ALLOW_HTTP", "true");
    const saved = setInstanceWebhook({
      instanceId: INSTANCE_A,
      url: "http://hooks.example.test/hook",
    });
    expect(saved.url).toBe("http://hooks.example.test/hook");
    expect(() => setInstanceWebhook({ instanceId: INSTANCE_B, url: "http://10.1.1.1/hook" })).toThrow(
      /Invalid instance webhook URL/,
    );
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
      url: INSTANCE_URL,
      authHeader: AUTH_HEADER,
      authConfigured: true,
      events: null,
    });
    expect(JSON.parse(getText)).toMatchObject({ authConfigured: true, url: INSTANCE_URL });
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
      url: SECOND_URL,
      authHeader: null,
      authConfigured: false,
      events: null,
    });
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
    expect(destinationsForInstance(config, INSTANCE_A).map((item) => item.id)).toEqual([
      "default",
    ]);
    expect(removeInstanceWebhook(INSTANCE_A)).toEqual({ deleted: false });
    expect(serialized(infoMock)).not.toContain(INSTANCE_URL);
  });

  it("deletes the stored webhook when the instance is deleted", () => {
    setInstanceWebhook({ instanceId: INSTANCE_A, url: INSTANCE_URL, authValue: AUTH_SECRET, authHeader: AUTH_HEADER });
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
