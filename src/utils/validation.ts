// ============================================================
// WA MCP — Shared Validation Utilities
// JID validation, URL safety (SSRF prevention), base64 limits
// ============================================================

import { URL } from "node:url";

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
  // IPv4 private ranges
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^0\./.test(hostname)) return true;
  if (hostname === "0.0.0.0") return true;

  // IPv6 loopback and private
  if (hostname === "::1" || hostname === "[::1]") return true;
  if (hostname.startsWith("fc") || hostname.startsWith("fd")) return true;
  if (hostname.startsWith("fe80")) return true;

  // Localhost names
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower === "localhost.localdomain") return true;

  // Metadata endpoints (cloud providers)
  if (hostname === "169.254.169.254") return true;
  if (lower === "metadata.google.internal") return true;

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

// ---- Base64 Size Limits ----

/** Max base64 payload size: 100 MB decoded (generous for documents) */
const MAX_BASE64_BYTES = 100 * 1024 * 1024;

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
