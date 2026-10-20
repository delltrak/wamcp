// ============================================================
// WA MCP — Optional fixed auto-reply
// Sends one configured text. Stays off unless WA_AUTO_REPLY_ENABLED=true.
// ============================================================

import type { InstanceManager } from "./instance-manager.js";
import type { MessageQueue } from "./message-queue.js";
import type { ChannelEvent, ChannelEventPayload } from "../types/channel.types.js";
import type { NormalizedMessageEvent } from "../types/channel.types.js";
import { createChildLogger } from "../utils/logger.js";

const logger = createChildLogger({ service: "auto-reply" });

export const AUTO_REPLY_MAX_CHARS = 4_000;
export const AUTO_REPLY_MIN_COOLDOWN_HOURS = 1;
export const AUTO_REPLY_MAX_COOLDOWN_HOURS = 24 * 365;
export const AUTO_REPLY_DEFAULT_COOLDOWN_HOURS = 24;
export const AUTO_REPLY_MIN_RATE_PER_MINUTE = 1;
export const AUTO_REPLY_MAX_RATE_PER_MINUTE = 30;
export const AUTO_REPLY_DEFAULT_RATE_PER_MINUTE = 6;
export const AUTO_REPLY_RATE_WINDOW_MS = 60_000;
export const AUTO_REPLY_MAX_IGNORE_JIDS = 100;
const MAX_IGNORE_JID_LENGTH = 256;
const MAX_TRACKED_MESSAGE_IDS = 1_000;
const IGNORE_JID_PATTERN = /^[a-z0-9@.*_:-]+$/i;

const DIRECT_CHAT_SERVERS = new Set(["s.whatsapp.net", "lid", "hosted", "hosted.lid"]);

export interface AutoReplyConfig {
  enabled: boolean;
  message: string;
  groups: boolean;
  cooldownMs: number;
  ratePerMinute: number;
  ignoreJids: readonly string[];
}

export type AutoReplySkipReason =
  | "disabled"
  | "missing_id"
  | "from_me"
  | "status_broadcast"
  | "newsletter"
  | "ignored"
  | "group"
  | "unsupported_chat"
  | "echo"
  | "duplicate"
  | "cooldown"
  | "rate_limit";

export interface AutoReplyDecision {
  action: "reply" | "skip";
  reason?: AutoReplySkipReason;
}

function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const value = env[key];
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`Invalid ${key}; expected true or false`);
}

function readBoundedInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = env[key];
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`Invalid ${key}; expected an integer from ${minimum} to ${maximum}`);
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid ${key}; expected an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

/** Parse the comma-separated ignore list. Blank means nothing is ignored. */
export function parseAutoReplyIgnoreJids(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  const entries = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (entries.length > AUTO_REPLY_MAX_IGNORE_JIDS) {
    throw new Error(
      `Invalid WA_AUTO_REPLY_IGNORE_JIDS; expected at most ${AUTO_REPLY_MAX_IGNORE_JIDS} entries`,
    );
  }
  for (const entry of entries) {
    if (entry.length > MAX_IGNORE_JID_LENGTH || !IGNORE_JID_PATTERN.test(entry)) {
      throw new Error(
        "Invalid WA_AUTO_REPLY_IGNORE_JIDS; expected comma-separated JIDs or wildcards such as 5511999999999@s.whatsapp.net, @lid, or 5577*@s.whatsapp.net",
      );
    }
  }
  return entries;
}

/** True when a chat or sender JID matches one ignore entry. */
export function jidMatchesIgnoreList(jid: string, patterns: readonly string[]): boolean {
  const value = jid.trim().toLowerCase();
  if (!value) return false;
  const user = value.slice(0, value.lastIndexOf("@"));
  return patterns.some((pattern) => {
    if (pattern.startsWith("@") && !pattern.includes("*")) return value.endsWith(pattern);
    if (/^\d+$/.test(pattern)) return user === pattern;
    if (pattern.includes("*")) {
      const expression = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`^${expression}$`).test(value);
    }
    return value === pattern;
  });
}

/** Read auto-reply settings. Invalid values throw. The feature stays off unless enabled. */
export function loadAutoReplyConfig(env: NodeJS.ProcessEnv = process.env): AutoReplyConfig {
  const enabled = readBoolean(env, "WA_AUTO_REPLY_ENABLED", false);
  const message = env.WA_AUTO_REPLY_TEXT?.trim() ?? "";
  if (message.length > AUTO_REPLY_MAX_CHARS) {
    throw new Error(
      `Invalid WA_AUTO_REPLY_TEXT; expected at most ${AUTO_REPLY_MAX_CHARS} characters`,
    );
  }
  if (enabled && message.length === 0) {
    throw new Error(
      "Invalid WA_AUTO_REPLY_TEXT; expected a non-blank text when WA_AUTO_REPLY_ENABLED=true",
    );
  }
  const groups = readBoolean(env, "WA_AUTO_REPLY_GROUPS", false);
  const cooldownHours = readBoundedInteger(
    env,
    "WA_AUTO_REPLY_COOLDOWN_HOURS",
    AUTO_REPLY_DEFAULT_COOLDOWN_HOURS,
    AUTO_REPLY_MIN_COOLDOWN_HOURS,
    AUTO_REPLY_MAX_COOLDOWN_HOURS,
  );
  const ratePerMinute = readBoundedInteger(
    env,
    "WA_AUTO_REPLY_RATE_PER_MINUTE",
    AUTO_REPLY_DEFAULT_RATE_PER_MINUTE,
    AUTO_REPLY_MIN_RATE_PER_MINUTE,
    AUTO_REPLY_MAX_RATE_PER_MINUTE,
  );
  const ignoreJids = parseAutoReplyIgnoreJids(env.WA_AUTO_REPLY_IGNORE_JIDS);
  return {
    enabled,
    message,
    groups,
    cooldownMs: cooldownHours * 60 * 60 * 1000,
    ratePerMinute,
    ignoreJids,
  };
}

