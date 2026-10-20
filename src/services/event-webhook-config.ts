import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { CHANNEL_EVENTS, type ChannelEvent } from "../types/channel.types.js";
import { logger } from "../utils/logger.js";
import { validateWebhookUrl } from "../utils/validation.js";

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

export type EventWebhookPreset = "grok-bot";

export interface EventWebhookDestination {
  id: string;
  url: string;
  headers: Record<string, string>;
  secret?: string;
  preset?: EventWebhookPreset;
  events: ChannelEvent[];
  ignoreFromMe: boolean;
  chatAllowlist?: string[];
  senderAllowlist?: string[];
  /** Exact JIDs and address-space wildcards. Unset or empty forwards every chat. */
  ignoreJids?: string[];
  debounceMs: number;
}

export interface EventWebhookConfig {
  destinations: EventWebhookDestination[];
  queuePrefix: string;
  /** Per-chat batching for incoming messages. Zero keeps the legacy event path. */
  messageDebounceMs: number;
  /** Maximum batch age measured from its first incoming message. */
  messageDebounceMaxMs: number;
  /** Retained for callers and for the backward-compatible single destination. */
  events: ChannelEvent[];
  ignoreFromMe: boolean;
  timeoutMs: number;
  retryAttempts: number;
  retryDelayMs: number;
}

export type EventWebhookWarning =
  "not_configured" | "incomplete_auth" | "empty_event_set" | "preset_dropped_events";

/** Redacted webhook state. Never includes URLs, header names, header values, tokens, or secrets. */
export interface EventWebhookStatus {
  configured: boolean;
  destinationCount: number;
  eventCount: number;
  authConfigured: boolean;
  warnings: EventWebhookWarning[];
  droppedEvents: ChannelEvent[];
}

type Environment = Record<string, string | undefined>;

const destinationsWithAuth = new WeakSet<EventWebhookDestination>();

function trackDestinationAuth(
  destination: EventWebhookDestination,
  authConfigured: boolean,
): EventWebhookDestination {
  if (authConfigured) destinationsWithAuth.add(destination);
  return destination;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function parseOptionalBoundedInteger(
  value: unknown,
  key: string,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`Invalid ${key}; expected an integer from 0 to ${maximum}`);
  }
  return value;
}

function parseMessageDebounceConfig(env: Environment): {
  messageDebounceMs: number;
  messageDebounceMaxMs: number;
} {
  const maxAllowedMs = 300_000;
  const parse = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = raw.trim();
    const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxAllowedMs) {
      logger.warn(
        { variable: key, maximumMs: maxAllowedMs },
        `Invalid ${key}; using the default value`,
      );
      return fallback;
    }
    return parsed;
  };

  const messageDebounceMs = parse("WA_WEBHOOK_DEBOUNCE_MS", 0);
  const configuredMax = parse("WA_WEBHOOK_DEBOUNCE_MAX_MS", 30_000);
  const messageDebounceMaxMs = Math.max(configuredMax, messageDebounceMs);
  if (messageDebounceMaxMs !== configuredMax) {
    logger.warn(
      { variable: "WA_WEBHOOK_DEBOUNCE_MAX_MS", minimumMs: messageDebounceMs },
      "WA_WEBHOOK_DEBOUNCE_MAX_MS is below WA_WEBHOOK_DEBOUNCE_MS; clamping to the debounce window",
    );
  }

  return { messageDebounceMs, messageDebounceMaxMs };
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

function parseDestinationEvents(value: unknown): ChannelEvent[] {
  if (!Array.isArray(value) || !value.every((event) => typeof event === "string")) {
    throw new Error("Invalid WA_EVENT_WEBHOOKS; destination events must be an array of names");
  }
  const events = [...new Set(value.map((event) => (event as string).trim()).filter(Boolean))];
  if (events.some((event) => !CHANNEL_EVENTS.includes(event as ChannelEvent))) {
    throw new Error("Invalid WA_EVENT_WEBHOOKS; contains an unsupported event name");
  }
  return events as ChannelEvent[];
}

