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

// ---- URL Safety (SSRF Prevention) ----

/** Private/internal IP ranges that must not be fetched. */
function isPrivateIp(hostname: string): boolean {
  const lower = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

  if (isIP(lower) === 4) {
    const [first = 0, second = 0] = lower.split(".").map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && (second === 0 || second === 168)) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }

  if (isIP(lower) === 6) {
    const [left, right] = lower.split("::");
    const leftGroups = left ? left.split(":") : [];
    const rightGroups = right ? right.split(":") : [];
    const omittedGroups = 8 - leftGroups.length - rightGroups.length;
    const groups = [
      ...leftGroups,
      ...Array(Math.max(0, omittedGroups)).fill("0"),
      ...rightGroups,
    ].map((group) => Number.parseInt(group, 16));

    if (groups.length !== 8) return true;
    const isMappedIpv4 = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
    if (isMappedIpv4) {
      const first = (groups[6] ?? 0) >> 8;
      const second = (groups[6] ?? 0) & 0xff;
      const third = (groups[7] ?? 0) >> 8;
      const fourth = (groups[7] ?? 0) & 0xff;
      return isPrivateIp(`${first}.${second}.${third}.${fourth}`);
    }

    const firstGroup = groups[0] ?? 0;
    return (
      groups.slice(0, 6).every((group) => group === 0) ||
      (firstGroup & 0xfe00) === 0xfc00 || // Unique local (fc00::/7)
      (firstGroup & 0xffc0) === 0xfe80 || // Link local (fe80::/10)
      (firstGroup & 0xff00) === 0xff00 || // Multicast (ff00::/8)
      (firstGroup === 0x2001 && groups[1] === 0x0db8) // Documentation range
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
  if (isPrivateIp(parsed.hostname)) {
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

  if (!parsed.hostname || isPrivateIp(parsed.hostname)) {
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
