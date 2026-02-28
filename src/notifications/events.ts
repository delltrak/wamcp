// ============================================================
// WA MCP — Event Notifications
// Maps channel events to MCP notifications pushed via SSE.
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { ChannelEvent, ChannelEventPayload } from "../types/channel.types.js";
import { logger } from "../utils/logger.js";

/** Mapping from channel event names to MCP notification method names */
const EVENT_TO_METHOD: Record<ChannelEvent, string> = {
  "message.received": "whatsapp/message.received",
  "message.updated": "whatsapp/message.updated",
  "message.deleted": "whatsapp/message.deleted",
  "message.reaction": "whatsapp/message.reaction",
  "message.edited": "whatsapp/message.edited",
  "presence.updated": "whatsapp/presence.updated",
  "chat.updated": "whatsapp/chat.updated",
  "group.updated": "whatsapp/group.updated",
  "group.participants_changed": "whatsapp/group.participants_changed",
  "contact.updated": "whatsapp/contact.updated",
  "connection.changed": "whatsapp/connection.changed",
  "call.received": "whatsapp/call.received",
};

/**
 * Wire instance manager events to MCP server notifications.
 * Every channel event from any instance gets forwarded as an MCP notification.
 */
export function registerEventNotifications(
  server: McpServer,
  instanceManager: InstanceManager,
): void {
  instanceManager.onAnyEvent(
    <E extends ChannelEvent>(event: E, instanceId: string, payload: ChannelEventPayload[E]) => {
      const method = EVENT_TO_METHOD[event];
      if (!method) return;

      logger.info({ event, method, instanceId }, "Forwarding event as MCP notification");

      void Promise.resolve(
        server.server.sendLoggingMessage({
          level: "info",
          logger: "whatsapp-events",
          data: { method, payload },
        }),
      )
        .then(() => {
          logger.info({ method }, "sendLoggingMessage sent successfully");
        })
        .catch((err) => {
          logger.warn({ err: String(err), method }, "sendLoggingMessage failed");
        });

      void Promise.resolve(
        server.server.notification({
          method: "notifications/message",
          params: {
            _meta: { notificationType: method },
            ...(payload as unknown as Record<string, unknown>),
          },
        }),
      )
        .then(() => {
          logger.info({ method }, "MCP notification sent successfully");
        })
        .catch((err) => {
          logger.warn({ err: String(err), method }, "MCP notification failed");
        });
    },
  );
}