function isHeaderName(name: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
}

function parseHeaderObject(value: unknown, errorPrefix: string): Record<string, string> {
  if (value === undefined || value === "") return {};
  if (!isRecord(value)) {
    throw new Error(`Invalid ${errorPrefix}; expected a JSON object of string values`);
  }

  const headers = new Headers();
  try {
    for (const [name, headerValue] of Object.entries(value)) {
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
    throw new Error(`Invalid ${errorPrefix}; contains an invalid HTTP header`);
  }
  return Object.fromEntries(headers.entries());
}

function parseJsonHeaders(value: string | undefined): Record<string, string> {
  if (value === undefined || value.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid WA_EVENT_WEBHOOK_HEADERS; expected a JSON object of string values");
  }
  return parseHeaderObject(parsed, "WA_EVENT_WEBHOOK_HEADERS");
}

function setHeader(
  headers: Record<string, string>,
  name: unknown,
  value: unknown,
  errorPrefix: string,
): void {
  if (
    typeof name !== "string" ||
    !isHeaderName(name) ||
    DISALLOWED_HEADERS.has(name.toLowerCase())
  ) {
    throw new Error(`Invalid ${errorPrefix} header name`);
  }
  if (typeof value !== "string") throw new Error(`Invalid ${errorPrefix} header value`);
  try {
    const normalized = new Headers(headers);
    normalized.set(name, value);
    Object.assign(headers, Object.fromEntries(normalized.entries()));
  } catch {
    throw new Error(`Invalid ${errorPrefix} header value`);
  }
}

function resolveEnvironmentValue(
  env: Environment,
  reference: unknown,
  label: string,
): string | undefined {
  if (reference === undefined) return undefined;
  if (typeof reference !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) {
    throw new Error(`Invalid ${label}; expected an environment variable name`);
  }
  const value = env[reference];
  if (value === undefined || value === "") {
    throw new Error(`Missing ${label} environment variable`);
  }
  return value;
}

function parsePreset(value: unknown, label: string): EventWebhookPreset | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "grok-bot") return value;
  throw new Error(`Invalid ${label}; supported preset: grok-bot`);
}

function parseAllowlist(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error(`Invalid ${label}; expected an array of non-empty IDs`);
  }
  return [...new Set(value.map((item) => (item as string).trim()))];
}

/** Address-space wildcards. An entry must be one of these or an exact JID. */
export const JID_ADDRESS_WILDCARDS = [
  "@g.us",
  "@s.whatsapp.net",
  "@lid",
  "@newsletter",
  "@broadcast",
  "@c.us",
] as const;

const EXACT_JID_RE = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,180}@[A-Za-z0-9][A-Za-z0-9.-]{0,80}$/;
const STAR_JID_RE = /^([0-9A-Za-z._:-]*)\*([0-9A-Za-z._:-]*)@([A-Za-z0-9][A-Za-z0-9.-]{0,80})$/;
const JID_DOMAINS = ["g.us", "s.whatsapp.net", "lid", "newsletter", "broadcast", "c.us"] as const;

export function parseIgnoreJidEntry(entry: string, label: string): string {
  const value = entry.trim().toLowerCase();
  if (!value) throw new Error(`Invalid ${label}; empty entry`);
  if (/\s/.test(value)) throw new Error(`Invalid ${label}; invalid JID "${value}"`);
  if (value.startsWith("@")) {
    if (!(JID_ADDRESS_WILDCARDS as readonly string[]).includes(value)) {
      throw new Error(
        `Invalid ${label}; unsupported wildcard "${value}". Supported wildcards: ${JID_ADDRESS_WILDCARDS.join(", ")}`,
      );
    }
    return value;
  }
  if (value.includes("*")) {
    const match = STAR_JID_RE.exec(value);
    const domain = match?.[3];
    if (!domain || !(JID_DOMAINS as readonly string[]).includes(domain)) {
      throw new Error(
        `Invalid ${label}; invalid JID wildcard "${value}". Use one * in the user part, for example 5577*@s.whatsapp.net`,
      );
    }
    // #140: *@domain has an empty user part, so it is the chat-only address wildcard.
    if ((match?.[1] ?? "") === "" && (match?.[2] ?? "") === "") return `@${domain}`;
    return value;
  }
  if (!EXACT_JID_RE.test(value)) {
    throw new Error(`Invalid ${label}; invalid JID "${value}"`);
  }
  return value;
}

