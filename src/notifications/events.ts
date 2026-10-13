// ============================================================
// WA MCP — Event Notifications
// Maps channel events to MCP notifications pushed via SSE.
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { ChannelEvent, ChannelEventPayload } from "../types/channel.types.js";
import { logger } from "../utils/logger.js";
import { TranscriptionService } from "../services/transcription.js";

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

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createConcurrencyLimiter(concurrency: number) {
  let active = 0;
  const waiting: Array<() => void> = [];

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active++;
    }

    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

interface SharedTranscriptionState {
  transcriptionService: TranscriptionService;
  limitTranscriptions: <T>(task: () => Promise<T>) => Promise<T>;
  inFlight: Map<string, Promise<string>>;
}

const transcriptionByInstanceManager = new WeakMap<InstanceManager, SharedTranscriptionState>();

function getSharedTranscriptionState(instanceManager: InstanceManager): SharedTranscriptionState {
  let state = transcriptionByInstanceManager.get(instanceManager);
  if (!state) {
    state = {
      transcriptionService: new TranscriptionService(),
      limitTranscriptions: createConcurrencyLimiter(
        positiveInteger(process.env.TRANSCRIPTION_CONCURRENCY, 2),
      ),
      inFlight: new Map(),
    };
    transcriptionByInstanceManager.set(instanceManager, state);
  }
  return state;
}

function transcribeIncomingAudio(
  instanceManager: InstanceManager,
  state: SharedTranscriptionState,
  instanceId: string,
  messageEvent: ChannelEventPayload["message.received"],
): Promise<string> {
  const key = JSON.stringify([instanceId, messageEvent.message.id]);
  const inFlight = state.inFlight.get(key);
  if (inFlight) return inFlight;

  const transcription = state.limitTranscriptions(async () => {
    const media = await instanceManager
      .getAdapter(instanceId)
      .downloadMessageAudio(
        messageEvent.message.id,
        state.transcriptionService.maxBytes,
        state.transcriptionService.timeoutMs,
      );
    const result = await state.transcriptionService.transcribe(media.data, media.mimeType);
    return result.text;
  });
  state.inFlight.set(key, transcription);
  const removeInFlight = () => {
    if (state.inFlight.get(key) === transcription) state.inFlight.delete(key);
  };
  void transcription.then(removeInFlight, removeInFlight);
  return transcription;
}

/**
 * Wire instance manager events to MCP server notifications.
 * Every channel event from any instance gets forwarded as an MCP notification.
 */
export function registerEventNotifications(
  server: McpServer,
  instanceManager: InstanceManager,
): () => void {
  const transcriptionState = getSharedTranscriptionState(instanceManager);

  return instanceManager.onAnyEvent(
    <E extends ChannelEvent>(event: E, instanceId: string, payload: ChannelEventPayload[E]) => {
      const method = EVENT_TO_METHOD[event];
      if (!method) return;

      void (async () => {
        let notificationPayload = payload as unknown as Record<string, unknown>;

        if (
          event === "message.received" &&
          transcriptionState.transcriptionService.isConfigured() &&
          (payload as ChannelEventPayload["message.received"]).message.type === "audio"
        ) {
          const messageEvent = payload as ChannelEventPayload["message.received"];
          try {
            const transcription = await transcribeIncomingAudio(
              instanceManager,
              transcriptionState,
              instanceId,
              messageEvent,
            );
            notificationPayload = {
              ...messageEvent,
              message: { ...messageEvent.message, transcription },
            };
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
