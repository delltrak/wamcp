import type { ChannelEvent } from "../types/channel.types.js";
import { validateWebhookUrl } from "../utils/validation.js";

const CHANNEL_EVENTS: readonly ChannelEvent[] = [
  "message.received",
  "message.updated",
  "message.deleted",
  "message.reaction",
  "message.edited",
  "presence.updated",
  "chat.updated",
  "group.updated",
  "group.participants_changed",
  "contact.updated",
  "connection.changed",
  "call.received",
];

const DISALLOWED_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface EventWebhookDestination {
  id: string;
  url: string;
  headers: Record<string, string>;
  secret?: string;
}

export interface EventWebhookConfig {
  destinations: EventWebhookDestination[];
  events: ChannelEvent[];
  ignoreFromMe: boolean;
  timeoutMs: number;
  retryAttempts: number;
  retryDelayMs: number;
}

type Environment = Record<string, string | undefined>;

function parseBoolean(env: Environment, key: string, fallback: boolean): boolean {
  const value = env[key];
  if (value === undefined || value.trim() === "") return fallback;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  throw new Error(`Invalid ${key}; expected true or false`);
}

function parsePositiveInteger(
  env: Environment,
  key: string,
  fallback: number,
  maximum: number,
): number {
  const value = env[key];
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) throw new Error(`Invalid ${key}; expected a positive integer`);

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`Invalid ${key}; expected a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

function parseEvents(value: string | undefined): ChannelEvent[] {
  if (value === undefined) return ["message.received"];
  if (value.trim() === "") return [];

  const events = [
    ...new Set(
      value
        .split(",")
        .map((event) => event.trim())
        .filter(Boolean),
    ),
  ];
  for (const event of events) {
    if (!CHANNEL_EVENTS.includes(event as ChannelEvent)) {
      throw new Error("Invalid WA_EVENT_WEBHOOK_EVENTS; contains an unsupported event name");
    }
  }
  return events as ChannelEvent[];
}

function isHeaderName(name: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
}

function parseHeaderObject(value: string | undefined): Record<string, string> {
  if (value === undefined || value.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid WA_EVENT_WEBHOOK_HEADERS; expected a JSON object of string values");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid WA_EVENT_WEBHOOK_HEADERS; expected a JSON object of string values");
  }

  const headers = new Headers();
  try {
    for (const [name, headerValue] of Object.entries(parsed)) {
      if (
        !isHeaderName(name) ||
        DISALLOWED_HEADERS.has(name.toLowerCase()) ||
        typeof headerValue !== "string"
      ) {
        throw new Error();
      }
      headers.set(name, headerValue);
    }
  } catch {
    throw new Error("Invalid WA_EVENT_WEBHOOK_HEADERS; contains an invalid HTTP header");
  }
  return Object.fromEntries(headers.entries());
}

function parseHeaders(env: Environment): Record<string, string> {
  const headers = new Headers(parseHeaderObject(env.WA_EVENT_WEBHOOK_HEADERS));
  const authHeader = env.WA_EVENT_WEBHOOK_AUTH_HEADER;
  const authValue = env.WA_EVENT_WEBHOOK_AUTH_VALUE;

  if ((authHeader === undefined) !== (authValue === undefined)) {
    throw new Error(
      "WA_EVENT_WEBHOOK_AUTH_HEADER and WA_EVENT_WEBHOOK_AUTH_VALUE must be configured together",
    );
  }

  if (authHeader !== undefined && authValue !== undefined) {
    if (!isHeaderName(authHeader) || DISALLOWED_HEADERS.has(authHeader.toLowerCase())) {
      throw new Error("Invalid WA_EVENT_WEBHOOK_AUTH_HEADER");
    }
    try {
      headers.set(authHeader, authValue);
    } catch {
      throw new Error("Invalid WA_EVENT_WEBHOOK_AUTH_VALUE");
    }
  }

  return Object.fromEntries(headers.entries());
}

/** Parse and validate the single configured destination without exposing secrets in errors. */
export function loadEventWebhookConfig(env: Environment = process.env): EventWebhookConfig {
  const allowHttp = parseBoolean(env, "WA_EVENT_WEBHOOK_ALLOW_HTTP", false);
  const ignoreFromMe = parseBoolean(env, "WA_EVENT_WEBHOOK_IGNORE_FROM_ME", true);
  const timeoutMs = parsePositiveInteger(env, "WA_EVENT_WEBHOOK_TIMEOUT_MS", 10_000, 300_000);
  const retryAttempts = parsePositiveInteger(env, "WA_EVENT_WEBHOOK_RETRY_ATTEMPTS", 5, 100);
  const retryDelayMs = parsePositiveInteger(env, "WA_EVENT_WEBHOOK_RETRY_DELAY_MS", 1_000, 300_000);
  const events = parseEvents(env.WA_EVENT_WEBHOOK_EVENTS);
  const headers = parseHeaders(env);
  const url = env.WA_EVENT_WEBHOOK_URL?.trim();

  if (!url) {
    return { destinations: [], events, ignoreFromMe, timeoutMs, retryAttempts, retryDelayMs };
  }

  if (validateWebhookUrl(url, allowHttp)) {
    throw new Error(
      "Invalid WA_EVENT_WEBHOOK_URL; expected a public URL under the configured protocol policy",
    );
  }

  return {
    destinations: [
      {
        id: "default",
        url: new URL(url).href,
        headers,
        ...(env.WA_EVENT_WEBHOOK_SECRET ? { secret: env.WA_EVENT_WEBHOOK_SECRET } : {}),
      },
    ],
    events,
    ignoreFromMe,
    timeoutMs,
    retryAttempts,
    retryDelayMs,
  };
}