/** Empty or unset means no JID filter. Blank comma slots are skipped; other invalid entries fail. */
export function parseIgnoreJidList(value: string | undefined, label: string): string[] {
  if (value === undefined || value.trim() === "") return [];
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set(entries.map((entry) => parseIgnoreJidEntry(entry, label)))];
}

function parseDestinationIgnoreJids(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Invalid WA_EVENT_WEBHOOKS; ignoreJids must be an array of JID patterns");
  }
  return [
    ...new Set(
      value
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => parseIgnoreJidEntry(item, "WA_EVENT_WEBHOOKS ignoreJids")),
    ),
  ];
}

function mergeIgnoreJids(globalJids: readonly string[], extra: readonly string[]): string[] {
  return [...new Set([...globalJids, ...extra])];
}

function validateDestinationUrl(url: string, allowHttp: boolean, label: string): string {
  if (validateWebhookUrl(url, allowHttp)) {
    throw new Error(`Invalid ${label}; expected a public URL under the configured protocol policy`);
  }
  return new URL(url).href;
}

function parseDestination(
  input: unknown,
  index: number,
  env: Environment,
  global: {
    allowHttp: boolean;
    events: ChannelEvent[];
    ignoreFromMe: boolean;
    preset?: EventWebhookPreset;
    debounceMs: number;
    ignoreJids: string[];
  },
  ids: Set<string>,
): EventWebhookDestination {
  if (!isRecord(input))
    throw new Error("Invalid WA_EVENT_WEBHOOKS; each destination must be an object");

  const id =
    typeof input.id === "string" && input.id.trim() ? input.id.trim() : `destination-${index + 1}`;
  if (ids.has(id)) throw new Error("Invalid WA_EVENT_WEBHOOKS; destination IDs must be unique");
  ids.add(id);

  if (typeof input.url !== "string" || !input.url.trim()) {
    throw new Error("Invalid WA_EVENT_WEBHOOKS; each destination needs a URL");
  }
  const url = validateDestinationUrl(input.url.trim(), global.allowHttp, "WA_EVENT_WEBHOOKS URL");
  const preset = parsePreset(input.preset, "WA_EVENT_WEBHOOKS preset") ?? global.preset;
  const events = input.events === undefined ? global.events : parseDestinationEvents(input.events);
  const ignoreFromMe = input.ignoreFromMe === undefined ? global.ignoreFromMe : input.ignoreFromMe;
  if (typeof ignoreFromMe !== "boolean") {
    throw new Error("Invalid WA_EVENT_WEBHOOKS; ignoreFromMe must be true or false");
  }

  const headers = parseHeaderObject(input.headers, "WA_EVENT_WEBHOOKS headers");
  const authValuePresent = input.authValue !== undefined;
  const authEnvPresent = input.authEnv !== undefined;
  if (authValuePresent && authEnvPresent) {
    throw new Error("Invalid WA_EVENT_WEBHOOKS; use authValue or authEnv, not both");
  }
  const authValue = authEnvPresent
    ? resolveEnvironmentValue(env, input.authEnv, "WA_EVENT_WEBHOOKS authEnv")
    : input.authValue;
  const authHeader =
    input.authHeader ??
    (preset === "grok-bot" && authValue !== undefined ? "X-Grok-Bot-Key" : undefined);
  if ((authHeader === undefined) !== (authValue === undefined)) {
    throw new Error(
      "Invalid WA_EVENT_WEBHOOKS; authHeader must be configured with authValue or authEnv",
    );
  }
  if (authHeader !== undefined) {
    setHeader(headers, authHeader, authValue, "WA_EVENT_WEBHOOKS auth");
  }

  const secretPresent = input.secret !== undefined;
  const secretEnvPresent = input.secretEnv !== undefined;
  if (secretPresent && secretEnvPresent) {
    throw new Error("Invalid WA_EVENT_WEBHOOKS; use secret or secretEnv, not both");
  }
  const secret = secretEnvPresent
    ? resolveEnvironmentValue(env, input.secretEnv, "WA_EVENT_WEBHOOKS secretEnv")
    : input.secret;
  if (secret !== undefined && typeof secret !== "string") {
    throw new Error("Invalid WA_EVENT_WEBHOOKS; secret must be a string");
  }

  const debounceMs =
    parseOptionalBoundedInteger(input.debounceMs, "WA_EVENT_WEBHOOKS debounceMs", 30_000) ??
    global.debounceMs;
  const chatAllowlist = parseAllowlist(input.chatAllowlist, "WA_EVENT_WEBHOOKS chatAllowlist");
  const senderAllowlist = parseAllowlist(
    input.senderAllowlist,
    "WA_EVENT_WEBHOOKS senderAllowlist",
  );
  const ignoreJids = mergeIgnoreJids(
    global.ignoreJids,
    parseDestinationIgnoreJids(input.ignoreJids),
  );

  return trackDestinationAuth(
    {
      id,
      url,
      headers,
      ...(typeof secret === "string" && secret ? { secret } : {}),
      ...(preset ? { preset } : {}),
      events,
      ignoreFromMe,
      ...(chatAllowlist !== undefined ? { chatAllowlist } : {}),
      ...(senderAllowlist !== undefined ? { senderAllowlist } : {}),
      ...(ignoreJids.length > 0 ? { ignoreJids } : {}),
      debounceMs,
    },
    authHeader !== undefined,
  );
}

