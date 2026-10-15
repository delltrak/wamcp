import { proto } from "@whiskeysockets/baileys";
import type { EventResponseStatus } from "../../types/channel.types.js";

export interface DecodedEventResponseMessage {
  response: unknown;
  timestampMs: unknown;
  extraGuestCount: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

/** Accept the WAProto message, encoded message bytes, or Baileys update wrappers. */
export function decodeEventResponseMessage(value: unknown): DecodedEventResponseMessage | null {
  return decodeEventResponseMessageAtDepth(value, 0);
}

function decodeEventResponseMessageAtDepth(
  value: unknown,
  depth: number,
): DecodedEventResponseMessage | null {
  if (depth > 6) return null;

  const bytes = messageBytes(value);
  if (bytes) {
    try {
      return decodeEventResponseMessageAtDepth(
        proto.Message.EventResponseMessage.decode(bytes),
        depth + 1,
      );
    } catch {
      return null;
    }
  }

  if (!isRecord(value)) return null;

  for (const field of [
    "eventResponseMessage",
    "event_response_message",
    "responseMessage",
    "response",
    "eventResponse",
  ]) {
    const nested = value[field];
    if (!isRecord(nested) && !messageBytes(nested)) continue;

    const decoded = decodeEventResponseMessageAtDepth(nested, depth + 1);
    if (!decoded) continue;

    return {
      response: decoded.response,
      timestampMs: value.senderTimestampMs ?? value.timestampMs ?? decoded.timestampMs,
      extraGuestCount: value.extraGuestCount ?? decoded.extraGuestCount,
    };
  }

  for (const field of [
    "response",
    "eventResponse",
    "event_response",
    "responseType",
    "eventResponseType",
  ]) {
    if (!Object.hasOwn(value, field)) continue;
    return {
      response: value[field],
      timestampMs: value.senderTimestampMs ?? value.timestampMs ?? null,
      extraGuestCount: value.extraGuestCount ?? null,
    };
  }

  return null;
}

export function eventResponseName(value: unknown): EventResponseStatus {
  const response = decodeEventResponseMessage(value)?.response ?? value;
  if (typeof response === "number") return statusFromNumber(response);
  if (typeof response === "bigint") return statusFromNumber(Number(response));
  if (typeof response === "string") return statusFromString(response);

  if (isRecord(response)) {
    if (typeof response.toNumber === "function") {
      try {
        const number = (response.toNumber as () => unknown)();
        if (typeof number === "number") return statusFromNumber(number);
      } catch {
        // Fall through to the string representation used by Long-like values.
      }
    }

    if (
      typeof response.toString === "function" &&
      response.toString !== Object.prototype.toString
    ) {
      try {
        return statusFromString((response.toString as () => string)());
      } catch {
        return "UNKNOWN";
      }
    }
  }

  return "UNKNOWN";
}

function statusFromNumber(value: number): EventResponseStatus {
  switch (value) {
    case 1:
      return "GOING";
    case 2:
      return "NOT_GOING";
    case 3:
      return "MAYBE";
    default:
      return "UNKNOWN";
  }
}

function statusFromString(value: string): EventResponseStatus {
  const normalized = value.trim().split(/[.:]/).at(-1)?.toUpperCase();
  if (normalized === "GOING" || normalized === "NOT_GOING" || normalized === "MAYBE") {
    return normalized;
  }
  if (normalized && /^[+-]?\d+$/.test(normalized)) {
    return statusFromNumber(Number(normalized));
  }
  return "UNKNOWN";
}
