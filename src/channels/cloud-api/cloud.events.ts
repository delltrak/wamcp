// ============================================================
// WA MCP — Cloud API Event Normalization
// Maps Meta webhook payloads to normalized ChannelEvent types.
// ============================================================

import { createChildLogger } from "../../utils/logger.js";
import type {
  MessageType,
  MessageDeliveryStatus,
  NormalizedMessageEvent,
  NormalizedMessageUpdateEvent,
  ChannelEvent,
  ChannelEventPayload,
} from "../../types/channel.types.js";

const logger = createChildLogger({ service: "cloud-api-events" });

// ---- Meta Webhook Payload Types ----

interface WebhookContact {
  profile: { name: string };
  wa_id: string;
}

interface WebhookMessageContext {
  from?: string;
  id?: string;
  forwarded?: boolean;
  frequently_forwarded?: boolean;
}

interface WebhookMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; sha256?: string; caption?: string; file_size?: number };
  video?: { id: string; mime_type?: string; sha256?: string; caption?: string; file_size?: number };
  audio?: { id: string; mime_type?: string; sha256?: string; file_size?: number };
  document?: {
    id: string;
    mime_type?: string;
    sha256?: string;
    caption?: string;
    filename?: string;
    file_size?: number;
  };
  sticker?: { id: string; mime_type?: string; sha256?: string; file_size?: number };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: Array<{ name: { formatted_name?: string }; phones?: Array<{ phone?: string }> }>;
  reaction?: { message_id: string; emoji: string };
  button?: { text: string; payload: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  context?: WebhookMessageContext;
}

interface WebhookStatusError {
  code: number;
  title: string;
  message?: string;
}

interface WebhookStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  errors?: WebhookStatusError[];
}

interface WebhookMetadata {
  display_phone_number: string;
  phone_number_id: string;
}

interface WebhookChangeValue {
  messaging_product: string;
  metadata: WebhookMetadata;
  contacts?: WebhookContact[];
  messages?: WebhookMessage[];
  statuses?: WebhookStatus[];
}

interface WebhookChange {
  value: WebhookChangeValue;
  field: string;
}

interface WebhookEntry {
  id: string;
  changes: WebhookChange[];
}

export interface MetaWebhookPayload {
  object: string;
  entry: WebhookEntry[];
}

// ---- Event type for routing ----

export interface NormalizedWebhookEvent {
  phoneNumberId: string;
  event: ChannelEvent;
  payload: ChannelEventPayload[ChannelEvent];
}

// ---- Type mapping ----

function mapMessageType(type: string): MessageType {
  switch (type) {
    case "text":
      return "text";
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "document":
      return "document";
    case "location":
      return "location";
    case "contacts":
      return "contact";
    case "reaction":
      return "reaction";
    case "sticker":
      return "sticker";
    case "button":
    case "interactive":
      return "text";
    default:
      return "text";
  }
}

function mapStatusToDelivery(status: string): MessageDeliveryStatus | null {
  switch (status) {
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "read":
      return "read";
    case "failed":
      return null; // a delivery failure is not evidence of a successful send
    default:
      return null;
  }
}

// ---- Content extraction ----

function extractTextContent(msg: WebhookMessage): string | null {
  if (msg.text?.body) return msg.text.body;
  if (msg.image?.caption) return msg.image.caption;
  if (msg.video?.caption) return msg.video.caption;
  if (msg.document?.caption) return msg.document.caption;

  if (msg.location) {
    const parts = [`lat:${msg.location.latitude}`, `lng:${msg.location.longitude}`];
    if (msg.location.name) parts.push(msg.location.name);
    if (msg.location.address) parts.push(msg.location.address);
    return parts.join(", ");
  }

  if (msg.contacts?.length) {
    return msg.contacts.map((c) => c.name?.formatted_name ?? "Unknown").join(", ");
  }

  if (msg.button) return msg.button.text;
  if (msg.interactive) {
    return msg.interactive.button_reply?.title ?? msg.interactive.list_reply?.title ?? null;
  }

  return null;
}

function extractMediaId(msg: WebhookMessage): string | null {
  return (
    msg.image?.id ?? msg.video?.id ?? msg.audio?.id ?? msg.document?.id ?? msg.sticker?.id ?? null
  );
}