interface SingleDestinationAuth {
  header: string | undefined;
  value: string | undefined;
  incomplete: boolean;
  configured: boolean;
}

/** Same pairing rules as single-destination loading, including the Grok Bot header default. */
function resolveSingleDestinationAuth(
  env: Environment,
  preset: EventWebhookPreset | undefined,
): SingleDestinationAuth {
  const value = env.WA_EVENT_WEBHOOK_AUTH_VALUE;
  let header = env.WA_EVENT_WEBHOOK_AUTH_HEADER;
  if (header === undefined && value !== undefined && preset === "grok-bot") {
    header = "X-Grok-Bot-Key";
  }
  const headerSet = header !== undefined;
  const valueSet = value !== undefined;
  return {
    header,
    value,
    incomplete: headerSet !== valueSet,
    configured: headerSet && valueSet,
  };
}

function effectiveEvents(
  events: readonly ChannelEvent[],
  preset: EventWebhookPreset | undefined,
): ChannelEvent[] {
  if (preset === "grok-bot") {
    return events.filter((event) => event === "message.received" || event.startsWith("instance."));
  }
  return [...events];
}

function droppedPresetEvents(
  config: EventWebhookConfig,
  fallbackPreset: EventWebhookPreset | undefined,
): ChannelEvent[] {
  if (config.destinations.length === 0) return [];
  const groups = config.destinations.map((destination) => ({
    events: destination.events,
    preset: destination.preset ?? fallbackPreset,
  }));
  const dropped = new Set<ChannelEvent>();
  for (const group of groups) {
    if (group.preset !== "grok-bot") continue;
    for (const event of group.events) {
      if (event !== "message.received" && !event.startsWith("instance.")) dropped.add(event);
    }
  }
  return [...dropped];
}

