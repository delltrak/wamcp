// ============================================================
// WA MCP — MCP Tool Response Types
// ============================================================

import { redactProxyCredentials } from "../utils/proxy-redact.js";

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

export type ToolContent = ToolTextContent | ToolImageContent;

export interface ToolSuccessResponse {
  [key: string]: unknown;
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: false;
}

export interface ToolErrorResponse {
  [key: string]: unknown;
  content: ToolTextContent[];
  isError: true;
}

export type ToolResponse = ToolSuccessResponse | ToolErrorResponse;

// Helper to create a success text response
export function toolSuccess(data: unknown): ToolSuccessResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

// Helper to create an error text response (sanitized for agent consumption)
export function toolError(message: string): ToolErrorResponse {
  // Strip internal paths, stack traces, and proxy credentials from error messages
  let sanitized = redactProxyCredentials(message, process.env.WA_BAILEYS_PROXY);
  sanitized = sanitized.replace(/\/[^\s:]+\.(ts|js|mjs|cjs)/g, "[internal]");
  sanitized = sanitized.replace(/\s+at\s+.+/g, "");
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${sanitized.trim()}` }],
  };
}

// MCP notification method names
export type McpNotificationMethod =
  | "whatsapp/message.received"
  | "whatsapp/message.updated"
  | "whatsapp/message.deleted"
  | "whatsapp/message.reaction"
  | "whatsapp/message.edited"
  | "whatsapp/presence.updated"
  | "whatsapp/chat.updated"
  | "whatsapp/group.updated"
  | "whatsapp/group.participants_changed"
  | "whatsapp/contact.updated"
  | "whatsapp/connection.changed"
  | "whatsapp/instance.connected"
  | "whatsapp/instance.disconnected"
  | "whatsapp/instance.pairing_code_generated"
  | "whatsapp/instance.qr_generated"
  | "whatsapp/instance.pairing_expired"
  | "whatsapp/instance.qr_expired"
  | "whatsapp/call.received"
  | "whatsapp/label.updated"
  | "whatsapp/event.response";

// MCP resource URI patterns
export type McpResourceUri =
  | "whatsapp://instances"
  | `whatsapp://instances/${string}`
  | `whatsapp://instances/${string}/contacts`
  | `whatsapp://instances/${string}/chats`
  | `whatsapp://instances/${string}/groups`
  | `whatsapp://instances/${string}/groups/${string}`
  | `whatsapp://instances/${string}/messages/${string}`
  | `whatsapp://instances/${string}/profile`
  | `whatsapp://instances/${string}/privacy`
  | `whatsapp://instances/${string}/blocklist`;
