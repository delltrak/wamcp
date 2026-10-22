// ============================================================
// WA MCP — Optional fixed auto-reply
// Sends one configured text. Stays off unless WA_AUTO_REPLY_ENABLED=true.
// ============================================================

import type { InstanceManager } from "./instance-manager.js";
import type { MessageQueue } from "./message-queue.js";
import type { ChannelEvent, ChannelEventPayload } from "../types/channel.types.js";
import type { MessageType, NormalizedMessageEvent } from "../types/channel.types.js";
import {
  sqliteAutoReplyCooldownStore,
  type AutoReplyCooldownStore,
} from "../db/auto-reply-cooldown.js";
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
export const AUTO_REPLY_MIN_MAX_AGE_SECONDS = 30;
export const AUTO_REPLY_MAX_MAX_AGE_SECONDS = 3_600;
export const AUTO_REPLY_DEFAULT_MAX_AGE_SECONDS = 180;
export const AUTO_REPLY_MAX_IGNORE_JIDS = 100;
export const AUTO_REPLY_MAX_INSTANCES = 100;
const MAX_IGNORE_JID_LENGTH = 256;
const MAX_INSTANCE_ID_LENGTH = 128;
const MAX_TRACKED_MESSAGE_IDS = 1_000;
const IGNORE_JID_PATTERN = /^[a-z0-9@.*_:-]+$/i;
const DIRECT_CHAT_SERVERS = new Set(["s.whatsapp.net", "lid"]);
const AUTO_REPLY_IGNORE_DOMAINS = new Set([
  "s.whatsapp.net",
  "lid",
  "g.us",
  "broadcast",
  "newsletter",
  "hosted",
  "hosted.lid",
]);
const CONTENT_TYPES = new Set<MessageType>([
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contact",
  "poll",
  "event",
  "album",
]);

export interface AutoReplyConfig {
  enabled: boolean;
  message: string;
  groups: boolean;
  cooldownMs: number;
  ratePerMinute: number;
  maxAgeSeconds: number;
  ignoreJids: readonly string[];
  /** Empty means every instance. */
  instances: readonly string[];
}

export interface AutoReplyContact {
  /** Phone JID for a private chat when one is known. The group JID when the chat is a group. */
  contactKey: string;
  aliases: readonly string[];
  ownJids: readonly string[];
}

export type AutoReplySkipReason =
  | "disabled"
  | "instance"
  | "missing_id"
  | "from_me"
  | "own_identity"
  | "status_broadcast"
  | "newsletter"
  | "ignored"
  | "group"
  | "unsupported_chat"
  | "not_content"
  | "stale"
  | "echo"
  | "duplicate"
  | "cooldown"
  | "rate_limit";

export interface AutoReplyDecision {
  action: "reply" | "skip";
  reason?: AutoReplySkipReason;
  queued?: () => void;
  failed?: () => void;
}

type IdentityLookup = {
  ownJids?: readonly string[];
  resolvePn?: (jid: string) => Promise<string>;
};

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

function disabledConfig(): AutoReplyConfig {
  return {
    enabled: false,
    message: "",
    groups: false,
    cooldownMs: AUTO_REPLY_DEFAULT_COOLDOWN_HOURS * 60 * 60 * 1000,
    ratePerMinute: AUTO_REPLY_DEFAULT_RATE_PER_MINUTE,
    maxAgeSeconds: AUTO_REPLY_DEFAULT_MAX_AGE_SECONDS,
    ignoreJids: [],
    instances: [],
  };
}

/** Drop a WhatsApp device suffix such as :12 before the server. */
export function bareJid(jid: string): string {
  const value = jid.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at <= 0) return value;
  let user = value.slice(0, at);
  const colon = user.indexOf(":");
  if (colon !== -1) user = user.slice(0, colon);
  return `${user}@${value.slice(at + 1)}`;
}

function chatServer(jid: string): string {
  const bare = bareJid(jid);
  const at = bare.lastIndexOf("@");
  return at === -1 ? "" : bare.slice(at + 1);
}

function isPhoneIgnorePattern(pattern: string): boolean {
  return /^[0-9*]+$/.test(pattern);
}

