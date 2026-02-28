// ============================================================
// WA MCP — MCP Tool Response Types
// ============================================================

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
  // Strip internal paths and stack traces from error messages
  let sanitized = message;
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
  | "whatsapp/call.received";

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
