// ============================================================
// WA MCP — Shared Validation Utilities
// JID validation, URL safety (SSRF prevention), base64 limits
// ============================================================

import { URL } from "node:url";
import { isIP } from "node:net";
import { MAX_BASE64_MEDIA_BYTES } from "../constants.js";

// ---- JID Validation ----

/**
 * WhatsApp JID format: <number>@s.whatsapp.net (individual)
 * or <number>-<timestamp>@g.us (group)
 * or <number>@newsletter
 * or status@broadcast
 */
const INDIVIDUAL_JID_RE = /^\d{5,20}@s\.whatsapp\.net$/;
const GROUP_JID_RE = /^\d{5,20}-\d{5,20}@g\.us$/;
const NEWSLETTER_JID_RE = /^\d{5,20}@newsletter$/;
const STATUS_BROADCAST_JID = "status@broadcast";
const STATUS_INDIVIDUAL_JID_RE =
  /^\d{5,20}(?::\d+)?@(s\.whatsapp\.net|c\.us|lid|hosted|hosted\.lid)$/;
const PHONE_INPUT_RE = /^[+\d\s().-]+$/;

export function isValidJid(jid: string): boolean {
  return (
    INDIVIDUAL_JID_RE.test(jid) ||
    GROUP_JID_RE.test(jid) ||
    NEWSLETTER_JID_RE.test(jid) ||
    jid === STATUS_BROADCAST_JID
  );
}

/**
 * Validate a JID-like input: either a valid JID or a raw phone number
 * (digits only, 5-20 chars) that will be normalized to a JID later.
 */
const PHONE_RE = /^\d{5,20}$/;

export function isValidJidOrPhone(input: string): boolean {
  return isValidJid(input) || PHONE_RE.test(input.replace(/[^0-9]/g, ""));
}

/**
 * Validate a status recipient. Status broadcasts accept individual PN, hosted,
 * and LID JIDs (Baileys resolves LID devices); groups, newsletters, and
 * broadcasts are not valid audience members.
 */
export function isValidStatusRecipient(input: string): boolean {
  const value = input.trim();
  if (value.includes("@")) {
    const match = STATUS_INDIVIDUAL_JID_RE.exec(value);
    if (!match) return false;
    if (match[1] === "lid" || match[1] === "hosted" || match[1] === "hosted.lid") return true;
    return isValidJid(`${value.slice(0, value.indexOf("@")).replace(/:\d+$/, "")}@s.whatsapp.net`);
  }

  return PHONE_INPUT_RE.test(value) && isValidJidOrPhone(value);
}

// ---- URL Safety (SSRF Prevention) ----