function assertIgnorePatternCanMatch(pattern: string): void {
  const atCount = pattern.split("@").length - 1;
  if (atCount === 0) {
    if (!isPhoneIgnorePattern(pattern)) {
      throw new Error(`Invalid WA_AUTO_REPLY_IGNORE_JIDS; entry "${pattern}" cannot match a chat`);
    }
    return;
  }
  if (atCount !== 1) {
    throw new Error(`Invalid WA_AUTO_REPLY_IGNORE_JIDS; entry "${pattern}" cannot match a chat`);
  }
  const at = pattern.indexOf("@");
  const user = pattern.slice(0, at);
  const domain = pattern.slice(at + 1);
  if (!domain || (user.length === 0 && !pattern.startsWith("@"))) {
    throw new Error(`Invalid WA_AUTO_REPLY_IGNORE_JIDS; entry "${pattern}" cannot match a chat`);
  }
  if (!AUTO_REPLY_IGNORE_DOMAINS.has(domain)) {
    throw new Error(`Invalid WA_AUTO_REPLY_IGNORE_JIDS; entry "${pattern}" cannot match a chat`);
  }
}

/** `@lid` and `*@lid` select a server. Exact JIDs and phone patterns do not. */
function isDomainOnlyPattern(pattern: string): boolean {
  const at = pattern.indexOf("@");
  if (at < 0) return false;
  if (at === 0) return true;
  return pattern.slice(0, at) === "*";
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
        "Invalid WA_AUTO_REPLY_IGNORE_JIDS; expected comma-separated JIDs or wildcards such as 5511999999999@s.whatsapp.net, @lid, or 5577*",
      );
    }
    assertIgnorePatternCanMatch(entry);
  }
  return entries;
}

function parseAutoReplyInstances(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length > AUTO_REPLY_MAX_INSTANCES) {
    throw new Error(
      `Invalid WA_AUTO_REPLY_INSTANCES; expected at most ${AUTO_REPLY_MAX_INSTANCES} entries`,
    );
  }
  for (const entry of entries) {
    if (entry.length > MAX_INSTANCE_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(entry)) {
      throw new Error(
        "Invalid WA_AUTO_REPLY_INSTANCES; expected a comma-separated list of instance ids",
      );
    }
  }
  return entries;
}

