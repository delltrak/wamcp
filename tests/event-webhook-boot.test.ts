import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHealthBody } from "../src/server/health.js";
import {
  bootEventWebhook,
  eventWebhookHealth,
  eventWebhookToolStatus,
  getEventWebhookStatus,
  type EventWebhookStatus,
} from "../src/services/event-webhook-config.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import { registerInstanceTools } from "../src/tools/instance.tools.js";
import { logger } from "../src/utils/logger.js";

const FIXTURE_URL = "https://hooks.example.test/super-secret-webhook-url-9f3a";
const FIXTURE_TOKEN = "fixture-token-9f3a";
const FIXTURE_HEADER_NAME = "X-Fixture-Secret-Header";
const FIXTURE_HEADER_VALUE = "fixture-header-value-9f3a";
const FIXTURE_HMAC = "fixture-hmac-secret-9f3a";
const SECRET_MARKERS = [
  FIXTURE_URL,
  "super-secret-webhook-url-9f3a",
  FIXTURE_TOKEN,
  FIXTURE_HEADER_NAME,
  FIXTURE_HEADER_VALUE,
  FIXTURE_HMAC,
  "https://",
  "http://",
];

type LogSpies = ReturnType<typeof captureLogs>;

function captureLogs() {
  return {
    warn: vi.spyOn(logger, "warn").mockImplementation(() => undefined),
    info: vi.spyOn(logger, "info").mockImplementation(() => undefined),
    error: vi.spyOn(logger, "error").mockImplementation(() => undefined),
    fatal: vi.spyOn(logger, "fatal").mockImplementation(() => undefined),
  };
}

function serializedLogs(logs: LogSpies): string {
  return JSON.stringify([
    logs.warn.mock.calls,
    logs.info.mock.calls,
    logs.error.mock.calls,
    logs.fatal.mock.calls,
  ]);
}

function assertRedacted(value: unknown): void {
  const text = JSON.stringify(value);
  for (const marker of SECRET_MARKERS) {
    expect(text).not.toContain(marker);
  }
}