const NON_PUBLIC_IPV4_RANGES: readonly [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv4InRange(address: string, network: string, prefix: number): boolean {
  const toNumber = (value: string): number =>
    value.split(".").reduce((result, part) => (result << 8) | Number(part), 0) >>> 0;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (toNumber(address) & mask) === (toNumber(network) & mask);
}

function parseIpv6Groups(address: string): number[] | null {
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = normalized.slice(lastColon + 1);
    if (isIP(ipv4) !== 4) return null;
    const octets = ipv4.split(".").map(Number);
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    normalized = `${normalized.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }
  const groups = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
  return groups.length === 8 && groups.every(Number.isInteger) ? groups : null;
}

/** Private, special-use, or non-global IP ranges that must not receive a webhook. */
export function isNonPublicIp(hostname: string): boolean {
  const lower = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

  if (isIP(lower) === 4) {
    return NON_PUBLIC_IPV4_RANGES.some(([network, prefix]) => ipv4InRange(lower, network, prefix));
  }

  if (isIP(lower) === 6) {
    const groups = parseIpv6Groups(lower);
    if (!groups) return true;
    const isMappedIpv4 = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
    if (isMappedIpv4) {
      const first = (groups[6] ?? 0) >> 8;
      const second = (groups[6] ?? 0) & 0xff;
      const third = (groups[7] ?? 0) >> 8;
      const fourth = (groups[7] ?? 0) & 0xff;
      return isNonPublicIp(`${first}.${second}.${third}.${fourth}`);
    }

    const firstGroup = groups[0] ?? 0;
    return (
      firstGroup < 0x2000 ||
      firstGroup > 0x3fff ||
      (firstGroup === 0x2001 && groups[1] === 0x0db8) || // Documentation range
      firstGroup === 0x2002 || // 6to4 embeds an IPv4 address
      (firstGroup === 0x2001 && groups[1] === 0x0000) // Teredo embeds IPv4 addresses
    );
  }

  // Local and single-label hostnames do not identify public webhook targets.
  if (
    lower === "localhost" ||
    lower === "localhost.localdomain" ||
    !lower.includes(".") ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal") ||
    lower.endsWith(".home.arpa")
  ) {
    return true;
  }

  // Metadata endpoints (cloud providers)
  if (lower === "169.254.169.254" || lower === "metadata.google.internal") return true;

  return false;
}

/**
 * Validate a URL for safe external fetching.
 * Blocks: non-HTTPS, private IPs, file://, data://, etc.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateMediaUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL format";
  }

  // Only allow HTTPS
  if (parsed.protocol !== "https:") {
    return `URL protocol must be https, got ${parsed.protocol}`;
  }

  // Block private/internal hosts
  if (isNonPublicIp(parsed.hostname)) {
    return "URL points to a private/internal address";
  }

  return null;
}

/**
 * Validate an outgoing webhook destination. HTTP is accepted only when the
 * caller explicitly enables it; private and local destinations remain blocked.
 */
export function validateWebhookUrl(url: string, allowHttp = false): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL format";
  }

  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    return "Webhook URL must use HTTPS unless HTTP is explicitly allowed";
  }

  if (parsed.username || parsed.password) {
    return "Webhook URL must not contain credentials";
  }

  if (!parsed.hostname || isNonPublicIp(parsed.hostname)) {
    return "Webhook URL must use a public hostname";
  }

  return null;
}

// ---- Base64 Size Limits ----

/** Max base64 payload size, decoded. Shared with the stdio read-buffer ceiling. */
const MAX_BASE64_BYTES = MAX_BASE64_MEDIA_BYTES;

/**
 * Validate that a base64 string does not exceed the size limit.
 * Returns null if valid, or an error message string if too large.
 */
export function validateBase64Size(base64: string, maxBytes = MAX_BASE64_BYTES): string | null {
  // base64 encodes 3 bytes into 4 chars; estimate decoded size
  const estimatedBytes = Math.ceil((base64.length * 3) / 4);
  if (estimatedBytes > maxBytes) {
    const maxMb = Math.round(maxBytes / 1024 / 1024);
    return `Base64 payload exceeds maximum size of ${maxMb} MB`;
  }
  return null;
}

// ---- Media Input Validation ----

/**
 * Validate a media input string (URL or base64).
 * Returns null if valid, or an error message string if invalid.
 */
export function validateMediaInput(input: string): string | null {
  if (input.startsWith("https://")) {
    return validateMediaUrl(input);
  }
  if (input.startsWith("http://")) {
    return "Media URLs must use HTTPS";
  }
  if (input.startsWith("file://") || input.startsWith("data:")) {
    return "file:// and data: URLs are not allowed";
  }

  // Treat as base64
  return validateBase64Size(input);
}

// ---- Instance ID Validation ----

const INSTANCE_ID_RE = /^inst_[a-f0-9]{8}$/;

export function isValidInstanceId(id: string): boolean {
  return INSTANCE_ID_RE.test(id);
}

// ---- Sanitize Error Messages ----

/**
 * Strip internal details (file paths, stack traces) from error messages
 * before returning them to agents.
 */
export function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    let msg = err.message;
    // Remove file paths
    msg = msg.replace(/\/[^\s:]+\.(ts|js|mjs|cjs)/g, "[internal]");
    // Remove stack-like lines
    msg = msg.replace(/\s+at\s+.+/g, "");
    return msg.trim();
  }
  return "An unexpected error occurred";
}
