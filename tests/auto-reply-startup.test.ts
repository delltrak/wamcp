import { afterEach, expect, it, vi } from "vitest";
import type { NormalizedMessageEvent } from "../src/types/channel.types.js";

const state = vi.hoisted(() => ({
  handler: undefined as
    ((event: string, id: string, payload: NormalizedMessageEvent) => void) | undefined,
  enqueue: vi.fn(async () => ({ status: "queued", jobId: "startup-reply" })),
  connected: vi.fn(async () => undefined),
}));
vi.mock("../src/services/instance-manager.js", () => ({
  InstanceManager: class {
    setMessageQueue() {}
    getInstanceChannel() {
      return "baileys";
    }
    onAnyEvent(handler: typeof state.handler) {
      state.handler = handler;
      return () => undefined;
    }
    async init() {
      state.handler?.("message.received", "startup", {
        instanceId: "startup",
        chatId: "5511999999999@s.whatsapp.net",
        message: {
          id: "startup-message",
          sender: "5511999999999@s.whatsapp.net",
          timestamp: Math.floor(Date.now() / 1000),
          type: "text",
          content: "hello",
          mediaUrl: null,
          quotedMessageId: null,
          isFromMe: false,
        },
      });
    }
  },
}));
vi.mock("../src/services/message-queue.js", () => ({
  MessageQueue: class {
    enqueueMessage = state.enqueue;
  },
}));
vi.mock("../src/services/event-webhook.js", () => ({
  EventWebhookService: class {
    start() {}
  },
}));
vi.mock("../src/services/maintenance.js", () => ({
  MaintenanceService: class {
    async start() {}
  },
}));
vi.mock("../src/server/mcp.js", () => ({
  createMcpServer: () => ({ server: { server: {}, connect: state.connected } }),
}));
vi.mock("../src/server/http-session.js", () => ({ McpHttpSessionManager: class {} }));
vi.mock("../src/utils/shutdown.js", () => ({
  installShutdownHandlers() {},
  SHUTDOWN_TIMEOUT_MS: 1000,
}));
vi.mock("../src/services/event-webhook-config.js", () => ({
  bootEventWebhook: () => ({ enabled: false }),
}));
vi.mock("../src/db/auto-reply-cooldown.js", () => ({
  sqliteAutoReplyCooldownStore: { load: () => undefined, save() {} },
}));

afterEach(() => vi.unstubAllEnvs());

it("answers an eligible message emitted while reconnecting existing instances at startup", async () => {
  vi.stubEnv("WA_TRANSPORT", "stdio");
  vi.stubEnv("WA_AUTO_REPLY_ENABLED", "true");
  vi.stubEnv("WA_AUTO_REPLY_TEXT", "startup response");
  await import("../src/index.js");
  await vi.waitFor(() => expect(state.connected).toHaveBeenCalledTimes(1));
  expect(state.enqueue).toHaveBeenCalledExactlyOnceWith(
    "startup",
    "5511999999999@s.whatsapp.net",
    { type: "text", text: "startup response" },
    "baileys",
  );
});