function countEffectiveEvents(
  config: EventWebhookConfig,
  fallbackPreset: EventWebhookPreset | undefined,
): number {
  const groups =
    config.destinations.length > 0
      ? config.destinations.map((destination) => ({
          events: destination.events,
          preset: destination.preset ?? fallbackPreset,
        }))
      : [{ events: config.events, preset: fallbackPreset }];
  const names = new Set<string>();
  for (const group of groups) {
    for (const event of effectiveEvents(group.events, group.preset)) names.add(event);
  }
  return names.size;
}

function loadConfigForStatus(env: Environment, stripIncompleteAuth: boolean): EventWebhookConfig {
  if (!stripIncompleteAuth) return loadEventWebhookConfig(env);
  const sanitized: Environment = { ...env };
  delete sanitized.WA_EVENT_WEBHOOK_AUTH_HEADER;
  delete sanitized.WA_EVENT_WEBHOOK_AUTH_VALUE;
  return loadEventWebhookConfig(sanitized);
}

/** Parse and validate webhook settings without exposing secrets in errors. */
export function loadEventWebhookConfig(env: Environment = process.env): EventWebhookConfig {
  const messageDebounce = parseMessageDebounceConfig(env);
  const configuredQueuePrefix = env.WA_EVENT_WEBHOOK_QUEUE_PREFIX?.trim();
  if (configuredQueuePrefix && !/^[A-Za-z0-9_-]{1,64}$/.test(configuredQueuePrefix)) {
    throw new Error("Invalid WA_EVENT_WEBHOOK_QUEUE_PREFIX; use 1-64 letters, digits, _ or -");
  }
  const deploymentId = env.WA_DEPLOYMENT_ID?.trim() || env.HOSTNAME?.trim() || hostname();
  const queuePrefix =
    configuredQueuePrefix ||
    `wa-event-webhooks-${createHash("sha256").update(deploymentId).digest("hex").slice(0, 16)}`;
  const allowHttp = parseBoolean(env, "WA_EVENT_WEBHOOK_ALLOW_HTTP", false);
  const ignoreFromMe = parseBoolean(env, "WA_EVENT_WEBHOOK_IGNORE_FROM_ME", true);
  const timeoutMs = parsePositiveInteger(env, "WA_EVENT_WEBHOOK_TIMEOUT_MS", 10_000, 300_000);
  const retryAttempts = parsePositiveInteger(env, "WA_EVENT_WEBHOOK_RETRY_ATTEMPTS", 5, 100);
  const retryDelayMs = parsePositiveInteger(env, "WA_EVENT_WEBHOOK_RETRY_DELAY_MS", 1_000, 300_000);
  const debounceMs =
    parseOptionalBoundedInteger(
      env.WA_EVENT_WEBHOOK_DEBOUNCE_MS === undefined ||
        env.WA_EVENT_WEBHOOK_DEBOUNCE_MS.trim() === ""
        ? undefined
        : Number(env.WA_EVENT_WEBHOOK_DEBOUNCE_MS),
      "WA_EVENT_WEBHOOK_DEBOUNCE_MS",
      30_000,
    ) ?? 0;
  if (
    env.WA_EVENT_WEBHOOK_DEBOUNCE_MS !== undefined &&
    env.WA_EVENT_WEBHOOK_DEBOUNCE_MS.trim() !== "" &&
    !/^\d+$/.test(env.WA_EVENT_WEBHOOK_DEBOUNCE_MS.trim())
  ) {
    throw new Error("Invalid WA_EVENT_WEBHOOK_DEBOUNCE_MS; expected an integer from 0 to 30000");
  }
  const events = parseEvents(env.WA_EVENT_WEBHOOK_EVENTS);
  const preset = parsePreset(env.WA_EVENT_WEBHOOK_PRESET, "WA_EVENT_WEBHOOK_PRESET");
  const ignoreJids = parseIgnoreJidList(
    env.WA_EVENT_WEBHOOK_IGNORE_JIDS,
    "WA_EVENT_WEBHOOK_IGNORE_JIDS",
  );
  const global = { allowHttp, events, ignoreFromMe, preset, debounceMs, ignoreJids };
  const multiValue = env.WA_EVENT_WEBHOOKS?.trim();

  if (multiValue) {
    if (env.WA_EVENT_WEBHOOK_URL?.trim()) {
      throw new Error("Configure either WA_EVENT_WEBHOOKS or WA_EVENT_WEBHOOK_URL, not both");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(multiValue);
    } catch {
      throw new Error("Invalid WA_EVENT_WEBHOOKS; expected a JSON array of destinations");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Invalid WA_EVENT_WEBHOOKS; expected a JSON array of destinations");
    }
    const ids = new Set<string>();
    const destinations = parsed.map((item, index) =>
      parseDestination(item, index, env, global, ids),
    );
    return {
      destinations,
      queuePrefix,
      ...messageDebounce,
      events,
      ignoreFromMe,
      timeoutMs,
      retryAttempts,
      retryDelayMs,
    };
  }

  const headers = parseJsonHeaders(env.WA_EVENT_WEBHOOK_HEADERS);
  const url = env.WA_EVENT_WEBHOOK_URL?.trim();
  const auth = resolveSingleDestinationAuth(env, preset);
  if (auth.incomplete) {
    throw new Error(
      "WA_EVENT_WEBHOOK_AUTH_HEADER and WA_EVENT_WEBHOOK_AUTH_VALUE must be configured together",
    );
  }
  if (auth.header !== undefined && auth.value !== undefined) {
    setHeader(headers, auth.header, auth.value, "WA_EVENT_WEBHOOK_AUTH");
  }

  if (!url) {
    return {
      destinations: [],
      queuePrefix,
      ...messageDebounce,
      events,
      ignoreFromMe,
      timeoutMs,
      retryAttempts,
      retryDelayMs,
    };
  }

  return {
    destinations: [
      trackDestinationAuth(
        {
          id: "default",
          url: validateDestinationUrl(url, allowHttp, "WA_EVENT_WEBHOOK_URL"),
          headers,
          ...(env.WA_EVENT_WEBHOOK_SECRET ? { secret: env.WA_EVENT_WEBHOOK_SECRET } : {}),
          ...(preset ? { preset } : {}),
          events,
          ignoreFromMe,
          ...(ignoreJids.length > 0 ? { ignoreJids } : {}),
          debounceMs,
        },
        auth.configured,
      ),
    ],
    queuePrefix,
    ...messageDebounce,
    events,
    ignoreFromMe,
    timeoutMs,
    retryAttempts,
    retryDelayMs,
  };
}