function healthFor(status: EventWebhookStatus) {
  return buildHealthBody({
    uptimeSeconds: 5,
    instances: { total: 1, connected: 0, disconnected: 1 },
    version: "2.0.0",
    webhook: status,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("event webhook boot status", () => {
  it("warns once when unconfigured and health shows configured false", async () => {
    const logs = captureLogs();
    const status = (await bootEventWebhook({}));

    expect(logs.warn).toHaveBeenCalledOnce();
    expect(logs.fatal).not.toHaveBeenCalled();
    expect(JSON.stringify(logs.warn.mock.calls)).toContain("no events will be delivered");
    expect(logs.warn.mock.calls[0]?.[0]).toMatchObject({ warning: "not_configured" });
    expect(status).toEqual({
      configured: false,
      destinationCount: 0,
      eventCount: 1,
      authConfigured: false,
      warnings: ["not_configured"],
      droppedEvents: [],
    });
    expect(healthFor(status).webhook).toEqual({
      configured: false,
      destinationCount: 0,
      eventCount: 1,
      authConfigured: false,
      warnings: ["not_configured"],
    });
  });

  it("exits when the webhook is required and no destination is configured", async () => {
    const logs = captureLogs();
    const exit = vi.fn();

    await expect(bootEventWebhook({ WA_REQUIRE_EVENT_WEBHOOK: "true" }, exit)).rejects.toThrow(/not configured/);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(logs.warn).toHaveBeenCalledOnce();
    expect(logs.fatal).toHaveBeenCalledOnce();
    expect(JSON.stringify(logs.fatal.mock.calls)).toContain("no events will be delivered");
  });

  it("logs nothing extra when the webhook is fully configured", async () => {
    const logs = captureLogs();
    const exit = vi.fn();
    const status = (await bootEventWebhook(
      {
        WA_EVENT_WEBHOOK_URL: "https://hooks.example.test/receive",
        WA_EVENT_WEBHOOK_EVENTS: "message.received,message.edited",
        WA_EVENT_WEBHOOK_AUTH_HEADER: "X-Api-Key",
        WA_EVENT_WEBHOOK_AUTH_VALUE: FIXTURE_HEADER_VALUE,
        WA_EVENT_WEBHOOK_SECRET: FIXTURE_HMAC,
        WA_REQUIRE_EVENT_WEBHOOK: "false",
      },
      exit,
    ));

    expect(logs.warn).not.toHaveBeenCalled();
    expect(logs.info).not.toHaveBeenCalled();
    expect(logs.error).not.toHaveBeenCalled();
    expect(logs.fatal).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(status.configured).toBe(true);
    expect(status.destinationCount).toBe(1);
    expect(status.eventCount).toBe(2);
    expect(status.authConfigured).toBe(true);
    expect(status.warnings).toEqual([]);
    expect(healthFor(status).webhook.configured).toBe(true);
    assertRedacted(status);
    assertRedacted(healthFor(status));
  });

  it.each([
    {
      name: "header without value",
      env: {
        WA_EVENT_WEBHOOK_URL: "https://hooks.example.test/receive",
        WA_EVENT_WEBHOOK_AUTH_HEADER: FIXTURE_HEADER_NAME,
      },
    },
    {
      name: "value without header",
      env: {
        WA_EVENT_WEBHOOK_URL: "https://hooks.example.test/receive",
        WA_EVENT_WEBHOOK_AUTH_VALUE: FIXTURE_HEADER_VALUE,
      },
    },
  ])("warns when auth is incomplete ($name)", async ({ env }) => {
    const logs = captureLogs();
    const exit = vi.fn();
    const status = (await bootEventWebhook(env, exit));

    expect(status.configured).toBe(true);
    expect(status.authConfigured).toBe(false);
    expect(status.warnings).toEqual(["incomplete_auth"]);
    expect(logs.warn).toHaveBeenCalledOnce();
    expect(logs.warn.mock.calls[0]?.[0]).toMatchObject({ warning: "incomplete_auth" });
    expect(exit).not.toHaveBeenCalled();
    expect(healthFor(status).webhook.warnings).toEqual(["incomplete_auth"]);
  });

  it("treats a Grok Bot auth value with the default header as complete", async () => {
    const logs = captureLogs();
    const status = (await bootEventWebhook({
      WA_EVENT_WEBHOOK_URL: "https://hooks.example.test/receive",
      WA_EVENT_WEBHOOK_PRESET: "grok-bot",
      WA_EVENT_WEBHOOK_AUTH_VALUE: FIXTURE_HEADER_VALUE,
    }));

    expect(logs.warn).not.toHaveBeenCalled();
    expect(status.authConfigured).toBe(true);
    expect(status.warnings).toEqual([]);
    assertRedacted(status);
  });

  it("warns when the event set is empty and exits if the webhook is required", async () => {
    const logs = captureLogs();
    const env = {
      WA_EVENT_WEBHOOK_URL: "https://hooks.example.test/receive",
      WA_EVENT_WEBHOOK_EVENTS: "",
    };
    const status = (await getEventWebhookStatus(env));

    expect(status).toMatchObject({
      configured: true,
      destinationCount: 1,
      eventCount: 0,
      warnings: ["empty_event_set"],
    });
    expect(healthFor(status).webhook.eventCount).toBe(0);

    const exit = vi.fn();
    await expect(bootEventWebhook({ ...env, WA_REQUIRE_EVENT_WEBHOOK: "TRUE" }, exit)).rejects.toThrow(/event set is empty/);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logs.warn).toHaveBeenCalledOnce();
    expect(logs.warn.mock.calls[0]?.[0]).toMatchObject({ warning: "empty_event_set" });
  });

  it("reports configured events dropped by the Grok Bot preset", async () => {
    const logs = captureLogs();
    const env = {
      WA_EVENT_WEBHOOK_URL: "https://hooks.example.test/receive",
      WA_EVENT_WEBHOOK_PRESET: "grok-bot",
      WA_EVENT_WEBHOOK_EVENTS: "message.received,instance.connected,connection.changed",
    };
    const status = (await bootEventWebhook(env));

    expect(status.eventCount).toBe(2);
    expect(status.warnings).toEqual(["preset_dropped_events"]);
    expect(status.warnings.every((warning) => typeof warning === "string")).toBe(true);
    expect(status.droppedEvents).toEqual(["connection.changed"]);
    expect(eventWebhookHealth(status).warnings).toEqual(["preset_dropped_events"]);
    expect(healthFor(status).webhook).not.toHaveProperty("droppedEvents");
    expect(JSON.stringify(healthFor(status).webhook)).not.toContain("connection.changed");
    expect(logs.warn).toHaveBeenCalledOnce();
    expect(logs.warn.mock.calls[0]?.[0]).toMatchObject({
      warning: "preset_dropped_events",
      droppedEvents: ["connection.changed"],
    });
  });

  it("does not warn when all Grok Bot events are supported", async () => {
    const logs = captureLogs();
    const status = (await getEventWebhookStatus({
      WA_EVENT_WEBHOOK_URL: "https://hooks.example.test/receive",
      WA_EVENT_WEBHOOK_PRESET: "grok-bot",
      WA_EVENT_WEBHOOK_EVENTS:
        "message.received,instance.connected,instance.disconnected,instance.qr_generated",
    }));

    expect(status.eventCount).toBe(4);
    expect(status.warnings).toEqual([]);
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it("logs one warning per code when several problems are present", async () => {
    const logs = captureLogs();
    const status = (await bootEventWebhook({
      WA_EVENT_WEBHOOK_AUTH_HEADER: FIXTURE_HEADER_NAME,
      WA_EVENT_WEBHOOK_EVENTS: "",
      WA_EVENT_WEBHOOK_SECRET: FIXTURE_HMAC,
    }));

    expect(status.warnings).toEqual(["not_configured", "incomplete_auth", "empty_event_set"]);
    expect(logs.warn).toHaveBeenCalledTimes(3);
    expect(logs.warn.mock.calls.map((call) => (call[0] as { warning: string }).warning)).toEqual([
      "not_configured",
      "incomplete_auth",
      "empty_event_set",
    ]);
    assertRedacted(status);
    assertRedacted(serializedLogs(logs));
  });

  it("keeps URLs, header names, header values, and tokens out of logs and health", async () => {
    const logs = captureLogs();
    const secretUrl = `${FIXTURE_URL}?token=${FIXTURE_TOKEN}`;
    const configured = (await bootEventWebhook({
      WA_EVENT_WEBHOOK_URL: secretUrl,
      WA_EVENT_WEBHOOK_AUTH_HEADER: FIXTURE_HEADER_NAME,
      WA_EVENT_WEBHOOK_AUTH_VALUE: FIXTURE_HEADER_VALUE,
      WA_EVENT_WEBHOOK_SECRET: FIXTURE_HMAC,
      WA_EVENT_WEBHOOK_HEADERS: JSON.stringify({
        [FIXTURE_HEADER_NAME]: FIXTURE_HEADER_VALUE,
        Authorization: `Bearer ${FIXTURE_TOKEN}`,
      }),
    }));
    const missingValue = (await getEventWebhookStatus({
      WA_EVENT_WEBHOOK_URL: secretUrl,
      WA_EVENT_WEBHOOK_AUTH_HEADER: FIXTURE_HEADER_NAME,
      WA_EVENT_WEBHOOK_SECRET: FIXTURE_HMAC,
      WA_EVENT_WEBHOOK_PRESET: "grok-bot",
      WA_EVENT_WEBHOOK_EVENTS: "message.received,connection.changed",
      WA_EVENT_WEBHOOK_HEADERS: JSON.stringify({ [FIXTURE_HEADER_NAME]: FIXTURE_HEADER_VALUE }),
    }));
    const missingHeader = (await getEventWebhookStatus({
      WA_EVENT_WEBHOOK_URL: secretUrl,
      WA_EVENT_WEBHOOK_AUTH_VALUE: FIXTURE_HEADER_VALUE,
      WA_EVENT_WEBHOOK_SECRET: FIXTURE_HMAC,
    }));
    const exit = vi.fn();
    await expect(bootEventWebhook(
        {
          WA_EVENT_WEBHOOK_URL: secretUrl,
          WA_EVENT_WEBHOOK_EVENTS: "",
          WA_EVENT_WEBHOOK_AUTH_VALUE: FIXTURE_HEADER_VALUE,
          WA_REQUIRE_EVENT_WEBHOOK: "true",
        },
        exit,
      )).rejects.toThrow(/event set is empty/);

    const health = healthFor(missingValue);
    expect(configured.configured).toBe(true);
    expect(missingHeader.warnings).toContain("incomplete_auth");
    expect(missingValue.droppedEvents).toEqual(["connection.changed"]);
    expect(missingValue.warnings.every((warning) => typeof warning === "string")).toBe(true);
    expect(Object.keys(health.webhook)).toHaveLength(5);
    expect(health.webhook.warnings).toContain("preset_dropped_events");
    expect(JSON.stringify(health)).not.toContain("connection.changed");
    expect(JSON.stringify(health)).not.toContain("message.received");
    expect(JSON.stringify(health)).not.toContain("instance.connected");
    expect(Object.keys(configured).sort()).toEqual([
      "authConfigured",
      "configured",
      "destinationCount",
      "droppedEvents",
      "eventCount",
      "warnings",
    ]);
    assertRedacted(configured);
    assertRedacted(missingValue);
    assertRedacted(missingHeader);
    assertRedacted(health);
    assertRedacted(health.webhook);
    assertRedacted(serializedLogs(logs));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("returns dropped event names through wa_get_instance_status only", async () => {
    const secretUrl = `${FIXTURE_URL}?token=${FIXTURE_TOKEN}`;
    vi.stubEnv("WA_EVENT_WEBHOOKS", "");
    vi.stubEnv("WA_EVENT_WEBHOOK_PRESET", "grok-bot");
    vi.stubEnv("WA_EVENT_WEBHOOK_EVENTS", "message.received,instance.connected,connection.changed");
    vi.stubEnv("WA_EVENT_WEBHOOK_URL", secretUrl);
    vi.stubEnv("WA_EVENT_WEBHOOK_AUTH_HEADER", FIXTURE_HEADER_NAME);
    vi.stubEnv("WA_EVENT_WEBHOOK_AUTH_VALUE", FIXTURE_HEADER_VALUE);
    vi.stubEnv("WA_EVENT_WEBHOOK_SECRET", FIXTURE_HMAC);
    vi.stubEnv(
      "WA_EVENT_WEBHOOK_HEADERS",
      JSON.stringify({
        [FIXTURE_HEADER_NAME]: FIXTURE_HEADER_VALUE,
        Authorization: `Bearer ${FIXTURE_TOKEN}`,
      }),
    );

    const handlers = new Map<string, (params: { instanceId?: string }) => Promise<unknown>>();
    const server = {
      registerTool: (
        name: string,
        _config: unknown,
        handler: (params: { instanceId?: string }) => Promise<unknown>,
      ) => handlers.set(name, handler),
    } as unknown as McpServer;
    const manager = {
      getInstanceLifecycleStatuses: () => [],
    } as unknown as InstanceManager;
    registerInstanceTools(server, manager, {} as MessageQueue);

    const response = (await handlers.get("wa_get_instance_status")?.({})) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(response.content[0]!.text) as {
      instances: unknown[];
      webhook: ReturnType<typeof eventWebhookToolStatus>;
    };
    const status = (await getEventWebhookStatus());
    const expected = eventWebhookToolStatus(status);
    const health = healthFor(status).webhook;

    expect(body.instances).toEqual([]);
    expect(body.webhook).toEqual(expected);
    expect(body.webhook).not.toEqual(health);
    expect(health).toEqual({
      configured: true,
      destinationCount: 1,
      eventCount: 2,
      authConfigured: true,
      warnings: ["preset_dropped_events"],
    });
    expect(body.webhook).toEqual({
      configured: true,
      destinationCount: 1,
      eventCount: 2,
      authConfigured: true,
      warnings: ["preset_dropped_events"],
      droppedEvents: ["connection.changed"],
    });
    expect(Object.keys(body.webhook).sort()).toEqual([
      "authConfigured",
      "configured",
      "destinationCount",
      "droppedEvents",
      "eventCount",
      "warnings",
    ]);
    expect(Object.keys(health).sort()).toEqual([
      "authConfigured",
      "configured",
      "destinationCount",
      "eventCount",
      "warnings",
    ]);
    expect(JSON.stringify(health)).not.toContain("connection.changed");
    assertRedacted(body);
    assertRedacted(body.webhook);
  });

  it("rejects an invalid WA_REQUIRE_EVENT_WEBHOOK value", async () => {
    captureLogs();
    await expect(bootEventWebhook({ WA_REQUIRE_EVENT_WEBHOOK: "yes" })).rejects.toThrow("Invalid WA_REQUIRE_EVENT_WEBHOOK; expected true or false");
  });
});