function extractMediaInfo(
  msg: WebhookMessage,
): Pick<
  ChannelEventPayload["message.received"]["message"],
  | "mediaMimetype"
  | "mediaFileName"
  | "mediaSize"
  | "mediaCaption"
  | "mimeType"
  | "fileName"
  | "size"
  | "caption"
> {
  const media =
    msg.type === "image"
      ? msg.image
      : msg.type === "video"
        ? msg.video
        : msg.type === "audio"
          ? msg.audio
          : msg.type === "document"
            ? msg.document
            : msg.type === "sticker"
              ? msg.sticker
              : undefined;
  if (!media) return {};

  const fileName =
    "filename" in media && typeof media.filename === "string" ? media.filename : undefined;
  const caption =
    "caption" in media && typeof media.caption === "string" ? media.caption : undefined;
  const size = media.file_size;
  const mimeType = media.mime_type;
  return {
    ...(mimeType ? { mediaMimetype: mimeType, mimeType } : {}),
    ...(fileName ? { mediaFileName: fileName, fileName } : {}),
    ...(typeof size === "number" && Number.isSafeInteger(size) && size > 0
      ? { mediaSize: size, size }
      : {}),
    ...(caption ? { mediaCaption: caption, caption } : {}),
  };
}

// ---- Main normalizer ----

/**
 * Parse a Meta webhook payload into an array of normalized events.
 * Each event includes the phoneNumberId for routing to the correct adapter.
 */
export function normalizeWebhookPayload(payload: MetaWebhookPayload): NormalizedWebhookEvent[] {
  const events: NormalizedWebhookEvent[] = [];

  if (payload.object !== "whatsapp_business_account") {
    logger.warn({ object: payload.object }, "Unexpected webhook object type");
    return events;
  }

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;

      const value = change.value;
      const phoneNumberId = value.metadata.phone_number_id;

      // Build contact name lookup
      const contactNames = new Map<string, string>();
      if (value.contacts) {
        for (const contact of value.contacts) {
          contactNames.set(contact.wa_id, contact.profile.name);
        }
      }

      // Process incoming messages
      if (value.messages) {
        for (const msg of value.messages) {
          // Handle reactions as separate event type
          if (msg.type === "reaction" && msg.reaction) {
            events.push({
              phoneNumberId,
              event: "message.reaction",
              payload: {
                instanceId: "", // filled by caller
                chatId: `${msg.from}@s.whatsapp.net`,
                messageId: msg.reaction.message_id,
                emoji: msg.reaction.emoji,
                reactedBy: `${msg.from}@s.whatsapp.net`,
              },
            });
            continue;
          }

          const mediaInfo = extractMediaInfo(msg);
          const messageEvent: NormalizedMessageEvent = {
            instanceId: "", // filled by caller
            chatId: `${msg.from}@s.whatsapp.net`,
            chatName: contactNames.get(msg.from) ?? null,
            senderName: contactNames.get(msg.from) ?? null,
            isGroup: false,
            message: {
              id: msg.id,
              sender: `${msg.from}@s.whatsapp.net`,
              timestamp: parseInt(msg.timestamp, 10),
              type: mapMessageType(msg.type),
              content: extractTextContent(msg),
              mediaUrl: extractMediaId(msg), // media ID, can be resolved later
              ...mediaInfo,
              quotedMessageId: msg.context?.id ?? null,
              isFromMe: false,
              isForwarded:
                msg.context?.forwarded === true || msg.context?.frequently_forwarded === true,
            },
          };

          events.push({
            phoneNumberId,
            event: "message.received",
            payload: messageEvent,
          });
        }
      }

      // Process status updates
      if (value.statuses) {
        for (const status of value.statuses) {
          if (status.errors?.length) {
            logger.warn({ messageId: status.id, errors: status.errors }, "Message delivery error");
          }
          const deliveryStatus = mapStatusToDelivery(status.status);
          if (!deliveryStatus) continue;

          const updateEvent: NormalizedMessageUpdateEvent = {
            instanceId: "", // filled by caller
            chatId: `${status.recipient_id}@s.whatsapp.net`,
            messageId: status.id,
            status: deliveryStatus,
            timestamp:
              Number.isSafeInteger(Number(status.timestamp)) && Number(status.timestamp) > 0
                ? Number(status.timestamp)
                : undefined,
          };

          events.push({
            phoneNumberId,
            event: "message.updated",
            payload: updateEvent,
          });
        }
      }
    }
  }

  return events;
}