function usesMultiDestinationConfig(env: Environment): boolean {
  return Boolean(env.WA_EVENT_WEBHOOKS?.trim());
}

/**
 * Internal redacted event-webhook state for boot logs and status projections.
 * The health projection omits dropped event names; only the tool projection
 * exposes them. Callers can pass a parsed config to avoid loading twice.
 * Nothing returned includes a URL, header name, header value, token, or secret.
 */
export function getEventWebhookStatus(
  env: Environment = process.env,
  config?: EventWebhookConfig,
): EventWebhookStatus {
  const multi = usesMultiDestinationConfig(env);
  const preset = parsePreset(env.WA_EVENT_WEBHOOK_PRESET, "WA_EVENT_WEBHOOK_PRESET");
  const auth = resolveSingleDestinationAuth(env, preset);
  const resolved = config ?? loadConfigForStatus(env, !multi && auth.incomplete);
  const destinationCount = resolved.destinations.length;
  const configured = destinationCount > 0;
  const eventCount = countEffectiveEvents(resolved, preset);
  const warnings: EventWebhookWarning[] = [];
  const droppedEvents = droppedPresetEvents(resolved, preset);
  if (!configured) warnings.push("not_configured");
  if (!multi && auth.incomplete) warnings.push("incomplete_auth");
  if (eventCount === 0) warnings.push("empty_event_set");
  if (droppedEvents.length > 0) warnings.push("preset_dropped_events");

  return {
    configured,
    destinationCount,
    eventCount,
    authConfigured:
      (!multi && auth.configured) ||
      resolved.destinations.some((destination) => destinationsWithAuth.has(destination)),
    warnings,
    droppedEvents,
  };
}

