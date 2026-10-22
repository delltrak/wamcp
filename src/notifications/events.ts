// ============================================================
// WA MCP — Event Notifications
// Maps channel events to MCP notifications pushed via SSE.
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { ChannelEvent, ChannelEventPayload } from "../types/channel.types.js";
import { logger } from "../utils/logger.js";
import { transcribeIncomingAudioIfConfigured } from "../services/incoming-audio-transcription.js";

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
  "group.member_label_changed": "whatsapp/group.member_label_changed",
  "contact.updated": "whatsapp/contact.updated",
  "connection.changed": "whatsapp/connection.changed",
  "instance.connected": "whatsapp/instance.connected",
  "instance.disconnected": "whatsapp/instance.disconnected",
  "instance.pairing_code_generated": "whatsapp/instance.pairing_code_generated",
  "instance.qr_generated": "whatsapp/instance.qr_generated",
  "instance.pairing_expired": "whatsapp/instance.pairing_expired",
  "instance.qr_expired": "whatsapp/instance.qr_expired",
  "call.received": "whatsapp/call.received",
  "label.updated": "whatsapp/label.updated",
  "event.response": "whatsapp/event.response",
};

/**
 * Wire instance manager events to MCP server notifications.
 * Every channel event from any instance gets forwarded as an MCP notification.
 */
export function registerEventNotifications(
  server: McpServer,
  instanceManager: InstanceManager,
): () => void {
  return instanceManager.onAnyEvent(
    <E extends ChannelEvent>(event: E, instanceId: string, payload: ChannelEventPayload[E]) => {
      const method = EVENT_TO_METHOD[event];
      if (!method) return;

      void (async () => {
        let notificationPayload = payload as unknown as Record<string, unknown>;

        if (
          event === "message.received" &&
          (payload as ChannelEventPayload["message.received"]).message.type === "audio"
        ) {
          const messageEvent = payload as ChannelEventPayload["message.received"];
          try {
            const transcription = transcribeIncomingAudioIfConfigured(
              instanceManager,
              instanceId,
              messageEvent,
            );
            if (transcription) {
              notificationPayload = {
                ...messageEvent,
                message: { ...messageEvent.message, transcription: await transcription },
              };
            }
          } catch (err) {
            logger.warn(
              { err: String(err), instanceId, messageId: messageEvent.message.id },
              "Incoming audio transcription failed; forwarding the original message event",
            );
          }
        }

        logger.info({ event, method, instanceId }, "Forwarding event as MCP notification");

        void Promise.resolve(
          server.server.sendLoggingMessage({
            level: "info",
            logger: "whatsapp-events",
            data: { method, payload: notificationPayload },
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
            method,
            params: {
              instanceId,
              ...notificationPayload,
            },
          }),
        )
          .then(() => {
            logger.info({ method }, "MCP notification sent successfully");
          })
          .catch((err) => {
            logger.warn({ err: String(err), method }, "MCP notification failed");
          });
      })();
    },
  );
}
