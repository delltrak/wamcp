// ============================================================
// WA MCP — Tool Handler Wrapper with Error Handling & Tracing
// ============================================================

import { createRequestLogger } from "./logger.js";
import { toolError } from "../types/mcp.types.js";
import type { ToolErrorResponse } from "../types/mcp.types.js";

/**
 * Classify an error and return an actionable MCP error response.
 * Logs the full error internally, returns a clean message to the agent.
 */
export function handleToolError(
  toolName: string,
  err: unknown,
  instanceId?: string,
): ToolErrorResponse {
  const log = createRequestLogger(toolName, instanceId);
  const message = err instanceof Error ? err.message : String(err);

  log.error({ err }, `Tool ${toolName} failed`);

  // Instance not found
  if (message.includes("not found")) {
    if (message.includes("not found or not initialized")) {
      return toolError(
        `Instance '${instanceId ?? "unknown"}' is not initialized. Call wa_connect_instance first, or wa_create_instance if it does not exist.`,
      );
    }
    return toolError(
      `Instance '${instanceId ?? "unknown"}' not found. Call wa_create_instance to create one.`,
    );
  }

  // Instance not connected
  if (
    message.includes("not connected") ||
    message.includes("Connection Closed") ||
    message.includes("DisconnectReason")
  ) {
    return toolError(
      `Instance '${instanceId ?? "unknown"}' is not connected. Call wa_connect_instance first.`,
    );
  }

  // Cloud API unsupported operation
  if (message.includes("not supported") || message.includes("not implemented")) {
    return toolError(
      `This operation is not supported by the current channel adapter. ${message}`,
    );
  }

  // Rate limiting
  if (message.includes("rate") && message.includes("limit")) {
    return toolError(
      `Rate limit reached for instance '${instanceId ?? "unknown"}'. Wait a moment and retry.`,
    );
  }

  // Queue/Redis errors
  if (message.includes("ECONNREFUSED") || message.includes("Redis")) {
    return toolError(
      "Message queue is unavailable (Redis connection failed). Check that Redis is running.",
    );
  }

  // Invalid parameters (from Zod or manual validation)
  if (message.includes("Invalid") || message.includes("required") || message.includes("Expected")) {
    return toolError(message);
  }

  // Default: return the error message without stack trace
  return toolError(message);
}