function globMatch(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  const expression = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${expression}$`).test(value);
}

function patternMatches(user: string, domain: string, pattern: string): boolean {
  if (!pattern.includes("@")) {
    return domain === "s.whatsapp.net" && globMatch(pattern, user);
  }
  const at = pattern.indexOf("@");
  let patternUser = pattern.slice(0, at);
  const patternDomain = pattern.slice(at + 1);
  const colon = patternUser.indexOf(":");
  if (colon !== -1) patternUser = patternUser.slice(0, colon);
  if (pattern.startsWith("@")) return globMatch(patternDomain, domain);
  return globMatch(patternUser, user) && globMatch(patternDomain, domain);
}

/** True when a chat or sender JID matches one ignore entry. */
export function jidMatchesIgnoreList(jid: string, patterns: readonly string[]): boolean {
  const bare = bareJid(jid);
  const at = bare.lastIndexOf("@");
  if (at <= 0) return false;
  const user = bare.slice(0, at);
  const domain = bare.slice(at + 1);
  return patterns.some((pattern) => patternMatches(user, domain, pattern));
}

/** Read auto-reply settings. Other variables are checked only when the feature is on. */
export function loadAutoReplyConfig(env: NodeJS.ProcessEnv = process.env): AutoReplyConfig {
  const enabled = readBoolean(env, "WA_AUTO_REPLY_ENABLED", false);
  if (!enabled) return disabledConfig();

  const message = env.WA_AUTO_REPLY_TEXT?.trim() ?? "";
  if (message.length > AUTO_REPLY_MAX_CHARS) {
    throw new Error(
      `Invalid WA_AUTO_REPLY_TEXT; expected at most ${AUTO_REPLY_MAX_CHARS} characters`,
    );
  }
  if (message.length === 0) {
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
  const maxAgeSeconds = readBoundedInteger(
    env,
    "WA_AUTO_REPLY_MAX_AGE_SECONDS",
    AUTO_REPLY_DEFAULT_MAX_AGE_SECONDS,
    AUTO_REPLY_MIN_MAX_AGE_SECONDS,
    AUTO_REPLY_MAX_MAX_AGE_SECONDS,
  );
  const ignoreJids = parseAutoReplyIgnoreJids(env.WA_AUTO_REPLY_IGNORE_JIDS);
  const instances = parseAutoReplyInstances(env.WA_AUTO_REPLY_INSTANCES);
  return {
    enabled,
    message,
    groups,
    cooldownMs: cooldownHours * 60 * 60 * 1000,
    ratePerMinute,
    maxAgeSeconds,
    ignoreJids,
    instances,
  };
}

function isStatusOrBroadcast(chatId: string): boolean {
  const jid = bareJid(chatId);
  return jid === "status@broadcast" || jid.endsWith("@broadcast");
}

function isGroupChat(chatId: string, isGroup: boolean | undefined): boolean {
  return isGroup === true || chatServer(chatId) === "g.us";
}

function isHosted(jid: string): boolean {
  const server = chatServer(jid);
  return server === "hosted" || server === "hosted.lid";
}

function hasReplyableContent(event: NormalizedMessageEvent): boolean {
  if (!CONTENT_TYPES.has(event.message.type)) return false;
  const raw = event.message.rawType?.toLowerCase() ?? "";
  if (
    raw.includes("protocol") ||
    raw.includes("stub") ||
    raw.includes("revoke") ||
    raw.includes("edit")
  ) {
    return false;
  }
  const text = event.message.content?.trim() ?? "";
  const media = event.message.mediaUrl?.trim() ?? "";
  const caption = event.message.caption?.trim() || event.message.mediaCaption?.trim() || "";
  return text.length > 0 || media.length > 0 || caption.length > 0;
}

function messageAgeSeconds(event: NormalizedMessageEvent, now: number): number | undefined {
  const timestamp = event.message.timestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
    return undefined;
  }
  return now / 1000 - timestamp;
}

function uniqueJids(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const bare = bareJid(value);
    if (!bare.includes("@")) continue;
    seen.add(bare);
  }
  return [...seen];
}

function preferPn(candidates: readonly string[], resolvedPn: string | undefined): string {
  const pn =
    candidates.find((jid) => chatServer(jid) === "s.whatsapp.net") ??
    (resolvedPn && chatServer(resolvedPn) === "s.whatsapp.net" ? bareJid(resolvedPn) : "");
  return pn || candidates[0] || "";
}

function contactAliases(event: NormalizedMessageEvent, resolvedPn: string | undefined): string[] {
  return uniqueJids([
    event.chatId,
    event.chatLid,
    event.message.sender,
    event.message.senderLid,
    event.message.senderPn,
    resolvedPn,
  ]);
}

function contactKeyFor(
  event: NormalizedMessageEvent,
  subject: string | undefined,
  subjectLid: string | undefined,
  resolvedPn: string | undefined,
): string {
  if (isGroupChat(event.chatId, event.isGroup)) return bareJid(event.chatId);
  return (
    preferPn(uniqueJids([subject, subjectLid, resolvedPn]), resolvedPn) || bareJid(event.chatId)
  );
}

/** Canonical contact for cooldown and ignore checks. A group shares one key. */
export async function resolveAutoReplyContact(
  event: NormalizedMessageEvent,
  lookup: IdentityLookup = {},
): Promise<AutoReplyContact> {
  const group = isGroupChat(event.chatId, event.isGroup);
  const subject = group ? event.message.sender : event.chatId;
  const subjectLid = group ? event.message.senderLid : event.chatLid;
  let resolvedPn: string | undefined;
  const subjectBare = bareJid(subject ?? "");
  if (chatServer(subjectBare) === "lid" && lookup.resolvePn) {
    try {
      const resolved = await lookup.resolvePn(subjectBare);
      if (resolved && bareJid(resolved) !== subjectBare) resolvedPn = bareJid(resolved);
    } catch {
      resolvedPn = undefined;
    }
  }
  return {
    contactKey: contactKeyFor(event, subject, subjectLid, resolvedPn),
    aliases: contactAliases(event, resolvedPn),
    ownJids: uniqueJids([...(lookup.ownJids ?? [])]),
  };
}

function contactFromEvent(event: NormalizedMessageEvent): AutoReplyContact {
  const group = isGroupChat(event.chatId, event.isGroup);
  const subject = group ? event.message.sender : event.chatId;
  const subjectLid = group ? event.message.senderLid : event.chatLid;
  return {
    contactKey: contactKeyFor(event, subject, subjectLid, undefined),
    aliases: contactAliases(event, undefined),
    ownJids: [],
  };
}

function matchesIgnoreList(
  event: NormalizedMessageEvent,
  contact: AutoReplyContact,
  patterns: readonly string[],
): boolean {
  if (patterns.length === 0) return false;
  const domainPatterns: string[] = [];
  const exactPatterns: string[] = [];
  for (const pattern of patterns) {
    if (isDomainOnlyPattern(pattern)) domainPatterns.push(pattern);
    else exactPatterns.push(pattern);
  }
  const subjects = [event.chatId];
  if (isGroupChat(event.chatId, event.isGroup) && event.message.sender) {
    subjects.push(event.message.sender);
  }
  if (
    domainPatterns.length > 0 &&
    subjects.some((jid) => jidMatchesIgnoreList(jid, domainPatterns))
  ) {
    return true;
  }
  return (
    exactPatterns.length > 0 &&
    contact.aliases.some((jid) => jidMatchesIgnoreList(jid, exactPatterns))
  );
}

export function memoryAutoReplyCooldownStore(): AutoReplyCooldownStore {
  const rows = new Map<string, number>();
  return {
    load(instanceId: string, contactKey: string): number | undefined {
      return rows.get(`${instanceId}\0${contactKey}`);
    },
    save(instanceId: string, contactKey: string, lastReplyAt: number): void {
      rows.set(`${instanceId}\0${contactKey}`, lastReplyAt);
    },
  };
}

export class AutoReplyGate {
  private readonly seenMessageIds = new Map<string, number>();
  private readonly sentAt = new Map<string, number[]>();
  private readonly pending = new Set<string>();
  private readonly unpersisted = new Map<string, number>();

  constructor(
    private readonly config: AutoReplyConfig,
    private readonly store: AutoReplyCooldownStore,
  ) {}

  async decide(
    instanceId: string,
    event: NormalizedMessageEvent,
    now: number,
    contact: AutoReplyContact,
  ): Promise<AutoReplyDecision> {
    if (!this.config.enabled || this.config.message.length === 0) {
      return { action: "skip", reason: "disabled" };
    }
    if (this.config.instances.length > 0 && !this.config.instances.includes(instanceId)) {
      return { action: "skip", reason: "instance" };
    }

    const messageId = event.message.id?.trim() ?? "";
    const seenKey = `${instanceId}\0${messageId}`;
    if (!messageId) return { action: "skip", reason: "missing_id" };
    if (this.seenMessageIds.has(seenKey)) return { action: "skip", reason: "duplicate" };
    this.rememberMessage(seenKey, now);

    if (event.message.isFromMe) return { action: "skip", reason: "from_me" };

    const chatId = event.chatId?.trim() ?? "";
    if (!chatId) return { action: "skip", reason: "unsupported_chat" };
    const own = new Set(contact.ownJids.map((jid) => bareJid(jid)));
    const participants = uniqueJids([
      chatId,
      event.chatLid,
      event.message.sender,
      event.message.senderLid,
      event.message.senderPn,
    ]);
    if (participants.some((jid) => own.has(jid))) {
      return { action: "skip", reason: "own_identity" };
    }
    if (isStatusOrBroadcast(chatId)) return { action: "skip", reason: "status_broadcast" };
    if (chatServer(chatId) === "newsletter") return { action: "skip", reason: "newsletter" };
    if (isHosted(chatId) || isHosted(event.message.sender ?? "")) {
      return { action: "skip", reason: "unsupported_chat" };
    }
    if (matchesIgnoreList(event, contact, this.config.ignoreJids)) {
      return { action: "skip", reason: "ignored" };
    }

    const group = isGroupChat(chatId, event.isGroup);
    if (group && !this.config.groups) return { action: "skip", reason: "group" };
    if (!group && !DIRECT_CHAT_SERVERS.has(chatServer(chatId))) {
      return { action: "skip", reason: "unsupported_chat" };
    }
    if (!hasReplyableContent(event)) return { action: "skip", reason: "not_content" };

    const ageSeconds = messageAgeSeconds(event, now);
    if (ageSeconds === undefined || ageSeconds > this.config.maxAgeSeconds) {
      return { action: "skip", reason: "stale" };
    }

    const content = event.message.content?.trim() ?? "";
    if (content === this.config.message) return { action: "skip", reason: "echo" };

    const contactKey = contact.contactKey || bareJid(chatId);
    const cooldownKey = `${instanceId}\0${contactKey}`;
    if (this.pending.has(cooldownKey)) return { action: "skip", reason: "cooldown" };
    let storedReplyAt: number | undefined;
    try {
      storedReplyAt =
        this.unpersisted.get(cooldownKey) ?? (await this.store.load(instanceId, contactKey));
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error), instanceId },
        "Auto-reply cooldown could not be read",
      );
      return { action: "skip", reason: "cooldown" };
    }
    if (this.pending.has(cooldownKey)) return { action: "skip", reason: "cooldown" };
    if (storedReplyAt !== undefined && now - storedReplyAt < this.config.cooldownMs) {
      return { action: "skip", reason: "cooldown" };
    }
    if (!this.takeRateSlot(instanceId, now)) return { action: "skip", reason: "rate_limit" };

    // Reserve locally while Redis accepts the job. A rejected enqueue must not
    // leave a persisted cooldown, but concurrent messages must not enqueue twice.
    this.pending.add(cooldownKey);
    return {
      action: "reply",
      queued: async () => {
        try {
          await this.store.save(instanceId, contactKey, now);
          this.unpersisted.delete(cooldownKey);
        } catch (error) {
          // Keep the cooldown in this process when persistence is unavailable.
          this.unpersisted.set(cooldownKey, now);
          logger.warn(
            { err: error instanceof Error ? error.message : String(error), instanceId },
            "Auto-reply cooldown could not be saved",
          );
        } finally {
          this.pending.delete(cooldownKey);
        }
      },
      failed: () => {
        this.pending.delete(cooldownKey);
        this.seenMessageIds.delete(seenKey);
        const recent = this.sentAt.get(instanceId);
        const index = recent?.indexOf(now) ?? -1;
        if (recent && index !== -1) recent.splice(index, 1);
      },
    };
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
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly config: AutoReplyConfig,
    private readonly send: (instanceId: string, chatId: string, text: string) => Promise<void>,
    private readonly now: () => number = Date.now,
    store: AutoReplyCooldownStore = memoryAutoReplyCooldownStore(),
    private readonly resolveContact?: (
      instanceId: string,
      event: NormalizedMessageEvent,
    ) => Promise<AutoReplyContact>,
  ) {
    this.gate = new AutoReplyGate(config, store);
  }

  handle(instanceId: string, event: NormalizedMessageEvent, contact?: AutoReplyContact): void {
    if (!this.resolveContact || contact) {
      void this.dispatch(instanceId, event, contact ?? contactFromEvent(event));
      return;
    }
    const resolveContact = this.resolveContact;
    const previous = this.tails.get(instanceId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (!resolveContact) return;
        const resolved = await resolveContact(instanceId, event);
        void this.dispatch(instanceId, event, resolved);
      })
      .catch((error: unknown) => {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error), instanceId },
          "Auto-reply failed",
        );
      });
    this.tails.set(instanceId, next);
  }

  private async dispatch(
    instanceId: string,
    event: NormalizedMessageEvent,
    contact: AutoReplyContact,
  ): Promise<void> {
    const decision = await this.gate.decide(instanceId, event, this.now(), contact);
    if (decision.action === "skip") {
      logger.debug(
        { instanceId, chatId: event.chatId, reason: decision.reason },
        "Auto-reply skipped",
      );
      return;
    }

    try {
      await this.send(instanceId, event.chatId, this.config.message);
      await decision.queued?.();
    } catch (error: unknown) {
      decision.failed?.();
      logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          instanceId,
          chatId: event.chatId,
        },
        "Auto-reply failed",
      );
    }
  }
}

type AutoReplyInstances = Pick<InstanceManager, "onAnyEvent" | "getInstanceChannel"> & {
  getAdapter?: InstanceManager["getAdapter"];
};

/** Subscribe to incoming messages. A disabled auto-reply does not subscribe. */
export function startAutoReply(
  instances: AutoReplyInstances,
  queue: Pick<MessageQueue, "enqueueMessage">,
  config: AutoReplyConfig,
  store: AutoReplyCooldownStore = sqliteAutoReplyCooldownStore,
): { stop: () => void } {
  if (!config.enabled || config.message.length === 0) return { stop() {} };

  const service = new AutoReplyService(
    config,
    async (instanceId, chatId, text) => {
      const channel = await instances.getInstanceChannel(instanceId);
      await queue.enqueueMessage(instanceId, chatId, { type: "text", text }, channel);
    },
    Date.now,
    store,
    async (instanceId, event) => {
      const lookup: IdentityLookup = {};
      if (instances.getAdapter) {
        try {
          const adapter = instances.getAdapter(instanceId) as {
            getLifecycleStatus?: () => { phone?: string | null; lid?: string | null };
            resolvePn?: (jid: string) => Promise<string>;
          };
          const runtime = adapter.getLifecycleStatus?.();
          lookup.ownJids = [runtime?.phone, runtime?.lid].filter((jid): jid is string =>
            Boolean(jid),
          );
          const resolvePn = adapter.resolvePn;
          if (resolvePn) lookup.resolvePn = (jid) => resolvePn.call(adapter, jid);
        } catch (error) {
          logger.warn(
            { err: error instanceof Error ? error.message : String(error), instanceId },
            "Auto-reply could not resolve the contact",
          );
        }
      }
      return resolveAutoReplyContact(event, lookup);
    },
  );
  const unsubscribe = instances.onAnyEvent(
    async <E extends ChannelEvent>(
      event: E,
      instanceId: string,
      payload: ChannelEventPayload[E],
    ) => {
      if (event !== "message.received") return;
      await service.handle(instanceId, payload as ChannelEventPayload["message.received"]);
    },
  );
  return { stop: unsubscribe };
}