/** Fields safe to expose from the public health response. */
export function eventWebhookHealth(status: EventWebhookStatus): {
  configured: boolean;
  destinationCount: number;
  eventCount: number;
  authConfigured: boolean;
  warnings: EventWebhookWarning[];
} {
  return {
    configured: status.configured,
    destinationCount: status.destinationCount,
    eventCount: status.eventCount,
    authConfigured: status.authConfigured,
    warnings: [...status.warnings],
  };
}

/** Fields safe to expose from wa_get_instance_status, including dropped event names. */
export function eventWebhookToolStatus(status: EventWebhookStatus): {
  configured: boolean;
  destinationCount: number;
  eventCount: number;
  authConfigured: boolean;
  warnings: EventWebhookWarning[];
  droppedEvents: ChannelEvent[];
} {
  return {
    ...eventWebhookHealth(status),
    droppedEvents: [...status.droppedEvents],
  };
}

function bootLogDetails(status: EventWebhookStatus, warning: EventWebhookWarning) {
  return {
    configured: status.configured,
    destinationCount: status.destinationCount,
    eventCount: status.eventCount,
    authConfigured: status.authConfigured,
    warning,
    ...(warning === "preset_dropped_events" ? { droppedEvents: [...status.droppedEvents] } : {}),
  };
}

/** Log one warning per status code. A complete configuration logs nothing. */
export function logEventWebhookBootStatus(
  status: EventWebhookStatus,
  log: Pick<typeof logger, "warn"> = logger,
): void {
  for (const warning of status.warnings) {
    const details = bootLogDetails(status, warning);
    switch (warning) {
      case "not_configured":
        log.warn(details, "Event webhook is not configured; no events will be delivered");
        break;
      case "incomplete_auth":
        log.warn(
          details,
          "Event webhook authentication is incomplete; set both WA_EVENT_WEBHOOK_AUTH_HEADER and WA_EVENT_WEBHOOK_AUTH_VALUE",
        );
        break;
      case "empty_event_set":
        log.warn(details, "Event webhook event set is empty; no events will be delivered");
        break;
      case "preset_dropped_events":
        log.warn(details, "Grok Bot preset drops configured events");
        break;
      default: {
        const unreachable: never = warning;
        throw new Error(`Unknown event webhook warning: ${String(unreachable)}`);
      }
    }
  }
}

function requiredEventWebhookMessage(status: EventWebhookStatus): string {
  const unconfigured = !status.configured;
  const emptyEvents = status.warnings.includes("empty_event_set");
  if (unconfigured && emptyEvents) {
    return "WA_REQUIRE_EVENT_WEBHOOK=true but the event webhook is not configured and the event set is empty; no events will be delivered";
  }
  if (unconfigured) {
    return "WA_REQUIRE_EVENT_WEBHOOK=true but the event webhook is not configured; no events will be delivered";
  }
  return "WA_REQUIRE_EVENT_WEBHOOK=true but the event webhook event set is empty; no events will be delivered";
}

/**
 * Log webhook boot warnings and, when WA_REQUIRE_EVENT_WEBHOOK=true, stop
 * startup if no destination is configured or the event set is empty.
 */
export function bootEventWebhook(
  env: Environment = process.env,
  exit: (code: number) => void = (code) => {
    process.exit(code);
  },
): EventWebhookStatus {
  const status = getEventWebhookStatus(env);
  logEventWebhookBootStatus(status);
  if (
    parseBoolean(env, "WA_REQUIRE_EVENT_WEBHOOK", false) &&
    (!status.configured || status.warnings.includes("empty_event_set"))
  ) {
    const message = requiredEventWebhookMessage(status);
    logger.fatal(message);
    exit(1);
    throw new Error(message);
  }
  return status;
}
