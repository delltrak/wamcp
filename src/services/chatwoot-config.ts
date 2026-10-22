// ============================================================
// WA MCP — Chatwoot configuration
// The integration is off until WA_CHATWOOT_ENABLED=true.
// ============================================================

import { isIP } from "node:net";
import { isValidGroupId } from "../utils/group-jid.js";
import { isNonPublicIp, isValidInstanceId, isValidJid } from "../utils/validation.js";

type Environment = Record<string, string | undefined>;

export interface DisabledChatwootConfig {
  enabled: false;
}

export interface EnabledChatwootConfig {
  enabled: true;
  url: string;
  token: string;
  accountId: string;
  inboxId: string;
  webhookSecret: string;
  ignoreJids: readonly string[];
  instanceId?: string;
  allowHttp: boolean;
  allowPrivateUrl: boolean;
  allowLegacySecret: boolean;
  blockGroupReplies: boolean;
  timeoutMs: number;
}

export type ChatwootConfig = DisabledChatwootConfig | EnabledChatwootConfig;

const MIN_WEBHOOK_SECRET_LENGTH = 16;
const MAX_IGNORE_PATTERNS = 100;

function read(env: Environment, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
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
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`Invalid ${key}; expected a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`Invalid ${key}; expected a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

function requireId(value: string | undefined, key: string): string {
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid ${key}; expected a positive integer`);
  }
  return value;
}

/** Comma-separated exact JIDs, `@domain` suffixes, or `*` wildcards. */
export function parseChatwootIgnoreJids(value: string | undefined): string[] {
  if (!value) return [];
  const patterns = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (patterns.length > MAX_IGNORE_PATTERNS) {
    throw new Error("Invalid WA_CHATWOOT_IGNORE_JIDS; expected at most 100 patterns");
  }
  for (const pattern of patterns) {
    if (pattern.length > 256) {
      throw new Error("Invalid WA_CHATWOOT_IGNORE_JIDS; a pattern is too long");
    }
    if (pattern === "*" || pattern === "**") {
      throw new Error("Invalid WA_CHATWOOT_IGNORE_JIDS; a pattern cannot match every JID");
    }
  }
  return patterns;
}

/** True for system chats and for JIDs selected by WA_CHATWOOT_IGNORE_JIDS. */
export function isChatwootJidIgnored(chatId: string, patterns: readonly string[]): boolean {
  const value = chatId.trim().toLowerCase();
  if (
    !value ||
    value === "status@broadcast" ||
    value.endsWith("@broadcast") ||
    value.endsWith("@newsletter")
  ) {
    return true;
  }

  for (const raw of patterns) {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern.includes("*")) {
      let expression = "^";
      for (const char of pattern) {
        expression += char === "*" ? ".*" : /[.+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
      }
      if (new RegExp(`${expression}$`).test(value)) return true;
      continue;
    }
    if (pattern.startsWith("@")) {
      if (value.endsWith(pattern)) return true;
      continue;
    }
    if (value === pattern) return true;
  }
  return false;
}

export function isChatwootMetadataAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "metadata.google.internal" || host === "169.254.169.254") return true;
  if (isIP(host) === 4) {
    const [first, second] = host.split(".");
    return first === "169" && second === "254";
  }
  if (isIP(host) === 6) {
    if (host.startsWith("::ffff:")) {
      const mapped = host.slice("::ffff:".length);
      if (isIP(mapped) === 4) return isChatwootMetadataAddress(mapped);
    }
    const first = Number.parseInt(host.split(":")[0] || "0", 16);
    return first >= 0xfe80 && first <= 0xfebf;
  }
  return false;
}

export function validateChatwootUrl(
  url: string,
  allowHttp: boolean,
  allowPrivateUrl: boolean,
): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid WA_CHATWOOT_URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Invalid WA_CHATWOOT_URL; credentials are not allowed");
  }
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    throw new Error("Invalid WA_CHATWOOT_URL; use HTTPS or set WA_CHATWOOT_ALLOW_HTTP=true");
  }
  if (!parsed.hostname || isChatwootMetadataAddress(parsed.hostname)) {
    throw new Error("Invalid WA_CHATWOOT_URL");
  }
  if (!allowPrivateUrl && isNonPublicIp(parsed.hostname)) {
    throw new Error(
      "Invalid WA_CHATWOOT_URL; use a public hostname or set WA_CHATWOOT_ALLOW_PRIVATE_URL=true",
    );
  }
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  return parsed.toString().replace(/\/$/, "");
}

const LID_REPLY_JID_RE = /^\d{5,20}@lid$/;

/** Destination chats this bridge will queue. Groups use the group-id check. */
export function isChatwootReplyJid(value: string): boolean {
  return (
    isValidJid(value) ||
    LID_REPLY_JID_RE.test(value) ||
    (value.endsWith("@g.us") && isValidGroupId(value))
  );
}

/** True when the contact source id addresses a newsletter, including `inst_<id>|…@newsletter`. */
export function isChatwootNewsletterSource(sourceId: string): boolean {
  const value = sourceId.trim();
  if (!value) return false;
  const separator = value.indexOf("|");
  const chatId = (separator > 0 ? value.slice(separator + 1) : value).trim().toLowerCase();
  return chatId.endsWith("@newsletter");
}

/** Contact-inbox source id. A pinned instance stores the bare chat JID. */
export function chatwootSourceId(
  instanceId: string,
  chatId: string,
  pinnedInstanceId?: string,
): string {
  if (pinnedInstanceId) return chatId;
  return `${instanceId}|${chatId}`;
}

export function parseChatwootSourceId(
  sourceId: string,
  pinnedInstanceId?: string,
): { instanceId?: string; chatId: string } {
  const value = sourceId.trim();
  if (!value) return { chatId: "" };
  const separator = value.indexOf("|");
  if (separator > 0) {
    const instanceId = value.slice(0, separator);
    const chatId = value.slice(separator + 1);
    if (!isValidInstanceId(instanceId) || !isChatwootReplyJid(chatId)) return { chatId: "" };
    if (pinnedInstanceId && instanceId !== pinnedInstanceId) return { chatId: "" };
    return { instanceId, chatId };
  }
  if (!isChatwootReplyJid(value)) return { chatId: "" };
  if (pinnedInstanceId) return { instanceId: pinnedInstanceId, chatId: value };
  return { chatId: value };
}

/** Parse Chatwoot settings. Disabled mode ignores incomplete credentials. */
export function loadChatwootConfig(env: Environment = process.env): ChatwootConfig {
  const enabled = parseBoolean(env, "WA_CHATWOOT_ENABLED", false);
  const allowHttp = parseBoolean(env, "WA_CHATWOOT_ALLOW_HTTP", false);
  const allowPrivateUrl = parseBoolean(env, "WA_CHATWOOT_ALLOW_PRIVATE_URL", false);
  const allowLegacySecret = parseBoolean(env, "WA_CHATWOOT_ALLOW_LEGACY_SECRET", false);
  const blockGroupReplies = parseBoolean(env, "WA_CHATWOOT_BLOCK_GROUP_REPLIES", false);
  const timeoutMs = parsePositiveInteger(env, "WA_CHATWOOT_TIMEOUT_MS", 10_000, 120_000);
  const ignoreJids = parseChatwootIgnoreJids(read(env, "WA_CHATWOOT_IGNORE_JIDS"));
  const instanceValue = read(env, "WA_CHATWOOT_INSTANCE_ID");
  if (instanceValue && !isValidInstanceId(instanceValue)) {
    throw new Error("Invalid WA_CHATWOOT_INSTANCE_ID");
  }
  if (!enabled) return { enabled: false };

  const url = validateChatwootUrl(read(env, "WA_CHATWOOT_URL") ?? "", allowHttp, allowPrivateUrl);
  const token = read(env, "WA_CHATWOOT_TOKEN");
  if (!token || token.length < 8 || /[\r\n]/.test(token)) {
    throw new Error("Invalid WA_CHATWOOT_TOKEN; expected a token when WA_CHATWOOT_ENABLED=true");
  }
  const webhookSecret = read(env, "WA_CHATWOOT_WEBHOOK_SECRET");
  if (
    !webhookSecret ||
    webhookSecret.length < MIN_WEBHOOK_SECRET_LENGTH ||
    /[\r\n]/.test(webhookSecret)
  ) {
    throw new Error(
      "Invalid WA_CHATWOOT_WEBHOOK_SECRET; expected at least 16 characters when WA_CHATWOOT_ENABLED=true",
    );
  }

  return {
    enabled: true,
    url,
    token,
    accountId: requireId(read(env, "WA_CHATWOOT_ACCOUNT_ID"), "WA_CHATWOOT_ACCOUNT_ID"),
    inboxId: requireId(read(env, "WA_CHATWOOT_INBOX_ID"), "WA_CHATWOOT_INBOX_ID"),
    webhookSecret,
    ignoreJids,
    ...(instanceValue ? { instanceId: instanceValue } : {}),
    allowHttp,
    allowPrivateUrl,
    allowLegacySecret,
    blockGroupReplies,
    timeoutMs,
  };
}
