import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InstanceManager } from "../src/services/instance-manager.js";
import { registerEventNotifications } from "../src/notifications/events.js";
import {
  registerEventWebhookHandler,
  type EventWebhookUnsubscribe,
} from "../src/services/event-webhook.js";
import { loadEventWebhookConfig } from "../src/services/event-webhook-config.js";
import type { ChannelEventPayload } from "../src/types/channel.types.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("InstanceManager adapter event forwarding", () => {
  it("forwards adapter-emitted event responses to global handlers, MCP, and webhooks", async () => {
    const instanceManager = new InstanceManager();
    const instance = await instanceManager.createInstance("event response forwarding test");
    cleanups.push(async () => (await instanceManager.deleteInstance(instance.id)));

    const eventHandler = vi.fn();
    const removeEventHandler = instanceManager.onAnyEvent(eventHandler);
    cleanups.push(removeEventHandler);

    const notification = vi.fn().mockResolvedValue(undefined);
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const server = {
      server: { notification, sendLoggingMessage },
    } as unknown as McpServer;
    const removeNotifications = registerEventNotifications(server, instanceManager);
    cleanups.push(removeNotifications);

    const enqueue = vi.fn().mockResolvedValue(undefined);
    const unsubscribeWebhook: EventWebhookUnsubscribe = registerEventWebhookHandler(
      instanceManager,
      loadEventWebhookConfig({
        WA_EVENT_WEBHOOKS: JSON.stringify([
          {
            id: "responses",
            url: "https://hooks.example.test/responses",
            events: ["event.response"],
          },
        ]),
      }),
      enqueue,
    );
    cleanups.push(() => {
      unsubscribeWebhook();
      return unsubscribeWebhook.flush();
    });

    const payload: ChannelEventPayload["event.response"] = {
      instanceId: instance.id,
      chatId: "120363000000000001@g.us",
      eventMessageId: "event-123",
      participant: "5500000000009@s.whatsapp.net",
      responseMessageId: "response-123",
      status: "GOING",
      timestamp: 1_800_000_123_000,
      extraGuestCount: 1,
    };
    const adapter = (await instanceManager.ensureAdapter(instance.id)) as unknown as {
      emit: (event: "event.response", eventPayload: ChannelEventPayload["event.response"]) => void;
    };

    adapter.emit("event.response", payload);

    await vi.waitFor(() => {
      expect(eventHandler).toHaveBeenCalledWith("event.response", instance.id, payload);
      expect(notification).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "whatsapp/event.response",
          params: expect.objectContaining({ instanceId: instance.id, ...payload }),
        }),
      );
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationId: "responses",
          payload: expect.objectContaining({
            event: "event.response",
            instanceId: instance.id,
            eventMessageId: "event-123",
            participant: "5500000000009@s.whatsapp.net",
            status: "GOING",
          }),
        }),
      );
    });
  });
});