function chatServer(chatId: string): string {
  const at = chatId.lastIndexOf("@");
  return at === -1
    ? ""
    : chatId
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

function isStatusOrBroadcast(chatId: string): boolean {
  const jid = chatId.trim().toLowerCase();
  return jid === "status@broadcast" || jid.endsWith("@broadcast");
}

function isGroupChat(chatId: string, isGroup: boolean | undefined): boolean {
  return isGroup === true || chatServer(chatId) === "g.us";
}

export class AutoReplyGate {
  private readonly seenMessageIds = new Map<string, number>();
  private readonly lastReplyAt = new Map<string, number>();
  private readonly sentAt = new Map<string, number[]>();

  constructor(private readonly config: AutoReplyConfig) {}

  decide(instanceId: string, event: NormalizedMessageEvent, now: number): AutoReplyDecision {
    if (!this.config.enabled || this.config.message.length === 0) {
      return { action: "skip", reason: "disabled" };
    }

    const messageId = event.message.id?.trim() ?? "";
    const seenKey = `${instanceId}\0${messageId}`;
    if (!messageId) return { action: "skip", reason: "missing_id" };
    if (this.seenMessageIds.has(seenKey)) return { action: "skip", reason: "duplicate" };
    this.rememberMessage(seenKey, now);

    if (event.message.isFromMe) return { action: "skip", reason: "from_me" };

    const chatId = event.chatId?.trim() ?? "";
    if (!chatId) return { action: "skip", reason: "unsupported_chat" };
    if (isStatusOrBroadcast(chatId)) return { action: "skip", reason: "status_broadcast" };
    if (chatServer(chatId) === "newsletter") return { action: "skip", reason: "newsletter" };
    if (
      jidMatchesIgnoreList(chatId, this.config.ignoreJids) ||
      jidMatchesIgnoreList(event.message.sender ?? "", this.config.ignoreJids)
    ) {
      return { action: "skip", reason: "ignored" };
    }

    const group = isGroupChat(chatId, event.isGroup);
    if (group && !this.config.groups) return { action: "skip", reason: "group" };
    if (!group && !DIRECT_CHAT_SERVERS.has(chatServer(chatId))) {
      return { action: "skip", reason: "unsupported_chat" };
    }

    const content = event.message.content?.trim() ?? "";
    if (content === this.config.message) return { action: "skip", reason: "echo" };

    const chatKey = `${instanceId}\0${chatId}`;
    const lastReplyAt = this.lastReplyAt.get(chatKey);
    if (lastReplyAt !== undefined && now - lastReplyAt < this.config.cooldownMs) {
      return { action: "skip", reason: "cooldown" };
    }
    if (!this.takeRateSlot(instanceId, now)) return { action: "skip", reason: "rate_limit" };

    this.lastReplyAt.set(chatKey, now);
    return { action: "reply" };
  }

  private rememberMessage(key: string, now: number): void {
    this.seenMessageIds.set(key, now);
    while (this.seenMessageIds.size > MAX_TRACKED_MESSAGE_IDS) {
      const oldest = this.seenMessageIds.keys().next().value;
      if (!oldest) break;
      this.seenMessageIds.delete(oldest);
    }
  }

  private takeRateSlot(instanceId: string, now: number): boolean {
    const windowStart = now - AUTO_REPLY_RATE_WINDOW_MS;
    const recent = (this.sentAt.get(instanceId) ?? []).filter((sentAt) => sentAt > windowStart);
    if (recent.length >= this.config.ratePerMinute) {
      this.sentAt.set(instanceId, recent);
      return false;
    }
    recent.push(now);
    this.sentAt.set(instanceId, recent);
    return true;
  }
}

export class AutoReplyService {
  private readonly gate: AutoReplyGate;

  constructor(
    private readonly config: AutoReplyConfig,
    private readonly send: (instanceId: string, chatId: string, text: string) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {
    this.gate = new AutoReplyGate(config);
  }

  handle(instanceId: string, event: NormalizedMessageEvent): void {
    const decision = this.gate.decide(instanceId, event, this.now());
    if (decision.action === "skip") {
      logger.debug(
        { instanceId, chatId: event.chatId, reason: decision.reason },
        "Auto-reply skipped",
      );
      return;
    }

    void this.send(instanceId, event.chatId, this.config.message).catch((error: unknown) => {
      logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          instanceId,
          chatId: event.chatId,
        },
        "Auto-reply failed",
      );
    });
  }
}

/** Subscribe to incoming messages. A disabled auto-reply does not subscribe. */
export function startAutoReply(
  instances: Pick<InstanceManager, "onAnyEvent" | "getInstanceChannel">,
  queue: Pick<MessageQueue, "enqueueMessage">,
  config: AutoReplyConfig,
): { stop: () => void } {
  if (!config.enabled || config.message.length === 0) return { stop() {} };

  const service = new AutoReplyService(config, async (instanceId, chatId, text) => {
    const channel = instances.getInstanceChannel(instanceId);
    await queue.enqueueMessage(instanceId, chatId, { type: "text", text }, channel);
  });
  const unsubscribe = instances.onAnyEvent(
    <E extends ChannelEvent>(event: E, instanceId: string, payload: ChannelEventPayload[E]) => {
      if (event !== "message.received") return;
      service.handle(instanceId, payload as ChannelEventPayload["message.received"]);
    },
  );
  return { stop: unsubscribe };
}
